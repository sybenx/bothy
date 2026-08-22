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
CREATE TABLE IF NOT EXISTS owner (
  pubkey  TEXT NOT NULL,
  name    TEXT,
  picture TEXT
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
`;

export function initSchema(sql: SqlStorage): void {
  sql.exec(SCHEMA);
}
