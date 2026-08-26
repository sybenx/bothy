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
// `ingested_at` is the wall-clock second this relay wrote the row, which
// is a different thing from `created_at`, the second the author says they
// signed it. The distinction is the whole reason the column exists.
// storage.ts estimateRowsWritten24h originally derived "rows written in
// the last 24h" from `created_at`, which silently measured something
// else: rows attributable to events *timestamped* in the last 24h. A
// backfilled event carries its original timestamp, often years old, so
// every row backfill wrote was invisible to that estimate -- it reported
// 729 rows for a period Cloudflare measured at 33,000. That is bad on the
// admin page and worse in backfill.ts hasBackfillHeadroom, which uses the
// same number to decide whether backfill may write at all: the guard
// protecting the daily write budget from backfill could not see
// backfill's own writes.
//
// A column, not a counter table. docs/budget.md rejected a write-counter
// row on the grounds that "a counter incremented on every stored event
// would itself cost a row write per event, which directly fights the
// thing the stats endpoint exists to make visible," and that reasoning
// still holds. A column added to an INSERT this code already performs
// costs zero additional rows written: a row write is a row, not a
// column, and no index covers `ingested_at` (adding one would cost the
// per-event row this approach exists to avoid). The per-event cost
// stated above is unchanged.
//
// Existing deployments get NULL for rows written before the migration
// below ran, and NULL never satisfies `> cutoff`. That undercounts for at
// most the one 24h window straddling the upgrade, and then is exactly
// right forever after. Deliberately not backfilled from `created_at`,
// which would reintroduce the very conflation this column exists to end.
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
  id          TEXT PRIMARY KEY,
  pubkey      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  kind        INTEGER NOT NULL,
  tags        TEXT NOT NULL,
  content     TEXT NOT NULL,
  sig         TEXT NOT NULL,
  expiration  INTEGER,
  ingested_at INTEGER
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
-- the locally-stored kind-0 event name/picture/about were last derived
-- from (so a re-run can tell "is there a newer one" without re-parsing
-- content every tick); icon_refreshed_at gates the refresh to at most
-- once/day regardless of how often the hourly cron fires.
-- about is the kind-0 field backing the NIP-11 description's kind-0
-- rung, the same way name/picture back name/icon -- see nip11.ts
-- resolveDescription.
CREATE TABLE IF NOT EXISTS owner (
  pubkey             TEXT NOT NULL,
  name               TEXT,
  picture            TEXT,
  about              TEXT,
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
-- last_refusal holds whatever a relay said instead of history: the CLOSED,
-- NOTICE or AUTH frames backfill-worker.ts fetchPage used to discard. Set
-- only when a page comes back with no events, and cleared the moment one
-- arrives, so it always describes the current reason a relay is producing
-- nothing. Without it an empty page is ambiguous -- a relay that answered
-- "auth-required" and a relay that answered nothing at all are the same
-- row -- and that ambiguity is what makes a stalled backfill undiagnosable
-- from the outside.
CREATE TABLE IF NOT EXISTS backfill_relays (
  relay_url    TEXT PRIMARY KEY,
  until_cursor INTEGER NOT NULL,
  exhausted    INTEGER NOT NULL DEFAULT 0,
  last_refusal TEXT
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

-- NIP-86 banevent/allowevent/listbannedevents (src/nip86.ts). Distinct
-- from deleted_ids on purpose, and the two must never be conflated:
-- deleted_ids is the union of every id this relay refuses to store
-- again, and NIP-09 deletions and NIP-62 vanish requests put ids there
-- too. This table holds only the ids an operator banned through the
-- management API, plus the reason they gave, so listbannedevents can
-- answer "what did I ban" instead of "what has ever been deleted here."
-- banevent writes both (the ban is what the operator sees; the tombstone
-- is what actually stops a re-send or a backfill replay from restoring
-- the event); allowevent clears both.
CREATE TABLE IF NOT EXISTS banned_events (
  id        TEXT PRIMARY KEY,
  reason    TEXT,
  banned_at INTEGER NOT NULL
);

-- NIP-86 blockip/unblockip/listblockedips (src/nip86.ts). Read exactly
-- once per WebSocket connection, in Relay.fetch() -- never per message
-- and never per event, so this table adds nothing to the per-event write
-- or read cost accounted for at the top of this file. It deliberately
-- does NOT gate the management endpoint: see the connection-time check in
-- src/relay.ts and the rule in src/nip86.ts blockip.
CREATE TABLE IF NOT EXISTS blocked_ips (
  ip         TEXT PRIMARY KEY,
  reason     TEXT,
  blocked_at INTEGER NOT NULL
);

-- NIP-86 changerelayname/changerelaydescription/changerelayicon
-- (src/nip86.ts). One row per set key ('name', 'description', 'icon');
-- clearing a value deletes the row rather than storing an empty string,
-- so "unset" and "set to empty" can never be confused by the resolution
-- chain in nip11.ts. Written only by the management API, at operator
-- pace -- not part of any per-event budget.
CREATE TABLE IF NOT EXISTS relay_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
  // `backfill_relays.last_refusal` was added in v0.3.2, after fetchPage
  // stopped discarding the frames a relay uses to refuse a request. Same
  // pragma_table_info shape as the other column migrations here.
  const hasRefusal =
    sql.exec(`SELECT 1 FROM pragma_table_info('backfill_relays') WHERE name = 'last_refusal'`).toArray()
      .length > 0;
  if (!hasRefusal) {
    sql.exec(`ALTER TABLE backfill_relays ADD COLUMN last_refusal TEXT`);
  }
  // `events.ingested_at` was added in v0.3.1; an events table created
  // before that predates the column and CREATE TABLE IF NOT EXISTS above
  // is a no-op on it. Left NULL for existing rows on purpose -- see the
  // column's comment above.
  const hasIngestedAt =
    sql.exec(`SELECT 1 FROM pragma_table_info('events') WHERE name = 'ingested_at'`).toArray().length > 0;
  if (!hasIngestedAt) {
    sql.exec(`ALTER TABLE events ADD COLUMN ingested_at INTEGER`);
  }
  // `owner.about` was added when NIP-86 gave the relay description a
  // kind-0 rung (nip11.ts resolveDescription); an owner table created
  // before that predates the column and CREATE TABLE IF NOT EXISTS above
  // is a no-op on it. Same pragma_table_info shape as the backfill_meta
  // column check above -- SQLite has no "ADD COLUMN IF NOT EXISTS".
  const hasAbout =
    sql.exec(`SELECT 1 FROM pragma_table_info('owner') WHERE name = 'about'`).toArray().length > 0;
  if (!hasAbout) {
    sql.exec(`ALTER TABLE owner ADD COLUMN about TEXT`);
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
