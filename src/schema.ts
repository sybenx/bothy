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

// ---------------------------------------------------------------------
// The schema is declared here, once, as data -- not as a CREATE TABLE
// string with a hand-written ALTER TABLE bolted on beside it for each
// column somebody remembered to migrate.
//
// The old arrangement failed exactly the way it was always going to.
// `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists,
// so adding a column to one of those statements does nothing whatsoever
// to a deployed relay; it only affects databases created afterwards. Four
// columns got a matching ALTER TABLE. Two -- owner.profile_synced_at and
// owner.icon_refreshed_at (added in bc36cbf) -- did not, and every relay
// claimed before that commit threw `no such column: profile_synced_at` on
// every single cron tick from then on. It was invisible for weeks: the
// Worker's fault isolation caught it, and no test could see it because
// tests always start from an empty database, where CREATE TABLE writes
// every column and there is nothing to migrate.
//
// So the declaration below IS the schema. Both the CREATE TABLE for a
// fresh database and the ADD COLUMN for an existing one are generated
// from it, which means a new column cannot skip its own migration -- there
// is no second place to forget to update. Adding a column is a one-line
// edit to a TABLES entry.
// ---------------------------------------------------------------------

export interface ColumnSpec {
  readonly name: string;
  // Everything that follows the column name in CREATE TABLE, used
  // verbatim in ALTER TABLE ADD COLUMN as well. Keeping one string for
  // both is what makes the two paths incapable of disagreeing.
  readonly definition: string;
}

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
}

function col(name: string, definition: string): ColumnSpec {
  return { name, definition };
}

export const TABLES: readonly TableSpec[] = [
  {
    name: "events",
    columns: [
      col("id", "TEXT PRIMARY KEY"),
      col("pubkey", "TEXT NOT NULL"),
      col("created_at", "INTEGER NOT NULL"),
      col("kind", "INTEGER NOT NULL"),
      col("tags", "TEXT NOT NULL"),
      col("content", "TEXT NOT NULL"),
      col("sig", "TEXT NOT NULL"),
      col("expiration", "INTEGER"),
      // `ingested_at` is the wall-clock second this relay wrote the row,
      // which is a different thing from `created_at`, the second the
      // author says they signed it. The distinction is the whole reason
      // the column exists. storage.ts estimateRowsWritten24h originally
      // derived "rows written in the last 24h" from `created_at`, which
      // silently measured something else: rows attributable to events
      // *timestamped* in the last 24h. A backfilled event carries its
      // original timestamp, often years old, so every row backfill wrote
      // was invisible to that estimate -- it reported 729 rows for a
      // period Cloudflare measured at 33,000. That is bad on the admin
      // page and worse in backfill.ts hasBackfillHeadroom, which uses the
      // same number to decide whether backfill may write at all: the guard
      // protecting the daily write budget from backfill could not see
      // backfill's own writes.
      //
      // Nullable on purpose. Rows written before this column existed get
      // NULL, and NULL never satisfies `> cutoff`, so the estimate
      // undercounts for at most the one 24h window straddling an upgrade
      // and is exact thereafter. Deliberately not backfilled from
      // `created_at`, which would reintroduce the very conflation the
      // column exists to end.
      col("ingested_at", "INTEGER"),
    ],
  },
  {
    name: "event_tags",
    columns: [
      col("tag_name", "TEXT NOT NULL"),
      col("tag_value", "TEXT NOT NULL"),
      col("event_id", "TEXT NOT NULL"),
      col("created_at", "INTEGER NOT NULL"),
    ],
  },
  {
    // TOFU ownership (CLAUDE.md "Ownership"). At most one row, ever. The
    // claim handler is the only writer and refuses if a row already
    // exists -- see ownership.ts. A one-time write; not part of the
    // per-event budget in the comment above.
    name: "owner",
    columns: [
      col("pubkey", "TEXT NOT NULL"),
      // name/picture/about cache the owner's kind-0 profile as resolved
      // at claim time (ROADMAP.md chunk 5), backing the NIP-11
      // document's name/description/icon instead of a deploy-time var --
      // null when the claim-time lookup found nothing. See nip11.ts
      // resolveName/resolveDescription/resolveIcon.
      col("name", "TEXT"),
      col("picture", "TEXT"),
      col("about", "TEXT"),
      // profile_synced_at/icon_refreshed_at back the icon-refresh cron
      // (ownership.ts refreshProfile): profile_synced_at is the
      // created_at of the locally-stored kind-0 the cached fields were
      // last derived from, so a re-run can tell "is there a newer one"
      // without re-parsing content every tick; icon_refreshed_at gates
      // the refresh to at most once/day regardless of how often the
      // hourly cron fires.
      //
      // These two are why this file is now written the way it is. They
      // were added to the CREATE TABLE with no migration beside them, so
      // every relay claimed earlier had an owner table without them and
      // refreshProfile's SELECT threw on every cron tick -- taking
      // resetWronglyExhaustedRelays, which runs after it, down with it.
      col("profile_synced_at", "INTEGER"),
      col("icon_refreshed_at", "INTEGER"),
    ],
  },
  {
    // ALLOW_FOLLOWS cache (CLAUDE.md "Configuration"): the owner's own
    // kind-3 follow list, re-derived on a cron schedule rather than per
    // event -- see ownership.ts refreshFollows(). Replaced wholesale on
    // each refresh, so no index beyond the primary key is needed.
    name: "follows",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("fetched_at", "INTEGER NOT NULL")],
  },
  {
    name: "deleted_ids",
    columns: [col("id", "TEXT PRIMARY KEY")],
  },
  {
    // This deployment's own host (see src/host.ts) -- recorded from
    // inbound request traffic, not known at deploy time. Single row, like
    // backfill_meta below.
    name: "relay_meta",
    columns: [col("host", "TEXT")],
  },
  {
    // One-shot backfill (ROADMAP.md chunk 7): one row per relay pulled
    // from the owner's kind-10002 relay list, tracking how far back this
    // relay has already fetched. Persisted rather than kept in memory
    // specifically so an hourly cron tick can resume a backfill that
    // spans days -- see CLAUDE.md "The budget" on why a large history may
    // genuinely take more than one day against the rows-written ceiling.
    name: "backfill_relays",
    columns: [
      col("relay_url", "TEXT PRIMARY KEY"),
      // Walks backward in time as pages are ingested (backfill.ts).
      col("until_cursor", "INTEGER NOT NULL"),
      // Set once a relay returns a page that is both empty AND terminated
      // by a real EOSE. A short-but-nonempty page (the relay's own
      // per-REQ cap), a page cut off by a fetch timeout or connection
      // error, and a refusal must never set this, since none of them mean
      // "no more history" -- see backfill.ts applyBackfillPage.
      col("exhausted", "INTEGER NOT NULL DEFAULT 0"),
      // Whatever a relay said instead of history: the CLOSED, NOTICE or
      // AUTH frames backfill-worker.ts fetchPage used to discard. Set
      // only when a page comes back with no events, and cleared the
      // moment one arrives, so it always describes the current reason a
      // relay is producing nothing. Without it an empty page is
      // ambiguous -- a relay that answered "auth-required" and a relay
      // that answered nothing at all are the same row -- and that
      // ambiguity is what makes a stalled backfill undiagnosable from
      // the outside.
      col("last_refusal", "TEXT"),
    ],
  },
  {
    // Single-row backfill status (backfill.ts
    // getBackfillStatus/seedBackfillRelays).
    name: "backfill_meta",
    columns: [
      // 'pending' until the owner's relay list has been discovered,
      // 'running' while any backfill_relays row is unexhausted,
      // 'paused-budget' when a cron tick's ingest hit the daily
      // rows-written ceiling and stopped without finishing its page,
      // 'done' once every relay is exhausted.
      col("status", "TEXT NOT NULL DEFAULT 'pending'"),
      col("total_stored", "INTEGER NOT NULL DEFAULT 0"),
      col("last_run_at", "INTEGER"),
      // Guards the one-time exhaustion-flag reset (backfill.ts
      // resetWronglyExhaustedRelays) needed to undo the effect of the
      // short-page exhaustion bug on relays already flagged before the
      // fix -- 0 until that reset has run once, then permanently 1.
      col("exhaust_reset_applied", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // NIP-86 banevent/allowevent/listbannedevents (src/nip86.ts).
    // Distinct from deleted_ids on purpose, and the two must never be
    // conflated: deleted_ids is the union of every id this relay refuses
    // to store again, and NIP-09 deletions and NIP-62 vanish requests put
    // ids there too. This table holds only the ids an operator banned
    // through the management API, plus the reason they gave, so
    // listbannedevents can answer "what did I ban" instead of "what has
    // ever been deleted here." banevent writes both (the ban is what the
    // operator sees; the tombstone is what actually stops a re-send or a
    // backfill replay from restoring the event); allowevent clears both.
    name: "banned_events",
    columns: [col("id", "TEXT PRIMARY KEY"), col("reason", "TEXT"), col("banned_at", "INTEGER NOT NULL")],
  },
  {
    // NIP-86 blockip/unblockip/listblockedips (src/nip86.ts). Read
    // exactly once per WebSocket connection, in Relay.fetch() -- never
    // per message and never per event, so this table adds nothing to the
    // per-event write or read cost accounted for at the top of this file.
    // It deliberately does NOT gate the management endpoint: see the
    // connection-time check in src/relay.ts and the rule in src/nip86.ts
    // blockip.
    name: "blocked_ips",
    columns: [col("ip", "TEXT PRIMARY KEY"), col("reason", "TEXT"), col("blocked_at", "INTEGER NOT NULL")],
  },
  {
    // NIP-86 changerelayname/changerelaydescription/changerelayicon
    // (src/nip86.ts). One row per set key ('name', 'description',
    // 'icon'); clearing a value deletes the row rather than storing an
    // empty string, so "unset" and "set to empty" can never be confused
    // by the resolution chain in nip11.ts. Written only by the management
    // API, at operator pace -- not part of any per-event budget.
    name: "relay_settings",
    columns: [col("key", "TEXT PRIMARY KEY"), col("value", "TEXT NOT NULL")],
  },
  {
    // NIP-86 banpubkey/unbanpubkey/listbannedpubkeys (src/nip86.ts,
    // "phase two" -- docs/budget.md). Unlike banned_events, this table IS
    // read on the per-event write path: ownership.ts isAllowedWriter
    // checks it for every non-owner write, before the follows lookup, so
    // a banned pubkey is refused even if it also appears in the owner's
    // follow list. That +1 indexed read per non-owner write is exactly
    // the cost phase one deferred this feature to avoid paying without a
    // measured baseline first.
    name: "banned_pubkeys",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("reason", "TEXT"), col("banned_at", "INTEGER NOT NULL")],
  },
  {
    // NIP-86 allowpubkey/unallowpubkey/listallowedpubkeys (src/nip86.ts).
    // A manual allowlist, distinct from both banned_pubkeys and the
    // ALLOW_FOLLOWS-derived `follows` table: it grants write access to a
    // specific pubkey the owner does not follow (or, with follows
    // disabled entirely, to anyone the owner names individually).
    // ownership.ts isAllowedWriter only consults this table on the path
    // already about to reject a write, so it costs nothing on the common
    // accept path (owner, or an existing follow).
    name: "allowed_pubkeys",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("reason", "TEXT"), col("allowed_at", "INTEGER NOT NULL")],
  },
];

// Exactly two secondary indexes, and adding a third multiplies the
// per-event write cost -- see the accounting at the top of this file
// before touching these. Not part of the column reconciliation: an index
// is created by CREATE INDEX IF NOT EXISTS, which unlike CREATE TABLE
// really does act on an existing table.
const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_events_pubkey_kind_created ON events (pubkey, kind, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_event_tags_lookup ON event_tags (tag_name, tag_value, created_at DESC)`,
];

function createTableSql(spec: TableSpec): string {
  const columns = spec.columns.map((c) => `${c.name} ${c.definition}`).join(", ");
  return `CREATE TABLE IF NOT EXISTS ${spec.name} (${columns})`;
}

// SQLite's ALTER TABLE ADD COLUMN cannot add every column a CREATE TABLE
// can declare (sqlite.org/lang_altertable.html): no PRIMARY KEY, no
// UNIQUE, no NOT NULL without a non-null constant default, no
// non-constant default, no generated STORED column.
//
// Returns why a column cannot be added, or null if it can. Only consulted
// for columns that are actually missing -- a PRIMARY KEY declared on a
// fresh database is created by CREATE TABLE and never reaches this path.
function whyNotAddable(c: ColumnSpec): string | null {
  const d = c.definition.toUpperCase();
  if (/\bPRIMARY\s+KEY\b/.test(d)) return "a PRIMARY KEY cannot be added to an existing table";
  if (/\bUNIQUE\b/.test(d)) return "a UNIQUE column cannot be added to an existing table";
  if (/\bREFERENCES\b/.test(d)) return "a foreign key column cannot be added to an existing table";
  if (/\bGENERATED\b/.test(d) && /\bSTORED\b/.test(d)) return "a generated STORED column cannot be added";
  if (/\bNOT\s+NULL\b/.test(d)) {
    if (!/\bDEFAULT\b/.test(d)) return "NOT NULL requires a DEFAULT to be added to an existing table";
    if (/\bDEFAULT\s+NULL\b/.test(d)) return "NOT NULL with DEFAULT NULL is not a usable default";
  }
  if (/\bDEFAULT\s+(CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP|\()/.test(d)) {
    return "only a constant DEFAULT can be added to an existing table";
  }
  return null;
}

// Brings one existing table up to its declaration by adding whatever
// columns are missing, and returns their names. Existing rows keep their
// data and receive the column's DEFAULT (or NULL), exactly as they would
// have on a fresh database.
//
// A missing column that SQLite cannot add throws rather than being
// skipped. That is deliberate and the whole point: silently continuing is
// what turned a missing column into weeks of failing cron ticks. This
// runs in the Durable Object constructor, so throwing here takes the
// object down loudly and immediately instead of leaving it half-migrated
// and failing somewhere unrelated.
export function reconcileColumns(sql: SqlStorage, spec: TableSpec): string[] {
  const present = new Set(
    sql
      .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, spec.name)
      .toArray()
      .map((r) => r.name),
  );
  // No rows means the table does not exist; createTableSql already ran
  // and declared every column, so there is nothing to reconcile.
  if (present.size === 0) return [];

  const added: string[] = [];
  for (const column of spec.columns) {
    if (present.has(column.name)) continue;
    const refusal = whyNotAddable(column);
    if (refusal !== null) {
      throw new Error(
        `schema: cannot add ${spec.name}.${column.name} (${column.definition}) to an existing database: ` +
          `${refusal}. Additive, defaultable columns are the only shape this reconciler supports; ` +
          `anything else needs a deliberate table rebuild.`,
      );
    }
    sql.exec(`ALTER TABLE ${spec.name} ADD COLUMN ${column.name} ${column.definition}`);
    added.push(column.name);
  }
  return added;
}

export function initSchema(sql: SqlStorage): void {
  for (const spec of TABLES) {
    // Creates the table with every declared column on a fresh database,
    // and is a no-op on an existing one -- which is exactly why the
    // reconcile pass below has to exist.
    sql.exec(createTableSql(spec));
    reconcileColumns(sql, spec);
  }
  for (const index of INDEXES) {
    sql.exec(index);
  }
  // NIP-51 mute list support was removed (see docs/budget.md); this drops
  // the now-orphaned table on deployed relays that still carry it from
  // before the removal. Idempotent and a no-op on a fresh database.
  sql.exec(`DROP TABLE IF EXISTS mutes`);
  // backfill_meta must have exactly one row to hold status -- seeded here
  // rather than by whichever code path happens to run first, so every
  // reader (getBackfillStatus, /api/stats) can assume it exists.
  sql.exec(`INSERT INTO backfill_meta (status) SELECT 'pending' WHERE NOT EXISTS (SELECT 1 FROM backfill_meta)`);
  // relay_meta must have exactly one row, like backfill_meta above, so
  // getOwnHost/recordHost (src/host.ts) never have to special-case "no
  // row yet".
  sql.exec(`INSERT INTO relay_meta (host) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM relay_meta)`);
}
