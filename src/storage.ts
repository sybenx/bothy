import { buildFilterQuery, compareEvents, expandFilter } from "./filters";
import { eventRowCost } from "./schema";
import { countReplacement, withReadPath } from "./read-metrics";
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
// estimateRowsWritten24h below then reads a column instead of rebuilding
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
// The most expensive read left in this codebase, and deliberately still
// here. Read this before "optimising" anything else.
//
// `DELETE FROM event_tags WHERE event_id = ?` has no index to use.
// `idx_event_tags_lookup` is (tag_name, tag_value, created_at) and
// `event_id` appears nowhere in it, so this scans the whole table: T
// rows, about 5E, to delete a handful. The `DELETE FROM events` beside
// it is a primary-key seek and costs ~1.
//
// It is paid on every replaceable/addressable REPLACEMENT -- every
// kind-0, kind-3, kind-10002, NIP-51 list and addressable event the
// owner republishes -- and on every NIP-09 deletion, NIP-62 vanish and
// NIP-86 banevent.
//
// WHY IT IS STILL HERE, AND WHY THAT IS A DEBT AND NOT A DECISION
//
// The fix is an index on event_tags(event_id). Pricing only the fix gets
// this wrong, and it did once: the fix costs a row write per TAG row
// rather than per event -- TAG_ROW_COST 2 -> 3, about five more rows per
// real note, roughly 15,000 rows/day at this relay's rate -- and stopping
// there makes it look like the expensive option. It is a FIXED DAILY
// FLOW against a ceiling that resets every morning.
//
// What it buys is the removal of a cost that SCALES WITH THE ACCUMULATED
// TABLE, which is the property that took this relay down. This path
// spends 5E rows read per replacement, so:
//
//   5E x R = 5,000,000   =>   E x R = 1,000,000
//
// where R is replaceable events stored per day that supersede an
// existing version. The cron floor (CLAUDE.md "The budget") reaches
// 5,000,000 at E ~= 104,000. This path reaches it at:
//
//   R =   5/day  ->  E = 200,000
//   R =  10/day  ->  E = 100,000     <- crossover with the cron floor
//   R =  25/day  ->  E =  40,000
//   R =  50/day  ->  E =  20,000
//   R = 100/day  ->  E =  10,000
//   R = 250/day  ->  E =   4,000     <- today's table size
//
// So this is the binding constraint for any R above about 10/day, and
// the cron floor -- the thing v0.7.2 spent two indexes fixing -- stops
// being the limit that matters at all.
//
// ESTIMATING R
//
// The replaceable kinds this relay accepts are kind 0, kind 3, 10000-19999
// and the addressable range 30000-39999 (nostr.ts). Three sources, and
// only two of them matter:
//
//  - The OWNER's own clients, which is the sustained term. kind-3 is
//    republished on every follow and unfollow, and some clients republish
//    it on every launch; NIP-51 lists (10000-10030: mutes, pins,
//    bookmarks, interests) are republished on every edit; addressable
//    kinds are the volatile ones, since a client autosaving a kind-30023
//    draft republishes the same address repeatedly. kind-0 and kind-10002
//    are rare. For one active owner this lands at roughly 5-20/day, with
//    the drafting case able to spike it by an order of magnitude for an
//    afternoon.
//
//  - FOLLOWS, when ALLOW_FOLLOWS is on (the default) AND a follow's
//    client actually writes to this relay -- which needs bothy in their
//    own write set, so it is normally zero and is entirely outside the
//    owner's control when it is not. Bounded by F x their republish rate,
//    so a single follow whose client re-blasts kind-3 aggressively can
//    contribute more than the owner does.
//
//  - BACKFILL contributes ~zero, which is worth stating because it looks
//    like it should dominate. Backfill walks time BACKWARD, so the newest
//    version of any replaceable address arrives first and every older one
//    is superseded -- storeEvent returns early on isSupersededBy without
//    calling this function at all. The cost is one replacement per
//    distinct (pubkey, kind, d), once, not one per ingested event.
//
// That estimate is a range spanning the crossover, which is exactly why
// it is not good enough to act on: read-metrics.ts counts replacements so
// R can be READ off /api/stats after deploy instead of guessed at. Fix
// this once that number is real -- the same rule that produced
// read-metrics.ts in the first place, and the same one hasBackfillHeadroom
// broke by guarding a number nobody had measured.
//
// test/read-cost.test.ts asserts this cost as "scales with the table"
// rather than "stays under N", so it stays visible while it stays here.
// ---------------------------------------------------------------------
function deleteEventRow(sql: SqlStorage, id: string): void {
  sql.exec(`DELETE FROM event_tags WHERE event_id = ?`, id);
  sql.exec(`DELETE FROM events WHERE id = ?`, id);
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

// Current count of stored gift wraps -- backs the MAX_GIFT_WRAPS cap
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
    // Counted here rather than inside deleteEventRow, which is also
    // reached by NIP-09/NIP-62/NIP-86 deletions -- see countReplacement.
    if (existing) {
      countReplacement();
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
      countReplacement();
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

function applyAddressDeletion(sql: SqlStorage, address: string, deletion: NostrEvent): void {
  const [kindStr, pubkey, d = ""] = address.split(":");
  const kind = Number(kindStr);
  if (!Number.isInteger(kind) || pubkey !== deletion.pubkey) return;

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

// NIP-62 (nips/62.md) Request to Vanish. Two clauses, both applied
// unconditionally against `requester` (the vanish event's own pubkey),
// matching the spec text rather than special-casing "if requester is the
// owner": "Relays MUST fully delete any events from the .pubkey" (the
// first loop) and "Relays SHOULD delete all NIP-59 Gift Wraps that
// p-tagged the .pubkey" (the second). Both clauses naturally do nothing
// for a requester who has no matching rows -- the relay doesn't need to
// know in advance whether the requester is the owner, a follow, or a
// stranger, since bothy's own write gate already ensures the only
// pubkeys ever found by the first clause are the owner or a follow (a
// gift wrap's own pubkey is a random one-time key, never a real
// identity someone could coordinate a vanish request around). Deliberately
// NOT routed through ownership.ts's isAllowedWriter -- unlike every other
// write path, a vanish request's authority comes from the requester
// vanishing their *own* data, not from relay-write permission, and the
// spec is explicit that write-restricted relays "MUST also follow the
// request to vanish regardless of the user's status."
export function applyVanish(
  sql: SqlStorage,
  requester: string,
  cutoffCreatedAt: number,
): { deletedAuthored: number; deletedGiftWraps: number } {
  const authored = sql
    .exec<{ id: string }>(
      `SELECT id FROM events WHERE pubkey = ? AND created_at <= ?`,
      requester,
      cutoffCreatedAt,
    )
    .toArray();
  for (const row of authored) deleteAndTombstone(sql, row.id);

  const giftWraps = sql
    .exec<{ id: string }>(
      `SELECT id FROM events WHERE kind = ? AND created_at <= ?
       AND id IN (SELECT event_id FROM event_tags WHERE tag_name = 'p' AND tag_value = ?)`,
      GIFT_WRAP_KIND,
      cutoffCreatedAt,
      requester,
    )
    .toArray();
  for (const row of giftWraps) deleteAndTombstone(sql, row.id);

  return { deletedAuthored: authored.length, deletedGiftWraps: giftWraps.length };
}

// Runs one filter, splitting it into per-(author, kind) queries first
// (filters.ts expandFilter) so each one pins its index key columns to a
// single value and stops at `limit` instead of sorting the table.
//
// The split is invisible from the outside. Each sub-filter carries the
// original `limit`, so the union may hold more events than the client
// asked for; re-sorting by the same rule buildFilterQuery's ORDER BY
// uses and slicing back to `limit` yields exactly the rows the unsplit
// query would have returned. Dedupe by id first -- `authors` and `kinds`
// are disjoint dimensions, so no event can appear twice, but the
// single-query path fed a Map for the same reason and the guarantee is
// cheap to keep.
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
// to measure itself. Backs /api/stats's `rowsWrittenEstimate24h`
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
// Summing a stamped column removes the join outright and never touches
// `event_tags` at all. What remains is the scan of `events` itself:
// `ingested_at` is covered by no index and must not be -- an index there
// would cost a row write per event, the exact cost the column was chosen
// to avoid -- so this is E, not the size of the window. Cutting E to the
// window would take that forbidden index; cutting the ~288E floor to
// ~48E did not, which is why this is where the line is drawn.
//
// Still an estimate, and still named one. It sums the cost of rows
// currently standing for events ingested in the window, which is not
// quite the same as every row written in it: a row written and then
// deleted inside the same window drops out, and the deletion's own write,
// plus any tombstone, is not counted. Rows written before `row_cost`
// existed carry NULL and are absent from the SUM entirely, which
// undercounts for at most the one 24h window straddling an upgrade. All
// three make this a floor rather than a ceiling, which is the safe
// direction for the budget guard in backfill.ts hasBackfillHeadroom -- it
// will never believe there is less headroom than there is, only more, and
// the reserved-half rule (BACKFILL_ROWS_SHARE_LIMIT) is what absorbs the
// difference.
export function estimateRowsWritten24h(sql: SqlStorage, sinceCutoff: number): number {
  return withReadPath("estimateRowsWritten24h", () => estimateRowsWritten24hInner(sql, sinceCutoff));
}

// Scoped separately from whichever path called it (read-metrics.ts):
// getStats displays this number once per admin page load, but
// backfill.ts hasBackfillHeadroom calls it twice per cron tick, and
// nothing in the /api/stats breakdown would distinguish those if this
// inherited its caller's bucket. It is also the one query here that
// filters on an unindexed column, which is reason enough to give it its
// own line in the report.
function estimateRowsWritten24hInner(sql: SqlStorage, sinceCutoff: number): number {
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

export function blockIp(sql: SqlStorage, ip: string, reason: string | null, nowSec: number): void {
  sql.exec(
    `INSERT INTO blocked_ips (ip, reason, blocked_at) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at`,
    ip,
    reason,
    nowSec,
  );
}

export function unblockIp(sql: SqlStorage, ip: string): void {
  sql.exec(`DELETE FROM blocked_ips WHERE ip = ?`, ip);
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
  return sql.exec(`SELECT 1 FROM blocked_ips WHERE ip = ?`, ip).toArray().length > 0;
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
