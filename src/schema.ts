// Per-event write cost against the Workers Free plan's 100,000
// rows-written/day ceiling — see CLAUDE.md "The budget". Rows written is
// the binding constraint, not storage or requests, so this is the number
// that decides how much headroom a single owner actually has.
//
//   events insert:                    1 base row + 1 for the composite
//                                      index below (pubkey/kind/created_at
//                                      are all written columns)          = 2
//   event_tags insert, per tag row:   1 base row + 1 for its index       = 2
//
//   => 2 + 2 * (single-letter tag count) rows per stored event.
//      A bare note costs 2 rows; a reply carrying #e and #p costs 6.
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
`;

export function initSchema(sql: SqlStorage): void {
  sql.exec(SCHEMA);
}
