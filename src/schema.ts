// Per-event write cost against the Workers Free plan's 100,000
// rows-written/day ceiling — see CLAUDE.md "The budget". Rows written is
// the binding constraint, not storage or requests, so this is the number
// that decides how much headroom a single owner actually has.
//
// Measured via SqlStorageCursor.rowsWritten (chunk 3, docs/baselines.json)
// rather than estimated, since `id TEXT PRIMARY KEY` isn't a rowid alias
// and costs its own implicit unique index on top of the composite one:
//
//   events insert:                    1 base row + 1 implicit PK index
//                                      (TEXT primary key, not a rowid
//                                      alias) + 1 composite index below = 3
//   event_tags insert, per tag row:   1 base row + 1 for its index       = 2
//
//   => 3 + 2 * (single-letter tag count) rows per stored event.
//      A bare note costs 3 rows; a reply carrying #e and #p costs 7.
//      NIP-09 deletes and replaceable-event replacement cost the same
//      shape again (a delete is a write too) plus this insert cost.
//
// Only ONE index exists on `events`. A second index on (kind, created_at)
// for kind-only filters was considered and rejected: chunk 4's read-abuse
// rules reject any filter lacking both `authors` and `kinds`, so every
// accepted query filters by pubkey, and pubkey cardinality for a single
// owner (plus optional follows) is small enough that an unindexed
// secondary scan is cheap. Do not add it without updating this comment
// and re-justifying the write cost.
//
// `event_tags` only stores single-letter tag names because NIP-01 only
// defines filtering via "#<single-letter>" — multi-character tags are
// still stored verbatim in `events.tags` for the client, just never
// indexed.
//
// `deleted_ids` (ROADMAP.md chunk 6) is a tombstone set, not part of the
// per-event write cost above. NIP-09/NIP-62 both require that a deleted
// event cannot be re-stored by re-sending the same signed copy -- without
// this, deleting a gift wrap is meaningless, since the sender still holds
// their own copy and nothing stops them replaying it (unlike this
// relay's other write paths, which are all owner-authored and so have no
// adversarial reason to replay a delete). One row per tombstoned id (2
// rows written: base + implicit PK index, same TEXT-PK shape as
// `events.id`) -- see storage.ts `deleteAndTombstone`. Only genuine
// deletion requests pay this; `storeEvent`'s replaceable/addressable
// replacement path calls the untombstoned `deleteEventRow` instead, since
// a superseded version has no replay risk to guard against.
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  pubkey     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind       INTEGER NOT NULL,
  tags       TEXT NOT NULL,
  content    TEXT NOT NULL,
  sig        TEXT NOT NULL,
  expiration INTEGER
);

CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created
  ON events (pubkey, kind, created_at DESC);

CREATE TABLE IF NOT EXISTS event_tags (
  tag_name   TEXT NOT NULL,
  tag_value  TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_tags_lookup
  ON event_tags (tag_name, tag_value, created_at DESC);

-- TOFU ownership (CLAUDE.md "Ownership"). At most one row, ever. The
-- claim handler is the only writer and refuses if a row already exists
-- -- see ownership.ts. A one-time write; not part of the per-event
-- budget in the comment above. name/picture cache the owner's kind-0
-- profile as resolved at claim time (ROADMAP.md chunk 5), backing the
-- NIP-11 document's name/icon instead of a deploy-time var -- null when
-- the claim-time lookup found nothing.
-- profile_synced_at/icon_refreshed_at back the icon-refresh cron (see
-- ownership.ts refreshProfile): profile_synced_at is the created_at of
-- the locally-stored kind-0 event name/picture were last derived from
-- (so a re-run can tell "is there a newer one" without re-parsing
-- content every tick); icon_refreshed_at gates the refresh to at most
-- once/day regardless of how often the hourly cron fires.
CREATE TABLE IF NOT EXISTS owner (
  pubkey             TEXT NOT NULL,
  name               TEXT,
  picture            TEXT,
  profile_synced_at  INTEGER,
  icon_refreshed_at  INTEGER
);

-- ALLOW_FOLLOWS cache (CLAUDE.md "Configuration"): the owner's own
-- kind-3 follow list, re-derived on a cron schedule rather than per
-- event -- see ownership.ts refreshFollows(). Replaced wholesale on
-- each refresh, so no index beyond the primary key is needed.
CREATE TABLE IF NOT EXISTS follows (
  pubkey     TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS deleted_ids (
  id TEXT PRIMARY KEY
);

-- This deployment's own host (see src/host.ts) -- recorded from inbound
-- request traffic, not known at deploy time. Single row, like
-- backfill_meta below.
CREATE TABLE IF NOT EXISTS relay_meta (
  host TEXT
);

-- One-shot backfill (ROADMAP.md chunk 7): one row per relay pulled from
-- the owner's kind-10002 relay list, tracking how far back this relay has
-- already fetched. until_cursor walks backward in time as pages are
-- ingested (backfill.ts); exhausted is set once a relay returns a page
-- that is both empty AND terminated by a real EOSE -- a short-but-nonempty
-- page (the relay's own per-REQ cap) or a page cut off by a fetch timeout
-- or connection error must never set this, since neither means "no more
-- history" (see backfill.ts applyBackfillPage). Persisted rather than kept
-- in memory specifically so an hourly cron tick can resume a backfill that
-- spans days -- see CLAUDE.md "The budget" on why a large history may
-- genuinely take more than one day against the rows-written ceiling.
CREATE TABLE IF NOT EXISTS backfill_relays (
  relay_url    TEXT PRIMARY KEY,
  until_cursor INTEGER NOT NULL,
  exhausted    INTEGER NOT NULL DEFAULT 0
);

-- Single-row backfill status (backfill.ts getBackfillStatus/seedBackfillRelays).
-- 'pending' until the owner's relay list has been discovered, 'running'
-- while any backfill_relays row is unexhausted, 'paused-budget' when a
-- cron tick's ingest hit the daily rows-written ceiling and stopped
-- without finishing its page, 'done' once every relay is exhausted.
-- exhaust_reset_applied guards the one-time exhaustion-flag reset
-- (backfill.ts resetWronglyExhaustedRelays) needed to undo the effect of
-- the short-page exhaustion bug on relays already flagged before the fix
-- -- 0 until that reset has run once, then permanently 1.
CREATE TABLE IF NOT EXISTS backfill_meta (
  status                  TEXT NOT NULL DEFAULT 'pending',
  total_stored            INTEGER NOT NULL DEFAULT 0,
  last_run_at             INTEGER,
  exhaust_reset_applied   INTEGER NOT NULL DEFAULT 0
);
`;

export function initSchema(sql: SqlStorage): void {
  sql.exec(SCHEMA);
  // NIP-51 mute list support was removed (see docs/budget.md); this drops
  // the now-orphaned table on deployed relays that still carry it from
  // before the removal. Idempotent and a no-op on a fresh database.
  sql.exec(`DROP TABLE IF EXISTS mutes`);
  // exhaust_reset_applied was added after backfill_meta first shipped, so
  // an existing deployment's table predates it -- CREATE TABLE IF NOT
  // EXISTS above is a no-op there. SQLite has no "ADD COLUMN IF NOT
  // EXISTS", so check pragma_table_info first; existing rows get the
  // column's DEFAULT 0, same as a fresh deployment.
  const hasResetMarker =
    sql
      .exec(`SELECT 1 FROM pragma_table_info('backfill_meta') WHERE name = 'exhaust_reset_applied'`)
      .toArray().length > 0;
  if (!hasResetMarker) {
    sql.exec(`ALTER TABLE backfill_meta ADD COLUMN exhaust_reset_applied INTEGER NOT NULL DEFAULT 0`);
  }
  // backfill_meta must have exactly one row to hold status -- seeded here
  // rather than by whichever code path happens to run first, so every
  // reader (getBackfillStatus, /api/stats) can assume it exists.
  sql.exec(`INSERT INTO backfill_meta (status) SELECT 'pending' WHERE NOT EXISTS (SELECT 1 FROM backfill_meta)`);
  // relay_meta must have exactly one row, like backfill_meta above, so
  // getOwnHost/recordHost (src/host.ts) never have to special-case "no
  // row yet".
  sql.exec(`INSERT INTO relay_meta (host) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM relay_meta)`);
}
