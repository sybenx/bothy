import { buildFilterQuery, compareEvents, expandFilter, type FilterQueryOptions } from "./filters";
import {
  acrossScopes,
  GROUP_SCOPE,
  type GroupScope,
  isGroupEvent,
  isGroupMetadataKind,
  PUBLIC_SCOPE,
  scopeOf,
  TOP_LEVEL_GROUP_ID,
} from "./groups";
import {
  EVENT_BASE_ROW_COST,
  EVENT_BASE_ROW_COST_MEASURED,
  EVENT_COUNTER_ROW_COST,
  eventRowCost,
  TAG_ROW_COST,
  TAG_ROW_COST_MEASURED,
  TOMBSTONE_ROW_COST,
} from "./schema";
import { addRowsWritten, takeRowsWritten, unlandedRowsWritten, withReadPath } from "./read-metrics";
import { normalizeIp } from "./ip";
import { getRelayPubkey } from "./relay-identity";
import {
  dTagValue,
  type Filter,
  GIFT_WRAP_KIND,
  isAddressableKind,
  isEphemeralKind,
  isReplaceableKind,
  type NostrEvent,
  pTagValues,
} from "./nostr";

interface EventRow extends Record<string, string | number | null> {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string;
  content: string;
  sig: string;
}

function rowToEvent(row: EventRow): NostrEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags) as string[][],
    content: row.content,
    sig: row.sig,
  };
}

// Parses the NIP-40 `expiration` tag, if present and well-formed.
export function expirationOf(event: NostrEvent): number | null {
  const tag = event.tags.find((t) => t[0] === "expiration");
  if (!tag?.[1]) return null;
  const value = Number(tag[1]);
  return Number.isInteger(value) ? value : null;
}

// True for a tag this relay writes an `event_tags` row for. Only
// single-letter tag names are indexed (NIP-01 `#<letter>` filters only
// ever query those), and only each tag's first value -- see schema.ts's
// write-cost comment. Shared by insertEventRow and the row-cost stamp
// below so the count and the inserts can never disagree.
function isIndexedTag(tag: string[]): boolean {
  return tag[0]?.length === 1 && tag[1] !== undefined;
}

// `ingestedAt` is wall-clock now, not event.created_at -- see schema.ts's
// `ingested_at` comment for why the two must never be conflated. It is
// one more column on an INSERT this function already performs, so it adds
// zero rows written per event.
//
// `row_cost` is stamped here for the same reason and at the same price:
// this INSERT is the only place that knows both how many indexed tag rows
// are about to follow and what the schema charges for each, and
// estimateRowsWrittenSince below then reads a column instead of rebuilding
// the figure from a table-wide join. eventRowCost is derived from
// schema.ts INDEXES, so the number stamped here tracks the real index set
// rather than a constant somebody has to remember to update.
function insertEventRow(
  sql: SqlStorage,
  event: NostrEvent,
  expiration: number | null,
  ingestedAt: number,
): void {
  const indexedTags = event.tags.filter(isIndexedTag);
  // Which partition this event lands in, decided once here from the
  // event's own tags (groups.ts scopeOf) and then copied onto every row
  // that describes it -- the event row, its tag rows, and the counters.
  // Decided at the choke point rather than by the caller for the same
  // reason `deleteEventRow` reads `created_at` itself: this is one of the
  // two functions in the codebase that write to `events`, so "what an
  // event is" and "what gets stored about it" are the same lines of code.
  const scope = scopeOf(event);
  sql.exec(
    `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost, is_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.pubkey,
    event.created_at,
    event.kind,
    JSON.stringify(event.tags),
    event.content,
    event.sig,
    expiration,
    ingestedAt,
    eventRowCost(indexedTags.length),
    scope,
  );
  // Immediately after the row exists and before anything else can fail.
  //
  // Not a separate step a caller could skip: this is one of the two
  // statements in the codebase that touch `events` (the other is
  // deleteEventRow), so "an event was stored" and "the counters moved" are
  // the same three lines of code. Placed after the INSERT rather than
  // before so a duplicate id -- which throws, and which backfill.ts
  // applyBackfillPage catches and continues past -- leaves the counters
  // untouched rather than counting an event that was never stored. Placed
  // before the tag loop for the same reason in the other direction: if a
  // tag insert throws, the event row is real and the counters must say so.
  //
  // Rows written: 2 per stored event (the third counter row is the ingest
  // bucket at the end of this function), on top of the 6 + 3T the row
  // itself costs -- see schema.ts eventRowCostMeasured, and
  // eventRowCost beside it for the figure the guards deliberately
  // over-charge. The UPDATE is one row in a one-row table with no index;
  // the upsert is one row in a rowid-aliased table with no index. Both
  // now carry the group half in a second column, which is free: a column
  // added to a statement that already runs is not a row.
  // CLAUDE.md "The budget" carries the arithmetic.
  bumpEventCounters(sql, event.created_at, 1, scope);
  for (const tag of indexedTags) {
    sql.exec(
      `INSERT INTO event_tags (tag_name, tag_value, event_id, created_at, is_group) VALUES (?, ?, ?, ?, ?)`,
      tag[0],
      tag[1],
      event.id,
      event.created_at,
      scope,
    );
  }
  // LAST, and after the tag rows rather than beside the counters above,
  // because this statement carries two things at once: the ingest-hour
  // bucket behind `ingested24h`, and the write meter's running total
  // (read-metrics.ts) landing in the same UPDATE. Everything this event
  // cost has to have happened before the total is taken, or the tag rows
  // would be attributed to the next event instead of this one.
  //
  // This is why the write meter is free on the event path: the bucket row
  // is being written anyway, and `rows_written` is one more column on it.
  // Only paths with no bucket of their own -- cron ticks, the follow
  // rebuild, NIP-86 calls -- pay a write to land their total, and there
  // are on the order of thirty of those a day (settleRowsWritten below).
  //
  // The total taken here includes whatever a removal in the same
  // execution context put there: a replaceable replacement deletes the
  // superseded version before reaching this line, and deleteEventRow
  // accounts for that removal into the same accumulator.
  bumpIngestCounters(sql, hourBucket(ingestedAt), 1, scope === GROUP_SCOPE ? 1 : 0, takeRowsWritten());
}

// ---------------------------------------------------------------------
// `DELETE FROM event_tags WHERE event_id = ?` is served by
// idx_event_tags_event (schema.ts), added in v0.7.3. Before it, this was
// a full scan of `event_tags` -- T rows, about 5E, to remove a handful --
// and it was the most expensive read in the codebase.
//
// It was deferred once on a budget argument, and the budget argument was
// the wrong frame. It priced the index (a row write per TAG row:
// TAG_ROW_COST 2 -> 3, about five more rows per real note, ~15,000
// rows/day here, moving the meter from ~44,000 to ~59,000 of 100,000)
// against the reads it saved, concluded that a fixed daily flow was
// expensive, and treated the path as a performance question to revisit
// when a counter said it was worth it.
//
// WHY IT IS NOT A BUDGET QUESTION
//
// This DELETE is reached by NIP-62 vanish, and NIP-62 says a relay
// honours a vanish request "regardless of the user's status" -- it binds
// write-restricted relays explicitly. relay.ts handleVanish is therefore
// dispatched BEFORE ownership.ts isAllowedWriter and pays none of
// acceptEvent's abuse caps. That is not an oversight; it is what the spec
// requires. The consequences are:
//
//   - It cannot be gated. Any pubkey with a valid signature reaches it.
//   - It cannot be throttled below "eventually completes", because the
//     spec requires completion.
//   - It cannot be revoked. banpubkey and unfollowing both go through
//     isAllowedWriter, which this path never calls -- so neither of the
//     owner's two revocation tools touches it, and an EX-follow keeps
//     both their stored events and the ability to trigger this.
//
// Cost is therefore the only control available. Not the preferred one,
// the only one. An unindexed DELETE here meant a single request from one
// ex-follow holding N stored events read N x 5E rows: at E = 4,000 and
// N = 500 that is 10,000,000 rows, two days of the read ceiling, from one
// message the relay is obliged to accept. The threshold for a single
// request to consume an entire day was N x E > 1,000,000 -- N = 250 at
// today's table size, which is not a large number of events for one
// pubkey to have accumulated.
//
// So the index is what makes an operation the relay cannot refuse
// affordable to perform. ~15,000 rows/day written is the price of not
// having an unrefusable, unrevocable read amplifier in the write path.
//
// The reads are fixed; the WRITES are not, and the index does nothing for
// them. Removing an event still costs its row, its index entries and a
// tombstone -- see schema.ts eventRemovalRowsWritten, and
// eventRemovalBudget for the figure the drain is paced against -- so a
// large vanish can still
// exceed a single request's budget partway through. That is why
// beginVanish/drainVanish below checkpoint the work across cron ticks
// rather than attempting it all inside the request: NIP-62 requires full
// deletion, and a vanish that stopped wherever the ceiling fell while
// reporting success would be a compliance failure, not a slow query.
//
// test/read-cost.test.ts asserts the seek cost, so a regression that
// dropped the index would fail rather than quietly restore the
// amplifier.
// ---------------------------------------------------------------------
function deleteEventRow(sql: SqlStorage, id: string): void {
  // Read before the delete, and read HERE rather than taken from the
  // caller. Four of the five callers already hold the row's `created_at`
  // (the replaceable and addressable replacement paths, applyDeletion,
  // applyAddressDeletion) and could pass it, but banEvent does not: it
  // tombstones an id that may never have been stored at all, and a caller
  // that guessed would decrement a bucket for an event that does not
  // exist. One PK seek at the choke point is what makes the decrement
  // correct for every caller including that one -- and `undefined` here is
  // the honest answer to "there was nothing to remove", not an error.
  //
  // Rows read: 1. Removals are rare next to insertions, and this is the
  // same index seek the DELETE below performs anyway.
  const row = sql
    .exec<{
      created_at: number;
      ingested_at: number | null;
      row_cost: number | null;
      is_group: number;
    }>(`SELECT created_at, ingested_at, row_cost, is_group FROM events WHERE id = ?`, id)
    .toArray()[0];
  sql.exec(`DELETE FROM event_tags WHERE event_id = ?`, id);
  sql.exec(`DELETE FROM events WHERE id = ?`, id);
  // After the DELETE, mirroring insertEventRow: a decrement that ran ahead
  // of a statement that then threw would leave the counters describing
  // fewer events than are stored.
  if (row === undefined) return;
  // `is_group` read from the row rather than recomputed from the event,
  // for the reason `created_at` beside it is: banEvent reaches here with
  // an id that may never have been stored, and the counters must move for
  // the partition the row was actually IN, not the one a caller guessed.
  const scope: GroupScope = row.is_group === 1 ? GROUP_SCOPE : PUBLIC_SCOPE;
  bumpEventCounters(sql, row.created_at, -1, scope);
  // The ingest-hour bucket behind `ingested24h`, which counts events this
  // relay took in and STILL HOLDS -- so a removal has to come back out of
  // the hour it arrived in, not the hour it was removed in. A plain
  // UPDATE rather than an upsert, for the reason bumpEventCounters gives:
  // a decrement can only be for an event that was counted, so its bucket
  // exists, and an upsert would quietly manufacture a -1 bucket if that
  // ever stopped being true instead of leaving the audit something to
  // find. `rows_written` on the same row is deliberately untouched -- a
  // row that was written and then deleted was still written, and the
  // allowance does not come back.
  //
  // Skipped for a NULL `ingested_at`, which only rows written before that
  // column existed carry: they were never bucketed (schema.ts
  // seedIngestCounts skips them too), so there is nothing to decrement.
  if (row.ingested_at !== null) {
    sql.exec(
      `UPDATE ingest_hour_counts SET n = n - 1, group_n = group_n - ? WHERE hour = ?`,
      scope === GROUP_SCOPE ? 1 : 0,
      hourBucket(row.ingested_at),
    );
  }
  // ------------------------------------------------------------------
  // THE ONE PLACE ROWS WRITTEN ARE ACCOUNTED BY HAND rather than
  // measured, and it is here because the instrument is blind on this
  // path. SqlStorageCursor reports index maintenance on INSERT and not on
  // DELETE (schema.ts eventRemovalRowsWritten), so the wrapper in
  // read-metrics.ts sees the base rows a removal retires and none of the
  // index entries -- an undercount, on a budget meter, of the one
  // operation this relay is not allowed to refuse (NIP-62 vanish).
  //
  // So the pessimistic figure is added on top: `row_cost` is what the
  // INSERT actually cost, stamped at insert time, and adding
  // TOMBSTONE_ROW_COST makes it exactly schema.ts eventRemovalBudget --
  // the same number the vanish drain is already paced against, chosen
  // there for the same reason and in the same direction. If Cloudflare
  // bills what the cursor reports, this reads high; if it bills index
  // maintenance both ways, this reads right. High is the safe way for a
  // meter to be wrong.
  //
  // DOUBLE-COUNTS DELIBERATELY. The cursor already reported the base rows
  // this DELETE retired, and they are in the accumulator; this adds the
  // full estimate over the top rather than the difference. Tracking the
  // difference would mean the meter carrying a second model of what the
  // cursor can and cannot see -- a hand-maintained derivation of exactly
  // the kind this project has got wrong before -- to shave a handful of
  // rows off a figure that is intentionally pessimistic anyway.
  //
  // A NULL `row_cost` (a row written before that column existed) falls
  // back to the cost of a bare note. It is a floor, like every other
  // pre-migration figure in this file, and it is wrong for at most as
  // long as those rows survive.
  //
  // Not landed here: this goes into the in-memory accumulator and is
  // written by whichever landing comes next in the same execution context
  // -- insertEventRow's bucket bump on a replacement, settleRowsWritten
  // at the entry point otherwise. A landing of its own would be a row
  // written per row removed, to record rows written.
  addRowsWritten((row.row_cost ?? eventRowCost(0)) + TOMBSTONE_ROW_COST);
}

// One hour, as both bucket tables key themselves: `event_hour_counts` by
// `created_at` and `ingest_hour_counts` by `ingested_at`. One function
// because the arithmetic is identical and must stay so; WHICH timestamp
// is handed to it is the distinction that matters, and it is made at each
// call site rather than hidden in here (see schema.ts on why those two
// clocks must never be conflated).
//
// Math.trunc, not Math.floor, because SQLite's integer `/` truncates
// toward zero and the seed migrations (schema.ts seedMaintainedCounts,
// seedIngestCounts) and the daily audit below all bucket in SQL. They differ only for negative
// created_at, which nothing rejects -- validate.ts
// isCreatedAtTooFarInFuture is deliberately one-sided -- so matching the
// SQL is what keeps an event from being seeded into one bucket and
// decremented out of another.
export function hourBucket(createdAt: number): number {
  return Math.trunc(createdAt / 3600);
}

// The maintained counters behind /api/stats' `totalEvents` and
// `events24h`, moved by `delta` (+1 on insert, -1 on removal).
//
// Private on purpose, and called from exactly two places: insertEventRow
// and deleteEventRow, the only two functions in the codebase that write to
// `events`. Nothing else may call it -- a second caller would be a way for
// the counters to move without the table moving, which is the one failure
// mode the daily audit exists to catch and the one this arrangement exists
// to prevent.
//
// The bucket row is upserted on the way up and plain-UPDATEd on the way
// down: a decrement can only ever be for an event that was counted, so its
// bucket necessarily exists, and an upsert there would silently create a
// -1 bucket if that ever stopped being true rather than leaving the audit
// something to find.
function bumpEventCounters(
  sql: SqlStorage,
  createdAt: number,
  delta: 1 | -1,
  scope: GroupScope,
): void {
  // The group half moves in the same statements as the total, never in
  // statements of its own -- which is what makes the split free. A column
  // added to an UPDATE that already runs costs no additional rows written
  // (measured: 1 row either way), where a second counter row per hour
  // would have cost one per event.
  const group = scope === GROUP_SCOPE ? 1 : 0;
  sql.exec(
    `UPDATE maintained_counts SET events = events + ?, group_events = group_events + ?`,
    delta,
    delta * group,
  );
  if (delta === 1) {
    sql.exec(
      `INSERT INTO event_hour_counts (hour, n, group_n) VALUES (?, 1, ?)
         ON CONFLICT(hour) DO UPDATE SET n = n + 1, group_n = group_n + excluded.group_n`,
      hourBucket(createdAt),
      group,
    );
  } else {
    sql.exec(
      `UPDATE event_hour_counts SET n = n - 1, group_n = group_n - ? WHERE hour = ?`,
      group,
      hourBucket(createdAt),
    );
  }
}

// The ingest-hour bucket behind `ingested24h` and `rowsWrittenToday`
// (schema.ts `ingest_hour_counts`), moved by `events` (1 when an event
// arrives, 0 when only rows-written is landing) and `rowsWritten`.
//
// One upsert, one row, no index entry: `hour` is a rowid alias. The
// decrement side lives in deleteEventRow as a plain UPDATE, for the same
// reason bumpEventCounters' does.
function bumpIngestCounters(
  sql: SqlStorage,
  hour: number,
  events: number,
  groupEvents: number,
  rowsWritten: number,
): void {
  sql.exec(
    `INSERT INTO ingest_hour_counts (hour, n, group_n, rows_written) VALUES (?, ?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET n = n + excluded.n,
                                       group_n = group_n + excluded.group_n,
                                       rows_written = rows_written + excluded.rows_written`,
    hour,
    events,
    groupEvents,
    rowsWritten,
  );
}

// A landing costs one row, so landing one pending row records one row of
// writing at the price of one row of writing. Below this, the residue
// carries to the next landing instead -- see the write meter's comment in
// read-metrics.ts for what that costs (at most the landing statement's
// own row, lost only if the object is evicted before the next one).
const MIN_ROWS_WRITTEN_LANDING = 2;

// Lands the write meter's running total into the CURRENT ingest hour.
//
// Called at every Durable Object entry point (relay.ts `metered`), inside
// the same execution context as the writes it describes and before that
// context returns. That timing is the correctness property, not a
// nicety: the accumulator is instance memory, this object hibernates
// between messages, and it wakes on the order of seventy times per cron
// interval -- so a flush on a timer, or one deferred to the next cron
// tick, would lose almost everything it measured, and lose more of it the
// quieter the relay is.
//
// Almost always a no-op. An event write has already landed its own total
// through insertEventRow's bucket bump, and a read-only request has
// nothing pending; what reaches here is the cron tick, the follow
// rebuild, a NIP-86 call, backfill's bookkeeping and the vanish drain --
// on the order of thirty writes a day.
//
// Rows read: 1 for the upsert's conflict check, and only when something
// actually lands. Scoped to "meter" so that trickle is named rather than
// swelling `unattributed`, which is the instrument's gap detector.
export function settleRowsWritten(sql: SqlStorage, nowSec: number): void {
  if (unlandedRowsWritten() < MIN_ROWS_WRITTEN_LANDING) return;
  withReadPath("meter", () => bumpIngestCounters(sql, hourBucket(nowSec), 0, 0, takeRowsWritten()));
}

// /api/stats `ingested24h` and `rowsWrittenToday`, out of the ingest-hour
// buckets in ONE statement.
//
// Both windows are suffixes of the same key range, which is why one seek
// answers both: `budgetSince` is the last 00:00 UTC and therefore always
// inside the last 24 hours, so its bucket is at or after the rolling
// window's first bucket. The range runs from there to the current hour --
// `ingested_at` is wall-clock write time, so nothing can be bucketed
// ahead of now.
//
// Rows read: at most 25, whatever E is, however busy the relay is and
// however many requests arrive. This replaced two window scans behind a
// five-minute cache row (`live_stats`), which cost ~1,200 rows every time
// the cache missed and made an unauthenticated GET worth rationing.
//
// `rowsWrittenToday` is exact at the boundary rather than approximate:
// 00:00 UTC is a whole number of hours, so the day's buckets are exactly
// the day's writes. `ingested24h` is whole hours and so spans 24-25h --
// the same fidelity trade countEvents24h makes, against a number that
// used to be up to five minutes stale.
export function readIngestCounts(
  sql: SqlStorage,
  nowSec: number,
  budgetSince: number,
): { ingested24h: number; ingestedGroup24h: number; rowsWrittenToday: number } {
  const row = sql
    .exec<{ ingested: number | null; grouped: number | null; written: number | null }>(
      `SELECT SUM(n) AS ingested,
              SUM(group_n) AS grouped,
              SUM(CASE WHEN hour >= ? THEN rows_written ELSE 0 END) AS written
         FROM ingest_hour_counts WHERE hour >= ?`,
      hourBucket(budgetSince),
      hourBucket(nowSec - 86400),
    )
    .toArray()[0];
  return {
    ingested24h: row?.ingested ?? 0,
    // Read out of the same bucket rows at no additional cost, and
    // subtracted before /api/stats reports anything -- see relay.ts
    // collectStats. The audit uses both halves.
    ingestedGroup24h: row?.grouped ?? 0,
    rowsWrittenToday: row?.written ?? 0,
  };
}

export interface CountAuditStatus {
  // Null means the audit has never run -- see the `last_drift` column
  // comment in schema.ts for why that must render differently from "ran
  // and found nothing".
  lastRanAt: number | null;
  // One string per disagreement the last completed run found, or null if
  // that run found none. Only meaningful when `lastRanAt` is non-null.
  drift: string[] | null;
}

// /api/stats `totalEvents`, `followCount` and the audit's own status, all
// from the one `maintained_counts` row. Rows read: 1 for the trio, whatever
// E and F are. Read together rather than separately because they live in
// one row and collectStats wants all of them.
export function readMaintainedCounts(
  sql: SqlStorage,
): { events: number; groupEvents: number; follows: number } & CountAuditStatus {
  const row = sql
    .exec<{
      events: number;
      group_events: number;
      follows: number;
      audited_at: number | null;
      last_drift: string | null;
    }>(`SELECT events, group_events, follows, audited_at, last_drift FROM maintained_counts`)
    .toArray()[0];
  return {
    events: row?.events ?? 0,
    // One more column off the row already being read: /api/stats reports
    // `events - groupEvents`, so a public poller cannot time group
    // arrivals off the total (schema.ts `group_events`).
    groupEvents: row?.group_events ?? 0,
    follows: row?.follows ?? 0,
    lastRanAt: row?.audited_at ?? null,
    drift: row?.last_drift ? (JSON.parse(row.last_drift) as string[]) : null,
  };
}

// The number of follows the write gate currently admits, maintained by
// ownership.ts refreshFollows. Rows written: 1, and only when the owner's
// contact list actually changes.
//
// Exported for refreshFollows and for nothing else. It lives here beside
// the counter it moves rather than in ownership.ts so the read and the
// write of this column sit in one file, the way the event counters do --
// but it is CALLED from inside refreshFollows' own write branches, not
// from its caller, which is the property that matters.
export function setFollowCount(sql: SqlStorage, follows: number): void {
  sql.exec(`UPDATE maintained_counts SET follows = ?`, follows);
}

// The `created_at` of the contact list the follow cache reflects -- not
// when that cache was last rebuilt, which is no longer a thing that
// happens on a schedule (ownership.ts refreshFollows).
//
// Rows read: 1. Every row in `follows` carries the same value (see
// schema.ts `follows`), so `LIMIT 1` is not a sample of the column, it IS
// the column -- which is why this needs no counter of its own. It was
// `MAX(fetched_at)` and cost F rows to pick one of F identical numbers.
export function followsListAt(sql: SqlStorage): number | null {
  return (
    sql.exec<{ fetched_at: number }>(`SELECT fetched_at FROM follows LIMIT 1`).toArray()[0]
      ?.fetched_at ?? null
  );
}

// /api/stats `events24h`: stored events whose own `created_at` falls in the
// last 24 hours -- what the owner has been posting, not what this relay
// took in (readIngestCounts' `ingested24h` answers that one).
//
// Rows read: at most 26, whatever E is and however busy the relay is. The
// range starts at the bucket containing (now - 86400) and cannot extend
// past the bucket an hour ahead of now, since limits.ts
// MAX_CREATED_AT_FUTURE_SECONDS refuses anything further ahead.
//
// The window is whole hours, so it covers between 24 and 25 hours rather
// than exactly 24 -- an event signed 24h40m ago still counts until the
// clock leaves its bucket. That is the one fidelity cost of the bucket
// table, and it replaces a figure that was exact to the second and up to
// SIX HOURS stale (it came from `stats_snapshot`), so the number on the
// page got considerably closer to the truth rather than further from it.
export function countEvents24h(
  sql: SqlStorage,
  nowSec: number,
): { total: number; group: number } {
  const row = sql
    .exec<{ n: number | null; grouped: number | null }>(
      `SELECT SUM(n) AS n, SUM(group_n) AS grouped FROM event_hour_counts WHERE hour >= ?`,
      hourBucket(nowSec - 86400),
    )
    .toArray()[0];
  // Both halves, from one statement over the same bucket rows: /api/stats
  // reports the difference, the audit checks each against the table.
  return { total: row?.n ?? 0, group: row?.grouped ?? 0 };
}

// Once-a-day proof that every maintained counter still matches the table
// it counts, called from relay.ts runCron.
//
// DETECT ONLY. It logs and returns; it never writes a corrected figure.
// A counter that repairs itself is a counter that erases the evidence of
// whatever broke it -- the drift would come back on the next occurrence of
// the same bug and be silently swallowed again, and the only symptom would
// be a number that is quietly wrong between repairs. A loud log line once
// a day and a figure that stays wrong until somebody looks is the strictly
// more useful failure.
//
// Rows read: E + F, once a day. One scan of `events` produces all FOUR
// event figures -- the total, the `created_at` window, the `ingested_at`
// window and the stamped cost in that window -- deliberately one
// statement rather than four, since each extra pass would be another E
// for an answer this one already has in hand; plus at most 26 + 25 bucket
// rows, plus a count over `follows`. Against the ~12E a day the stats snapshot used to spend
// recomputing these same numbers four times over, this is a quarter of the
// cost and it verifies rather than assumes.
//
// `follows` is audited here rather than trusted because it is maintained
// by a different function in a different file (ownership.ts
// refreshFollows) with its own two write branches. A counter's safety
// argument is about its choke point, and a second choke point is a second
// thing that can be wrong -- so it gets the same daily check, at F rows,
// which is the cost this whole change removed from the per-request path.
//
// Paced by `maintained_counts.audited_at` rather than by the cron's own
// frequency, so it stays daily whatever the cron schedule becomes.
export function auditMaintainedCounts(sql: SqlStorage, nowSec: number): void {
  const state = sql
    .exec<{ events: number; groupEvents: number; follows: number; audited_at: number | null }>(
      `SELECT events, group_events AS groupEvents, follows, audited_at FROM maintained_counts`,
    )
    .toArray()[0];
  if (state === undefined) return;
  if (state.audited_at !== null && nowSec - state.audited_at < 86400) return;

  const cutoff = hourBucket(nowSec - 86400);
  // One scan of `events`, four figures. Two more than it produced before
  // the ingest buckets existed, and deliberately in the same statement:
  // a second scan would be a second E for numbers the first pass already
  // has in hand.
  const actual = sql
    .exec<{
      total: number;
      groupTotal: number;
      windowed: number;
      groupWindowed: number;
      ingested: number;
      groupIngested: number;
      ingestedCost: number;
      ingestedCosted: number;
    }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(is_group), 0) AS groupTotal,
              COALESCE(SUM(CASE WHEN created_at / 3600 >= ? THEN 1 ELSE 0 END), 0) AS windowed,
              COALESCE(SUM(CASE WHEN created_at / 3600 >= ? THEN is_group ELSE 0 END), 0) AS groupWindowed,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? THEN 1 ELSE 0 END), 0) AS ingested,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? THEN is_group ELSE 0 END), 0) AS groupIngested,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? THEN row_cost ELSE 0 END), 0) AS ingestedCost,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? AND row_cost IS NOT NULL THEN 1 ELSE 0 END), 0) AS ingestedCosted
         FROM events`,
      cutoff,
      cutoff,
      cutoff,
      cutoff,
      cutoff,
      cutoff,
    )
    .toArray()[0] ?? {
    total: 0,
    groupTotal: 0,
    windowed: 0,
    groupWindowed: 0,
    ingested: 0,
    groupIngested: 0,
    ingestedCost: 0,
    ingestedCosted: 0,
  };
  const counted24h = countEvents24h(sql, nowSec);
  // The rolling half of the ingest buckets, on the same cutoff the scan
  // above used. `budgetSince` is passed as the rolling cutoff too, so
  // `rowsWrittenToday` here is a 24h figure rather than a since-midnight
  // one -- which is what the floor check below wants: it is comparing
  // against the cost of events ingested in the same 24 hours.
  const ingestBuckets = readIngestCounts(sql, nowSec, nowSec - 86400);
  const actualFollows =
    sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM follows`).toArray()[0]?.n ?? 0;

  // Collected alongside the console.error this function already made,
  // rather than replacing it: the console line is for whoever is
  // tailing logs at the moment this runs, and `driftMessages` is what
  // survives past that moment for /api/stats to read back tomorrow.
  const driftMessages: string[] = [];
  // `message` is what survives into `maintained_counts.last_drift`, which
  // /api/stats reads back -- and that endpoint is PUBLIC and
  // unauthenticated. `detail` is the part that goes only to the log line.
  // The split exists for the group membership check below, whose useful
  // detail is a list of pubkeys: naming them in `last_drift` would publish
  // part of this group's membership on the one document anybody can fetch,
  // which is the disclosure the whole partition exists to prevent. The
  // stored half therefore counts; the logged half names.
  const report = (message: string, where: string, detail = "") => {
    driftMessages.push(message);
    console.error(
      `MAINTAINED COUNT DRIFT: ${message}.${detail === "" ? "" : ` ${detail}.`} ` +
        `NOT corrected -- see storage.ts auditMaintainedCounts. ` +
        `Every write to the counted table must go through ${where}.`,
    );
  };
  const drift = (what: string, said: number, is: number, where: string) => {
    report(`${what} says ${said}, the table says ${is} (off by ${said - is})`, where);
  };

  if (actual.total !== state.events) {
    drift("maintained_counts.events", state.events, actual.total, "insertEventRow/deleteEventRow");
  }
  // The group halves are audited separately rather than folded into the
  // totals above, because they are what /api/stats SUBTRACTS: a group
  // counter that drifted low would put group events back on a public,
  // unauthenticated document one at a time, and a total that still
  // matched would say nothing was wrong.
  if (actual.groupTotal !== state.groupEvents) {
    drift(
      "maintained_counts.group_events",
      state.groupEvents,
      actual.groupTotal,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actual.windowed !== counted24h.total) {
    drift(
      "event_hour_counts, summed over the last 24h",
      counted24h.total,
      actual.windowed,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actual.groupWindowed !== counted24h.group) {
    drift(
      "event_hour_counts.group_n, summed over the last 24h",
      counted24h.group,
      actual.groupWindowed,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actualFollows !== state.follows) {
    drift("maintained_counts.follows", state.follows, actualFollows, "refreshFollows");
  }
  if (actual.ingested !== ingestBuckets.ingested24h) {
    drift(
      "ingest_hour_counts, summed over the last 24h",
      ingestBuckets.ingested24h,
      actual.ingested,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actual.groupIngested !== ingestBuckets.ingestedGroup24h) {
    drift(
      "ingest_hour_counts.group_n, summed over the last 24h",
      ingestBuckets.ingestedGroup24h,
      actual.groupIngested,
      "insertEventRow/deleteEventRow",
    );
  }
  // A FLOOR, not an equality, and that asymmetry is the whole check.
  // `rows_written` counts every row this relay wrote in the hour --
  // deletions, tombstones, follow rebuilds, NIP-86 calls, backfill
  // bookkeeping -- so it is expected to EXCEED the cost of the events
  // still standing from that hour, often by a lot. What it can never
  // legitimately do is fall below it: every one of those events was
  // stored, and storing it cost the `row_cost` stamped on it. Below the
  // floor means the meter lost writes, which is the one failure mode that
  // matters here -- an entry point that landed nothing before returning,
  // or a write reaching SQLite outside the wrapper.
  //
  // Detect only, like everything else in this function.
  //
  // AND IT IS COMPARED AGAINST THE MEASURED COST, NOT THE STAMPED ONE.
  // `row_cost` carries schema.ts eventRowCost, which is deliberately an
  // over-estimate: it counts each partial index PAIR twice where a row
  // pays one half (12 + 4T charged against 9 + 3T spent -- see
  // EVENT_BASE_ROW_COST for why that is left wrong). Every other consumer
  // of that number is a guard made stricter by over-charging; this one is
  // not. A floor set above what the meter can ever report is not a floor,
  // it is a drift line logged every single day, on the one check whose
  // value is that it fires rarely.
  //
  // So the stamped sum is converted back to what those events actually
  // cost, using the same two declarations it was built from: the tag rows
  // in the window are recovered from the stamped total, then re-priced at
  // the measured per-row figures. When the derivation is one day fixed,
  // measured and stamped become equal, this arithmetic collapses to
  // `ingestedCost`, and it should be deleted.
  //
  // Rows written before `row_cost` existed are excluded from both sides
  // (`ingestedCosted` counts only stamped rows), the same way they have
  // always been absent from the sum.
  const stampedPerEvent = EVENT_BASE_ROW_COST + EVENT_COUNTER_ROW_COST;
  const measuredPerEvent = EVENT_BASE_ROW_COST_MEASURED + EVENT_COUNTER_ROW_COST;
  const tagRowsInWindow = Math.max(
    0,
    (actual.ingestedCost - actual.ingestedCosted * stampedPerEvent) / TAG_ROW_COST,
  );
  const measuredCost = Math.floor(
    actual.ingestedCosted * measuredPerEvent + tagRowsInWindow * TAG_ROW_COST_MEASURED,
  );
  if (ingestBuckets.rowsWrittenToday < measuredCost) {
    drift(
      "ingest_hour_counts.rows_written, summed over the last 24h, is BELOW the cost of the events in it",
      ingestBuckets.rowsWrittenToday,
      measuredCost,
      "the read-metrics.ts wrapper, landed by storage.ts settleRowsWritten at every entry point",
    );
  }

  // NOT a counter, and the one check here that is about an invariant
  // between two tables rather than between a table and a number kept
  // alongside it. It lives in this function anyway because this is where
  // the daily pace is (schema.ts `maintained_counts`: "a single
  // `audited_at` is then what paces one daily audit over everything this
  // relay maintains, rather than two gates that could drift apart").
  //
  // What it checks: every NIP-29 group member has an `allowed_pubkeys`
  // row. Membership is the inner of two nested lists and the outer one is
  // what the write gate actually consults (src/nip29.ts), so a member
  // missing from it is a member who silently cannot write -- their events
  // are refused by ownership.ts isAllowedWriter with a message about
  // follows that says nothing about groups, and nothing anywhere connects
  // the cause to the effect. The two tables are written together by
  // nip29.ts applyModeration and can only come apart through a bug or a
  // hand-edit, which is exactly the class of thing a daily check is for.
  //
  // Detect only, like everything above it. Repairing the containment would
  // mean this function granting relay write access to a pubkey on the
  // strength of a row it has just decided it cannot trust -- the loudest
  // possible version of the objection schema.ts already makes to
  // self-healing counters.
  //
  // Rows read: M plus an indexed seek each, where M is the member count.
  const unallowedMembers = groupMembersWithoutAllowance(sql);
  if (unallowedMembers.length > 0) {
    report(
      `${unallowedMembers.length} group member(s) have no allowed_pubkeys row, so the relay-wide write ` +
        `gate refuses their events even though the group holds them as members`,
      "nip29.ts applyModeration, which writes both tables together",
      `Affected pubkeys: ${unallowedMembers.join(", ")}`,
    );
  }

  // Written whether or not anything disagreed: this records that the audit
  // RAN, which is what paces the next one. Recording it only on success
  // would make a drifting relay recount E rows on every cron tick.
  //
  // `last_drift` is stamped in the same statement as `audited_at` so the
  // two can never describe different runs -- a reader must never be able
  // to see this run's timestamp paired with a previous run's findings.
  // NULL, not an empty array, when nothing disagreed: schema.ts's
  // `last_drift` comment is why that distinction (never audited vs.
  // audited-and-clean) has to survive into what gets stored, not just
  // what gets displayed.
  sql.exec(
    `UPDATE maintained_counts SET audited_at = ?, last_drift = ?`,
    nowSec,
    driftMessages.length > 0 ? JSON.stringify(driftMessages) : null,
  );
}

// One-time correction for events that were flagged is_group = 1 for two
// reasons that turned out to be the same shape: groups.ts isGroupEvent
// used to accept ANY `h` tag as this relay's group, and separately used to
// accept ANY 39000-series event as this relay's group metadata regardless
// of who signed it. Two populations, one partition, one migration:
//
//   1. An ordinary `h`-tagged event backfilled from the owner's own
//      history that names some OTHER relay's NIP-29 group -- reached here
//      because backfill fetches wherever the owner's events were
//      published, not only what was written to this relay.
//   2. A 39000-series event NOT signed by this relay's own identity
//      (relay-identity.ts) -- reached the same way, and refused at the
//      source now (storeEvent below); this migration is what cleans up
//      any that got in before that refusal existed. Checked by SIGNER,
//      not by `d`, for the reason storeEvent's own comment gives: a
//      forged `d` reading TOP_LEVEL_GROUP_ID would defeat a `d`-tag check.
//
// Both make an event unreadable to anyone who is not a member of the one
// group this relay actually hosts -- population 1 hides a stranger's
// unrelated content behind a membership list that has nothing to do with
// it, population 2 sits in the partition as a second, indistinguishable
// candidate for "this group's member list" alongside the relay's genuine
// one, which is worse than hidden: it is ambiguous.
//
// THE TWO POPULATIONS ARE FIXED DIFFERENTLY, and that is deliberate.
// Population 1 is de-flagged into the PUBLIC partition -- it is somebody
// else's ordinary content, wrongly gated, and belongs there once ungated.
// Population 2 is DELETED outright, not de-flagged, because de-flagging
// alone does not close the ambiguity it exists to fix: an owner-or-member
// reader is the one actually entitled to ask `{"kinds":[39002]}`, and that
// reader's REQ merges BOTH partitions (relay.ts handleReqInner: `scopes =
// mayReadGroups ? ALL_SCOPES : [PUBLIC_SCOPE]`), so a de-flagged copy
// would still turn up alongside this relay's genuine member list -- the
// exact ambiguity this migration exists to end, surviving for the one
// audience it matters to. De-flagging population 2 would also be a NEW
// disclosure: an entirely ordinary, group-unrelated `{"authors":[owner]}`
// from an unauthenticated client would start returning it once it sat in
// the public partition, since filterNamesGroup only refuses a filter that
// NAMES a group or a metadata kind, and an authors-only filter does
// neither. Deletion is safe unconditionally because storeEvent's own
// signer check (below) means no event shaped like this can ever be
// re-admitted -- there is nothing left to preserve and nothing this purge
// could need to run twice for.
//
// BATCHED, and deliberately without a separate cursor. Every call asks the
// group partition's own indexes for up to `limit` candidates -- the same
// bounded-request shape hasVanishTargets/drainVanish already use to make a
// cost this relay cannot avoid a fixed one instead of a table scan. `limit`
// is VANISH_BATCH_SIZE at the one call site (relay.ts runCronInner) --
// reused rather than a constant invented for this, because both fixes
// share its cost shape: population 1's UPDATE moves a row's `is_group`
// between partitions, retiring its old partial-index entries and writing
// new ones, and population 2's DELETE removes them outright -- the same
// index-maintenance cost schema.ts eventRemovalBudget prices for a
// removal, which is exactly what VANISH_BATCH_SIZE is paced against.
//
// EACH CANDIDATE'S FIX RUNS INSIDE storage.transactionSync, which is what
// makes a crash mid-fix leave NO residue at all, rather than merely a
// SAFE one.
//
// Cloudflare's SQLite-backed Durable Object storage commits each
// `SqlStorage.exec()` call independently; there is no cross-statement
// atomicity without asking for it, and asking for it with raw SQL is
// refused outright ("please use the state.storage.transaction() or
// state.storage.transactionSync() APIs instead of the SQL BEGIN
// TRANSACTION or SAVEPOINT statements", confirmed against the real
// runtime). transactionSync's actual contract, also confirmed directly:
// an exception thrown inside its closure rolls back every write the
// closure made, including writes issued through instrumentSql's Proxy
// wrapper around the same underlying connection (relay.ts's `this.sql`
// is never the raw object). That is exactly what an interrupted cron
// tick needs: either the whole read-check-fix sequence for one candidate
// happened, or none of it did. A crash between population 1's `events`
// flip and its `event_tags` flip therefore cannot leave the two columns
// disagreeing -- the transaction that would have produced that
// disagreement never committed anything, and the SAME candidate query
// rediscovers the row on the next call exactly as it was before this
// call started. Same for population 2's deleteEventRow: either the row
// and its counters are gone, or nothing happened.
//
// This replaces an earlier version of this migration that relied on
// STATEMENT ORDERING instead -- candidacy keyed to whichever field the
// fix touched first, so a re-run could not double-decrement a counter.
// That version could still leave a stale `event_tags.is_group` behind on
// a crash between the two flips, reasoned about at the time as a safe,
// bounded, one-row residue. It was not: filters.ts buildFilterQuery's
// tag-filter subquery (`SELECT event_id FROM event_tags WHERE is_group =
// ? AND tag_name = ? AND tag_value IN (...)`) reads event_tags.is_group
// DIRECTLY to decide which ids a `#<letter>`-tag-filtered REQ returns, in
// whichever partition the reader is scoped to -- an access decision, not
// a cosmetic one, and "safe direction" was the wrong standard to hold it
// to. transactionSync removes the crash window the residue depended on,
// rather than reasoning about what it would have left behind.
//
// Guarded by relay_meta.group_scope_fixed exactly the way
// backfill_meta.exhaust_reset_applied guards backfill.ts
// resetWronglyExhaustedRelays: 0 until a call finds nothing left to fix,
// then permanently 1, so a relay with nothing wrong -- and every relay
// going forward, once this has run -- pays one bounded, index-seeked
// query and never asks again.
//
// Population 1's candidate id is still re-checked against the real,
// corrected isGroupEvent before anything is written -- an event can carry
// more than one `h` tag, and groupIdOf reads only the FIRST one, so a
// second, mismatched tag on an event that is genuinely ours must not be
// reclassified. Population 2 needs no such recheck: `pubkey` is a single
// column, not a repeatable tag, so the SQL condition IS the authoritative
// answer.
//
// A NOTE ON WHAT "BOUNDED" DOES NOT PROMISE, for population 1: an event
// with a genuinely matching FIRST `h` tag and an extra, different one
// after it is a false positive every single call re-selects and
// re-skips, so a relay holding one never sees group_scope_fixed flip to
// 1 -- every future cron tick pays this one bounded, index-seeked query
// forever rather than zero. That is still bounded (the same cost every
// time, never a scan that grows with E), just not self-terminating. No
// real NIP-29 client emits two `h` tags with different values, so this is
// a cost this relay accepts rather than a case worth a second piece of
// state to track.
export function fixMisclassifiedGroupEvents(
  sql: SqlStorage,
  storage: DurableObjectStorage,
  limit: number,
): number {
  const alreadyFixed =
    sql.exec<{ group_scope_fixed: number }>(`SELECT group_scope_fixed FROM relay_meta LIMIT 1`).toArray()[0]
      ?.group_scope_fixed ?? 1;
  if (alreadyFixed) return 0;

  const relayPubkey = getRelayPubkey(sql);

  const candidates = sql
    .exec<{ event_id: string }>(
      `SELECT DISTINCT event_id FROM (
         SELECT et.event_id FROM event_tags et JOIN events e ON e.id = et.event_id
          WHERE et.is_group = 1 AND e.is_group = 1 AND et.tag_name = 'h' AND et.tag_value <> ?
         UNION ALL
         SELECT id AS event_id FROM events
          WHERE is_group = 1 AND kind BETWEEN 39000 AND 39005 AND pubkey <> ?
       ) LIMIT ?`,
      TOP_LEVEL_GROUP_ID,
      relayPubkey,
      limit,
    )
    .toArray();

  if (candidates.length === 0) {
    sql.exec(`UPDATE relay_meta SET group_scope_fixed = 1`);
    return 0;
  }

  let fixed = 0;
  for (const { event_id } of candidates) {
    // The whole read-check-fix sequence for ONE candidate, atomically --
    // see the header comment above for why this is a transaction rather
    // than an ordering argument. Returns whether this candidate was
    // actually corrected, so a false positive (population 1's recheck) or
    // a row already gone (a previous call's completed fix) costs nothing
    // and changes nothing.
    const wasFixed = storage.transactionSync((): boolean => {
      const row = sql
        .exec<EventRow & { ingested_at: number | null }>(
          `SELECT id, pubkey, created_at, kind, tags, content, sig, ingested_at
             FROM events WHERE id = ? AND is_group = 1`,
          event_id,
        )
        .toArray()[0];
      if (row === undefined) return false;
      const event = rowToEvent(row);

      if (isGroupMetadataKind(event.kind)) {
        // Population 2 is PURGED, not reclassified -- de-flagging it
        // into the public partition would leave it exactly as ambiguous
        // as it was in the group partition, just for a different
        // audience. The owner-or-member reader who is actually entitled
        // to ask `{"kinds":[39002]}` reads BOTH partitions merged
        // (relay.ts handleReqInner: `scopes = mayReadGroups ?
        // ALL_SCOPES : [PUBLIC_SCOPE]`), so a de-flagged copy would still
        // turn up alongside this relay's genuine member list -- the
        // exact ambiguity the partition-only fix was supposed to end,
        // just surviving for the one audience it matters to. Worse, an
        // unauthenticated `{"authors":[owner]}` (an entirely ordinary
        // query, unrelated to groups) would start returning it once it
        // sat in the public partition, since filterNamesGroup only
        // refuses a filter that NAMES a group or a metadata kind -- an
        // authors-only filter does neither. Deletion is what
        // storeEvent's refusal made safe to do unconditionally: no
        // signer-mismatched event in this kind range can ever be
        // re-admitted, so there is nothing to preserve and nothing this
        // purge could need to run again for.
        //
        // deleteEventRow is the existing single removal choke point
        // (defined above in this file) -- reusing it means this pays
        // exactly the event_tags cleanup and counter decrements a live
        // NIP-09 deletion would, through the one place that keeps "what
        // an event is" and "what gets stored about it" in the same
        // lines of code.
        deleteEventRow(sql, event_id);
        return true;
      }

      // Population 1: the false-positive guard the header comment
      // describes. An event can carry more than one `h` tag, and
      // groupIdOf reads only the FIRST one, so a second, mismatched tag
      // on an event that is genuinely ours must not be reclassified.
      if (isGroupEvent(event)) return false;

      sql.exec(`UPDATE events SET is_group = 0 WHERE id = ?`, event_id);
      sql.exec(`UPDATE event_tags SET is_group = 0 WHERE event_id = ?`, event_id);
      // Mirrors bumpEventCounters'/deleteEventRow's decrement exactly,
      // minus the `events`/`n` halves -- this is a reclassification, not
      // a removal, so the total event count does not move, only which
      // half of it is "group".
      sql.exec(`UPDATE maintained_counts SET group_events = group_events - 1`);
      sql.exec(
        `UPDATE event_hour_counts SET group_n = group_n - 1 WHERE hour = ?`,
        hourBucket(row.created_at),
      );
      if (row.ingested_at !== null) {
        sql.exec(
          `UPDATE ingest_hour_counts SET group_n = group_n - 1 WHERE hour = ?`,
          hourBucket(row.ingested_at),
        );
      }
      return true;
    });
    if (wasFixed) fixed += 1;
  }
  return fixed;
}

// ---------------------------------------------------------------------
// THE PARTITION RULE, stated once and obeyed by every query below.
//
// Every stored event lives in exactly one partition of `events` --
// `is_group` 0 or 1 (src/groups.ts) -- and schema.ts declares the three
// REQ-serving indexes as partial PAIRS keyed on it. SQLite uses a partial
// index only for a query whose WHERE clause implies the index's own
// predicate, so:
//
//   pinned to one partition   the same plan, and the same cost, as before
//                             this column existed
//   pinned to neither         no index qualifies; SCAN events
//
// Measured at 50,000 group events, `SELECT id FROM events WHERE pubkey = ?
// AND kind = ?`: 2 rows read pinned, 51,500 unpinned.
//
// A lookup that is not about one partition in particular therefore runs
// once per partition and concatenates, which costs one extra seek and
// keeps every one of them index-served. Reads that ARE about one
// partition -- everything a REQ produces -- pin it directly instead.
//
// Primary-key lookups (`WHERE id = ?`) are exempt and always were:
// `sqlite_autoindex_events_1` is not partial, so an id seek needs no pin.
// ---------------------------------------------------------------------
export function eventExists(sql: SqlStorage, id: string): boolean {
  return sql.exec(`SELECT 1 FROM events WHERE id = ?`, id).toArray().length > 0;
}

// Tombstone check for the write path (relay.ts handleEvent) -- a plain
// `eventExists` can't tell a genuinely new id from one that was deleted
// and is being replayed, since deletion removes the row. See schema.ts's
// `deleted_ids` comment.
export function isDeleted(sql: SqlStorage, id: string): boolean {
  return sql.exec(`SELECT 1 FROM deleted_ids WHERE id = ?`, id).toArray().length > 0;
}

// Deletes an event and permanently blocks its id from ever being stored
// again -- the durability NIP-09/NIP-62 require. Only for genuine
// deletion requests (applyDeletion, applyAddressDeletion, applyVanish);
// `storeEvent`'s replaceable/addressable replacement path must keep using
// the untombstoned `deleteEventRow` -- see schema.ts.
function deleteAndTombstone(sql: SqlStorage, id: string): void {
  deleteEventRow(sql, id);
  sql.exec(`INSERT OR IGNORE INTO deleted_ids (id) VALUES (?)`, id);
}

// True while the database is still small enough to accept writes from
// someone other than the owner -- see limits.ts NON_OWNER_STORAGE_SHARE_LIMIT
// for why the threshold is measured against total size and what that
// reserves. `limit` is passed in because it is env-overridable and the
// caller (relay.ts acceptEvent) has already resolved it. `databaseSize`
// is a property read, not a query -- getStats reads the same one.
export function hasNonOwnerStorageHeadroom(sql: SqlStorage, limit: number): boolean {
  return sql.databaseSize < limit;
}

// Current count of stored gift wraps -- backs the maxGiftWraps cap
// (limits.ts) on the write path. A read against the 5,000,000/day
// rows-read ceiling, not the rows-written one -- see CLAUDE.md "The
// budget".
export function giftWrapCount(sql: SqlStorage): number {
  // Both partitions: nothing stops a sender putting an `h` tag on a gift
  // wrap, and a storage cap that only counted half of what it is capping
  // would be a cap with a hole in it. Two index counts rather than one --
  // measured at the same 500 rows the single count cost (the partial pair
  // holds between them exactly the rows the whole index held).
  return acrossScopes((scope) =>
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events WHERE kind = ? AND is_group = ?`,
        GIFT_WRAP_KIND,
        scope,
      )
      .toArray(),
  ).reduce((total, row) => total + row.n, 0);
}

interface StoreResult {
  ok: boolean;
  message: string;
  stored: NostrEvent | null;
}

// NIP-01 "Kinds" storage rules: regular kinds keep every event;
// replaceable/addressable kinds keep only the newest per key, with
// equal-`created_at` ties broken by the lowest id; ephemeral kinds are
// never written to a row at all -- `stored` is still set to the event so
// relay.ts's caller broadcasts it live, but nothing here inserts a row
// for it. Duplicate and already-expired checks happen before this is
// called (relay.ts).
export function storeEvent(sql: SqlStorage, event: NostrEvent, ingestedAt: number): StoreResult {
  if (isEphemeralKind(event.kind)) {
    return { ok: true, message: "", stored: event };
  }

  if (isReplaceableKind(event.kind)) {
    // Both partitions, because NIP-01 keys a replaceable event by
    // (pubkey, kind) and says nothing about groups: the newest one wins
    // whether or not either copy carries an `h` tag. Pinning only the
    // incoming event's own partition would have let one author hold two
    // "current" kind-10002s, one public and one group-scoped, which is a
    // protocol divergence bought for nothing -- see the partition rule
    // above for why the alternative (no pin at all) is a table scan.
    const existing = acrossScopes((scope) =>
      sql
        .exec<{ id: string; created_at: number }>(
          `SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND is_group = ?`,
          event.pubkey,
          event.kind,
          scope,
        )
        .toArray(),
    );
    if (existing.some((row) => isSupersededBy(row, event))) {
      return { ok: true, message: "", stored: null };
    }
    for (const row of existing) {
      deleteEventRow(sql, row.id);
    }
    insertEventRow(sql, event, expirationOf(event), ingestedAt);
    return { ok: true, message: "", stored: event };
  }

  if (isAddressableKind(event.kind)) {
    // NIP-29: 39000-series group metadata events "MUST be created by the
    // relay master key only... Relays shouldn't accept these events if
    // they're signed by anyone else." nip29.ts authorizeGroupWrite already
    // refuses every client-submitted one of these outright, unconditionally
    // -- but that gate sits ABOVE storeEvent, on the live write path only.
    // backfill.ts applyBackfillPage is the other caller of storeEvent, and
    // it bypasses that gate entirely: it can pull in anything the owner
    // ever personally signed, including a kind in this range signed under
    // their OWN key rather than the relay's, if they (or some client bug)
    // ever published one elsewhere.
    //
    // Checked by SIGNER, not by the `d` tag it carries. groups.ts
    // isGroupEvent used to accept a metadata-kind event with a missing or
    // empty `d` as "ours" on the reasoning that hiding is safer than
    // disclosing -- which protected against disclosure but not against
    // AMBIGUITY: a bare `{"kinds":[39002]}` still can't tell that
    // malformed row apart from this relay's own genuine member list, both
    // landing in the same partition. Checking the `d` value instead of the
    // signer would not have fixed that either -- a forged kind-39002
    // signed by the owner's own key with `d` set to read TOP_LEVEL_GROUP_ID
    // would pass a `d`-tag check and be genuinely indistinguishable from
    // this relay's real member list to any `#d`-scoped filter too. The
    // signer is the one thing a forgery cannot fake: only
    // relay-identity.ts signAsRelay ever produces a signature this check
    // accepts, and every event it signs (nip29.ts applyModeration) always
    // stamps `d` as TOP_LEVEL_GROUP_ID correctly -- so a metadata-kind
    // event that reaches insertEventRow below is guaranteed well-formed,
    // and groups.ts isGroupEvent no longer needs a malformed case at all.
    //
    // Refused the same way a superseded replacement is (ok: true, nothing
    // stored) rather than as a protocol-level error: the only caller that
    // reaches this branch with such an event is backfill, which reads
    // `stored` and nothing else (CLAUDE.md storage-semantics: "dropped
    // rather than stored" is the same rule ephemeral kinds follow above).
    if (isGroupMetadataKind(event.kind) && event.pubkey !== getRelayPubkey(sql)) {
      return { ok: true, message: "", stored: null };
    }
    const d = dTagValue(event.tags);
    // Both partitions, for the reason the replaceable branch above gives.
    const candidates = acrossScopes((scope) =>
      sql
        .exec<{ id: string; created_at: number; tags: string }>(
          `SELECT id, created_at, tags FROM events WHERE pubkey = ? AND kind = ? AND is_group = ?`,
          event.pubkey,
          event.kind,
          scope,
        )
        .toArray(),
    );
    const matching = candidates.filter((c) => dTagValue(JSON.parse(c.tags) as string[][]) === d);
    if (matching.some((c) => isSupersededBy(c, event))) {
      return { ok: true, message: "", stored: null };
    }
    for (const existing of matching) {
      deleteEventRow(sql, existing.id);
    }
    insertEventRow(sql, event, expirationOf(event), ingestedAt);
    return { ok: true, message: "", stored: event };
  }

  // Regular kinds, and the spec-undefined 45-999/>=40000 ranges, land
  // here and are stored like regular events: 45-999 holds live assigned
  // kinds, writes are owner-only so permissiveness costs nothing, and
  // storing too much is recoverable while rejecting the owner's own
  // events is not.
  insertEventRow(sql, event, expirationOf(event), ingestedAt);
  return { ok: true, message: "", stored: event };
}

// True when `candidate` loses to `existing` under NIP-01's replacement
// rule: higher created_at wins; on a tie, the lowest id wins.
function isSupersededBy(
  existing: { id: string; created_at: number },
  candidate: NostrEvent,
): boolean {
  if (existing.created_at > candidate.created_at) return true;
  if (existing.created_at === candidate.created_at && existing.id < candidate.id) return true;
  return false;
}

// NIP-09 deletion (nips/09.md): an `e` tag removes the referenced event
// by id (unless it is itself a deletion request -- "deleting a deletion
// request has no effect", line 53); an `a` tag removes replaceable/
// addressable versions at or before the deletion's created_at.
//
// Authorization on the `e`-tag path branches on the target's kind
//:
//   - target is a gift wrap (kind 1059): authorized iff the deletion's
//     pubkey appears in the target's `p` tags. NIP-59 gift wraps are
//     signed by a random one-time key, so the ordinary "same pubkey"
//     NIP-09 rule can never fire for them -- NIP-59's carve-out is that
//     the tagged recipient may delete instead.
//   - everything else: authorized iff `deletion.pubkey === target.pubkey`,
//     the standard NIP-09 same-author rule. This used to be true for
//     every row in `events` purely because the write gate
//     (ownership.ts isAllowedWriter) only ever let the owner (or a
//     follow) write anything -- so any deletion request the relay would
//     even accept already shared its pubkey with every existing row, and
//     this function didn't need to check. Gift wraps break that: kind
//     1059 is the one write-gate exception, so the table can now hold
//     rows whose pubkey has nothing to do with the deleter. This check
//     is made explicit rather than left resting on that invariant, since
//     it now only holds per-kind, not relay-wide -- getting it backwards
//     is exactly the permissive-direction mistake CLAUDE.md warns about:
//     a stranger deleting the owner's posts, or the owner's kind-5
//     deleting a stranger's gift wrap to someone else. (In practice
//     `deletion.pubkey` is always the owner here too, since kind-5 still
//     goes through the write gate -- but that's the accept-path's
//     promise, not this function's, and this function shouldn't depend
//     on a promise made elsewhere.)
export function applyDeletion(sql: SqlStorage, deletion: NostrEvent): void {
  for (const tag of deletion.tags) {
    if (tag[0] === "e" && tag[1]) {
      const target = sql
        .exec<{ kind: number; pubkey: string; tags: string }>(
          `SELECT kind, pubkey, tags FROM events WHERE id = ?`,
          tag[1],
        )
        .toArray()[0];
      if (!target || target.kind === 5) continue;
      const authorized =
        target.kind === GIFT_WRAP_KIND
          ? pTagValues(JSON.parse(target.tags) as string[][]).includes(deletion.pubkey)
          : target.pubkey === deletion.pubkey;
      if (authorized) deleteAndTombstone(sql, tag[1]);
    } else if (tag[0] === "a" && tag[1]) {
      applyAddressDeletion(sql, tag[1], deletion);
    }
  }
}

// NIP-09 `a` tags address replaceable and addressable events only --
// "<kind>:<pubkey>:<d-identifier>" names a coordinate that exists solely
// for kinds that have one. Regular events have no coordinate and are
// deleted by `e` tag, one id at a time.
//
// Accepting a regular kind here was a conformance bug with a sharp edge.
// `1:<pubkey>:` names no single event, so the branch below treated it as
// "every kind-1 event by that pubkey at or before the cutoff" and
// tombstoned all of them. One tag, unbounded N. That made
// MAX_EVENT_BYTES a bound on nothing for bulk deletion: the size cap
// limits a kind-5 to roughly 870 `e` tags, but a single `a` tag reached
// the same N with none of the effort, and each removal pays the DELETE
// above.
//
// Restricted to the kinds NIP-09 actually addresses, N per `a` tag is at
// most one stored event -- replaceable kinds keep one version per
// (pubkey, kind), addressable ones keep one per (pubkey, kind, d) -- so
// the byte cap becomes a real bound on what one deletion request can
// cost.
function applyAddressDeletion(sql: SqlStorage, address: string, deletion: NostrEvent): void {
  const [kindStr, pubkey, d = ""] = address.split(":");
  const kind = Number(kindStr);
  if (!Number.isInteger(kind) || pubkey !== deletion.pubkey) return;
  if (!isReplaceableKind(kind) && !isAddressableKind(kind)) return;

  // Both partitions on both branches: a NIP-09 deletion names an address,
  // and an author deleting their own address means all of it. See the
  // partition rule above.
  if (isAddressableKind(kind)) {
    const candidates = acrossScopes((scope) =>
      sql
        .exec<{ id: string; created_at: number; tags: string }>(
          `SELECT id, created_at, tags FROM events WHERE pubkey = ? AND kind = ? AND created_at <= ? AND is_group = ?`,
          pubkey,
          kind,
          deletion.created_at,
          scope,
        )
        .toArray(),
    );
    for (const c of candidates) {
      if (dTagValue(JSON.parse(c.tags) as string[][]) === d) deleteAndTombstone(sql, c.id);
    }
  } else {
    const candidates = acrossScopes((scope) =>
      sql
        .exec<{ id: string }>(
          `SELECT id FROM events WHERE pubkey = ? AND kind = ? AND created_at <= ? AND is_group = ?`,
          pubkey,
          kind,
          deletion.created_at,
          scope,
        )
        .toArray(),
    );
    for (const c of candidates) deleteAndTombstone(sql, c.id);
  }
}

// NIP-62 (nips/62.md) Request to Vanish, in two halves: this one records
// the request, and drainVanish below does the work.
//
// It is split because a vanish is the one request whose size is chosen by
// the sender and bounded by nothing this relay controls. Removing an
// event costs its tag rows, its own row and a tombstone (schema.ts
// eventRemovalRowsWritten), and the drain is paced against the
// pessimistic eventRemovalBudget -- so a pubkey with thousands of stored
// events cannot be vanished inside one request without exceeding the
// daily write budget partway through. Doing it inline anyway would leave the pubkey
// half-vanished while the OK frame said it had succeeded, and "fully
// delete" is the spec's word, so that is a compliance failure rather than
// a slow query.
//
// Recording first also makes the request durable: once this row exists,
// the drain resumes on the next cron tick whether or not the socket, the
// request or the Durable Object survived.
//
// Applied unconditionally against `requester` (the vanish event's own
// pubkey), matching the spec text rather than special-casing "if
// requester is the owner": "Relays MUST fully delete any events from the
// .pubkey" and "Relays SHOULD delete all NIP-59 Gift Wraps that p-tagged
// the .pubkey". Both clauses naturally do nothing for a requester who has
// no matching rows. Deliberately NOT routed through ownership.ts's
// isAllowedWriter -- unlike every other write path, a vanish request's
// authority comes from the requester vanishing their *own* data, not from
// relay-write permission, and the spec is explicit that write-restricted
// relays "MUST also follow the request to vanish regardless of the user's
// status." See deleteEventRow above for what that costs and why the index
// exists.
//
// `cutoffCreatedAt` is stored rather than recomputed on resume: it is the
// original request's created_at, and re-deriving it later would silently
// change which events the requester actually asked to remove.
export function beginVanish(
  sql: SqlStorage,
  requester: string,
  cutoffCreatedAt: number,
  nowSec: number,
): void {
  // ON CONFLICT keeps the WIDEST request rather than the newest. Two
  // vanish requests from one pubkey are unusual, but if the second names
  // an earlier cutoff, honouring it would narrow a deletion already
  // promised -- so the cutoff only ever moves outward.
  sql.exec(
    `INSERT INTO vanishing (pubkey, cutoff_created_at, requested_at) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET
         cutoff_created_at = MAX(cutoff_created_at, excluded.cutoff_created_at),
         requested_at = excluded.requested_at`,
    requester,
    cutoffCreatedAt,
    nowSec,
  );
}

// The set of events one vanish request covers, as one query, so
// drainVanish (which removes them) and hasVanishTargets (which asks
// whether there are any) cannot disagree about what a vanish means.
//
// Both NIP-62 clauses in one statement: events the requester authored,
// and (nips/62.md: "Relays SHOULD delete all NIP-59 Gift Wraps that
// p-tagged the .pubkey") gift wraps addressed to them. UNION rather than
// two queries so a single `limit` bounds the whole operation, and so a
// caller cannot finish the first clause, report done, and leave the
// second.
function vanishTargets(
  sql: SqlStorage,
  requester: string,
  cutoffCreatedAt: number,
  limit: number,
): { id: string }[] {
  // Once per partition, and the partition pin reaches the tag subquery too
  // -- see the partition rule above, and filters.ts for why a tag lookup
  // that names no partition cannot use the pair either. A vanish covers
  // everything the requester has here, group events included: NIP-62 binds
  // the relay to erase, and an erasure that skipped the partition the
  // requester happened to post in would be a compliance failure rather
  // than a saving.
  //
  // `limit` is applied per partition and again by the caller's slice, so
  // one drain batch stays bounded by the figure limits.ts paces it at.
  return acrossScopes((scope) =>
    sql
      .exec<{ id: string }>(
        `SELECT id FROM events WHERE pubkey = ? AND created_at <= ? AND is_group = ?
         UNION
         SELECT id FROM events WHERE kind = ? AND created_at <= ? AND is_group = ?
           AND id IN (SELECT event_id FROM event_tags WHERE is_group = ? AND tag_name = 'p' AND tag_value = ?)
         LIMIT ?`,
        requester,
        cutoffCreatedAt,
        scope,
        GIFT_WRAP_KIND,
        cutoffCreatedAt,
        scope,
        scope,
        requester,
        limit,
      )
      .toArray(),
  ).slice(0, limit);
}

// Whether this relay holds anything a vanish request would remove.
//
// A READ standing in front of a WRITE, and that is the whole point.
// beginVanish below used to be called unconditionally, so a vanish from
// a pubkey with nothing stored still wrote a checkpoint row -- which
// drainVanish then deleted again on finding no targets, having deleted
// nothing. Measured over the wire: 4 rows written per request, from a
// path that runs before every write gate the relay has (NIP-62 binds
// write-restricted relays to honour a vanish "regardless of the user's
// status", so that ordering is correct and cannot change) and needs no
// prior relationship with the relay at all. At the ~20 requests/second
// the per-IP message throttle permits, that is ~1,730,000 rows/day
// against a 100,000/day ceiling: the owner stops being able to publish
// about ninety minutes in.
//
// NIP-62 requires the relay to honour the request. It does not require
// paying rows to remember a request with nothing to do -- a vanish over
// an empty set is complete the moment it is asked, and the honest answer
// costs one seek.
export function hasVanishTargets(sql: SqlStorage, requester: string, cutoffCreatedAt: number): boolean {
  return vanishTargets(sql, requester, cutoffCreatedAt, 1).length > 0;
}

// The cutoff of a vanish already checkpointed for this pubkey, or null if
// none is pending.
//
// Backs handleVanish's dedupe: a signed vanish event is replayable by
// anyone who has ever seen it, forever, and each replay re-ran
// beginVanish (a write) and a fresh drain batch (up to VANISH_BATCH_SIZE
// removals) for a request already in progress. Read back and compared
// against the incoming request's own cutoff, a replay is recognised for
// what it is and costs one row read. Only a request that would WIDEN the
// pending one gets to write, which is the same rule beginVanish's
// ON CONFLICT already applies -- stated as a read in front of the write
// rather than as a write that happens to change nothing.
export function pendingVanishCutoff(sql: SqlStorage, requester: string): number | null {
  const row = sql
    .exec<{ cutoff_created_at: number }>(
      `SELECT cutoff_created_at FROM vanishing WHERE pubkey = ?`,
      requester,
    )
    .toArray()[0];
  return row?.cutoff_created_at ?? null;
}

export interface VanishProgress {
  deleted: number;
  // True once nothing is left to remove for this pubkey, at which point
  // the `vanishing` row is gone and the request is complete.
  done: boolean;
}

// Removes up to `limit` of one pubkey's events, newest first, and clears
// the checkpoint once nothing is left. Safe to call repeatedly; calling
// it for a pubkey with no `vanishing` row is a no-op.
//
// Both NIP-62 clauses drain through one query (vanishTargets above) so a
// single limit bounds the whole operation, and so "what a vanish covers"
// has one definition that hasVanishTargets asks the same question of.
export function drainVanish(sql: SqlStorage, requester: string, limit: number): VanishProgress {
  const row = sql
    .exec<{ cutoff_created_at: number; deleted_so_far: number }>(
      `SELECT cutoff_created_at, deleted_so_far FROM vanishing WHERE pubkey = ?`,
      requester,
    )
    .toArray()[0];
  if (!row) return { deleted: 0, done: true };

  const targets = vanishTargets(sql, requester, row.cutoff_created_at, limit);

  for (const target of targets) deleteAndTombstone(sql, target.id);

  // Fewer than asked for means the set is exhausted. Checked against the
  // limit rather than by re-running the query, which would cost a second
  // pass over the same index for an answer this already implies.
  const done = targets.length < limit;
  if (done) {
    sql.exec(`DELETE FROM vanishing WHERE pubkey = ?`, requester);
  } else {
    sql.exec(
      `UPDATE vanishing SET deleted_so_far = ? WHERE pubkey = ?`,
      row.deleted_so_far + targets.length,
      requester,
    );
  }
  return { deleted: targets.length, done };
}

// ---------------------------------------------------------------------
// `ingested24h` and `rowsWrittenToday` used to live here, in a cache row
// (`live_stats`) on a five-minute clock, with readLiveStats/
// computeLiveStats/writeLiveStats around it and a `liveAt` field on
// /api/stats to state how stale they were.
//
// All of it is gone. Both figures are bucket counters now
// (readIngestCounts above, schema.ts `ingest_hour_counts`), read at at
// most 25 rows in one statement, so there is no expensive read left for a
// clock to ration -- the same ending `stats_snapshot` came to when
// `events24h` was bucketed, one release earlier. That is twice now, and
// it is the lesson limits.ts records where costs get priced: a TTL over
// an expensive read bounds how often you pay it, not what it costs, and
// it survives only until somebody makes the read cheap. Reach for the
// counter first and the clock second.
//
// Nothing on /api/stats answers to a clock any more, and `liveAt` went
// with the last one that did.
// ---------------------------------------------------------------------

export interface PendingVanish {
  pubkey: string;
  deletedSoFar: number;
  requestedAt: number;
}

// Vanish requests still draining -- read by relay.ts runCron to resume
// them. Oldest first, so a request cannot be starved by newer ones
// arriving.
//
// INTERNAL ONLY: these rows name pubkeys, and pubkeys are what a vanish
// request exists to disassociate from this relay. /api/stats takes
// vanishSummary below instead.
export function pendingVanishes(sql: SqlStorage): PendingVanish[] {
  return sql
    .exec<{ pubkey: string; deleted_so_far: number; requested_at: number }>(
      `SELECT pubkey, deleted_so_far, requested_at FROM vanishing ORDER BY requested_at ASC`,
    )
    .toArray()
    .map((r) => ({ pubkey: r.pubkey, deletedSoFar: r.deleted_so_far, requestedAt: r.requested_at }));
}

export interface VanishSummary {
  // How many pubkeys have a drain in progress.
  pending: number;
  // Events removed so far across all of them.
  deletedSoFar: number;
  // When the oldest pending request arrived, or null if none is pending
  // -- what makes a stalled drain visible.
  oldestRequestedAt: number | null;
}

// What /api/stats publishes about vanish requests, and deliberately not
// pendingVanishes above.
//
// /api/stats is unauthenticated and public, and it used to carry the
// `vanishing` rows verbatim, pubkey included -- so anyone could read off
// which identities had asked this relay to erase them, which is close to
// the opposite of what asking bought them. The operational question the
// admin page asks ("is a drain stuck?") is answered by a count, a
// progress total and an age; none of those name anyone.
//
// One row read: three aggregates over a table that is empty except while
// a vanish is draining.
export function vanishSummary(sql: SqlStorage): VanishSummary {
  const row = sql
    .exec<{ pending: number; deleted: number; oldest: number | null }>(
      `SELECT COUNT(*) AS pending, COALESCE(SUM(deleted_so_far), 0) AS deleted,
              MIN(requested_at) AS oldest
         FROM vanishing`,
    )
    .toArray()[0];
  return {
    pending: row?.pending ?? 0,
    deletedSoFar: row?.deleted ?? 0,
    oldestRequestedAt: row?.oldest ?? null,
  };
}

// What a READER is allowed to see, as opposed to what one query asks for.
//
// `scopes` is the partitions of `events` this read covers: the public rows
// alone for every unauthenticated client, both for a reader the relay has
// authorised (relay.ts handleReqInner). It is a list rather than a boolean
// because it is not a filter condition -- each partition is a separate
// query, for the reason filters.ts FilterQueryOptions.scope gives.
export interface ReadOptions {
  excludeGiftWraps?: boolean;
  // Owner-only, and NOT implied by `scopes` covering the group partition:
  // a member reads the group and does not read the invite codes in it
  // (groups.ts CREATE_INVITE_KIND). Two separate permissions, so two
  // separate options.
  excludeInvites?: boolean;
  scopes?: readonly GroupScope[];
}

export function queryFilter(
  sql: SqlStorage,
  filter: Filter,
  nowSec: number,
  options: ReadOptions = {},
): NostrEvent[] {
  const scopes = options.scopes ?? [PUBLIC_SCOPE];
  const parts = expandFilter(filter);
  const perQuery = (scope: GroupScope): FilterQueryOptions => ({
    ...(options.excludeGiftWraps === undefined ? {} : { excludeGiftWraps: options.excludeGiftWraps }),
    ...(options.excludeInvites === undefined ? {} : { excludeInvites: options.excludeInvites }),
    scope,
    // The tag scan budget is shared across the partitions this read
    // covers, so an authorised read costs what limits.ts prices a tag
    // filter at rather than twice it -- see FilterQueryOptions.
    tagScanDivisor: scopes.length,
  });

  const onlyPart = parts[0];
  const onlyScope = scopes[0];
  if (parts.length === 1 && scopes.length === 1 && onlyPart !== undefined && onlyScope !== undefined) {
    return runFilterQuery(sql, onlyPart, nowSec, perQuery(onlyScope));
  }

  const byId = new Map<string, NostrEvent>();
  for (const scope of scopes) {
    for (const part of parts) {
      for (const event of runFilterQuery(sql, part, nowSec, perQuery(scope))) byId.set(event.id, event);
    }
  }
  const merged = [...byId.values()].sort(compareEvents);
  return filter.limit === undefined ? merged : merged.slice(0, filter.limit);
}

function runFilterQuery(
  sql: SqlStorage,
  filter: Filter,
  nowSec: number,
  options?: FilterQueryOptions,
): NostrEvent[] {
  const query = buildFilterQuery(filter, nowSec, options);
  if (query === null) return [];
  return sql
    .exec<EventRow>(query.sql, ...query.params)
    .toArray()
    .map(rowToEvent);
}

// Rows written in the last 24h, summed from the per-event `row_cost`
// column each INSERT stamps (schema.ts eventRowCost, storage.ts
// insertEventRow). A read-only estimate, not a tracked counter -- see
// limits.ts/relay.ts comments on why this relay avoids extra writes just
// to measure itself. Backs /api/stats's `rowsWrittenToday`
// (relay.ts getStats) and backfill's own headroom check (backfill.ts
// hasBackfillHeadroom: backfill must yield to the owner's live traffic
// rather than compete with it for the same daily ceiling) -- both need
// the same number, so it lives here once rather
// than being computed twice and risking drift between what the admin page
// displays and what backfill actually throttles against.
//
// Measured by `ingested_at` -- when this relay actually wrote the row --
// and never by `created_at`, which is when the author says they signed
// it. Filtering on created_at made this function report rows
// attributable to events *timestamped* in the window, so backfill's
// writes (carrying years-old timestamps) were invisible to it: 729
// reported against 33,000 actually written. See schema.ts's
// `ingested_at` comment for the full account.
//
// Rows read: E, where E is every row in `events`. It was E + T until
// v0.7.2, and that join is the single change in this file that mattered
// most to the read budget. The old query derived each event's tag count
// live:
//
//   SELECT COUNT(t.event_id) FROM events e
//   LEFT JOIN event_tags t ON t.event_id = e.id
//   WHERE e.ingested_at > ? GROUP BY e.id
//
// `idx_event_tags_lookup` is (tag_name, tag_value, created_at) and
// `event_id` appears nowhere in it, so SQLite resolved that join by
// building an automatic index over the whole of `event_tags` -- reading
// every tag row in the table to answer a question about the handful of
// events in the 24h window. The cost tracked the TABLE, not the window.
// backfill.ts hasBackfillHeadroom calls this twice per cron tick, so on
// an hourly cron that one query was ~288E rows read per day, and at
// E ~= 17,400 it was the entire 5,000,000/day ceiling on its own with no
// client connected (CLAUDE.md "The budget").
//
// Summing a stamped column removed the join outright and never touches
// `event_tags` at all. What remained was a scan of `events` itself,
// because `ingested_at` led no index: E rows read to add up the rows in
// a 24h window. That was left in place deliberately, on the grounds that
// indexing `ingested_at` would cost a row write per event -- the exact
// cost stamping the column had been chosen to avoid -- and that cutting
// the floor from ~288E to ~48E was enough.
//
// It was not enough, and the reason is that E is not a constant. A cost
// proportional to everything ever stored, paid twice per cron tick
// forever, gets worse as the relay fills whether or not anything else
// changes; it was the last remaining line in CLAUDE.md "The budget"'s
// cron floor, binding at E ~= 104,000. Measured live at E = 4,232:
// 4,224 rows read per call, which is to say it read the entire table to
// answer a question about roughly a thousand rows.
//
// idx_events_ingested (schema.ts, v0.7.6) is (ingested_at, row_cost),
// covering, so this is now a range seek answered from the index without
// visiting the table: the size of the WINDOW, not the size of E, and it
// scales with the day's ingest instead of with the accumulated history.
// The price is one row written per stored event, ~1,100/day here against
// 100,000. The reasoning that finally justified paying it is on the
// index itself.
//
// Still an estimate, and still named one. It sums the cost of rows
// currently standing for events ingested in the window, which is not
// quite the same as every row written in it: a row written and then
// deleted inside the same window drops out. Rows written before
// `row_cost` existed carry NULL and are absent from the SUM entirely,
// which undercounts for at most the one 24h window straddling an
// upgrade. Both make this a floor rather than a ceiling, which is the
// safe direction for the budget guard in backfill.ts
// hasBackfillHeadroom -- it will never believe there is less headroom
// than there is, only more, and the reserved-half rule
// (BACKFILL_ROWS_SHARE_LIMIT) is what absorbs the difference.
//
// IT COUNTS INSERTIONS ONLY, AND IT IS NO LONGER THE WRITE-BUDGET
// METER. `row_cost` is stamped by insertEventRow and nothing else, so no
// deletion this relay performs appears in this number -- not the delete
// half of a replaceable replacement, not NIP-09, not NIP-62 vanish, not
// NIP-86 banevent, and not the tombstone any of them writes. Nor does
// anything this relay writes that is not an event row: the follow cache
// rebuild (ownership.ts refreshFollows, 900 rows at 300 follows), the
// NIP-86 ban and settings tables, backfill's cursor bookkeeping. Every
// one of those is a real write against the same 100,000/day ceiling.
//
// This comment used to end by saying to read the number as "rows written
// STORING events, not rows written", because /api/stats displayed it as
// the write-budget meter and the understatement was on the page. That is
// no longer where the meter comes from. `rowsWrittenToday` is now
// MEASURED -- every cursor's rowsWritten, accumulated by the wrapper in
// read-metrics.ts and landed in an ingest-hour bucket by
// settleRowsWritten above -- so the display counts everything and this
// function has exactly one caller left.
//
// That caller is backfill.ts hasBackfillHeadroom, and the omission is
// correct for it, which is why the function survives rather than being
// replaced by the measured figure. The guard asks "may backfill write
// more" and compares against BACKFILL_ROWS_SHARE_LIMIT, half the
// ceiling; deletion traffic is bounded by its own reserved share
// (limits.ts VANISH_ROWS_SHARE_LIMIT, a quarter) and cannot eat into
// backfill's half however busy it gets. A guard protecting one share does
// not need to see writes already bounded away from it.
//
// So the two numbers are deliberately different and neither feeds the
// other: this one is a projection over stamped per-event costs, sized to
// a reservation, and the meter is a measurement of what was actually
// spent. Wiring the meter into this guard would make backfill yield to
// traffic it is already insulated from; wiring this into the meter would
// put the old understatement back on the admin page.
export function estimateRowsWrittenSince(sql: SqlStorage, sinceCutoff: number): number {
  return withReadPath("estimateRowsWrittenSince", () => estimateRowsWrittenSinceInner(sql, sinceCutoff));
}

// Scoped separately from whichever path called it (read-metrics.ts):
// getStats displays this number once per admin page load, but
// backfill.ts hasBackfillHeadroom calls it twice per cron tick, and
// nothing in the /api/stats breakdown would distinguish those if this
// inherited its caller's bucket. It was for a long time the single most
// expensive line in the fixed daily floor, which is reason enough to
// keep its own line in the report now that it is not -- a path that
// stops being expensive is worth being able to see stay that way.
function estimateRowsWrittenSinceInner(sql: SqlStorage, sinceCutoff: number): number {
  return (
    sql
      .exec<{ total: number | null }>(
        `SELECT SUM(row_cost) AS total FROM events WHERE ingested_at > ?`,
        sinceCutoff,
      )
      .toArray()[0]?.total ?? 0
  );
}

// Multiple filters in one REQ are ORed (nips/01.md line 129) and
// deduped/re-sorted as a single result set, newest-first with ties
// broken by lowest id -- matching the ordering a single filter's query
// would produce.
export function queryFilters(
  sql: SqlStorage,
  filters: Filter[],
  nowSec: number,
  options?: ReadOptions,
): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const filter of filters) {
    for (const event of queryFilter(sql, filter, nowSec, options)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort(compareEvents);
}

// ---------------------------------------------------------------------
// NIP-86 relay management (src/nip86.ts) storage. None of the queries
// below run on the per-event write path or the REQ read path -- bans and
// settings are written at operator pace, and the only one that runs on a
// client-facing path at all is isIpBlocked, called exactly once per
// WebSocket connection in Relay.fetch(). See schema.ts for the tables.
// ---------------------------------------------------------------------

export interface BannedEvent {
  id: string;
  reason: string | null;
}

// Records the ban AND tombstones the id. Both are needed and they do
// different jobs: `banned_events` is the operator-visible record that
// listbannedevents reads back, while the `deleted_ids` tombstone is what
// actually stops the event from coming back -- a re-send from a client or
// a replay from backfill (backfill.ts applyBackfillPage checks isDeleted)
// would otherwise restore an event the operator just banned. Banning an
// id that isn't stored is meaningful for exactly that reason: the
// tombstone refuses it on arrival.
export function banEvent(sql: SqlStorage, id: string, reason: string | null, nowSec: number): void {
  deleteAndTombstone(sql, id);
  sql.exec(
    `INSERT INTO banned_events (id, reason, banned_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at`,
    id,
    reason,
    nowSec,
  );
}

// The ONLY place in this codebase that deletes a row from `deleted_ids`,
// deliberately and by NIP-86's definition of allowevent. Everywhere else
// a tombstone is permanent on purpose: `deleted_ids` exists so a NIP-09
// or NIP-62 deletion sticks even though the sender still holds a signed
// copy they could replay (see schema.ts). Lifting it here is safe only
// because the operator is the relay owner and is explicitly asking for
// this id to become storable again -- which also means allowevent will
// un-delete an id that was tombstoned by a NIP-09 deletion rather than by
// banevent, if the owner passes one. That is the operator's call to make;
// do not "fix" it by restricting the delete to ids present in
// banned_events, since an id banned before it ever arrived has no other
// way back.
export function allowEvent(sql: SqlStorage, id: string): void {
  sql.exec(`DELETE FROM banned_events WHERE id = ?`, id);
  sql.exec(`DELETE FROM deleted_ids WHERE id = ?`, id);
}

// Reads `banned_events`, never `deleted_ids` -- listing every tombstone
// would report the owner's own NIP-09 deletions and NIP-62 vanish
// requests as "banned events", which they are not.
export function listBannedEvents(sql: SqlStorage): BannedEvent[] {
  return sql
    .exec<{ id: string; reason: string | null }>(
      `SELECT id, reason FROM banned_events ORDER BY banned_at DESC`,
    )
    .toArray();
}

export interface BlockedIp {
  ip: string;
  reason: string | null;
}

// ip is canonicalized (ip.ts normalizeIp) before it ever reaches storage
// or a comparison, at all three call sites here plus the self-block check
// in nip86.ts -- the same address written two different ways (an
// operator's hand-typed, expanded IPv6 vs. Cloudflare's own compressed
// CF-Connecting-IP) must resolve to the same key, or a block stored under
// one spelling silently fails to match connections presenting the other:
// listblockedips would read the row back as "blocked" while the
// connection-time check below never fires. See ip.ts for the full
// reasoning.
export function blockIp(sql: SqlStorage, ip: string, reason: string | null, nowSec: number): void {
  sql.exec(
    `INSERT INTO blocked_ips (ip, reason, blocked_at) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at`,
    normalizeIp(ip),
    reason,
    nowSec,
  );
}

export function unblockIp(sql: SqlStorage, ip: string): void {
  sql.exec(`DELETE FROM blocked_ips WHERE ip = ?`, normalizeIp(ip));
}

export function listBlockedIps(sql: SqlStorage): BlockedIp[] {
  return sql
    .exec<{ ip: string; reason: string | null }>(`SELECT ip, reason FROM blocked_ips ORDER BY blocked_at DESC`)
    .toArray();
}

// One indexed lookup, run once per WebSocket connection in Relay.fetch()
// -- never per message and never per event, so an IP block costs nothing
// on the hot path. The management endpoint never calls this: see
// src/nip86.ts.
export function isIpBlocked(sql: SqlStorage, ip: string): boolean {
  return sql.exec(`SELECT 1 FROM blocked_ips WHERE ip = ?`, normalizeIp(ip)).toArray().length > 0;
}

// The stored rung of the relay identity chain (nip11.ts) -- what
// changerelayname/changerelaydescription/changerelayicon write. Absent
// keys read back as null; there is no "" value, because clearing deletes
// the row (see setRelaySetting).
export interface RelaySettings {
  name: string | null;
  description: string | null;
  icon: string | null;
}

export function getRelaySettings(sql: SqlStorage): RelaySettings {
  const rows = sql.exec<{ key: string; value: string }>(`SELECT key, value FROM relay_settings`).toArray();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    name: byKey.get("name") ?? null,
    description: byKey.get("description") ?? null,
    icon: byKey.get("icon") ?? null,
  };
}

// An empty string clears the stored value rather than storing one --
// NIP-86 defines no unset operation, so this is bothy's convention for
// falling back down the chain (README.md "Relay management API"). Storing
// "" instead would be indistinguishable from a deliberate empty name and
// would shadow the kind-0 and hardcoded rungs forever.
export function setRelaySetting(sql: SqlStorage, key: "name" | "description" | "icon", value: string): void {
  if (value === "") {
    sql.exec(`DELETE FROM relay_settings WHERE key = ?`, key);
    return;
  }
  sql.exec(
    `INSERT INTO relay_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

// ---------------------------------------------------------------------
// NIP-86 phase two (src/nip86.ts): banpubkey/unbanpubkey/listbannedpubkeys
// and allowpubkey/unallowpubkey/listallowedpubkeys. Unlike everything else
// in this section, isPubkeyBanned and isPubkeyAllowed below DO run on the
// per-event write path (ownership.ts isAllowedWriter) -- see schema.ts for
// the cost accounting.
// ---------------------------------------------------------------------

export interface BannedPubkey {
  pubkey: string;
  reason: string | null;
}

export function banPubkey(sql: SqlStorage, pubkey: string, reason: string | null, nowSec: number): void {
  sql.exec(
    `INSERT INTO banned_pubkeys (pubkey, reason, banned_at) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at`,
    pubkey,
    reason,
    nowSec,
  );
}

export function unbanPubkey(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM banned_pubkeys WHERE pubkey = ?`, pubkey);
}

export function listBannedPubkeys(sql: SqlStorage): BannedPubkey[] {
  return sql
    .exec<{ pubkey: string; reason: string | null }>(
      `SELECT pubkey, reason FROM banned_pubkeys ORDER BY banned_at DESC`,
    )
    .toArray();
}

// The write-path check -- one indexed lookup per non-owner write, run
// before the follows check (ownership.ts isAllowedWriter) so a banned
// pubkey is refused even if it is also a follow.
export function isPubkeyBanned(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM banned_pubkeys WHERE pubkey = ?`, pubkey).toArray().length > 0;
}

export interface AllowedPubkey {
  pubkey: string;
  reason: string | null;
}

// The NIP-86 allowpubkey path, and the only one that writes
// `source = 'owner'`. An existing row is PROMOTED rather than left alone:
// an operator typing this command means the grant to outlive whatever the
// group does next, and a kind-9001 remove-user must not be able to revoke
// it afterwards. See schema.ts `allowed_pubkeys.source`.
export function allowPubkey(sql: SqlStorage, pubkey: string, reason: string | null, nowSec: number): void {
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source) VALUES (?, ?, ?, 'owner')
       ON CONFLICT(pubkey) DO UPDATE SET reason = excluded.reason, allowed_at = excluded.allowed_at,
                                         source = 'owner'`,
    pubkey,
    reason,
    nowSec,
  );
}

// ---------------------------------------------------------------------
// NIP-29 group membership (src/nip29.ts), and the group's half of the
// allowlist beside it. Two nested lists: a row in `group_members` says a
// pubkey may write `h`-tagged events, a row in `allowed_pubkeys` says it
// may write here at all, and a member needs both -- see schema.ts
// `allowed_pubkeys.source` for why the second one has to remember who
// created it.
// ---------------------------------------------------------------------

// The row a new member needs in order to reach the relay at all -- written
// by kind-9000 put-user and by a redeemed kind-9021 join request, which is
// why the reason is the caller's to supply rather than a constant here.
// DO NOTHING on conflict rather than an upsert. A pubkey already carrying
// an owner-granted allowance keeps it as owner-granted: put-user must
// never demote a deliberate grant into one remove-user can reclaim, which
// an upsert writing `source = 'invite'` would do silently. And a pubkey
// already carrying an invite-granted one needs nothing changed.
export function allowPubkeyForGroup(
  sql: SqlStorage,
  pubkey: string,
  reason: string,
  nowSec: number,
): void {
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source)
       VALUES (?, ?, ?, 'invite')
       ON CONFLICT(pubkey) DO NOTHING`,
    pubkey,
    reason,
    nowSec,
  );
}

// The inverse, and deliberately narrower than "delete the row": only what
// the group itself granted comes back out. `AND source = 'invite'` is the
// whole point of that column.
export function revokeGroupAllowance(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM allowed_pubkeys WHERE pubkey = ? AND source = 'invite'`, pubkey);
}

export function addGroupMember(sql: SqlStorage, pubkey: string, nowSec: number): void {
  sql.exec(`INSERT INTO group_members (pubkey, added_at) VALUES (?, ?) ON CONFLICT(pubkey) DO NOTHING`,
    pubkey, nowSec);
}

export function removeGroupMember(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM group_members WHERE pubkey = ?`, pubkey);
}

// The write-path check (nip29.ts authorizeGroupWrite). Reached only for an
// event carrying an `h` tag whose author is not the owner, so ordinary
// traffic never pays it.
export function isGroupMember(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM group_members WHERE pubkey = ?`, pubkey).toArray().length > 0;
}

// Ordered by pubkey, which makes the regenerated kind-39002 member list a
// function of the member SET alone. That is what lets nip29.ts decide
// whether to write a new one by comparing tags: ordered by `added_at`
// instead, removing a member and adding them back would move them to the
// end and rewrite an event whose membership had not changed.
export function listGroupMembers(sql: SqlStorage): string[] {
  return sql
    .exec<{ pubkey: string }>(`SELECT pubkey FROM group_members ORDER BY pubkey ASC`)
    .toArray()
    .map((r) => r.pubkey);
}

// Group members with no `allowed_pubkeys` row: the containment the two
// nested lists are supposed to have, checked once a day by
// auditMaintainedCounts above. M rows plus an indexed seek each, where M
// is the member count.
export function groupMembersWithoutAllowance(sql: SqlStorage): string[] {
  return sql
    .exec<{ pubkey: string }>(
      `SELECT m.pubkey FROM group_members m
         LEFT JOIN allowed_pubkeys a ON a.pubkey = m.pubkey
        WHERE a.pubkey IS NULL
        ORDER BY m.added_at ASC`,
    )
    .toArray()
    .map((r) => r.pubkey);
}

// ---------------------------------------------------------------------
// NIP-29 invite codes (src/nip29.ts). One row per kind-9009 the owner
// publishes; the row, not the event, is what a kind-9021 join request is
// checked against -- see schema.ts `group_invites`.
// ---------------------------------------------------------------------

export interface GroupInvite {
  code: string;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  redeemed_by: string | null;
  revoked_at: number | null;
}

// What a presented code turned out to be. Four of the five are refusals,
// and nip29.ts collapses all of them into ONE message on the wire -- this
// distinction exists for the owner's log line and for the NIP-86 methods,
// never for the person who presented the code. See handleJoinRequest.
export type InviteOutcome = "redeemed" | "unknown" | "revoked" | "spent" | "expired";

export function lookupInvite(sql: SqlStorage, code: string): GroupInvite | null {
  return (
    sql
      .exec<{
        code: string;
        created_at: number;
        expires_at: number;
        redeemed_at: number | null;
        redeemed_by: string | null;
        revoked_at: number | null;
      }>(
        `SELECT code, created_at, expires_at, redeemed_at, redeemed_by, revoked_at
           FROM group_invites WHERE code = ?`,
        code,
      )
      .toArray()[0] ?? null
  );
}

export function createInvite(sql: SqlStorage, code: string, createdAt: number, expiresAt: number): void {
  sql.exec(
    `INSERT INTO group_invites (code, created_at, expires_at) VALUES (?, ?, ?)`,
    code,
    createdAt,
    expiresAt,
  );
}

// Outstanding means redeemable right now: unspent, unrevoked, unexpired.
// The same three conditions as listUnusedInvites below and as the
// redeemable branch of redeemInvite -- stated three times because they
// are three different statements, and kept identical because a row this
// count admits and a redemption refuses would be a cap the owner cannot
// clear by using the invites it is counting.
export function countOutstandingInvites(sql: SqlStorage, nowSec: number): number {
  return (
    sql
      .exec<{
        n: number
      }>(
        `SELECT COUNT(*) AS n FROM group_invites
          WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        nowSec,
      )
      .toArray()[0]?.n ?? 0
  );
}

export interface UnusedInvite {
  code: string;
  created_at: number;
  expires_at: number;
}

export function listUnusedInvites(sql: SqlStorage, nowSec: number): UnusedInvite[] {
  return sql
    .exec<{ code: string; created_at: number; expires_at: number }>(
      `SELECT code, created_at, expires_at FROM group_invites
        WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      nowSec,
    )
    .toArray();
}

// Classify, then spend -- both here, so SINGLE USE is a property of one
// statement rather than of a caller's ordering.
//
// The UPDATE repeats every condition the SELECT above just checked, which
// looks redundant and is not the same claim: the SELECT decides what to
// TELL the owner, the UPDATE decides what to WRITE, and only the second
// one has to be safe against two redemptions of the same code. A Durable
// Object is single-threaded and nothing awaits between these two
// statements, so today they cannot disagree; the guard is what keeps that
// true if a future caller ever puts something between them.
//
// The classification order is revoked, then spent, then expired, because
// a row can be more than one at once and the owner wants the most
// decisive reason: an invite that was revoked and has since also lapsed
// was revoked, and saying "expired" would describe the clock instead of
// the act.
export function redeemInvite(
  sql: SqlStorage,
  code: string,
  pubkey: string,
  nowSec: number,
): InviteOutcome {
  const invite = lookupInvite(sql, code);
  if (invite === null) return "unknown";
  if (invite.revoked_at !== null) return "revoked";
  if (invite.redeemed_at !== null) return "spent";
  if (invite.expires_at <= nowSec) return "expired";
  sql.exec(
    `UPDATE group_invites SET redeemed_at = ?, redeemed_by = ?
      WHERE code = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    nowSec,
    pubkey,
    code,
    nowSec,
  );
  return "redeemed";
}

// What a revoke did. A separate type from InviteOutcome above, which
// describes a REDEMPTION -- reusing it would have made "revoked" mean
// "this revoke succeeded" in one function and "this code was already dead
// when you presented it" in the other.
export type RevokeOutcome = "revoked" | "unknown" | "spent" | "already-revoked";

// NIP-86 revokeinvite (src/nip86.ts). Says exactly why a revoke did
// nothing -- here the caller IS the owner, so there is nobody to keep the
// distinction from, which is the opposite of the join path's rule.
//
// A spent invite is left alone rather than marked revoked: it is already
// unusable, and overwriting its history would lose `redeemed_by`, which
// is the only record of who the code let in.
//
// An EXPIRED but unspent invite is revoked normally rather than reported
// as already-dead. The owner saying they meant it dead outlives the clock
// having made it so, and the row is what an admin reads back later.
export function revokeInvite(sql: SqlStorage, code: string, nowSec: number): RevokeOutcome {
  const invite = lookupInvite(sql, code);
  if (invite === null) return "unknown";
  if (invite.revoked_at !== null) return "already-revoked";
  if (invite.redeemed_at !== null) return "spent";
  sql.exec(`UPDATE group_invites SET revoked_at = ? WHERE code = ? AND redeemed_at IS NULL`, nowSec, code);
  return "revoked";
}

export function unallowPubkey(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM allowed_pubkeys WHERE pubkey = ?`, pubkey);
}

export function listAllowedPubkeys(sql: SqlStorage): AllowedPubkey[] {
  return sql
    .exec<{ pubkey: string; reason: string | null }>(
      `SELECT pubkey, reason FROM allowed_pubkeys ORDER BY allowed_at DESC`,
    )
    .toArray();
}

// The write-path check -- ownership.ts isAllowedWriter only calls this on
// the path already about to reject a write (owner-only mode, or "not a
// follow"), so it costs nothing on the common accept path.
export function isPubkeyAllowed(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM allowed_pubkeys WHERE pubkey = ?`, pubkey).toArray().length > 0;
}

// ---------------------------------------------------------------------
// Web push subscriptions (src/push.ts, src/nip86.ts subscribepush).
//
// The pubkey on every row here is the one the NIP-98 signature proved,
// never one a request body offered -- see schema.ts `push_subscriptions`.
// These functions take it as a parameter and never derive it, so there is
// no path through this file where a body could reach that column.
// ---------------------------------------------------------------------

export interface PushSubscriptionRow {
  endpoint: string;
  pubkey: string;
  p256dh: string;
  auth: string;
}

// The same row plus the only column the fan-out reads and does not send:
// when this endpoint last worked, which decides whether a success is
// worth a row write at all (limits.ts PUSH_LAST_OK_INTERVAL_SECONDS).
export interface PushFanoutRow extends PushSubscriptionRow {
  last_ok_at: number | null;
}

// Registers or refreshes one endpoint, evicting this pubkey's oldest if
// they are already at the cap.
//
// An upsert rather than an insert, because a browser hands the same
// endpoint back on every load once it has one (hearth's subscribeToPush
// reuses `getSubscription()`), and because the keys behind an endpoint
// can legitimately change. Rebinding an endpoint to a DIFFERENT pubkey is
// allowed for the same reason: an endpoint belongs to a browser profile,
// and a household laptop signed into one npub and then another is one
// endpoint that genuinely changed hands. The row moving means the old
// pubkey stops receiving on it, which is the correct outcome.
export function upsertPushSubscription(
  sql: SqlStorage,
  row: PushSubscriptionRow,
  perPubkeyCap: number,
  nowSec: number,
): void {
  sql.exec(
    `INSERT INTO push_subscriptions (endpoint, pubkey, p256dh, auth, created_at, last_ok_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(endpoint) DO UPDATE SET
         pubkey = excluded.pubkey,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         created_at = excluded.created_at`,
    row.endpoint,
    row.pubkey,
    row.p256dh,
    row.auth,
    nowSec,
  );
  // Oldest out, not newest refused. A browser that rotates its endpoint
  // -- which they do, on their own schedule and without telling anyone --
  // would otherwise fill a member's four slots with dead rows and lock
  // them out of their own notifications, with the newest registration,
  // the only live one, being the one turned away.
  //
  // `rowid DESC` breaks the tie, and it is load-bearing rather than
  // tidy: `created_at` is a whole second, and four devices registered by
  // one person setting up their phone and laptop land inside one. Ordered
  // by endpoint instead, the survivor would be whichever string sorted
  // first -- which is to say arbitrary, and specifically NOT the
  // registration that just arrived. `endpoint` is a TEXT primary key and
  // so not a rowid alias, which is what leaves the implicit rowid free to
  // carry insertion order.
  sql.exec(
    `DELETE FROM push_subscriptions
       WHERE pubkey = ?
         AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE pubkey = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
    row.pubkey,
    row.pubkey,
    perPubkeyCap,
  );
}

// Scoped to the pubkey that signed the call, not to the endpoint alone.
// Without the `AND pubkey = ?` any member holding a valid NIP-98 key
// could unsubscribe anybody else's device by naming its endpoint --
// endpoints are not secrets to the people who have seen a fan-out fail,
// and silently turning somebody's notifications off is a quieter kind of
// damage than turning them on.
export function deletePushSubscription(sql: SqlStorage, pubkey: string, endpoint: string): boolean {
  const before = sql
    .exec(`SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND pubkey = ?`, endpoint, pubkey)
    .toArray().length;
  if (before === 0) return false;
  sql.exec(`DELETE FROM push_subscriptions WHERE endpoint = ? AND pubkey = ?`, endpoint, pubkey);
  return true;
}

// Deletes by endpoint alone -- the disposal path, for an endpoint the
// push service itself reported gone (404/410). No pubkey to scope it to:
// the authority here is the push service, not a caller.
export function forgetPushEndpoint(sql: SqlStorage, endpoint: string): void {
  sql.exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint);
}

// One page of the fan-out. Ordered by endpoint and resumed by endpoint
// (schema.ts `push_outbox.cursor`) so a subscription added or removed
// mid-fan-out cannot shift the page boundary underneath the cursor, which
// a rowid offset would.
export function pushSubscriptionsAfter(
  sql: SqlStorage,
  after: string | null,
  limit: number,
): PushFanoutRow[] {
  return sql
    .exec<{
      endpoint: string;
      pubkey: string;
      p256dh: string;
      auth: string;
      last_ok_at: number | null;
    }>(
      `SELECT endpoint, pubkey, p256dh, auth, last_ok_at FROM push_subscriptions
         WHERE endpoint > ? ORDER BY endpoint ASC LIMIT ?`,
      after ?? "",
      limit,
    )
    .toArray();
}

export function markPushEndpointOk(sql: SqlStorage, endpoint: string, nowSec: number): void {
  sql.exec(`UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?`, nowSec, endpoint);
}

export function countPushSubscriptions(sql: SqlStorage): number {
  const row = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM push_subscriptions`).toArray()[0];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------
// The push outbox (schema.ts `push_outbox`, relay.ts drainPushOutbox).
// At most two rows -- one per notification reason -- because messages
// arriving in the same few seconds are one notification.
// ---------------------------------------------------------------------

export interface PushOutboxRow {
  reason: string;
  actors: string[];
  queued_at: number;
  cursor: string | null;
  sent: number;
}

// Queues a notification, or folds this occurrence into the one already
// queued for the same reason.
//
// Folding does NOT reset `cursor` or `sent`: a fan-out already halfway
// through its endpoints keeps going rather than starting again, so a busy
// room cannot make the drain restart forever and never reach the last
// member. It does add the new actor, so somebody who has just posted is
// not pushed about their own message even when it arrived after the row
// did.
export function queuePush(sql: SqlStorage, reason: string, actor: string, nowSec: number): void {
  const existing = sql
    .exec<{ actors: string }>(`SELECT actors FROM push_outbox WHERE reason = ?`, reason)
    .toArray()[0];
  if (existing === undefined) {
    sql.exec(
      `INSERT INTO push_outbox (reason, actors, queued_at, cursor, sent) VALUES (?, ?, ?, NULL, 0)`,
      reason,
      JSON.stringify([actor]),
      nowSec,
    );
    return;
  }
  const actors = parseActors(existing.actors);
  if (actors.includes(actor)) return;
  actors.push(actor);
  sql.exec(`UPDATE push_outbox SET actors = ? WHERE reason = ?`, JSON.stringify(actors), reason);
}

// A stored column parsed back, so a row written by some future version --
// or corrupted -- degrades into "exclude nobody" rather than throwing
// inside the alarm and stalling every pending notification.
function parseActors(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function pendingPushes(sql: SqlStorage): PushOutboxRow[] {
  return sql
    .exec<{ reason: string; actors: string; queued_at: number; cursor: string | null; sent: number }>(
      `SELECT reason, actors, queued_at, cursor, sent FROM push_outbox ORDER BY queued_at ASC`,
    )
    .toArray()
    .map((row) => ({ ...row, actors: parseActors(row.actors) }));
}

export function advancePush(sql: SqlStorage, reason: string, cursor: string, sent: number): void {
  sql.exec(`UPDATE push_outbox SET cursor = ?, sent = ? WHERE reason = ?`, cursor, sent, reason);
}

export function clearPush(sql: SqlStorage, reason: string): void {
  sql.exec(`DELETE FROM push_outbox WHERE reason = ?`, reason);
}

// ---------------------------------------------------------------------
// Call presence (schema.ts `presence`, limits.ts's presence block).
//
// Read and written at most once per PRESENCE_WRITE_INTERVAL_SECONDS per
// pubkey -- relay.ts's in-memory tier is what keeps the seven beats in
// between from reaching this file at all.
// ---------------------------------------------------------------------

export function lastPresenceAt(sql: SqlStorage, pubkey: string): number | null {
  const row = sql
    .exec<{ last_seen: number }>(`SELECT last_seen FROM presence WHERE pubkey = ?`, pubkey)
    .toArray()[0];
  return row?.last_seen ?? null;
}

export function recordPresence(sql: SqlStorage, pubkey: string, nowSec: number): void {
  sql.exec(
    `INSERT INTO presence (pubkey, last_seen) VALUES (?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET last_seen = excluded.last_seen`,
    pubkey,
    nowSec,
  );
}

// A deliberate departure: hearth publishes a kind-25051 with
// `{"status":"leave"}` when somebody closes the call, and honouring it
// means their next arrival is announced however soon it comes. Without
// this, leaving and coming back inside PRESENCE_STALE_SECONDS would be
// silent -- which is the right default for a dropped connection and the
// wrong one for somebody who said they were going.
export function clearPresence(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM presence WHERE pubkey = ?`, pubkey);
}
