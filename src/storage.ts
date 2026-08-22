import { buildFilterQuery } from "./filters";
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

function insertEventRow(sql: SqlStorage, event: NostrEvent, expiration: number | null): void {
  sql.exec(
    `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.pubkey,
    event.created_at,
    event.kind,
    JSON.stringify(event.tags),
    event.content,
    event.sig,
    expiration,
  );
  // Only single-letter tag names are indexed (NIP-01 `#<letter>` filters
  // only ever query those), and only each tag's first value -- see
  // schema.ts's write-cost comment.
  for (const tag of event.tags) {
    if (tag[0]?.length === 1 && tag[1] !== undefined) {
      sql.exec(
        `INSERT INTO event_tags (tag_name, tag_value, event_id, created_at) VALUES (?, ?, ?, ?)`,
        tag[0],
        tag[1],
        event.id,
        event.created_at,
      );
    }
  }
}

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
export function storeEvent(sql: SqlStorage, event: NostrEvent): StoreResult {
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
    if (existing) deleteEventRow(sql, existing.id);
    insertEventRow(sql, event, expirationOf(event));
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
    if (existing) deleteEventRow(sql, existing.id);
    insertEventRow(sql, event, expirationOf(event));
    return { ok: true, message: "", stored: event };
  }

  // Regular kinds, and the spec-undefined 45-999/>=40000 ranges, land
  // here and are stored like regular events: 45-999 holds live assigned
  // kinds, writes are owner-only so permissiveness costs nothing, and
  // storing too much is recoverable while rejecting the owner's own
  // events is not.
  insertEventRow(sql, event, expirationOf(event));
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
// (ROADMAP.md chunk 6):
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

export function queryFilter(sql: SqlStorage, filter: Filter, nowSec: number): NostrEvent[] {
  const query = buildFilterQuery(filter, nowSec);
  if (query === null) return [];
  return sql
    .exec<EventRow>(query.sql, ...query.params)
    .toArray()
    .map(rowToEvent);
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
  return [...byId.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
