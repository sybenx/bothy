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

// `ingestedAt` is wall-clock now, not event.created_at -- see schema.ts's
// `ingested_at` comment for why the two must never be conflated. It is
// one more column on an INSERT this function already performs, so it adds
// zero rows written per event.
function insertEventRow(
  sql: SqlStorage,
  event: NostrEvent,
  expiration: number | null,
  ingestedAt: number,
): void {
  sql.exec(
    `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.pubkey,
    event.created_at,
    event.kind,
    JSON.stringify(event.tags),
    event.content,
    event.sig,
    expiration,
    ingestedAt,
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
    if (existing) deleteEventRow(sql, existing.id);
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
    if (existing) deleteEventRow(sql, existing.id);
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

// Row-cost formula from schema.ts: 3 base rows + 2 per single-letter tag.
// A read-only estimate, not a tracked counter -- see limits.ts/relay.ts
// comments on why this relay avoids extra writes just to measure itself.
// Backs /api/stats's `rowsWrittenEstimate24h` (relay.ts getStats) and
// backfill's own headroom check (backfill.ts hasBackfillHeadroom,
// ROADMAP.md chunk 7: backfill must yield to the owner's live traffic
// rather than compete with it for the same daily ceiling) -- both need
// the same number, so it lives here once rather than being computed
// twice and risking drift between what the admin page displays and what
// backfill actually throttles against.
//
// A single LEFT JOIN + GROUP BY, not a two-query "fetch ids, then IN (...)
// those ids" -- an earlier version did the latter and passed one bound
// parameter per matching event, which broke past a few hundred events in
// the window with a real SqlStorage "too many SQL variables" error. That
// window is normally small (this relay's own recent live traffic), but
// backfill's headroom check calls this same function while the window
// may also contain a large burst of live writes -- exactly the case this
// query now has to hold up under.
// Measured by `ingested_at` -- when this relay actually wrote the row --
// and never by `created_at`, which is when the author says they signed
// it. Filtering on created_at made this function report rows
// attributable to events *timestamped* in the window, so backfill's
// writes (carrying years-old timestamps) were invisible to it: 729
// reported against 33,000 actually written. See schema.ts's
// `ingested_at` comment for the full account.
//
// Still an estimate, and still named one. It counts the rows currently
// standing for events ingested in the window, which is not quite the
// same as every row written in it: a row written and then deleted inside
// the same window drops out, and the deletion's own write, plus any
// tombstone, is not counted. Both make this a floor rather than a
// ceiling, which is the safe direction for the budget guard in
// backfill.ts hasBackfillHeadroom -- it will never believe there is less
// headroom than there is, only more, and the reserved-half rule
// (BACKFILL_ROWS_SHARE_LIMIT) is what absorbs the difference.
//
// Rows read: one scan of `events` joined to `event_tags`. No index
// covers `ingested_at` and none should -- an index here would cost a row
// write per event, the exact thing this column was chosen to avoid. The
// unindexed scan is what the created_at version already did, so the read
// cost is unchanged.
export function estimateRowsWritten24h(sql: SqlStorage, sinceCutoff: number): number {
  const rows = sql
    .exec<{ tag_count: number }>(
      `SELECT COUNT(t.event_id) AS tag_count
       FROM events e
       LEFT JOIN event_tags t ON t.event_id = e.id
       WHERE e.ingested_at > ?
       GROUP BY e.id`,
      sinceCutoff,
    )
    .toArray();

  let total = 0;
  for (const r of rows) {
    total += 3 + 2 * r.tag_count;
  }
  return total;
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
  return [...byId.values()].sort((a, b) => {
    if (a.created_at !== b.created_at) return b.created_at - a.created_at;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
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
