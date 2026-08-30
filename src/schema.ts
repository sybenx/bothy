import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateRelayKeypair } from "./relay-identity";

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
// storage.ts estimateRowsWrittenSince originally derived "rows written in
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
// not. Without it, estimateRowsWrittenSince read every row in `events` to
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
      // the column exists. storage.ts estimateRowsWrittenSince originally
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
      // estimateRowsWrittenSince used to derive it from a
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
      // 1 when this event carries an `h` tag naming a NIP-29 group
      // (groups.ts isGroupEvent), 0 otherwise. Kind-agnostic: any kind may
      // be scoped to a group, which is what NIP-29 says and what makes
      // this a column rather than a kind range.
      //
      // It is a PARTITION, not a flag that gets tested. The three
      // REQ-serving indexes below are partial pairs keyed on it, so every
      // query pins it to one value and reads only that half; a query that
      // pins nothing can use neither half and scans. That is the whole
      // design, and it is why `is_group = ?` appears in every statement
      // this codebase issues against `events` -- see INDEXES below for the
      // measurements, and storage.ts for the two-partition form the
      // internal lookups use.
      //
      // A column, not a second table. It costs nothing in rows written (a
      // row write is a row, not a column -- the same accounting
      // `ingested_at` and `row_cost` are argued on above), and the
      // alternative measured no cheaper on any read while doubling every
      // write path, every deletion path and the tombstone set.
      //
      // NOT NULL DEFAULT 0, so an existing relay's rows migrate to
      // "public" -- which is exactly right: nothing carrying an `h` tag
      // could have been stored before this shipped, because nothing
      // distinguished it.
      col("is_group", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    name: "event_tags",
    columns: [
      col("tag_name", "TEXT NOT NULL"),
      col("tag_value", "TEXT NOT NULL"),
      col("event_id", "TEXT NOT NULL"),
      col("created_at", "INTEGER NOT NULL"),
      // The `is_group` of the event this tag row belongs to, copied at
      // insert time the way `created_at` above already is, and for the
      // same reason: the tag subquery has to be able to apply the
      // exclusion ITSELF.
      //
      // Without it the subquery's own LIMIT (filters.ts tagScanLimit) runs
      // before the exclusion does, so the candidate set is filled with
      // group events and then emptied by the outer query -- measured at
      // 50,000 group events, a client asking for 20 got 1. The rows have
      // to be excluded where they are counted, not after.
      //
      // Zero additional rows written: the lookup index below is a partial
      // PAIR on this column rather than a second index, so a tag row still
      // pays one base row and one lookup entry, plus idx_event_tags_event.
      col("is_group", "INTEGER NOT NULL DEFAULT 0"),
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
    // event -- see ownership.ts refreshFollows(). Replaced wholesale when
    // it is replaced at all, so no index beyond the primary key is
    // needed.
    //
    // `fetched_at` is the `created_at` of the kind-3 these rows were
    // derived FROM, not the wall clock at which they were written. It is
    // the watermark refreshFollows compares against to decide whether
    // there is anything to rebuild -- the same job owner.profile_synced_at
    // does for kind-0, kept here because a relay running under
    // OWNER_PUBKEY has no `owner` row to put it on. Every row carries the
    // same value, so one row read answers for the whole table. It was
    // wall-clock time until v0.7.7, when rebuilding unconditionally on
    // every cron tick turned out to cost 900 rows written per tick at 300
    // follows.
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
    columns: [
      col("host", "TEXT"),
      // Guards the one-time correction for events wrongly flagged
      // is_group = 1 before groups.ts isGroupEvent was scoped to
      // TOP_LEVEL_GROUP_ID (storage.ts fixMisclassifiedGroupEvents,
      // called from relay.ts runCron) -- 0 until a cron tick finds
      // nothing left to fix, then permanently 1, the same shape
      // backfill_meta.exhaust_reset_applied guards its own one-time
      // reset below.
      col("group_scope_fixed", "INTEGER NOT NULL DEFAULT 0"),
      // Fingerprint of the follow SET the `follows` table currently
      // holds (ownership.ts computeFollowsHash) -- the same shape as
      // schema_meta.hash: derived from the content it describes, never
      // maintained by hand, and written only after the rebuild it
      // describes has completed, so a rebuild that dies partway leaves
      // the previous hash in place and the next call retries. NULL until
      // the first rebuild under this column, and cleared when the cache
      // is cleared. It is what lets refreshFollows tell "a new kind-3
      // arrived" from "the follows actually changed" at one row read --
      // see that function for why created_at could not.
      col("follows_hash", "TEXT"),
    ],
  },
  {
    // This relay's own signing identity (src/relay-identity.ts), distinct
    // from the owner's pubkey. Generated once, at schema-init time
    // (initSchema's seedRelayIdentity below) rather than tied to the TOFU
    // claim step -- OWNER_PUBKEY skips claim() entirely and this identity
    // must exist under that mode too, for the same reason `follows` and
    // `relay_meta` live off the `owner` table rather than on it. Exactly
    // one row, forever, like relay_meta and backfill_meta.
    name: "relay_identity",
    columns: [col("secret_key", "TEXT NOT NULL"), col("public_key", "TEXT NOT NULL")],
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
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("reason", "TEXT"),
      col("allowed_at", "INTEGER NOT NULL"),
      // WHO PUT THIS ROW HERE, and the only thing that decides whether a
      // NIP-29 kind-9001 remove-user may take it away again.
      //
      // 'owner' is an explicit act: a NIP-86 allowpubkey call the operator
      // made by hand. 'invite' is bookkeeping: the row kind-9000 put-user
      // writes so a new group member can actually reach the relay at all,
      // since membership is the INNER of two nested lists and the outer one
      // is what ownership.ts isAllowedWriter consults (src/nip29.ts states
      // the nesting in full).
      //
      // remove-user deletes only 'invite' rows. Without the distinction it
      // would have exactly two options, and both are wrong: delete every
      // row and removing somebody from the group silently revokes a write
      // grant the owner made deliberately and separately, or delete none
      // and every member ever removed keeps writing forever. The column is
      // what lets the group take back only what the group gave.
      //
      // An allowpubkey on a row already here PROMOTES it to 'owner' rather
      // than leaving it as the group's to reclaim -- an explicit act
      // outranks the bookkeeping, and the operator who types the command
      // means the grant to survive whatever the group does next. The
      // promotion is one-way: put-user never demotes an 'owner' row back.
      //
      // NOT NULL DEFAULT 'owner', so every row on an existing relay
      // migrates to owner-owned, which is exactly what they are: NIP-86
      // allowpubkey was the only thing that could write this table before
      // this column existed.
      col("source", "TEXT NOT NULL DEFAULT 'owner'"),
    ],
  },
  {
    // NIP-29 group membership (src/nip29.ts) -- the INNER of the two
    // nested lists described on `allowed_pubkeys.source` above. A row here
    // means the pubkey may write `h`-tagged events; a row THERE means it
    // may write to this relay at all, and a member needs both.
    //
    // No group id column, because there is exactly one group and its id is
    // a constant (groups.ts TOP_LEVEL_GROUP_ID). A second group would need
    // a composite primary key, which SQLite cannot add to an existing
    // table (see whyNotAddable below) and which would therefore be a
    // deliberate table rebuild rather than a column addition. That is the
    // honest shape of the decision and it is recorded here rather than
    // pre-paid for with a column nothing reads.
    //
    // Read on the write path, but only for events that carry an `h` tag
    // and are not the owner's (nip29.ts authorizeGroupWrite), so it costs
    // an indexed lookup on group traffic and nothing at all on the rest.
    // Written at moderation pace: one row per put-user, one delete per
    // remove-user.
    //
    // Members and their `allowed_pubkeys` rows can drift apart -- two
    // tables, two writes -- and the failure that produces is silent: a
    // member the relay believes is in the group, whose events the outer
    // gate refuses with a message about follows that names nothing about
    // groups. storage.ts auditMaintainedCounts checks the containment once
    // a day and logs, like every other invariant there, without repairing
    // it.
    name: "group_members",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("added_at", "INTEGER NOT NULL")],
  },
  {
    // NIP-29 invite codes (src/nip29.ts): one row per kind-9009
    // create-invite the owner publishes, and the thing a kind-9021 join
    // request from a stranger is checked against.
    //
    // THE ROW IS THE TRUTH, not the kind-9009 event that created it. The
    // event is the owner's own history of having issued the invite; this
    // row is the invite's current state, and only this row is consulted
    // when a code is presented. Storing the state on the event instead
    // would mean mutating a signed event to spend a code, which is not a
    // thing that can be done.
    //
    // The code is stored VERBATIM rather than hashed, which is a
    // deliberate departure from how a bearer token is usually held at
    // rest. Hashing protects a secret from whoever can read the table;
    // here that is the relay owner, who is the person that issued the
    // code and the only person the NIP-86 list method will ever show it
    // to. They need to read a live invite back -- that is the entire
    // point of listunusedinvites, since a link the admin cannot see again
    // is a link they cannot re-send or match against the one they are
    // being asked about. Hashing would buy nothing against the threat
    // this relay actually has (a stranger guessing, which the throttle
    // and the code length bound) and would cost the feature that was
    // asked for.
    //
    // Spent, revoked and expired are three different NULL-able columns
    // rather than one status string, because a row can be more than one
    // of them and the admin's log line says which. A code is redeemable
    // only while all three are clear.
    //
    // Rows are never swept. They accumulate at owner pace -- one per
    // invite ever issued, on a relay with one owner -- so a sweep would
    // cost more complexity than the rows are worth, and keeping the dead
    // ones is what lets nip29.ts tell the admin "this code expired" or
    // "this code was already used" instead of "no such code" forever
    // after. Deleting them would erase exactly the distinction the log
    // line exists to draw.
    name: "group_invites",
    columns: [
      col("code", "TEXT PRIMARY KEY"),
      col("created_at", "INTEGER NOT NULL"),
      // Always set. See limits.ts INVITE_DEFAULT_TTL_SECONDS: there is no
      // never-expiring invite, so this column has no "unset" state to
      // represent and is NOT NULL rather than nullable-means-forever.
      col("expires_at", "INTEGER NOT NULL"),
      col("redeemed_at", "INTEGER"),
      col("redeemed_by", "TEXT"),
      col("revoked_at", "INTEGER"),
    ],
  },
  {
    // Every count /api/stats reports that is maintained rather than
    // computed. Exactly one row.
    //
    // `events` and `follows` are here for the same reason and were made
    // maintained in that order: each was a COUNT over a table nothing
    // indexed for counting, each was read by an unauthenticated endpoint,
    // and each therefore had to be rationed behind a cache clock instead
    // of simply being cheap. `stats_snapshot` was that cache, and moving
    // the last field out of it is what let it be deleted -- along with
    // its TTL, its refresh function and its cron call, a mechanism whose
    // whole job was rationing a cost that no longer exists.
    //
    // Seeded once by initSchema from real counts and thereafter only ever
    // moved by the code that writes the table it counts -- never
    // recomputed, and never repaired. storage.ts auditMaintainedCounts
    // recounts once a day and logs a disagreement; it deliberately does
    // not fix one, because a counter that silently repairs itself hides
    // whatever broke it, and "the number was wrong for a day" is a much
    // smaller problem than "the number is wrong and always looks right".
    //
    // One row for both, rather than a table each, because a stats request
    // reads them together and one row read answers for both -- and
    // because a single `audited_at` is then what paces one daily audit
    // over everything this relay maintains, rather than two gates that
    // could drift apart.
    //
    // WHAT MAY WRITE HERE. `events` moves only in storage.ts
    // insertEventRow/deleteEventRow, the only two statements in the
    // codebase that touch `events`. `follows` moves only in ownership.ts
    // refreshFollows, the only function that writes the `follows` table,
    // and in both of its write branches rather than at its exit. In each
    // case the counter write sits inside the function that performs the
    // row write, not beside its callers, so there is no path that can
    // change a table without moving its counter. That property is what
    // makes a maintained count safe, and it is asserted rather than
    // assumed (test/stats.test.ts, test/follows.test.ts).
    //
    // `events` PAYS A ROW WRITE PER EVENT, which is the trade this file
    // has refused twice (a rows-written counter table; read-metrics.ts's
    // counters). Both refusals were about measuring the relay's own
    // plumbing -- paying a permanent per-event write to observe a
    // per-event write, where the thing measured and the cost of measuring
    // it grow together and the answer is a diagnostic. This is not that.
    // `totalEvents` is the oldest number on the admin page, the
    // alternative is a scan of `events` that grows without bound, and the
    // price is fixed at 1 row against an event that already costs 6 to
    // 21. The earlier refusals stand; this is a different question with a
    // different answer, not a reversal.
    //
    // `follows` does not pay per event at all: it moves when the owner's
    // contact list changes, which is rare, and costs 1 row against the
    // hundreds refreshFollows writes rebuilding the list in the same
    // breath.
    name: "maintained_counts",
    columns: [
      col("events", "INTEGER NOT NULL"),
      // How many of `events` are group events (groups.ts isGroupEvent).
      // /api/stats reports `events - group_events`, because that endpoint
      // is public and unauthenticated and a total that moved with group
      // traffic would announce every arrival to anyone polling it -- the
      // same detection the security review found for gift wraps, where
      // holding a /live socket and polling `totalEvents` timed arrivals to
      // the second. Relay.getStats carries the note about what this does
      // NOT fix.
      //
      // A column on the row this write already updates, so splitting the
      // counter costs zero additional rows written (measured: an UPDATE
      // touching two columns reports the same 1 row as one touching one).
      col("group_events", "INTEGER NOT NULL DEFAULT 0"),
      col("follows", "INTEGER NOT NULL"),
      // Wall-clock seconds of the last auditMaintainedCounts run, so the
      // daily recount is paced by the data rather than by how often the
      // cron happens to fire. NULL until the first audit.
      col("audited_at", "INTEGER"),
      // What the last audit found, as a JSON array of one string per
      // disagreement -- the same text auditMaintainedCounts already logs
      // with console.error, kept here because a console line is read by
      // nobody: this is the only durable record of what a daily check
      // that runs unattended on a cron actually found. NULL means the
      // last run found nothing wrong, and it means that ONLY when
      // `audited_at` is non-null -- a relay that has never audited also
      // has `last_drift` NULL, and /api/stats must tell those two states
      // apart (relay.ts getStats' `countAudit`) rather than let "never
      // checked" read as "checked, clean". Written by the same UPDATE
      // that stamps `audited_at`, so the two can never describe different
      // runs. Display only: nothing reads this column back to correct
      // anything, matching the detect-don't-heal rule the column it sits
      // beside already established.
      col("last_drift", "TEXT"),
    ],
  },
  {
    // `events24h` on /api/stats: one row per hour of `created_at`
    // history, holding how many stored events carry a `created_at` in
    // that hour.
    //
    // Buckets rather than a single counter because `events24h` is a
    // ROLLING window and a scalar cannot express one -- an event leaves
    // the window by the clock moving, with nothing happening to the
    // event. Bucketing is what lets a maintained count answer a moving
    // question: the window is a range of bucket keys, and it costs the
    // number of buckets in it rather than the number of events.
    //
    // Keyed by `created_at`, NOT `ingested_at`, and that is the whole
    // subtlety of this table. `events24h` answers "what has the owner
    // posted lately"; a backfilled note signed in 2021 and stored this
    // morning belongs in a 2021 bucket and must not appear in the current
    // window at all. Incrementing on arrival would have made backfill
    // look like a posting spree -- the mirror image of the bug
    // `ingested_at` exists to fix (see `events.ingested_at` above), and
    // the reason these two windows need two different mechanisms.
    //
    // The companion to `maintained_counts.events` above: that row is the
    // grand total, these rows are the same events indexed by when they
    // were signed. Both move in the same two functions.
    //
    // `hour INTEGER PRIMARY KEY` is a rowid alias, so an upsert here
    // writes 1 row and no index entry, and a window read is a range seek
    // over consecutive integer keys.
    //
    // Rows read for a 24h window: at most 26. The cutoff is the bucket
    // containing (now - 86400) and the highest reachable bucket is the
    // one an hour ahead of now (limits.ts MAX_CREATED_AT_FUTURE_SECONDS
    // refuses anything further), so the range spans 26 keys whatever the
    // relay's size or activity.
    //
    // Rows never leave this table. A bucket that decrements to zero is
    // kept rather than deleted: deleting it would be a second row write
    // on the removal path to save one row read on a window that includes
    // at most 26 of them, and outside the window it is never read at all.
    // Table size is one row per hour in which the owner published
    // something ever, which for a decade of history is thousands of rows
    // and nothing reads them.
    name: "event_hour_counts",
    columns: [
      // floor(created_at / 3600). storage.ts hourBucket derives it in JS
      // with Math.trunc, matching SQLite's integer `/`, so the seed
      // below, the daily audit and the per-event increments all agree on
      // which bucket a given created_at belongs to -- including for the
      // negative created_at nothing rejects (validate.ts
      // isCreatedAtTooFarInFuture is deliberately one-sided).
      col("hour", "INTEGER PRIMARY KEY"),
      col("n", "INTEGER NOT NULL"),
      // How many of `n` are group events, subtracted before /api/stats
      // reports `events24h` -- see `group_events` on `maintained_counts`
      // for why the public document must not move with group traffic.
      // One more column on a bucket row that is written anyway: zero
      // additional rows.
      col("group_n", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // `ingested24h` and `rowsWrittenToday` on /api/stats: one row per
    // hour of INGEST history, holding how many events this relay took in
    // during that hour and how many rows it wrote during it.
    //
    // The sibling of `event_hour_counts` above, and deliberately NOT the
    // same table, because it answers a different question with a
    // different key. `event_hour_counts` is keyed by `created_at` and
    // asks "what has the owner posted lately"; this one is keyed by
    // `ingested_at` and asks "what did this relay DO lately". A
    // backfilled note signed in 2021 and stored this morning belongs in a
    // 2021 bucket there and in this morning's bucket here -- the two
    // windows are the same events viewed through the two clocks
    // `events.ingested_at` exists to keep apart, and sharing one table
    // would have merged exactly the distinction that column was added to
    // make.
    //
    // These two were the last computed figures on /api/stats. They lived
    // in a cache row (`live_stats`) on a five-minute clock, because each
    // read the ingest WINDOW -- ~1,200 rows per request on the live
    // relay, on an unauthenticated GET, so ~4,100 requests took the whole
    // 5,000,000 rows-read/day allowance. A TTL bounds how often you pay
    // an expensive read; it does not make the read cheap, and it survives
    // only until someone does. Bucketing did, so `live_stats`, its TTL
    // (limits.ts records where that constant stood and why), its refresh
    // function and the `liveAt` age that dated it are all gone, the same way
    // `stats_snapshot` went when `events24h` was bucketed.
    //
    // `hour INTEGER PRIMARY KEY` is a rowid alias, so an upsert writes 1
    // row and no index entry, and a window read is a range seek over
    // consecutive integer keys.
    //
    // Rows read for BOTH figures: at most 25, in one statement. The
    // rolling 24h window starts at the bucket containing (now - 86400)
    // and cannot extend past the current hour, since `ingested_at` is
    // wall-clock write time and nothing can be ingested in the future;
    // the since-00:00-UTC window starts later than that (a UTC day
    // boundary is always inside the last 24 hours) and is therefore a
    // suffix of the same range, so one seek and two conditional sums
    // answer both.
    //
    // The rows-written window is EXACT at the reset boundary rather than
    // approximate, which is the one thing the old cache could not manage:
    // 00:00 UTC is a whole number of hours, so `hour >= dayStart / 3600`
    // selects today and nothing else. The rolling window is whole hours
    // and so spans 24-25h, the same fidelity trade `event_hour_counts`
    // makes, against a figure that used to be up to five minutes stale.
    //
    // Rows never leave this table, for the reason they never leave
    // `event_hour_counts`: deleting an emptied bucket would be a second
    // row write on the removal path to save one row read inside a window
    // that holds at most 25 of them.
    name: "ingest_hour_counts",
    columns: [
      // floor(ingested_at / 3600), by storage.ts hourBucket -- the same
      // Math.trunc the created_at buckets use, matching SQLite's integer
      // `/` so the seed, the audit and the per-event bumps agree.
      col("hour", "INTEGER PRIMARY KEY"),
      // Events this relay ingested in this hour and still holds.
      // Decremented on removal, so it matches what a COUNT over `events`
      // by `ingested_at` would say -- which is what makes it auditable
      // (storage.ts auditMaintainedCounts).
      col("n", "INTEGER NOT NULL"),
      // How many of `n` are group events, subtracted before /api/stats
      // reports `ingested24h`. Same argument as `group_n` on
      // `event_hour_counts`, through the other clock.
      col("group_n", "INTEGER NOT NULL DEFAULT 0"),
      // Rows written during this hour, ALL of them: event rows, index
      // entries, tombstones, counter updates, the follow-list rebuild,
      // NIP-86 bans, backfill bookkeeping. Measured by the SqlStorage
      // wrapper in read-metrics.ts rather than reported by each path, and
      // landed here inside the execution context that spent them -- see
      // storage.ts settleRowsWritten.
      //
      // NOT decremented on removal, unlike `n` beside it. A row that was
      // written and then deleted was still written; the allowance does
      // not come back. That asymmetry is also what keeps the audit's
      // floor check valid: this can only ever exceed the cost of the
      // events still standing in the hour.
      col("rows_written", "INTEGER NOT NULL"),
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
  // A partial-index predicate (sqlite.org/partialindex.html). An index
  // declared with one indexes only the rows satisfying it, and SQLite will
  // use it only for a query whose own WHERE clause implies the predicate.
  //
  // Every entry carrying this is one half of a PAIR -- `is_group = 0` and
  // `is_group = 1` over identical columns -- which is what makes the group
  // partition free in rows written: a row satisfies exactly one predicate,
  // so it pays exactly one index entry, the same as the single index the
  // pair replaced (measured on a real cursor, test/hibernation.test.ts).
  //
  // The cost is paid in queries instead: a query that pins neither value
  // can use neither half. That is not a subtlety to be careful about, it
  // is the invariant -- storage.ts states it once and every lookup obeys
  // it, because the alternative is a full scan (51,500 rows against 2,
  // measured at 50,000 group events).
  readonly where?: string;
}

export const INDEXES: readonly IndexSpec[] = [
  // ------------------------------------------------------------------
  // The three REQ-serving indexes, each declared TWICE: once over the
  // public partition and once over the group partition (`is_group`, see
  // TABLES above and src/groups.ts).
  //
  // Why pairs rather than one index carrying `is_group` as a key column:
  // measured. A widened index makes `is_group` part of the key, so every
  // query that does NOT pin it changes plan -- an authenticated owner
  // reading their own gift wraps went from 601 rows read to 204,701,
  // because SQLite abandoned the primary-key seek for a partition scan.
  // A partial pair leaves the key columns exactly as they were, so a
  // query pinning the partition gets the identical plan it got before
  // this column existed, and a query pinning the other one gets the
  // mirror image. Measured across every shape this relay serves, the
  // public path is unchanged or cheaper and the authorised path costs at
  // most 2x (two partitions instead of one).
  //
  // And why pairs rather than one partial index over the public rows
  // alone: rows written. A lone `WHERE is_group = 0` index would leave
  // group rows unindexed for every internal lookup (replacement, NIP-09,
  // NIP-62 vanish), and adding a full index beside it would charge every
  // public row twice. A pair charges each row once, whichever side it
  // falls on.
  //
  // Serves `authors` + `kinds` together -- the shape a well-behaved
  // client sends, and the only one that was ever cheap here.
  {
    name: "idx_events_pubkey_kind_created_pub",
    table: "events",
    keyColumns: ["pubkey", "kind"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_events_pubkey_kind_created_grp",
    table: "events",
    keyColumns: ["pubkey", "kind"],
    orderedBy: "created_at",
    where: "is_group = 1",
  },
  // Serves `kinds` with no `authors`. Added v0.7.2; see the measurement
  // at the top of this file. Also turns storage.ts giftWrapCount --
  // `SELECT COUNT(*) FROM events WHERE kind = ?`, run on every accepted
  // gift wrap -- from a full scan of `events` into an index count.
  {
    name: "idx_events_kind_created_pub",
    table: "events",
    keyColumns: ["kind"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_events_kind_created_grp",
    table: "events",
    keyColumns: ["kind"],
    orderedBy: "created_at",
    where: "is_group = 1",
  },
  // Serves `authors` with no `kinds`. Added v0.7.2. On a single-owner
  // relay this is the shape that looks harmless and is not: every row in
  // the table carries the owner's pubkey, so `{"authors":[owner]}` is a
  // request for the whole table with a `limit` that bounds nothing.
  {
    name: "idx_events_pubkey_created_pub",
    table: "events",
    keyColumns: ["pubkey"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_events_pubkey_created_grp",
    table: "events",
    keyColumns: ["pubkey"],
    orderedBy: "created_at",
    where: "is_group = 1",
  },
  // Serves `#<letter>` tag filters, through the subquery in
  // buildFilterQuery -- as a partial pair for the same reason the three
  // above are one, and with the same measured consequence if it is not:
  // carrying `is_group` as a leading KEY column here is what took the
  // owner's own gift wrap read from 601 rows to 204,701, since that query
  // pins no partition.
  //
  // The subquery has to be able to exclude group rows before its own
  // LIMIT applies, or the candidate set fills with them and the outer
  // query returns a short page -- 1 event where 20 were asked for, at
  // 50,000 group events. See `event_tags.is_group` in TABLES.
  {
    name: "idx_event_tags_lookup_pub",
    table: "event_tags",
    keyColumns: ["tag_name", "tag_value"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_event_tags_lookup_grp",
    table: "event_tags",
    keyColumns: ["tag_name", "tag_value"],
    orderedBy: "created_at",
    where: "is_group = 1",
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
  // Serves `WHERE ingested_at > ?` -- storage.ts estimateRowsWrittenSince
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
  const where = spec.where === undefined ? "" : ` WHERE ${spec.where}`;
  return `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${columns.join(", ")})${where}`;
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

// ---------------------------------------------------------------------
// DELIBERATELY WRONG, AND WRONG IN THE SAFE DIRECTION. Read this before
// "fixing" it, and read test/hibernation.test.ts, which asserts the
// over-charge so that a fix cannot land silently.
//
// One base row, plus the implicit unique index SQLite maintains for
// `id TEXT PRIMARY KEY` (a TEXT primary key is not a rowid alias, so it
// costs its own index), plus one row per declared index on `events`. That
// last term is the wrong one now: `indexesOn("events")` counts SEVEN
// indexes, but three of them are the group halves of partial pairs and a
// row satisfies exactly one half of each pair. A public event pays the
// base row, the PK index, three partial entries and idx_events_ingested:
//
//   declared   2 + 7 = 9   + EVENT_COUNTER_ROW_COST 3   + 4 per tag row
//   measured   2 + 4 = 6   + EVENT_COUNTER_ROW_COST 3   + 3 per tag row
//
//   => eventRowCost says 12 + 4T, an event costs 9 + 3T.
//      A real five-tag note: 32 charged, 24 spent -- a third too much.
//
// Left wrong on purpose, because every consumer of this number is a
// GUARD, and every one of them is made stricter rather than looser by an
// over-estimate: limits.ts BACKFILL_PAGE_SIZE fetches smaller pages,
// VANISH_BATCH_SIZE drains fewer events per tick, backfill.ts
// hasBackfillHeadroom stops sooner, and `events.row_cost` stamps a figure
// that makes estimateRowsWrittenSince read high. Backfill and the vanish
// drain get slower; nothing overruns. That is the same direction
// eventRemovalBudget was deliberately wrong in, for the same reason, and
// this file already argues it there.
//
// Making it right means teaching IndexSpec that a pair costs one row --
// which is a real change to the derivation, not a constant edit, and it
// moves BACKFILL_PAGE_SIZE, VANISH_BATCH_SIZE and every stamped
// `row_cost` with it. Do it deliberately or not at all.
//
// The one place the over-charge is NOT safe is
// storage.ts auditMaintainedCounts, whose rows-written check is a FLOOR:
// it asks whether the metered total ever fell below what the events in
// the window cost to store, and an inflated cost turns that into a daily
// false alarm on a check whose entire value is that it fires rarely. So
// the measured figure is derived alongside, below, and used there and
// nowhere else.
// ---------------------------------------------------------------------
export const EVENT_BASE_ROW_COST = 2 + indexesOn("events").length;

// The three maintained counters storage.ts insertEventRow moves alongside
// every stored event: one row in `maintained_counts` (one row, no index),
// one in `event_hour_counts` and one in `ingest_hour_counts` (both
// rowid-aliased primary keys, so no index entry either). Declared here
// rather than as a bare `+ 3` in
// eventRowCost below because this number is what makes the counters'
// price visible in the one place the project prices a write -- backfill's
// page sizing and the vanish drain's pacing both read it, and the admin
// page's budget bar is summed from it.
//
// It was 2 until `ingest_hour_counts` landed. The third row buys two
// things at once: `ingested24h` and `rowsWrittenToday` stop being window
// scans behind a five-minute cache, and the same statement is where the
// measured rows-written total lands, so the write meter costs nothing on
// the event path beyond a bucket that was being written anyway. See that
// table in TABLES, and storage.ts settleRowsWritten for the paths that do
// have to pay a write of their own.
export const EVENT_COUNTER_ROW_COST = 3;

// One base row per `event_tags` row, plus one per index on that table --
// over-charged by exactly one, for the reason EVENT_BASE_ROW_COST above
// carries in full: `idx_event_tags_lookup_pub`/`_grp` are a partial pair
// and a tag row pays one of them, so this says 4 where a tag row costs 3.
export const TAG_ROW_COST = 1 + indexesOn("event_tags").length;

// How many partial index PAIRS are declared on a table. One pair is one
// row written per stored row, not two, so this is exactly the amount by
// which the two constants above over-charge.
//
// Derived from the declaration rather than written down, like everything
// else in this section: adding or removing a pair moves it, and the pair
// is recognised structurally (a partial index is one carrying `where`, and
// they are declared in twos). If a future index carries `where` WITHOUT a
// mirror -- a partial index over some rows and no index over the rest --
// this halving stops being right, which is why the pairing is asserted in
// test/schema-migration.ts rather than assumed here.
export function partialIndexPairsOn(table: string): number {
  return indexesOn(table).filter((i) => i.where !== undefined).length / 2;
}

// What a stored event ACTUALLY costs, as SqlStorageCursor reports it.
//
// This is not the fix for the over-charge above and must not be used as
// one: it exists for storage.ts auditMaintainedCounts, whose rows-written
// check compares a METERED total against the cost of the events that
// produced it. A floor derived from an over-estimate is not a floor, it is
// a daily false alarm, and a check that cries wolf once a day is a check
// nobody reads on the day it is right.
//
// Everything else -- page sizing, drain pacing, the stamped `row_cost`
// column -- deliberately keeps using the over-charged `eventRowCost`.
// test/hibernation.test.ts pins both, and pins the difference between
// them, so neither can drift and a fix to the derivation cannot land
// without deleting this.
export const EVENT_BASE_ROW_COST_MEASURED = EVENT_BASE_ROW_COST - partialIndexPairsOn("events");
export const TAG_ROW_COST_MEASURED = TAG_ROW_COST - partialIndexPairsOn("event_tags");

export function eventRowCostMeasured(indexedTagCount: number): number {
  return (
    EVENT_BASE_ROW_COST_MEASURED + EVENT_COUNTER_ROW_COST + TAG_ROW_COST_MEASURED * indexedTagCount
  );
}

// Rows written by storing one event carrying `indexedTagCount`
// single-letter tags. Stamped into `events.row_cost` at insert time
// (storage.ts insertEventRow) so estimateRowsWrittenSince can sum a column
// instead of rebuilding this from a join.
//
// The counter cost is INSIDE this figure rather than accounted separately,
// which is the point of putting it here: backfill.ts prices a page against
// eventRowCost, the vanish drain paces against eventRemovalBudget which
// calls it, and the admin page's write-budget bar sums the stamped column.
// A counter cost added at the write site but not to this number would be
// two rows per event that every one of those guards was blind to -- the
// same shape of error that made estimateRowsWrittenSince wrong by 45x.
export function eventRowCost(indexedTagCount: number): number {
  return EVENT_BASE_ROW_COST + EVENT_COUNTER_ROW_COST + TAG_ROW_COST * indexedTagCount;
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
//   UPDATE maintained_counts / event_hour_counts
//     / ingest_hour_counts                 3
//
// So a removal reports one row per base row deleted, plus the tombstone,
// plus the three counter updates -- which are plain UPDATEs on unindexed
// one-row-per-key tables and so cost the same going down as coming up,
// unlike everything above them.
//
// The asymmetry is also why storage.ts deleteEventRow has to account for
// a removal EXPLICITLY rather than leaving it to the SqlStorage wrapper
// that meters every other write (read-metrics.ts): the wrapper can only
// report what the cursor reports, and on this path the cursor is
// missing every index entry the DELETEs actually retired. A meter that
// inherited that gap would understate exactly the operation this relay
// cannot refuse.
// Both functions below are real; which one to use depends on whether you
// are reporting or budgeting.
// ---------------------------------------------------------------------

// What SqlStorageCursor actually reports for removing one event: the tag
// rows, the event row, and the tombstone. Asserted against a real cursor
// in test/hibernation.test.ts.
export function eventRemovalRowsWritten(indexedTagCount: number): number {
  return indexedTagCount + 1 + TOMBSTONE_ROW_COST + EVENT_COUNTER_ROW_COST;
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
// the class of error that made estimateRowsWrittenSince wrong by 45x.
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
//    resetsOnAdd; index name, table, keyColumns, orderedBy, covering,
//    where) --
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
      where: i.where ?? null,
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

// The one-time migration behind `maintained_counts`/`event_hour_counts`:
// counts what is already stored so the maintained counters start from the
// truth rather than from zero on a relay that has been running for months.
//
// Guarded on `maintained_counts` being EMPTY, not on the schema hash, and
// the difference matters. initSchema's reconcile pass runs again on every
// future schema change, and a seed keyed to that would recount each time --
// which would also silently repair any drift the counters had accumulated,
// defeating storage.ts auditMaintainedCounts before it ever got to report
// it. Seeding once means a wrong counter stays wrong and gets logged, which
// is the whole design (see `maintained_counts` in TABLES).
//
// Ordering is load-bearing: the hour buckets are filled first and the event
// total is then summed FROM those buckets, so the two cannot disagree at
// birth even if the table changed underneath a longer scan. It also means
// `events` is scanned exactly once.
//
// Rows read: E + F, once per deployment, on the wake that upgrades to this.
// Zero on a fresh database, where both scans find nothing.
function seedMaintainedCounts(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM maintained_counts LIMIT 1`).toArray().length > 0) return;
  // Clears a seed that died between the statements below. `hour` is a
  // primary key, so a retry over a half-filled bucket table would throw on
  // the first duplicate and keep throwing on every subsequent wake. Reached
  // only when `maintained_counts` is empty, so it can never discard buckets
  // a completed seed produced.
  sql.exec(`DELETE FROM event_hour_counts`);
  sql.exec(
    `INSERT INTO event_hour_counts (hour, n, group_n)
       SELECT created_at / 3600, COUNT(*), COALESCE(SUM(is_group), 0)
         FROM events GROUP BY created_at / 3600`,
  );
  sql.exec(
    `INSERT INTO maintained_counts (events, group_events, follows, audited_at)
       SELECT (SELECT COALESCE(SUM(n), 0) FROM event_hour_counts),
              (SELECT COALESCE(SUM(group_n), 0) FROM event_hour_counts),
              (SELECT COUNT(*) FROM follows),
              NULL`,
  );
}

// The same one-time migration for `ingest_hour_counts`, and guarded the
// same way and for the same reason: on the TABLE being empty, never on
// the schema hash. A seed keyed to the reconcile pass would re-run on
// every future schema change and silently repair whatever drift the
// buckets had accumulated, which is precisely the evidence
// storage.ts auditMaintainedCounts exists to report.
//
// A separate guard from seedMaintainedCounts' rather than a shared one,
// because these tables were seeded at different times: a relay upgrading
// to this already has a non-empty `maintained_counts` and must still get
// its ingest buckets filled.
//
// `rows_written` is seeded from `events.row_cost`, which is the cost of
// STORING those events and nothing else -- the deletions, follow
// rebuilds and bookkeeping writes of past hours are not recoverable and
// are not invented. So the buckets predating this migration are a floor,
// exactly as `row_cost`'s own arrival was, and the figure is exact from
// the first full UTC day after the upgrade. That is the same undercount
// `ingested_at` and `row_cost` each accepted for one straddling window,
// accepted here for the same reason: a made-up number is worse than a
// known-low one.
//
// Rows with a NULL `ingested_at` (written before that column existed)
// are skipped entirely rather than bucketed under hour 0 -- the same
// rule the estimate they replace applied by never matching `> cutoff`.
//
// Rows read: E, once per deployment, on the wake that upgrades to this.
// Zero on a fresh database.
function seedIngestCounts(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM ingest_hour_counts LIMIT 1`).toArray().length > 0) return;
  sql.exec(
    `INSERT INTO ingest_hour_counts (hour, n, group_n, rows_written)
       SELECT ingested_at / 3600, COUNT(*), COALESCE(SUM(is_group), 0),
              COALESCE(SUM(row_cost), 0)
         FROM events WHERE ingested_at IS NOT NULL
        GROUP BY ingested_at / 3600`,
  );
}

// relay_identity must have exactly one row, like relay_meta and
// backfill_meta -- guarded on the table being empty rather than
// generated unconditionally on every reconcile, so a schema change years
// from now cannot mint a second keypair underneath whatever this relay
// has already published signed as itself. See src/relay-identity.ts for
// why this exists and why it lives off the `owner` table.
function seedRelayIdentity(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM relay_identity LIMIT 1`).toArray().length > 0) return;
  const { secretKeyHex, publicKeyHex } = generateRelayKeypair();
  sql.exec(`INSERT INTO relay_identity (secret_key, public_key) VALUES (?, ?)`, secretKeyHex, publicKeyHex);
}

// Drops any index this file no longer declares.
//
// Needed because CREATE INDEX IF NOT EXISTS does exactly what it says: it
// will not redefine an index that already exists under that name, and it
// reports no error either. So an index whose DEFINITION changes has to
// change its NAME -- which is how `idx_events_kind_created` became
// `idx_events_kind_created_pub`/`_grp` -- and the old name then has to be
// removed here, or a deployed relay keeps maintaining an index nothing
// queries and pays a row per stored event for it forever.
//
// Scoped to our own `idx_` prefix so it can never touch
// `sqlite_autoindex_*`, the implicit unique indexes behind TEXT PRIMARY
// KEY columns, which are not ours to drop and are half of what
// EVENT_BASE_ROW_COST counts.
//
// Runs only on the reconcile path (a schema-hash mismatch), so the handful
// of rows it reads out of `sqlite_master` are paid on the wake after a
// deploy that changed the schema, not on every wake. After the CREATE
// INDEX loop rather than before it, so a throw part-way through leaves the
// old indexes in place: an extra index is a cost, a missing one is an
// outage.
function dropUndeclaredIndexes(sql: SqlStorage): void {
  const declared = new Set(INDEXES.map((i) => i.name));
  const existing = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx\\_%' ESCAPE '\\'`,
    )
    .toArray();
  for (const row of existing) {
    if (!declared.has(row.name)) sql.exec(`DROP INDEX IF EXISTS ${row.name}`);
  }
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
  dropUndeclaredIndexes(sql);
  // NIP-51 mute list support was removed (see CLAUDE.md "The budget"); this drops
  // the now-orphaned table on deployed relays that still carry it from
  // before the removal. Idempotent and a no-op on a fresh database.
  sql.exec(`DROP TABLE IF EXISTS mutes`);
  // `stats_snapshot` cached the two counts over `events` and the two over
  // `follows` behind a six-hour clock, because each walked a table. All
  // four are maintained counters now or deleted outright, so the cache
  // has nothing to hold and the clock nothing to ration. Dropped rather
  // than left orphaned, the same way `mutes` above is: an unused table is
  // a thing a future reader has to work out the status of.
  sql.exec(`DROP TABLE IF EXISTS stats_snapshot`);
  // `live_stats` cached `ingested24h` and `rowsWrittenToday` behind a
  // five-minute clock, because each read the ingest window. Both are
  // bucket counters now (`ingest_hour_counts` above), so the row, its
  // TTL and the `liveAt` age that dated it have nothing left to hold --
  // the same ending `stats_snapshot` came to one release earlier, and
  // for the same reason. Dropped rather than left orphaned.
  sql.exec(`DROP TABLE IF EXISTS live_stats`);
  // backfill_meta must have exactly one row to hold status -- seeded here
  // rather than by whichever code path happens to run first, so every
  // reader (getBackfillStatus, /api/stats) can assume it exists.
  sql.exec(`INSERT INTO backfill_meta (status) SELECT 'pending' WHERE NOT EXISTS (SELECT 1 FROM backfill_meta)`);
  // relay_meta must have exactly one row, like backfill_meta above, so
  // getOwnHost/recordHost (src/host.ts) never have to special-case "no
  // row yet".
  sql.exec(`INSERT INTO relay_meta (host) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM relay_meta)`);
  seedMaintainedCounts(sql);
  seedIngestCounts(sql);
  seedRelayIdentity(sql);

  // Stored only now that every statement above has run without throwing --
  // see the header comment on this function for why that ordering is the
  // whole safety property.
  writeSchemaHash(sql, hash);
}
