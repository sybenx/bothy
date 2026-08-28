import { buildFilterQuery, compareEvents, expandFilter } from "./filters";
import { eventRowCost } from "./schema";
import { withReadPath } from "./read-metrics";
import { normalizeIp } from "./ip";
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
  sql.exec(
    `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  // Rows written: 2 per stored event, on top of the 6 + 3T the row itself
  // costs -- see schema.ts eventRowCost. The UPDATE is one row in a
  // one-row table with no index; the upsert is one row in a rowid-aliased
  // table with no index. CLAUDE.md "The budget" carries the arithmetic.
  bumpEventCounters(sql, event.created_at, 1);
  for (const tag of indexedTags) {
    sql.exec(
      `INSERT INTO event_tags (tag_name, tag_value, event_id, created_at) VALUES (?, ?, ?, ?)`,
      tag[0],
      tag[1],
      event.id,
      event.created_at,
    );
  }
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
    .exec<{ created_at: number }>(`SELECT created_at FROM events WHERE id = ?`, id)
    .toArray()[0];
  sql.exec(`DELETE FROM event_tags WHERE event_id = ?`, id);
  sql.exec(`DELETE FROM events WHERE id = ?`, id);
  // After the DELETE, mirroring insertEventRow: a decrement that ran ahead
  // of a statement that then threw would leave the counters describing
  // fewer events than are stored.
  if (row !== undefined) bumpEventCounters(sql, row.created_at, -1);
}

// One hour of `created_at`, as schema.ts `event_hour_counts` keys it.
//
// Math.trunc, not Math.floor, because SQLite's integer `/` truncates
// toward zero and the seed migration (schema.ts seedEventCounters) and the
// daily audit below both bucket in SQL. They differ only for negative
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
function bumpEventCounters(sql: SqlStorage, createdAt: number, delta: 1 | -1): void {
  sql.exec(`UPDATE maintained_counts SET events = events + ?`, delta);
  if (delta === 1) {
    sql.exec(
      `INSERT INTO event_hour_counts (hour, n) VALUES (?, 1)
         ON CONFLICT(hour) DO UPDATE SET n = n + 1`,
      hourBucket(createdAt),
    );
  } else {
    sql.exec(`UPDATE event_hour_counts SET n = n - 1 WHERE hour = ?`, hourBucket(createdAt));
  }
}

// /api/stats `totalEvents` and `followCount`, both from the one
// `maintained_counts` row. Rows read: 1 for the pair, whatever E and F are.
// Read together rather than separately because they live in one row and
// collectStats wants both.
export function readMaintainedCounts(sql: SqlStorage): { events: number; follows: number } {
  const row = sql
    .exec<{ events: number; follows: number }>(`SELECT events, follows FROM maintained_counts`)
    .toArray()[0];
  return { events: row?.events ?? 0, follows: row?.follows ?? 0 };
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
// took in (countIngested24h answers that one).
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
export function countEvents24h(sql: SqlStorage, nowSec: number): number {
  return (
    sql
      .exec<{ n: number | null }>(
        `SELECT SUM(n) AS n FROM event_hour_counts WHERE hour >= ?`,
        hourBucket(nowSec - 86400),
      )
      .toArray()[0]?.n ?? 0
  );
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
// Rows read: E + F, once a day. One scan of `events` produces both event
// figures -- deliberately one statement rather than two, since two would
// be 2E for the same answer -- plus at most 26 bucket rows, plus a count
// over `follows`. Against the ~12E a day the stats snapshot used to spend
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
    .exec<{ events: number; follows: number; audited_at: number | null }>(
      `SELECT events, follows, audited_at FROM maintained_counts`,
    )
    .toArray()[0];
  if (state === undefined) return;
  if (state.audited_at !== null && nowSec - state.audited_at < 86400) return;

  const cutoff = hourBucket(nowSec - 86400);
  const actual = sql
    .exec<{ total: number; windowed: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN created_at / 3600 >= ? THEN 1 ELSE 0 END), 0) AS windowed
         FROM events`,
      cutoff,
    )
    .toArray()[0] ?? { total: 0, windowed: 0 };
  const counted24h = countEvents24h(sql, nowSec);
  const actualFollows =
    sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM follows`).toArray()[0]?.n ?? 0;

  const drift = (what: string, said: number, is: number, where: string) =>
    console.error(
      `MAINTAINED COUNT DRIFT: ${what} says ${said}, the table says ${is} ` +
        `(off by ${said - is}). NOT corrected -- see storage.ts auditMaintainedCounts. ` +
        `Every write to the counted table must go through ${where}.`,
    );

  if (actual.total !== state.events) {
    drift("maintained_counts.events", state.events, actual.total, "insertEventRow/deleteEventRow");
  }
  if (actual.windowed !== counted24h) {
    drift(
      "event_hour_counts, summed over the last 24h",
      counted24h,
      actual.windowed,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actualFollows !== state.follows) {
    drift("maintained_counts.follows", state.follows, actualFollows, "refreshFollows");
  }

  // Written whether or not anything disagreed: this records that the audit
  // RAN, which is what paces the next one. Recording it only on success
  // would make a drifting relay recount E rows on every cron tick.
  sql.exec(`UPDATE maintained_counts SET audited_at = ?`, nowSec);
}

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
  return (
    sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`, GIFT_WRAP_KIND).toArray()[0]
      ?.n ?? 0
  );
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
    const existing = sql
      .exec<{ id: string; created_at: number }>(
        `SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ?`,
        event.pubkey,
        event.kind,
      )
      .toArray()[0];
    if (existing && isSupersededBy(existing, event)) {
      return { ok: true, message: "", stored: null };
    }
    if (existing) {
      deleteEventRow(sql, existing.id);
    }
    insertEventRow(sql, event, expirationOf(event), ingestedAt);
    return { ok: true, message: "", stored: event };
  }

  if (isAddressableKind(event.kind)) {
    const d = dTagValue(event.tags);
    const candidates = sql
      .exec<{ id: string; created_at: number; tags: string }>(
        `SELECT id, created_at, tags FROM events WHERE pubkey = ? AND kind = ?`,
        event.pubkey,
        event.kind,
      )
      .toArray();
    const existing = candidates.find((c) => dTagValue(JSON.parse(c.tags) as string[][]) === d);
    if (existing && isSupersededBy(existing, event)) {
      return { ok: true, message: "", stored: null };
    }
    if (existing) {
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

  if (isAddressableKind(kind)) {
    const candidates = sql
      .exec<{ id: string; created_at: number; tags: string }>(
        `SELECT id, created_at, tags FROM events WHERE pubkey = ? AND kind = ? AND created_at <= ?`,
        pubkey,
        kind,
        deletion.created_at,
      )
      .toArray();
    for (const c of candidates) {
      if (dTagValue(JSON.parse(c.tags) as string[][]) === d) deleteAndTombstone(sql, c.id);
    }
  } else {
    const candidates = sql
      .exec<{ id: string }>(
        `SELECT id FROM events WHERE pubkey = ? AND kind = ? AND created_at <= ?`,
        pubkey,
        kind,
        deletion.created_at,
      )
      .toArray();
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
// Both NIP-62 clauses drain through one query so a single limit bounds
// the whole operation: events the requester authored, and gift wraps
// p-tagging them. Deleting the union in one pass also means the caller
// cannot finish the first clause, report done, and leave the second.
export function drainVanish(sql: SqlStorage, requester: string, limit: number): VanishProgress {
  const row = sql
    .exec<{ cutoff_created_at: number; deleted_so_far: number }>(
      `SELECT cutoff_created_at, deleted_so_far FROM vanishing WHERE pubkey = ?`,
      requester,
    )
    .toArray()[0];
  if (!row) return { deleted: 0, done: true };

  const targets = sql
    .exec<{ id: string }>(
      `SELECT id FROM events WHERE pubkey = ? AND created_at <= ?
       UNION
       SELECT id FROM events WHERE kind = ? AND created_at <= ?
         AND id IN (SELECT event_id FROM event_tags WHERE tag_name = 'p' AND tag_value = ?)
       LIMIT ?`,
      requester,
      row.cutoff_created_at,
      GIFT_WRAP_KIND,
      row.cutoff_created_at,
      requester,
      limit,
    )
    .toArray();

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
// The last cached figures on /api/stats (schema.ts `live_stats`), on the
// five-minute clock of limits.ts LIVE_STATS_MAX_AGE_MS.
//
// They sat beside a second cache, `stats_snapshot`, on a six-hour clock
// over the counts that walked a table. That one is gone: every field it
// held is a maintained counter now or deleted, so there is nothing left
// for a clock to ration. These two survive because what they measure
// genuinely cannot be maintained the same way -- `rowsWrittenToday` is a
// sum over a window that empties at 00:00 UTC and `ingested24h` a rolling
// count by ingest time, and neither is a quantity any single write knows
// how to increment toward. Cached, therefore, rather than counted.
// ---------------------------------------------------------------------

export interface LiveStats {
  // Wall-clock seconds this was computed at -- /api/stats `liveAt`.
  computedAt: number;
  // The 00:00 UTC boundary `rowsWrittenToday` was measured from. See
  // readLiveStats' caller: a row from yesterday is invalid however fresh.
  budgetSince: number;
  ingested24h: number;
  rowsWrittenToday: number;
}

// Null when nothing has computed one yet. Same reasoning as
// readStatsSnapshot: no seeded row, because a zeroed cache and a real one
// would be indistinguishable and the zeroes would be a lie about the
// relay's budget rather than a harmless placeholder.
//
// Rows read: 1.
export function readLiveStats(sql: SqlStorage): LiveStats | null {
  const row = sql
    .exec<{
      computed_at: number;
      budget_since: number;
      ingested_24h: number;
      rows_written_today: number;
    }>(`SELECT * FROM live_stats LIMIT 1`)
    .toArray()[0];
  if (row === undefined) return null;
  return {
    computedAt: row.computed_at,
    budgetSince: row.budget_since,
    ingested24h: row.ingested_24h,
    rowsWrittenToday: row.rows_written_today,
  };
}

// Rows read: the ingest window twice over -- roughly (events ingested in
// the last 24h) + (events ingested since 00:00 UTC), both served by
// idx_events_ingested and neither proportional to E. Measured at ~1,200
// on the live relay. This is the whole cost the row exists to stop paying
// per request; limits.ts LIVE_STATS_MAX_AGE_MS is the arithmetic for how
// often paying it is affordable.
//
// estimateRowsWrittenSince keeps its own read-metrics scope inside here,
// so the diagnostics on /api/stats still bill it separately -- which now
// also means its bucket only moves on a cache MISS, and a run of stats
// requests that leaves it flat is the cache working.
export function computeLiveStats(
  sql: SqlStorage,
  nowSec: number,
  budgetSince: number,
): LiveStats {
  return {
    computedAt: nowSec,
    budgetSince,
    ingested24h: countIngested24h(sql, nowSec - 86400),
    rowsWrittenToday: estimateRowsWrittenSince(sql, budgetSince),
  };
}

// Replaced wholesale, like the snapshot above and for the same reason.
//
// Rows written: 2 (1 the first time, when there is nothing to delete).
// The table carries no primary key and no index, so neither statement
// pays for one.
export function writeLiveStats(sql: SqlStorage, live: LiveStats): void {
  sql.exec(`DELETE FROM live_stats`);
  sql.exec(
    `INSERT INTO live_stats (computed_at, budget_since, ingested_24h, rows_written_today)
     VALUES (?, ?, ?, ?)`,
    live.computedAt,
    live.budgetSince,
    live.ingested24h,
    live.rowsWrittenToday,
  );
}

export interface PendingVanish {
  pubkey: string;
  deletedSoFar: number;
  requestedAt: number;
}

// Vanish requests still draining -- read by relay.ts runCron to resume
// them, and surfaced on /api/stats so a stalled one is visible rather
// than inferred. Oldest first, so a request cannot be starved by newer
// ones arriving.
export function pendingVanishes(sql: SqlStorage): PendingVanish[] {
  return sql
    .exec<{ pubkey: string; deleted_so_far: number; requested_at: number }>(
      `SELECT pubkey, deleted_so_far, requested_at FROM vanishing ORDER BY requested_at ASC`,
    )
    .toArray()
    .map((r) => ({ pubkey: r.pubkey, deletedSoFar: r.deleted_so_far, requestedAt: r.requested_at }));
}

export function queryFilter(sql: SqlStorage, filter: Filter, nowSec: number): NostrEvent[] {
  const parts = expandFilter(filter);
  const only = parts[0];
  if (parts.length === 1 && only !== undefined) return runFilterQuery(sql, only, nowSec);

  const byId = new Map<string, NostrEvent>();
  for (const part of parts) {
    for (const event of runFilterQuery(sql, part, nowSec)) byId.set(event.id, event);
  }
  const merged = [...byId.values()].sort(compareEvents);
  return filter.limit === undefined ? merged : merged.slice(0, filter.limit);
}

function runFilterQuery(sql: SqlStorage, filter: Filter, nowSec: number): NostrEvent[] {
  const query = buildFilterQuery(filter, nowSec);
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
// IT COUNTS INSERTIONS ONLY. `row_cost` is stamped by insertEventRow and
// nothing else, so no deletion this relay performs appears in this number
// -- not the delete half of a replaceable replacement, not NIP-09, not
// NIP-62 vanish, not NIP-86 banevent, and not the tombstone any of them
// writes. Every one of those is a real write against the same 100,000/day
// ceiling this figure exists to describe.
//
// That is correct for the guard and wrong for the display, and the two
// callers want different things from it:
//
//   - backfill.ts hasBackfillHeadroom is asking "may backfill write
//     more", and it compares against BACKFILL_ROWS_SHARE_LIMIT, half the
//     ceiling. Deletion traffic is bounded by its own reserved share
//     (limits.ts VANISH_ROWS_SHARE_LIMIT, a quarter) and so cannot eat
//     into backfill's half however busy it gets. The guard does not need
//     to see writes that are already bounded away from the budget it is
//     protecting.
//
//   - relay.ts getStats is asking "how much did this relay write today",
//     and shows the answer on the admin page. There the omission is a
//     real understatement, and the largest case is a vanish drain: while
//     one is running this figure misses up to VANISH_ROWS_SHARE_LIMIT --
//     25,000 rows/day as the drain is paced, ~9,000 as
//     SqlStorageCursor actually counts a removal (see schema.ts
//     eventRemovalRowsWritten and eventRemovalBudget for why those two
//     numbers differ). Ordinary deletion traffic is far smaller -- a
//     handful of replaceable republishes a day at 8 rows each -- but it
//     is unbounded in principle, since nothing reserves a share for
//     NIP-09.
//
// Deletion is not the only omission, and the other one is quieter: this
// sums `events.row_cost`, so it sees nothing this relay writes that is
// not an event row. The follow cache rebuild (ownership.ts
// refreshFollows) is the largest of those -- 900 rows at 300 follows,
// every time the owner's contact list changes, and once per cron tick
// besides until v0.7.7 stopped it rebuilding a list that had not moved.
// The NIP-86 ban and settings tables, backfill's cursor bookkeeping and
// the stats snapshot are the rest, each small and none of them here.
// Every one is a real write against the same 100,000/day ceiling.
//
// So: read this number as "rows written STORING events", not "rows
// written". `/api/stats` reports draining vanish requests alongside it
// (`vanishing`), which is the signal that the gap is currently wide.
// Fixing it would mean stamping deletion cost somewhere, and the only
// place to stamp it is a counter row -- a row write to measure a row
// write, which is the trade schema.ts rejected for exactly this column.
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

// How many events this relay actually took in during the window,
// regardless of how old they are. The companion to the events24h count in
// relay.ts getStats, which counts by `created_at` and so answers a
// genuinely different question: "how much did the owner post lately"
// versus "how much did this relay do lately". During a backfill those two
// numbers differ by orders of magnitude, and reporting only the first one
// made the admin page claim 9 events on a day it ingested thousands.
export function countIngested24h(sql: SqlStorage, sinceCutoff: number): number {
  return (
    sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE ingested_at > ?`, sinceCutoff)
      .toArray()[0]?.n ?? 0
  );
}

// Multiple filters in one REQ are ORed (nips/01.md line 129) and
// deduped/re-sorted as a single result set, newest-first with ties
// broken by lowest id -- matching the ordering a single filter's query
// would produce.
export function queryFilters(sql: SqlStorage, filters: Filter[], nowSec: number): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const filter of filters) {
    for (const event of queryFilter(sql, filter, nowSec)) {
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

export function allowPubkey(sql: SqlStorage, pubkey: string, reason: string | null, nowSec: number): void {
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET reason = excluded.reason, allowed_at = excluded.allowed_at`,
    pubkey,
    reason,
    nowSec,
  );
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
