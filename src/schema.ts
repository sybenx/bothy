import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Per-event write cost against the Workers Free plan's 100,000
// rows-written/day ceiling — see CLAUDE.md "The budget". Rows written is
// the binding constraint, not storage or requests, so this is the number
// that decides how much headroom a single owner actually has.
//
// Measured via SqlStorageCursor.rowsWritten (test/hibernation.test.ts)
// rather than estimated, since `id TEXT PRIMARY KEY` isn't a rowid alias
// and costs its own implicit unique index on top of the declared ones:
//
//   events insert:                    1 base row + 1 implicit PK index
//                                      (TEXT primary key, not a rowid
//                                      alias) + 1 per declared index on
//                                      `events` (4 of them)             = 6
//   event_tags insert, per tag row:   1 base row + 1 per index on that
//                                      table (2 of them)                = 3
//
//   => 6 + 3 * (single-letter tag count) rows per stored event.
//      A bare note costs 6 rows; a reply carrying #e and #p costs 12;
//      a real note carrying about five tags costs 21.
//      NIP-09 deletes and replaceable-event replacement cost the same
//      shape again (a delete is a write too) plus this insert cost.
//
// eventRowCost() below computes exactly that from INDEXES, and
// test/hibernation.test.ts asserts the computed figure against a real
// SqlStorageCursor.rowsWritten. Neither number is written down twice.
//
// FOUR indexes exist on `events`, and the third row of the arithmetic
// above is what they cost. Two of them were added in v0.7.2 after the
// relay went down on rows READ, not rows written; the fourth,
// idx_events_ingested, was added in v0.7.6 for the same reason -- see
// CLAUDE.md "The budget".
//
// This comment twice rejected an index on (kind, created_at), on the
// grounds that the read-abuse guard rejected any filter lacking both
// `authors` and `kinds`, so every accepted query filtered by pubkey.
// Both halves were wrong. `isUnconstrainedFilter` accepted
// `authors` OR `kinds`, not both, so a kinds-only filter was always
// admissible; and filtering by pubkey buys nothing on a single-owner
// relay, where every row shares one pubkey. The reasoning was never
// re-checked against a measurement because the read cost was
// hypothetical. It stopped being hypothetical when the relay consumed
// its entire 5,000,000 rows-read/day allowance with no attacker
// involved.
//
// Measured, at E=2,000 rows in `events` (test/read-cost.test.ts):
//
//   {"kinds":[1],"limit":20}            3,940 rows -> 41
//   {"authors":[owner],"limit":20}      3,600 rows -> 41
//
// The trade is stated plainly: two more rows written per stored event,
// against two filter shapes that each read the whole table however small
// their `limit`. At the live relay's ~2,900 events/day that is ~5,800
// extra rows written against a 100,000/day ceiling metered at ~38,000 --
// versus 125 REQs being enough to clear the entire read ceiling.
//
// Every index below is declared once, as data, and the per-event write
// cost is DERIVED from that declaration by eventRowCost() rather than
// restated as a constant beside it. Adding a fourth index therefore
// updates the accounting automatically -- which matters because this
// project has already shipped rows-written accounting that was wrong by
// a factor of 45 (see `ingested_at` below).
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
// A column, not a counter table. A counter row incremented on every
// stored event would itself cost a row write per event, which directly
// fights the thing the stats endpoint exists to make visible -- the
// measurement would consume the budget it reports on. A column added to an INSERT this code already performs
// costs zero additional rows written: a row write is a row, not a
// column.
//
// `ingested_at` IS indexed, as of v0.7.6, and that decision is the one
// this comment used to argue the other way. The argument was that an
// index here would cost a row write per event, which is true, and that
// the cost bought nothing the column had not already bought, which was
// not. Without it, estimateRowsWritten24h read every row in `events` to
// answer a question about the rows in a 24h window: a cost that scales
// with the accumulated table rather than with the day's traffic, paid
// twice per cron tick forever. idx_events_ingested is
// (ingested_at, row_cost) -- covering, so the SUM is answered from the
// index without touching the table at all -- and it turns that read from
// E into the size of the window. The price is one row per stored event:
// the per-event cost above goes 5 -> 6, about 1,100 rows/day at the live
// relay's ingest rate, against a 100,000/day ceiling. See
// CLAUDE.md "The budget".
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
// `deleted_ids` is a tombstone set, not part of the
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
  // Other columns in the same table to reset to NULL when THIS column is
  // newly added to an existing database via ALTER TABLE (never on a fresh
  // CREATE TABLE, where every column starts out consistent with each
  // other). Use this when this column caches a value derived from another
  // column's data via a "has the source changed since we last derived
  // this" guard -- adding the new column leaves that guard holding a
  // stale answer (the source hasn't changed) forever, since the guard has
  // no way to know a brand-new derived field never got its first parse.
  // Resetting the guard column forces exactly one re-derive on the next
  // pass. See owner.about below for the motivating case.
  readonly resetsOnAdd?: readonly string[];
}

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
}

function col(name: string, definition: string, resetsOnAdd?: readonly string[]): ColumnSpec {
  return resetsOnAdd ? { name, definition, resetsOnAdd } : { name, definition };
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
      //
      // That straddle window is not hypothetical: it is what the live
      // relay showed the day `row_cost` shipped, reporting 221 rows
      // written over a 24h period in which it had ingested 1,105 events.
      // Every one of those rows was real and none of the pre-upgrade ones
      // were countable. It corrected itself within a day, exactly as this
      // comment said it would, and the reason to record it here is that
      // the symptom is indistinguishable at a glance from the
      // created_at/ingested_at conflation this column exists to prevent.
      //
      // Indexed since v0.7.6 by idx_events_ingested, jointly with
      // `row_cost` -- see that index and the header comment above.
      col("ingested_at", "INTEGER"),
      // What this event's INSERT actually cost in rows written, stamped
      // at insert time by eventRowCost() -- base row, implicit PK index,
      // one row per declared index on `events`, plus TAG_ROW_COST for
      // each single-letter tag row.
      //
      // Stored rather than recomputed because recomputing it was the
      // single most expensive read in the codebase.
      // estimateRowsWritten24h used to derive it from a
      // `LEFT JOIN event_tags` and a per-row COUNT, and `event_tags` has
      // no index on `event_id` -- so SQLite built an automatic index over
      // the whole table on every call, reading E + T rows to answer a
      // question about the ten rows in the 24h window. Called twice per
      // cron tick, that one query was ~288E rows/day of the 5,000,000
      // ceiling all by itself, and at E ~= 17,400 it was the entire
      // ceiling with no client connected (CLAUDE.md "The budget"). Summing a
      // column reads E and touches `event_tags` not at all.
      //
      // Costs zero additional rows written as a column: this is one more
      // column on an INSERT that already happens, and a row write is a
      // row, not a column.
      //
      // It is carried in an index as of v0.7.6, but as the payload of
      // idx_events_ingested rather than as a key of its own -- the index
      // exists to bound the `ingested_at` scan, and including `row_cost`
      // makes it covering so the SUM never touches the table. Widening an
      // index costs no additional rows written; adding one does, and that
      // single row per event is charged to `ingested_at` above, where the
      // argument for paying it is made.
      //
      // Nullable, and NULL rows are simply absent from the SUM. Rows
      // written before this column existed undercount for at most the one
      // 24h window straddling an upgrade, then it is exact forever --
      // the same tradeoff `ingested_at` made, accepted for the same
      // reason. Deliberately not backfilled: the historical cost of a row
      // written under a two-index schema is not the cost it would carry
      // today, and inventing that number is how this project got
      // rows-written accounting wrong by 45x the first time.
      col("row_cost", "INTEGER"),
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
    // TOFU ownership (CLAUDE.md "What it is"). At most one row, ever. The
    // claim handler is the only writer and refuses if a row already
    // exists -- see ownership.ts. A one-time write; not part of the
    // per-event budget in the comment above.
    name: "owner",
    columns: [
      col("pubkey", "TEXT NOT NULL"),
      // name/picture/about cache the owner's kind-0 profile as resolved
      // at claim time, backing the NIP-11
      // document's name/description/icon instead of a deploy-time var --
      // null when the claim-time lookup found nothing. See nip11.ts
      // resolveName/resolveDescription/resolveIcon.
      col("name", "TEXT"),
      col("picture", "TEXT"),
      // `about` was added to this table after profile_synced_at already
      // existed on deployed relays, so it landed NULL with no newer kind-0
      // to trigger a re-parse -- ownership.ts refreshProfile's "is there a
      // newer kind-0 than profile_synced_at" guard had no way to know a
      // brand-new derived field never got its first parse, and the
      // description fell through to the hardcoded default forever.
      // resetsOnAdd forces exactly one re-parse on the next refreshProfile
      // by clearing the guard the moment this column is actually added to
      // an existing database.
      col("about", "TEXT", ["profile_synced_at"]),
      // Backs NIP-11's `contact` (nip11.ts resolveContact). Added after
      // profile_synced_at already existed on deployed relays, so it takes
      // the same resetsOnAdd treatment `about` documents above: without
      // it, refreshProfile's "is there a newer kind-0 than
      // profile_synced_at" guard would answer "no" forever and a
      // brand-new derived column would never get its first parse.
      col("website", "TEXT", ["profile_synced_at"]),
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
    // NIP-62 vanish requests that have not finished draining
    // (storage.ts beginVanish/drainVanish, relay.ts handleVanish and
    // runCron). One row per pubkey with a vanish in progress; the row is
    // deleted once nothing is left to remove.
    //
    // This table exists because a vanish is the one request whose size is
    // chosen by the sender and unbounded by anything this relay controls.
    // Deleting N events costs N tombstone inserts and N row deletions --
    // 8 rows written each as the cursor counts them, and paced against a
    // pessimistic 22 (see eventRemovalRowsWritten/eventRemovalBudget) -- so a
    // large vanish can exceed a single request's budget partway through.
    // Without a checkpoint it would then stop wherever the ceiling fell,
    // having deleted some of the pubkey's events and reported success,
    // which is a compliance failure rather than a performance problem:
    // NIP-62 says "fully delete", and a half-vanished pubkey is
    // indistinguishable from a finished one.
    //
    // `cutoff_created_at` is stored, not recomputed, because resumption
    // must use the ORIGINAL request's created_at. Re-deriving it later
    // would silently widen or narrow the set of events the requester
    // actually asked to remove.
    name: "vanishing",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("cutoff_created_at", "INTEGER NOT NULL"),
      col("requested_at", "INTEGER NOT NULL"),
      // Purely diagnostic: how many rows have been removed so far, so a
      // stalled drain is visible on /api/stats rather than inferred.
      col("deleted_so_far", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // This deployment's own host (see src/host.ts) -- recorded from
    // inbound request traffic, not known at deploy time. Single row, like
    // backfill_meta below.
    name: "relay_meta",
    columns: [col("host", "TEXT")],
  },
  {
    // One-shot backfill: one row per relay pulled
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
    // "phase two" -- CLAUDE.md "The budget"). Unlike banned_events, this table IS
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
  {
    // The expensive half of /api/stats, computed on a cron tick and read
    // back from here (storage.ts readStatsSnapshot/writeStatsSnapshot,
    // relay.ts collectStats). At most one row, replaced wholesale; no row
    // at all until the first computation, which is the correct state for
    // a relay that has never served a stats request or run a cron tick.
    //
    // A row, and this file has twice refused to put a cached number in
    // one -- rejecting a rows-written counter table, and rejecting it
    // again for read-metrics.ts's counters. The rule those refusals set
    // is not "never cache in storage", it is "never pay a row write PER
    // EVENT to measure something". This row is written on a cron tick,
    // gated by limits.ts STATS_SNAPSHOT_MAX_AGE_MS: 2 rows written per
    // refresh, four refreshes a day, 8 rows against a 100,000/day
    // ceiling. It is not on the per-event write path at all.
    //
    // What it replaces was in memory, and that is the whole point. The
    // 15-second in-memory cache it succeeds was measured on the live
    // relay never hitting: the Durable Object hibernates between admin
    // page visits, in-memory state does not survive eviction, and two
    // page loads therefore paid two full scans of `events` apiece. A
    // cache whose lifetime is shorter than the gap between the requests
    // it exists to serve is not a cache. Storage is the only state in
    // this object that outlives hibernation, so a cache that must span
    // page loads has to live here or nowhere.
    //
    // Every column is a count over `events` or `follows` costing O(E) or
    // O(F) rows read to produce -- that is the criterion for being in
    // here, not whether the number looks stale-tolerant. Fields that cost
    // nothing to read live (`sql.databaseSize`, the owner row, the tiny
    // backfill tables) are deliberately absent and stay live, so the page
    // keeps showing a current storage bar and current backfill progress.
    name: "stats_snapshot",
    columns: [
      // Wall-clock seconds when this row was computed. Read by
      // collectStats to decide whether to recompute, and reported on
      // /api/stats as `snapshotAt` so the admin page can say how old
      // these numbers are rather than presenting them as current.
      col("computed_at", "INTEGER NOT NULL"),
      col("total_events", "INTEGER NOT NULL"),
      col("events_24h", "INTEGER NOT NULL"),
      col("follow_count", "INTEGER NOT NULL"),
      col("follows_refreshed_at", "INTEGER"),
      // storage.ts largestNonOwnerAuthor, flattened. Both null when no
      // non-owner has written anything, which is the normal state.
      col("largest_author_pubkey", "TEXT"),
      col("largest_author_events", "INTEGER"),
    ],
  },
];

// ---------------------------------------------------------------------
// The index set, declared as data for the same reason TABLES is: two
// separate things read it, and neither may drift from what SQLite
// actually has.
//
// 1. initSchema creates them.
// 2. limits.ts filterReadCost asks "which of these serves this filter,
//    and what does its `limit` cost against that index" -- the read-abuse
//    guard is DERIVED from this list rather than hardcoding a list of
//    permitted filter field combinations. That is the whole fix: the
//    old guard reasoned about a filter's shape, this one reasons about
//    its cost, and adding or removing an index below changes which
//    filters are affordable without anyone editing the guard.
// 3. eventRowCost derives the per-event rows-written cost from the count.
//
// Each entry says which columns are pinned by equality and which single
// column the index then orders by. That split is not decoration -- it is
// exactly the property that decides cost. An index can serve
// `ORDER BY created_at DESC LIMIT n` cheaply only when every key column
// ahead of `created_at` is pinned to a single value; pin all of them and
// the rows arrive already sorted, so LIMIT stops the scan. Pin none, or
// pin only some, and SQLite must read every matching row and sort it
// before LIMIT can discard any -- which is why a `limit` of 20 and a
// `limit` of 500 cost the identical 2E rows on the shapes that broke
// this relay.
//
// Not part of the column reconciliation: an index is created by
// CREATE INDEX IF NOT EXISTS, which unlike CREATE TABLE really does act
// on an existing table, so a new entry here reaches a deployed relay on
// its next Durable Object constructor.
// ---------------------------------------------------------------------

export interface IndexSpec {
  readonly name: string;
  readonly table: string;
  // Columns that must ALL be pinned to a single value by a filter before
  // this index can serve an ordered scan. In index order.
  readonly keyColumns: readonly string[];
  // The column the index is then sorted by, matching buildFilterQuery's
  // `ORDER BY created_at DESC`. Declared DESC in the SQL below.
  //
  // Optional, because not every index exists to serve an ordered scan.
  // An index whose only job is to make an equality lookup cheap --
  // idx_event_tags_event below, which exists so a DELETE can find a
  // handful of rows without reading the table -- has nothing to sort by,
  // and giving it a fake ordering column would cost a wider index for
  // nothing. limits.ts filterReadCost only ever considers indexes on
  // `events`, so an unordered index is never mistaken for one that can
  // bound a REQ.
  readonly orderedBy?: string;
  // Extra columns appended to the index purely so a query can be answered
  // from the index without visiting the table. NOT key columns: nothing
  // may pin them, order by them, or seek on them, and limits.ts
  // filterReadCost must never treat them as something a filter can
  // satisfy -- which is exactly why they are a separate field rather than
  // more entries in `keyColumns`. Declaring them there would have been
  // one word shorter and would have told the read-abuse guard that a
  // filter pinning `row_cost` unlocks an index, which is meaningless.
  //
  // Widening an index this way costs no additional rows written -- a row
  // write is a row, not a column, the same accounting `ingested_at` and
  // `row_cost` are argued on above. The cost of an index is incurred by
  // its existence, not its width.
  readonly covering?: readonly string[];
}

export const INDEXES: readonly IndexSpec[] = [
  // Serves `authors` + `kinds` together -- the shape a well-behaved
  // client sends, and the only one that was ever cheap here.
  {
    name: "idx_events_pubkey_kind_created",
    table: "events",
    keyColumns: ["pubkey", "kind"],
    orderedBy: "created_at",
  },
  // Serves `kinds` with no `authors`. Added v0.7.2; see the measurement
  // at the top of this file. Also turns storage.ts giftWrapCount --
  // `SELECT COUNT(*) FROM events WHERE kind = ?`, run on every accepted
  // gift wrap -- from a full scan of `events` into an index count.
  {
    name: "idx_events_kind_created",
    table: "events",
    keyColumns: ["kind"],
    orderedBy: "created_at",
  },
  // Serves `authors` with no `kinds`. Added v0.7.2. On a single-owner
  // relay this is the shape that looks harmless and is not: every row in
  // the table carries the owner's pubkey, so `{"authors":[owner]}` is a
  // request for the whole table with a `limit` that bounds nothing.
  {
    name: "idx_events_pubkey_created",
    table: "events",
    keyColumns: ["pubkey"],
    orderedBy: "created_at",
  },
  // Serves `#<letter>` tag filters, through the subquery in
  // buildFilterQuery.
  {
    name: "idx_event_tags_lookup",
    table: "event_tags",
    keyColumns: ["tag_name", "tag_value"],
    orderedBy: "created_at",
  },
  // Serves `DELETE FROM event_tags WHERE event_id = ?` (storage.ts
  // deleteEventRow), which without it scans the whole table to remove a
  // handful of rows. No ordering column: this exists for an equality
  // seek, not for a sorted scan.
  //
  // This index was deferred twice on write cost and is the most
  // expensive one here -- a row per TAG row rather than per event, so
  // TAG_ROW_COST goes 2 -> 3 and a real five-tag note costs five more
  // rows to store. The reasoning that finally justified it is on
  // deleteEventRow in storage.ts, beside the query, and it is not a
  // budget argument: NIP-62 forbids gating the path that pays this cost,
  // so cost is the only control left.
  {
    name: "idx_event_tags_event",
    table: "event_tags",
    keyColumns: ["event_id"],
  },
  // Serves `WHERE ingested_at > ?` -- storage.ts estimateRowsWritten24h
  // and countIngested24h, the two queries that ask what this relay did in
  // the last 24 hours. Added v0.7.6.
  //
  // This is the second index in this file added because a query's cost
  // tracked the TABLE rather than the WINDOW it was asking about, and the
  // shape of the mistake was the same both times. `ingested_at` led no
  // index, so `SUM(row_cost) WHERE ingested_at > ?` scanned every row in
  // `events` to add up the handful ingested today -- 4,224 rows read
  // against 4,232 stored, measured live. backfill.ts hasBackfillHeadroom
  // calls it twice per cron tick, so on an hourly cron that was 48E rows
  // read per day with no client connected, reaching the 5,000,000 ceiling
  // at E ~= 104,000. That was the documented cron floor in
  // CLAUDE.md "The budget"; this index removes it, and what replaces it
  // scales with the day's ingest rather than with everything ever stored.
  //
  // `row_cost` is carried as a covering column, not a key. With it the
  // SUM is answered from the index alone; without it SQLite would seek
  // the range in the index and then fetch each row's `row_cost` from the
  // table, doubling the read for no saving in rows written.
  //
  // The price is one row written per stored event -- EVENT_BASE_ROW_COST
  // 5 -> 6, ~1,100 rows/day at the live relay's ingest rate against a
  // 100,000/day ceiling. That trade was refused twice in this file's
  // header on the grounds that the whole point of stamping `row_cost` in
  // a column was to avoid a per-event row. It buys something different
  // from what the column bought: the column removed the `event_tags`
  // join, taking the read from E + T to E, and no rewriting of the query
  // could take it below E while the scan was unindexed.
  //
  // No `orderedBy`. The query is a SUM over a range, not an ordered scan,
  // and `ingested_at` is not a filterable field -- limits.ts PINS maps
  // only `pubkey` and `kind` -- so filterReadCost can never mistake this
  // for an index that bounds a REQ.
  //
  // On an existing relay this index is built once, by the
  // CREATE INDEX IF NOT EXISTS in initSchema, on the first Durable Object
  // constructor after the upgrade: a one-time write of E rows, ~4,200 at
  // the live relay's size, against the 100,000/day ceiling. Every wake
  // from hibernation after that is a no-op. A relay large enough for that
  // one-time build to matter would have been long past the read ceiling
  // this index exists to keep it under.
  {
    name: "idx_events_ingested",
    table: "events",
    keyColumns: ["ingested_at"],
    covering: ["row_cost"],
  },
];

function createIndexSql(spec: IndexSpec): string {
  const columns = [
    ...spec.keyColumns,
    ...(spec.orderedBy === undefined ? [] : [`${spec.orderedBy} DESC`]),
    // Last, and unordered: these exist to be read off the index, not to
    // be seeked or sorted on, so their position after the ordering column
    // is what keeps them out of the part of the index that does the work.
    ...(spec.covering ?? []),
  ];
  return `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${columns.join(", ")})`;
}

// Indexes declared on one table. Exported because limits.ts needs the
// `events` set to decide what a filter costs.
export function indexesOn(table: string): readonly IndexSpec[] {
  return INDEXES.filter((i) => i.table === table);
}

// ---------------------------------------------------------------------
// Per-event rows-written cost, DERIVED from INDEXES above rather than
// written down as a constant beside it.
//
// Derived on purpose. The figure is used in three places -- the admin
// page's 24h estimate, backfill.ts's headroom guard, and limits.ts
// BACKFILL_PAGE_SIZE's sizing -- and the last time it was maintained by
// hand it was wrong by a factor of 45 and stayed wrong for months
// (see `ingested_at` above). Adding an index below now updates all
// three, and test/hibernation.test.ts checks the derivation against a
// real SqlStorageCursor.rowsWritten, so an SQLite change that made the
// arithmetic wrong would fail the suite rather than quietly mis-bill the
// budget.
// ---------------------------------------------------------------------

// One base row, plus the implicit unique index SQLite maintains for
// `id TEXT PRIMARY KEY` (a TEXT primary key is not a rowid alias, so it
// costs its own index), plus one row per declared index on `events`.
export const EVENT_BASE_ROW_COST = 2 + indexesOn("events").length;

// One base row per `event_tags` row, plus one per index on that table.
export const TAG_ROW_COST = 1 + indexesOn("event_tags").length;

// Rows written by storing one event carrying `indexedTagCount`
// single-letter tags. Stamped into `events.row_cost` at insert time
// (storage.ts insertEventRow) so estimateRowsWritten24h can sum a column
// instead of rebuilding this from a join.
export function eventRowCost(indexedTagCount: number): number {
  return EVENT_BASE_ROW_COST + TAG_ROW_COST * indexedTagCount;
}

// Rows written by tombstoning one id: the `deleted_ids` row, plus the
// implicit unique index behind its TEXT PRIMARY KEY (same shape as
// `events.id`), plus any index later declared on that table.
export const TOMBSTONE_ROW_COST = 2 + indexesOn("deleted_ids").length;

// ---------------------------------------------------------------------
// Removing one stored event, which costs two different numbers depending
// on what the number is for.
//
// The obvious assumption is that a delete costs what the insert cost:
// every row and index entry created has to come back out. It does not,
// and this was assumed here before it was measured. SqlStorageCursor
// counts index maintenance on INSERT but NOT on DELETE (measured on a
// two-tag event, workerd, 2026-08-26):
//
//   INSERT INTO events ...                 5   (1 row + PK index + 3 indexes)
//   INSERT INTO event_tags ... x2          3   each (1 row + 2 indexes)
//   DELETE FROM event_tags (2 rows)        2   <- 2, not 6
//   DELETE FROM events (1 row)             1   <- 1, not 5
//   INSERT OR IGNORE INTO deleted_ids      2
//
// So a removal reports one row per base row deleted, plus the tombstone.
// Both functions below are real; which one to use depends on whether you
// are reporting or budgeting.
// ---------------------------------------------------------------------

// What SqlStorageCursor actually reports for removing one event: the tag
// rows, the event row, and the tombstone. Asserted against a real cursor
// in test/hibernation.test.ts.
export function eventRemovalRowsWritten(indexedTagCount: number): number {
  return indexedTagCount + 1 + TOMBSTONE_ROW_COST;
}

// What the NIP-62 vanish drain is PACED against, and deliberately the
// pessimistic figure rather than the measured one.
//
// The asymmetry above is a property of Cloudflare's instrument, and the
// instrument is the only thing this project can see. Whether their
// BILLING also ignores index maintenance on DELETE is not something a
// cursor can answer. Pacing a budget guard against the smaller of two
// plausible numbers would mean that if the cursor under-reports, the
// drain quietly overruns its share -- the unsafe direction, and exactly
// the class of error that made estimateRowsWritten24h wrong by 45x.
//
// So the drain assumes a removal costs what the insertion cost, plus the
// tombstone. If the cursor is right, the drain simply runs at about a
// third of its allowance, which costs a vanish some days; if the cursor
// is under-reporting, the share still holds. That is the correct
// direction to be wrong in for a guard.
export function eventRemovalBudget(indexedTagCount: number): number {
  return eventRowCost(indexedTagCount) + TOMBSTONE_ROW_COST;
}

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
  // Collected rather than applied inline: a resetsOnAdd target may itself
  // be a column this same pass is about to add later in `spec.columns`
  // (owner.about resets profile_synced_at, which is declared after it),
  // and an UPDATE against a column that doesn't exist yet fails outright.
  const resets = new Set<string>();
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
    for (const resetColumn of column.resetsOnAdd ?? []) {
      resets.add(resetColumn);
    }
  }
  for (const resetColumn of resets) {
    sql.exec(`UPDATE ${spec.name} SET ${resetColumn} = NULL`);
  }
  return added;
}

// ---------------------------------------------------------------------
// initSchema runs in the Relay constructor, i.e. on every wake from
// hibernation, not once per deploy -- see relay.ts. Reconciling the full
// TABLES/INDEXES declaration on every one of those wakes measured at 55
// rows read live, ~94,000 rows/day at the relay's wake rate, to do
// nothing on the overwhelming majority of them: nobody deployed a schema
// change between this wake and the last one.
//
// So the reconcile pass only runs when the schema actually changed.
// `schemaHash` fingerprints the declaration; `schema_meta` stores the
// fingerprint the database was last reconciled to; a match short-circuits
// the whole pass down to the one row read that fetches it. Two properties
// make that short-circuit safe rather than a trap:
//
// 1. The hash is DERIVED from TABLES and INDEXES structurally --
//    `computeSchemaHash` walks every field `reconcileColumns` and
//    `createIndexSql` actually act on (column name, definition,
//    resetsOnAdd; index name, table, keyColumns, orderedBy, covering) --
//    not a hand-maintained version number, and not a hash of a hand-picked
//    subset. A hand-maintained number can be forgotten to bump; a
//    structural hash cannot, because it has no "forgot" state -- it is
//    just a function of the declaration. That is the same lesson TABLES
//    itself already teaches (see the header comment above): the owner
//    table went weeks with two columns missing because a hand-written
//    ALTER TABLE was the thing that had to be remembered, and half the
//    time it wasn't. A field this hash doesn't cover would be a field
//    whose change silently skips its own migration -- exactly that bug
//    again, one layer up.
// 2. The hash is stored only AFTER the reconcile below completes without
//    throwing -- see the end of this function. Storing it before, or
//    alongside, the ALTER TABLE/CREATE INDEX statements would mean a
//    migration that dies partway (reconcileColumns throws on an
//    un-addable column -- see whyNotAddable) leaves the NEW hash in
//    place with an OLD table shape underneath it: the next wake would see
//    a match, skip the reconcile it still needs, and the object would be
//    permanently stuck half-migrated. Writing the hash last means a
//    throw here leaves the PREVIOUS hash (or none) in storage, so the
//    next wake retries the whole pass -- safe because every statement in
//    it is idempotent (CREATE TABLE/INDEX IF NOT EXISTS,
//    reconcileColumns only touches columns it does not already find).
//
// The first wake after a deploy that changes the schema -- including the
// very first wake after upgrading to this hashing scheme itself, since no
// pre-existing database has a `schema_meta` row -- finds no match and
// pays the full reconcile. That is correct, not a regression to optimise
// away: it is the one wake that actually has work to do.
// ---------------------------------------------------------------------

// Deliberately not a TABLES entry, and not reconciled by reconcileColumns:
// this table has to exist and be readable BEFORE initSchema can decide
// whether TABLES itself needs reconciling, so it is created directly by
// ensureSchemaMetaTable below rather than through the declarative pass it
// exists to gate. Its own shape (one column, no migrations ever) is fixed
// deliberately so it never needs that pass either.
const SCHEMA_META_TABLE = "schema_meta";

// Structural fingerprint of a TABLES/INDEXES declaration. Exported (rather
// than closed over the module-level TABLES/INDEXES) so tests can hash two
// different declarations and assert they differ, instead of only being
// able to assert something about the one true schema.
export function computeSchemaHash(tables: readonly TableSpec[], indexes: readonly IndexSpec[]): string {
  const fingerprint = {
    tables: tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({
        name: c.name,
        definition: c.definition,
        resetsOnAdd: c.resetsOnAdd ?? [],
      })),
    })),
    indexes: indexes.map((i) => ({
      name: i.name,
      table: i.table,
      keyColumns: i.keyColumns,
      orderedBy: i.orderedBy ?? null,
      covering: i.covering ?? [],
    })),
  };
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(fingerprint))));
}

function currentSchemaHash(): string {
  return computeSchemaHash(TABLES, INDEXES);
}

function ensureSchemaMetaTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} (hash TEXT NOT NULL)`);
}

function readStoredSchemaHash(sql: SqlStorage): string | null {
  const row = sql.exec<{ hash: string }>(`SELECT hash FROM ${SCHEMA_META_TABLE} LIMIT 1`).toArray()[0];
  return row?.hash ?? null;
}

function writeSchemaHash(sql: SqlStorage, hash: string): void {
  sql.exec(`DELETE FROM ${SCHEMA_META_TABLE}`);
  sql.exec(`INSERT INTO ${SCHEMA_META_TABLE} (hash) VALUES (?)`, hash);
}

// TEST ONLY: discards the stored fingerprint so the next initSchema() call
// runs a full reconcile, as if this were the first wake after a deploy
// that changed the schema. Real code never calls this -- the hash is
// meant to persist across wakes, that being the entire point.
export function forgetSchemaHash(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${SCHEMA_META_TABLE}`);
}

export function initSchema(sql: SqlStorage): void {
  ensureSchemaMetaTable(sql);
  const hash = currentSchemaHash();
  if (readStoredSchemaHash(sql) === hash) return;

  for (const spec of TABLES) {
    // Creates the table with every declared column on a fresh database,
    // and is a no-op on an existing one -- which is exactly why the
    // reconcile pass below has to exist.
    sql.exec(createTableSql(spec));
    reconcileColumns(sql, spec);
  }
  for (const index of INDEXES) {
    sql.exec(createIndexSql(index));
  }
  // NIP-51 mute list support was removed (see CLAUDE.md "The budget"); this drops
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

  // Stored only now that every statement above has run without throwing --
  // see the header comment on this function for why that ordering is the
  // whole safety property.
  writeSchemaHash(sql, hash);
}
