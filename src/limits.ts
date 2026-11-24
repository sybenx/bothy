import { tagFilterEntries, type Filter } from "./nostr";
import { expandFilterCount, filterParamCount, tagScanLimit } from "./filters";
import { eventRemovalBudget, eventRowCost, indexesOn } from "./schema";

// Every numeric abuse and budget cap in the project, each with what it
// bounds. Reads are public by design, so anyone can spend the daily
// 5,000,000 rows-read and 100,000 Durable Object request allowances without
// touching ownership; who may write is decided separately
// (ownership.ts isAllowedWriter). The per-IP message throttle lives in
// relay.ts because it needs connection state.
//
// A TTL over an expensive read bounds how often it is paid, not what it
// costs. Prefer a maintained counter to a cache: /api/stats has no cache
// because every figure on it is maintained (storage.ts
// readMaintainedCounts).

// Concurrent subscriptions a single WebSocket connection may hold open.
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 10;

// A filter's own `limit` field is capped at this even if the client asks
// for more.
export const MAX_FILTER_LIMIT = 500;

// Total events returned across all filters in one REQ, after ORing and
// deduping (storage.ts queryFilters).
export const MAX_EVENTS_PER_REQ = 500;

// ---------------------------------------------------------------------
// Write-path abuse caps: what a writer who IS allowed to write can cost.
// Under the default `follows` policy that is every pubkey the owner
// follows; under `mentions`/`all` it is strangers. Without these, one such
// writer is bounded only by the per-IP message throttle (relay.ts
// RATE_LIMIT_MAX_MESSAGES, ~300 events/minute): the daily rows-written
// ceiling goes in under half an hour, and the 5GB storage ceiling, which
// never resets, in under ten minutes at SQLite's 2MB maximum row size
// (5GB / 2MB = 2,560 events;
// developers.cloudflare.com/durable-objects/platform/limits/, checked
// 2026-08-25).
//
// Each cap is raisable or disablable through an environment variable
// (resolveLimit), since none of these ceilings apply on a paid plan.
// ---------------------------------------------------------------------

// The only value that turns a cap off: removing a safety cap must be
// spelled out, never done by any truthy value. A malformed or empty value
// falls back to the default, so a dashboard typo costs the override, not
// the cap.
const DISABLE_VALUE = "off";

// Resolves one of the env-overridable caps. Null means disabled; callers
// skip the check rather than comparing against Infinity. Read defensively
// because none of these are declared in wrangler.jsonc (src/env.d.ts).
function resolveLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (raw === DISABLE_VALUE) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// Largest event accepted, in JSON-serialized wire bytes, from every writer
// including the owner. 64KB is generous for real content (a NIP-17 DM is
// low single-digit KB; long-form kind 30023 rarely approaches it). This is
// the cap that bounds PERMANENT damage: rows written reset daily, stored
// bytes do not. It covers gift wraps too; do not add a separate per-kind
// byte cap, since two caps for one idea have to agree forever.
export const MAX_EVENT_BYTES = 64 * 1024;

export function maxEventBytes(env: Env): number | null {
  return resolveLimit(env.MAX_EVENT_BYTES, MAX_EVENT_BYTES);
}

// Gift wrap write throttle (relay.ts giftWrapRefusal), separate from
// relay.ts's general per-message limit (which counts every frame type and
// is tuned for connection spam). Two counters, because a wrap is signed by
// a throwaway key and says nothing about who sent it:
//
// - A connection signed in (NIP-42) as the owner or a member is counted per
//   signed-in pubkey: two members behind one home Wi-Fi do not share an
//   allowance, and one member on two connections shares their own. 120 a
//   minute, because a messenger spends wraps fast: a one-to-one message is
//   two (theirs and the sender's own copy), a message in an old-style group
//   one per person plus one, and reactions, edits, pins, themes and name
//   cards are wraps too. Thirty messages and thirty reactions in a minute
//   is 120.
// - Everyone else (strangers writing to someone's inbox, and a member's app
//   that has not signed in on this connection) is counted per IP, 5 a
//   minute. Over it, a connection that has not signed in is sent an AUTH
//   challenge and refused with `auth-required:`, so a member's app signs in
//   and sends again under its own allowance; one that has signed in as
//   someone else is refused with `rate-limited:`.
//
// Rows: a stored wrap costs 12 rows written (schema.ts
// eventRowCostMeasured(1)). One address at 5 a minute could write ~86,000
// rows a day. One member at 120 a minute writes 1,440 rows a minute, so a
// member sending flat out spends the Workers Free 100,000 rows written a
// day in about 70 minutes; a busy real day (a thousand messages, two wraps
// each) is ~24,000. A member is someone the owner let in and can remove,
// and what bounds stored mail in total is the mailbox (mailStorageBytes,
// mailBytesPerMember), not these rates.
//
// Both are env-overridable (MAX_GIFT_WRAPS_PER_IP_PER_MINUTE,
// MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE): a positive number, or "off".
export const GIFT_WRAP_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_GIFT_WRAPS_PER_IP_PER_WINDOW = 5;
export const MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW = 120;

export function maxGiftWrapsPerIp(env: Env): number | null {
  return resolveLimit(env.MAX_GIFT_WRAPS_PER_IP_PER_MINUTE, MAX_GIFT_WRAPS_PER_IP_PER_WINDOW);
}

export function maxGiftWrapsPerMember(env: Env): number | null {
  return resolveLimit(env.MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE, MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW);
}

// Sealed signals (kind 21059, relay.ts handleSignal): typing, seen
// receipts and call setup. Never stored, so they cost no rows; this
// bounds the fan-out work (a schnorr check and one send each). Counted per
// authenticated sender, apart from the gift wrap limit above. An app sends
// one signal per other person: in a 20-person group, typing (one every 6
// seconds) is 190 a minute and a seen receipt for each of 20 incoming
// messages is 380 more, so 600 a minute. Env-overridable
// (MAX_SIGNALS_PER_MEMBER_PER_MINUTE): a positive number, or "off". Each is
// at most 16KB on the wire, because call setup carries an SDP answer or an
// ICE restart offer.
export const SIGNAL_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_SIGNALS_PER_SENDER_PER_WINDOW = 600;
export const SIGNAL_MAX_BYTES = 16 * 1024;

export function maxSignalsPerMember(env: Env): number | null {
  return resolveLimit(env.MAX_SIGNALS_PER_MEMBER_PER_MINUTE, MAX_SIGNALS_PER_SENDER_PER_WINDOW);
}

// Home group messages (kind 1490, relay.ts handleGroupMessage), per
// authenticated sender. One stored event reaches the whole group, so a
// lively group of any size costs each sender one a message: 120 a minute
// is two a second from one person. Was the signal limit's constant until
// that was raised; stored events keep this one.
export const GROUP_MESSAGE_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_GROUP_MESSAGES_PER_SENDER_PER_WINDOW = 120;

// Rings (relay.ts handleGiftWrap): a kind 1059 wrap with an outer
// `["ring"]` tag, the call invite. Stored like any wrap, so the callee's
// phone can fetch it after the push wakes it, but short-lived: it must
// carry a NIP-40 expiration no more than RING_MAX_TTL_SECONDS ahead, and
// the wrap_expiry sweep removes it. Rings skip both gift wrap limits above
// (a call that rings, is cancelled and rings again is normal) and have
// their own two limits instead: per address, and per recipient, which is
// what stops a stranger from waking one phone in a loop. Size is
// MAX_EVENT_BYTES like any wrap: an SDP offer sealed twice is well under it.
export const RING_MAX_TTL_SECONDS = 120;
export const RING_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_RINGS_PER_IP_PER_WINDOW = 10;
export const MAX_RINGS_PER_RECIPIENT_PER_WINDOW = 6;

// The ICE servers a home offers its members' calls, on NIP-11 `calls`.
// The owner's open decision (calls.md question 6): Google's and
// Cloudflare's public STUN for now, which learn a caller's address but
// carry no media. A TURN entry, with a member-only `turnpass` management
// call returning short-lived TURN REST credentials, is a later step and
// is not built.
export const CALL_ICE_SERVERS: readonly { readonly urls: readonly string[] }[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:stun.cloudflare.com:3478"] },
];

// ---------------------------------------------------------------------
// NIP-29 invites (src/nip29.ts). An invite code is a bearer token: the
// relay cannot authenticate whoever presents it (the invitee may have no
// npub until they click the link), so the only controls are lifetime,
// count, guessability and guess rate -- one constant each below.
// ---------------------------------------------------------------------

// Lifetime when the kind-9009 names no expiry, and the longest it may
// name. Expiry is mandatory (bothy's policy; NIP-29 is silent): a bearer
// token with no expiry stays live in every chat log and screenshot it was
// pasted into until the owner remembers to revoke it. A longer request is
// refused, not clamped: a clamped one would be answered OK and the client
// would go on describing the link's lifetime wrongly. The refusal names
// the maximum.
export const INVITE_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

// The minimum is the only guessing floor the relay can enforce over a code
// it did not generate, and length is not entropy: it stops accidents
// (hand-typed codes, lazy generators). MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW
// is what bounds deliberate guessing; 16 random hex characters is 64 bits.
// The maximum is a storage bound: the code is stored verbatim in
// `group_invites` and echoed back by the NIP-86 list method.
export const MIN_INVITE_CODE_LENGTH = 16;
export const MAX_INVITE_CODE_LENGTH = 128;

// Invites outstanding (unspent, unexpired, unrevoked) at once. Only the
// owner can create one, so this is not a defence; it bounds the NIP-86
// listunusedinvites response, which returns every outstanding code and has
// to stay readable for the owner to revoke from it.
export const MAX_OUTSTANDING_INVITES = 64;

// ---------------------------------------------------------------------
// QR claim nonces (ownership.ts issueClaimNonce, claimWithNonce). Unlike
// invites, anyone can mint one, by pressing the button on a public,
// unclaimed relay's admin page.
// ---------------------------------------------------------------------

// Long enough to scan the QR, open a signer and approve, without leaving a
// long-lived code in a URL fragment on a screen someone may photograph.
export const CLAIM_NONCE_TTL_SECONDS = 10 * 60;

// Unexpired nonces at once; far above what one owner needs. Because
// issueClaimNonce deletes expired rows before counting (rather than merely
// excluding them, as the invite count does), `claim_nonces` never holds
// more than this many rows however hard POST /api/claim-nonce is flooded.
export const MAX_OUTSTANDING_CLAIM_NONCES = 8;

// Per-IP kind-9021 join request throttle, and the real bound on invite
// guessing. Join requests come from pubkeys the relay has never
// authorized, so they get their own counter; the general per-message
// throttle (50 per 10s) would allow ~432,000 guesses a day per address.
// Five a minute is generous for a person following a link. In memory
// (relay.ts joinRateLimits): no row cost, reset on eviction, so a patient
// attacker gets fresh windows but never a fast one.
export const JOIN_REQUEST_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW = 5;

// Per-PUBKEY write throttle. Keyed by pubkey because the other throttles
// are per IP, and an author with several addresses (phone, laptop, VPN)
// walks around those; a follow's authority to write comes from the pubkey.
//
// Sized against rows written. A real five-tag note writes 24 rows
// (schema.ts eventRowCostMeasured(5)), so ~4,200 events spend the daily
// 100,000: ~14 minutes at the per-IP limit alone (300/min), ~3.5 hours at
// 20/min per pubkey. The aim is not to make abuse impossible but slow
// enough for the owner to notice and revoke (unfollow, or NIP-86
// banpubkey) the same day, while staying far above any human posting rate.
//
// In memory (relay.ts pubkeyRateLimits): no row cost, lost on eviction. A
// sustained flood keeps the object awake, so the window that matters is
// the one that survives.
//
// Ephemeral kinds (20000-29999) are exempt (relay.ts acceptEvent): they
// write zero rows (storage.ts storeEvent drops them), and counting them
// made WebRTC call signalling (dozens of candidates in the first second)
// impossible for a non-owner. Their verify and broadcast cost is still
// bounded by the per-IP message throttle (50 per 10s, shared with every
// other frame on the connection).
export const PUBKEY_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_EVENTS_PER_PUBKEY_PER_WINDOW = 20;

export function maxEventsPerPubkeyPerWindow(env: Env): number | null {
  return resolveLimit(env.MAX_EVENTS_PER_PUBKEY_PER_MINUTE, MAX_EVENTS_PER_PUBKEY_PER_WINDOW);
}

// Ceiling on the pubkeys the in-memory throttle map tracks. Unlike the
// per-IP maps, its key is free to mint: every NIP-59 gift wrap is signed
// by a fresh one-time key, so a busy inbox adds an entry per message.
// Stale windows are dropped once the map reaches this size (relay.ts
// prunePubkeyRateLimits). The owner plus follows is hundreds of keys, so a
// real relay never reaches it.
export const PUBKEY_RATE_LIMIT_MAX_TRACKED = 10_000;

// ---------------------------------------------------------------------
// The read-abuse guard. boundFilter admits a REQ filter only at a limit
// some index in schema.ts INDEXES can afford. The verdict is computed from
// the declared index set, so adding or dropping an index changes what is
// admitted with nothing here to edit. Do not replace it with a check on
// which fields are present: presence says nothing about what a query
// reads (`{"authors":[owner]}` reads every row on a relay the owner wrote
// alone, unless an index orders it).
//
//   rows read  =  combinations x (2 x limit + 1)
//              +  tag values x TAG_ROWS_READ_PER_MATCH x TAG_SCAN_DEPTH x limit
//
// `combinations` is the number of queries filters.ts expandFilter runs
// (authors x kinds, times partitions read). The 2 is ROWS_READ_PER_MATCH.
// An index qualifies only when every key column ahead of its ordering
// column is pinned to one value; since/until bound a range and pin
// nothing, so a filter of only since/until/limit is refused. Both terms
// scale with `limit`, which is what lets boundFilter clamp rather than
// refuse.
// ---------------------------------------------------------------------

// The most recent 00:00 UTC, in seconds: when Cloudflare's free-tier
// allowances reset (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-26). Anything asking "how much of today's budget is
// spent" (backfill.ts hasBackfillHeadroom, the admin page's meters) must
// use this, not now-minus-24h: a rolling window carries yesterday's spend
// past the reset, so the meter reads high and backfill stays blocked for
// most of a day after a recovery.
export function utcDayStartSeconds(nowMs: number): number {
  const msPerDay = 86_400_000;
  return Math.floor((nowMs - (nowMs % msPerDay)) / 1000);
}

// Seconds until the allowances reset; the Retry-After on the 503 an
// exhausted allowance produces (src/index.ts).
export function secondsUntilUtcMidnight(nowMs: number): number {
  const msPerDay = 86_400_000;
  return Math.ceil((msPerDay - (nowMs % msPerDay)) / 1000);
}

// Workers Free daily rows-read ceiling (same source, checked 2026-08-26).
// MAX_FILTER_ROWS_READ is derived from it.
export const DAILY_ROWS_READ_LIMIT = 5_000_000;

// The most one REQ frame may read: 1/500 of the day. relay.ts
// handleReqInner divides it equally among the frame's filters
// (boundFilter's `budget`), so stacking filters in one frame cannot
// multiply it.
//
// Not a bound over time: the per-IP throttle (relay.ts
// RATE_LIMIT_MAX_MESSAGES, 50 per 10s) admits 5 REQs/second, which at this
// cap is 50,000 rows/second -- the daily ceiling in 100 seconds from one
// address. Closing that needs a per-connection or per-IP rows-read budget,
// which this relay does not have.
export const MAX_FILTER_ROWS_READ = DAILY_ROWS_READ_LIMIT / 500;

// Events req-cache.ts may hold across all entries. A memory bound only: a
// full cache evicts and re-reads. The cache serves clients that reconnect
// every few seconds and re-send identical REQs (2026-10-09: ~236 rows per
// REQ, projected 6.26M rows/day). 10,000 is about twice a personal relay's
// whole `events` table at the time (4,954) and a few MB against the DO's
// 128MB.
export const REQ_CACHE_MAX_EVENTS = 10_000;

// Filters one REQ frame may carry; NIP-01 sets no bound. MAX_FILTER_ROWS_READ
// bounds the frame's rows; this bounds its statement count and keeps each
// filter's share of that budget from thinning to uselessness. Ten matches
// MAX_SUBSCRIPTIONS_PER_CONNECTION (both bound one connection's concurrent
// read work) and is above what real clients send (one to five).
export const MAX_FILTERS_PER_REQ = 10;

// Bytes of serialized connection state (relay.ts ConnState: every open
// subscription's filters plus ip/host/challenge/authedPubkey). A platform
// bound: subscriptions live in the WebSocket attachment to survive
// hibernation, and serializeAttachment throws above 16KiB
// (developers.cloudflare.com/durable-objects/api/websockets/, checked
// 2026-08-28) -- after the query has run, leaving the client with no
// CLOSED. An ordinary `{"authors":[<400 keys>],"kinds":[1]}` is ~26KB and
// passes every other cap. Checked before the state is stored, and set
// below the real ceiling so a later AUTH adding fields cannot push an
// admitted state over it.
export const MAX_CONN_STATE_BYTES = 15 * 1024;

// Rows read per row returned by an ordered index scan: the index entry,
// then the table row it points at. Measured (test/read-cost.test.ts: 41
// rows for a limit of 20).
const ROWS_READ_PER_MATCH = 2;

// Rows read per tag row a `#<letter>` condition scans: the
// idx_event_tags_lookup_{pub,grp} entry plus the `event_tags` row behind it
// (the index does not carry event_id), then the outer `id IN (...)`'s
// primary-key entry plus the `events` row. Measured at exactly 4 for one
// tag value (test/read-cost.test.ts: 400 rows for a scan of 100). Charged
// per named value, which is pessimistic for several values (SQLite merges
// the ranges: ~4.5 per scanned row for two values, not 8) but is the worst
// case that cannot be exceeded.
export const TAG_ROWS_READ_PER_MATCH = 4;

// Queries one filter may expand into (expandFilter's authors x kinds,
// times partitions), capped separately from rows read: statements cost
// Durable Object CPU whether or not they read rows, and a lower `limit`
// removes none of them. `{"ids":[<one id>],"authors":[<5,000 keys>]}`
// reads only 5,000 rows but runs 5,000 statements (measured: 71ms of DO
// time).
//
// Set to the bound the index path already implies: at limit 1 an
// index-served filter costs combinations x (ROWS_READ_PER_MATCH + 1), so
// more than MAX_FILTER_ROWS_READ / 3 combinations is refused at every limit
// anyway. This applies the same ceiling to the `ids` path.
export const MAX_FILTER_COMBINATIONS = Math.floor(MAX_FILTER_ROWS_READ / (ROWS_READ_PER_MATCH + 1));

// SQLite-backed Durable Object storage refuses a query with more than 100
// bound parameters (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-28), as an uncaught "too many SQL variables" SQLITE_ERROR.
// Rows-read pricing does not track this: an `ids` filter prices at one row
// per id, so up to MAX_FILTER_ROWS_READ ids would pass the cost check, and
// neither ids.length nor a tag's value count shrinks when boundFilter
// lowers `limit`. So it is checked once, against filters.ts
// filterParamCount, before the halving loop.
//
// Ten below the real ceiling because filterParamCount counts only the
// filter's own parameters; the read gates add up to four more after
// boundFilter has admitted it (excludeGiftWraps, excludeInvites, the chat
// horizon -- see filterParamCount). Group scoping adds more still; see
// MAX_SCOPED_GROUPS.
export const MAX_QUERY_BOUND_PARAMS = 90;

// Which filter field pins which indexed column. `created_at` is absent on
// purpose: since/until constrain a range, and a range-constrained key still
// yields rows out of sort order, so every match is read and sorted before
// LIMIT applies.
const PINS: Record<string, (filter: Filter) => readonly unknown[] | undefined> = {
  pubkey: (filter) => filter.authors,
  kind: (filter) => filter.kinds,
};

export interface FilterReadCost {
  // Estimated rows read to answer this filter.
  rowsRead: number;
  // The access path behind the estimate: an index name, the primary key,
  // or a driver and a tag conjunct joined by `+`. Lets tests and
  // diagnostics say WHY a filter is cheap.
  via: string;
}

// The cheapest bounded way to answer this filter, or null when nothing
// bounds it below the size of the table. Access paths (primary key, the
// ordered indexes on `events`) are alternatives -- SQLite picks one -- so
// the cheapest is the estimate. A `#<letter>` condition is a conjunct whose
// subquery always runs, so its cost is ADDED to whichever path drives
// (measured: `{"#p":[owner],"kinds":[1059],"limit":20}` reads 127 rows at
// E=1,000, not the 41 the kinds index alone predicts).
//
// `limit` is taken as given; boundFilter does the clamping. `scopes` is how
// many partitions the reader may read (src/groups.ts): 1 unauthenticated,
// 2 authorised. It multiplies the query count because storage.ts
// queryFilter runs the filter once per partition (a partial index pair
// serves only a query that pins one), and it is an argument because it is
// a property of the reader, not the filter. The tag term is not multiplied:
// filters.ts splits the tag scan budget across the partitions.
export function filterReadCost(filter: Filter, scopes = 1): FilterReadCost | null {
  const limit = filter.limit ?? MAX_FILTER_LIMIT;
  const candidates: FilterReadCost[] = [];

  // Every access path pays the query count: expandFilter runs before
  // storage, and each sub-filter carries the rest of the filter (any `ids`
  // list included) with it. Counted arithmetically (expandFilterCount,
  // asserted equal to expandFilter's length in test/read-cost.test.ts)
  // because `authors` off the wire is uncapped, and materialising the
  // cross-product just to price it would be a cheap denial of service
  // against this guard.
  const combinations = expandFilterCount(filter) * scopes;

  // The primary key: one seek per id, no ordering needed. Times
  // `combinations`, since every expanded query repeats the `id IN (...)`
  // list.
  if (filter.ids !== undefined && filter.ids.length > 0) {
    candidates.push({ rowsRead: combinations * filter.ids.length, via: "events primary key" });
  }

  // The ordered indexes on `events`. An index qualifies when every key
  // column is pinned. Priced by `combinations` (the queries actually run),
  // not by the chosen index's own key columns: one author and two kinds
  // runs two queries whichever index serves them.
  for (const index of indexesOn("events")) {
    const qualifies = index.keyColumns.every((column) => {
      const values = PINS[column]?.(filter);
      return values !== undefined && values.length > 0;
    });
    if (!qualifies) continue;
    candidates.push({
      rowsRead: combinations * (ROWS_READ_PER_MATCH * limit + 1),
      via: index.name,
    });
  }

  const driver =
    candidates.length === 0
      ? null
      : candidates.reduce((best, c) => (c.rowsRead < best.rowsRead ? c : best));

  // Tag conditions, through the idx_event_tags_lookup pair, added to the
  // driver. Bounded because the subquery is: filters.ts tagScanLimit caps
  // how deep it reads, so the cost scales with `limit` rather than with how
  // many rows carry the named value (see filters.ts TAG_SCAN_DEPTH). That
  // cap exists only when the filter has a `limit`, so a limitless tag
  // filter is priced as unbounded. boundFilter always supplies one, but the
  // two must agree on when the subquery is capped.
  const tags = tagFilterEntries(filter);
  const values = tags.reduce((n, [, v]) => n + v.length, 0);
  if (values > 0) {
    if (filter.limit === undefined) return null;
    const tagRows = values * TAG_ROWS_READ_PER_MATCH * tagScanLimit(filter.limit);
    return {
      rowsRead: (driver?.rowsRead ?? 0) + tagRows,
      via: driver === null ? "idx_event_tags_lookup" : `${driver.via} + idx_event_tags_lookup`,
    };
  }

  return driver;
}

export type FilterBound =
  | { ok: true; filter: Filter; cost: FilterReadCost }
  | { ok: false; reason: string };

// Groups one REQ may be scoped over (filters.ts FilterQueryOptions.groupIds).
// The scoping condition binds one parameter per group on the outer query
// and on every tag subquery, and filterParamCount cannot count them: it
// prices the filter before the relay knows who sent it. Bounded rather
// than accounted: a reader in more groups is refused and told to name one
// with "#h" (relay.ts handleReqInner) rather than crashed or silently
// under-served. Sixteen because only the owner can create a group or admit
// anybody to one, so seventeen is not reached by accident.
//
// Open gap: sixteen group parameters per query (and per tag subquery)
// exceed the ten MAX_QUERY_BOUND_PARAMS holds in reserve, so a filter near
// that cap, read by a member of many groups, can still pass SQLite's 100.
export const MAX_SCOPED_GROUPS = 16;

// Clamps a filter's `limit` until the query fits `budget`, and refuses it
// when no limit is small enough. Clamping before refusing: a client asking
// for 20 events from each of 400 follows is not abusive, and fewer per
// author is a better answer than a refusal. Refusal is for what no limit
// fixes: too many combinations, too many bound parameters, no index that
// serves it, or a cost that does not fall with the limit.
//
// `budget` defaults to MAX_FILTER_ROWS_READ; relay.ts handleReqInner passes
// an equal share when a REQ carries several filters -- equal rather than
// first-come, so the answer does not depend on filter order.
export function boundFilter(
  filter: Filter,
  budget: number = MAX_FILTER_ROWS_READ,
  scopes = 1,
): FilterBound {
  // Ahead of the cost model, which prices rows and cannot see statement
  // count -- see MAX_FILTER_COMBINATIONS.
  const combinations = expandFilterCount(filter) * scopes;
  if (combinations > MAX_FILTER_COMBINATIONS) {
    return {
      ok: false,
      reason:
        `invalid: filter expands to ${combinations} queries, over the ` +
        `${MAX_FILTER_COMBINATIONS} limit; name fewer authors x kinds combinations ` +
        `and split it across several REQs`,
    };
  }

  const requested = filter.limit === undefined ? MAX_FILTER_LIMIT : Math.min(filter.limit, MAX_FILTER_LIMIT);

  // Also ahead of the halving loop -- see MAX_QUERY_BOUND_PARAMS. The count
  // does not change as the loop lowers the limit, so `requested` serves.
  const paramCount = filterParamCount({ ...filter, limit: requested });
  if (paramCount > MAX_QUERY_BOUND_PARAMS) {
    return {
      ok: false,
      reason:
        `invalid: filter binds ${paramCount} SQL parameters, over the ` +
        `${MAX_QUERY_BOUND_PARAMS} limit; name fewer ids, or fewer values in a ` +
        `#<letter> tag condition, and split it across several REQs`,
    };
  }

  // Halving rather than solving for the largest affordable limit, so there
  // is no inverse of the cost function to keep in step with it. At most
  // nine steps from MAX_FILTER_LIMIT; the cost is a client sometimes
  // getting 62 events where 100 would have fit.
  for (let limit = requested; limit >= 1; limit = Math.floor(limit / 2)) {
    const candidate = { ...filter, limit };
    const cost = filterReadCost(candidate, scopes);
    if (cost === null) {
      // Unbounded at any limit -- the limit is not what is wrong with it.
      return {
        ok: false,
        reason:
          "invalid: filter must constrain ids, kinds, authors or a #<letter> tag; " +
          "since/until alone would scan the whole table",
      };
    }
    if (cost.rowsRead <= budget) return { ok: true, filter: candidate, cost };
  }

  // Reached only when the cost does not fall with the limit: an authors x
  // kinds cross-product too large even at one row each, or an `ids` list
  // whose seeks alone exceed the budget. The message names both, since
  // guessing wrong sends the client to fix the field that was fine.
  return {
    ok: false,
    reason:
      `invalid: filter is too broad to answer within ${budget} rows read ` +
      `at any limit; name fewer ids, or fewer authors x kinds combinations, ` +
      `and split it across several REQs`,
  };
}

// Live feed caps (relay.ts). /live has no filters, no auth and no
// per-message throttle, so it gets its own: a ceiling on concurrent
// connections (refused at the upgrade, before acceptWebSocket) and a
// lifetime enforced by a DO alarm. The admin page's own idle timeout
// (public/index.html) is cooperative only; a client can ignore it.
export const MAX_LIVE_FEED_CONNECTIONS = 5;
export const LIVE_FEED_MAX_LIFETIME_MS = 10 * 60 * 1000;


// ---------------------------------------------------------------------
// HTTP rate limiting. The limits themselves are NOT declared here, the one
// exception to this file holding every cap: Cloudflare's Rate Limiting
// binding enforces wrangler.jsonc's `ratelimits` block (60/min for every
// path that wakes the Durable Object, 10/min for /api/profile) in the
// runtime before the Worker runs, so a number here would be decorative and
// could disagree with the one in force. A binding rather than our own
// counter because ours would live in the DO (a row write per request) or
// in isolate memory (evicted by the flood it is counting).
// ---------------------------------------------------------------------

// The Retry-After the 429 carries, in seconds. Must match `period` in
// wrangler.jsonc's ratelimits block, or a caller retries before the window
// resets and spends another rejected request.
export const HTTP_RATE_LIMIT_PERIOD_SECONDS = 60;

// ---------------------------------------------------------------------
// /api/profile's kind-0 cache (profile-lookup.ts lookupProfileCached).
// A kind-0 changes a few times a year and the endpoint's traffic is one
// person typing a pubkey into the claim form, so five minutes collapses any
// realistic burst at no cost in freshness.
export const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

// Entries held before the oldest is evicted. Bounds isolate memory under a
// flood of distinct pubkeys; ordinary use never evicts.
export const PROFILE_CACHE_MAX_ENTRIES = 256;

// ---------------------------------------------------------------------
// The upstream version check (upstream-version.ts) behind /api/stats'
// update notice. Isolate-local like the profile cache (caches.default
// needs a custom domain; bothy deploys to workers.dev). /api/stats is
// public and loaded on every admin page view, and the answer changes a few
// times a month, so six hours is well under "a release you have not
// noticed" and well over any burst.
export const UPSTREAM_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// A failed check says nothing about upstream, so it is cached for minutes:
// long enough that an outage cannot turn each page view into an outbound
// attempt, short enough that one blip does not hide an update for hours.
export const UPSTREAM_VERSION_ERROR_CACHE_TTL_MS = 10 * 60 * 1000;

// The most a slow GitHub can add to a page load: the check runs
// concurrently with the getStats round trip (index.ts handleStats), and
// when it is slow the right answer is to respond without it.
export const UPSTREAM_VERSION_TIMEOUT_MS = 2500;

// Most the check will read before deciding upstream is not serving a
// package.json (the real file is ~800 bytes), so a URL that stops being a
// small JSON file cannot pull an unbounded body into Worker memory.
export const UPSTREAM_VERSION_MAX_BYTES = 16 * 1024;



// How long the cron tick waits for EOSE on one outbound backfill socket
// before giving up for this tick, so a slow or unreachable relay cannot
// stall the whole cron invocation.
export const BACKFILL_FETCH_TIMEOUT_MS = 8000;

// How much this relay may store: its storage BUDGET, the base every share
// below is a fraction of. Also served on /api/stats for the admin page's
// storage bar.
//
// 1GB by default, the smallest reading of Cloudflare's limits page
// (developers.cloudflare.com/durable-objects/platform/limits/, re-read
// 2026-11-21). The page is inconsistent: its table gives 5GB of storage per
// ACCOUNT on Workers Free and 10GB per Durable Object, and its FAQ says a
// SQLite-backed Durable Object stops taking writes at 1GB on the Free plan.
// The relay is one Durable Object, and the account's 5GB is shared with
// every other Durable Object app on the account, which bothy cannot see.
// So it assumes the least, and the owner raises it when they know better
// (STORAGE_BUDGET_BYTES; a Workers Paid account can take 10GB). Until
// 0.26.0 this was 5GB, five times the Free plan's per-object reading.
//
// Every check against it uses the database's real size
// (`sql.databaseSize`), never an estimate.
export const STORAGE_BYTES_LIMIT = 1024 * 1024 * 1024;

export function storageBudget(env: Env): number {
  return resolveLimit(env.STORAGE_BUDGET_BYTES, STORAGE_BYTES_LIMIT) ?? STORAGE_BYTES_LIMIT;
}

// Non-owner writes stop once the database passes this size, so at least
// half the ceiling stays free for the owner's own archive (the same
// reservation BACKFILL_ROWS_SHARE_LIMIT makes of the daily write budget).
// The only cap on total permanent storage: MAX_EVENT_BYTES bounds one
// event and the per-pubkey throttle the rate.
//
// Measures total database size, not the non-owner share: `sql.databaseSize`
// is a free property read, where per-author attribution would cost a row
// write per event or a scan. The owner's own data therefore counts toward
// the threshold, which is the right direction -- it is the owner's
// remaining headroom being protected.
export const NON_OWNER_STORAGE_SHARE_LIMIT = STORAGE_BYTES_LIMIT / 2;

export function nonOwnerStorageLimit(env: Env): number | null {
  return resolveLimit(env.NON_OWNER_STORAGE_BYTES, storageBudget(env) / 2);
}

// ---------------------------------------------------------------------
// The mailbox: stored gift wraps, bounded in BYTES as actually stored
// (storage.ts `mail_usage`, maintained on every insert and delete), not by
// a count priced at the worst-case event size. Until 0.26.0 this was 2,048
// wraps for the whole home (128MB / 64KB), which group messages, one wrap
// per member, would fill in days.
//
// Where the storage budget (storageBudget, 1GB by default) goes, as
// fractions so it all scales when the owner raises it: half is the
// owner's alone (nonOwnerStorageLimit); of the shared half, mail may take
// 30% of the budget, profile photos 5% (photoStorageBytes), and follows'
// and members' own events the rest. Payload bytes are counted here; SQLite
// adds its tag rows and index entries on top (about a third more for a
// small wrap), which the non-owner half absorbs.
// ---------------------------------------------------------------------

// All mail together, payload bytes: 30% of the budget (about 307MB at
// 1GB). MAIL_STORAGE_BYTES overrides; "off" removes this cap and leaves
// the non-owner share as the backstop.
const MAIL_SHARE_OF_BUDGET = 0.3;
export const MAIL_STORAGE_BYTES_DEFAULT = Math.floor(STORAGE_BYTES_LIMIT * MAIL_SHARE_OF_BUDGET);

export function mailStorageBytes(env: Env): number | null {
  return resolveLimit(env.MAIL_STORAGE_BYTES, Math.floor(storageBudget(env) * MAIL_SHARE_OF_BUDGET));
}

// One recipient's mail, the owner's included, so no one person (or a
// stranger mailing them) can fill the home: a tenth of the mail total
// (about 31MB at the default budget, some 10,000 wraps of a typical 3KB).
// MAIL_BYTES_PER_MEMBER overrides; "off" removes it.
const MAIL_SHARES = 10;
export const MAIL_BYTES_PER_MEMBER_DEFAULT = Math.floor(MAIL_STORAGE_BYTES_DEFAULT / MAIL_SHARES);

export function mailBytesPerMember(env: Env): number | null {
  const total = Math.floor(storageBudget(env) * MAIL_SHARE_OF_BUDGET);
  return resolveLimit(env.MAIL_BYTES_PER_MEMBER, Math.floor(total / MAIL_SHARES));
}

// Gift wraps one signing key may have stored here. NIP-59 signs every wrap
// with a fresh key, so a real sender never comes near it; what it bounds
// is reads. Unauthenticated reads omit gift wraps (filters.ts
// excludeGiftWraps), and an `authors`-pinned filter on a key that signed
// only wraps reads every one of them to skip it (2 rows each). That was
// why the whole inbox used to be capped by MAX_FILTER_ROWS_READ; a cap per
// key bounds the same read at 2 x 100 rows, whatever the inbox holds.
export const MAX_WRAPS_PER_AUTHOR = 100;

// Wraps eraseme deletes in its own call (storage.ts eraseMember); the rest
// go on the hourly sweep. Deleting costs about 5 rows written a wrap, so a
// large mailbox erased in one call could spend the day's 100,000.
export const ERASE_MAIL_BATCH = 1000;

// Workers Free daily rows-written ceiling (the same limits page as
// DAILY_ROWS_READ_LIMIT). Every write-side share below is a fraction of
// it; also served on /api/stats for the admin page's meter.
export const DAILY_ROWS_WRITTEN_LIMIT = 100_000;

// Single-letter tags on a gift wrap: the one `p` naming its recipient.
// NIP-59 puts nothing else there, so unlike TAGS_PER_CHAT_MESSAGE below
// this is the shape of the kind, not an estimate.
const TAGS_PER_GIFT_WRAP = 1;

// Expired gift wraps one cron tick may remove (storage.ts
// sweepExpiredGiftWraps). Insurance for many wraps expiring in the same
// hour: they drain across ticks, and the remainder needs no checkpoint
// because the sweep takes the soonest expiry first. Five percent of the
// day per tick, as CHAT_SWEEP_BATCH_SIZE: ~312 wraps.
//
// No daily share: every wrap removed was first written here at a higher
// cost (12 rows to store, 5 to remove), so a day's sweeping cannot exceed
// a day's gift wrap ingest, which the daily rows-written ceiling bounds.
const GIFT_WRAP_SWEEP_TICK_SHARE = DAILY_ROWS_WRITTEN_LIMIT / 20;
export const GIFT_WRAP_SWEEP_BATCH_SIZE = Math.max(
  1,
  Math.floor(GIFT_WRAP_SWEEP_TICK_SHARE / eventRowCost(TAGS_PER_GIFT_WRAP)),
);

// ---------------------------------------------------------------------
// Members (storage.ts, the section "Members"). A member is a pubkey in
// `allowed_pubkeys`: the relay keeps an inbox for them (relay.ts
// handleGiftWrap) and pushes to their devices when mail arrives. Someone
// joins with an invite code the owner made (nip86.ts createinvite,
// redeeminvite).
// ---------------------------------------------------------------------

// How many times one code may be redeemed, by default and at most. One by
// default: a code is normally made for one person and sent to them. The
// most is for a code posted to a group chat; the owner chooses it.
export const MEMBER_INVITE_DEFAULT_USES = 1;
export const MEMBER_INVITE_MAX_USES = 100;

// Home activity (nip86.ts homestats): 14 days of messages per day, 8
// weeks of joins, and the per-day counts kept a little longer than shown.
export const HOME_STATS_DAYS = 14;
export const HOME_STATS_WEEKS = 8;
export const HOME_STATS_DAYS_KEPT = 30;

// Who may see who else is in the home (nip86.ts homemembers). "members"
// (the default): every member sees the list, as in a group. "hidden": only
// the owner and admins do; members get an empty list and a note. Anything
// else reads as the default.
export type MemberListVisibility = "members" | "hidden";

export function memberListVisibility(env: Env): MemberListVisibility {
  return env.MEMBER_LIST?.trim().toLowerCase() === "hidden" ? "hidden" : "members";
}

// The `network` write policy (src/network.ts): the people the owner's
// follows follow, built from the follows' own contact lists, which the
// hourly tick fetches from NETWORK_RELAYS and verifies.
//
// Keys it may hold. Each costs 2 rows written to add and 1 to keep on each
// weekly refresh, so 40,000 is about 80,000 rows once and 40,000 a week,
// both paced by NETWORK_ROWS_PER_TICK. Sized from one real owner
// (2026-11-22): 361 follows, 217 of whose lists three public relays had,
// naming 25,450 distinct people. Past the cap, further keys are not added
// and /api/stats says so. NETWORK_MAX_KEYS overrides.
export const NETWORK_MAX_KEYS_DEFAULT = 40_000;

export function networkMaxKeys(env: Env): number {
  return resolveLimit(env.NETWORK_MAX_KEYS, NETWORK_MAX_KEYS_DEFAULT) ?? NETWORK_MAX_KEYS_DEFAULT;
}

// Rows one tick may write to the list: a tenth of the day's 100,000,
// spread over the 24 hourly ticks. Filling 40,000 keys takes about eight
// days; a refresh of them about four.
export const NETWORK_ROWS_PER_TICK = Math.floor(100_000 / 10 / 24);

// Follows whose contact lists one tick fetches, in one REQ per relay.
export const NETWORK_AUTHORS_PER_TICK = 25;

// How often the whole list is rebuilt from the follows' current lists, so
// someone a follow stops following drops out.
export const NETWORK_REFRESH_SECONDS = 7 * 24 * 60 * 60;

// A rebuild only drops keys nobody re-listed when it found at least this
// share of the lists the previous rebuild found: a relay that answered for
// fewer this week must not empty the list. Relative, not a share of all
// follows, because public relays hold only some follows' lists (60% in
// the measurement above), and an absolute bar would never be met.
export const NETWORK_MIN_COVERAGE = 0.8;

// Where the follows' lists are fetched from (network-worker.ts). Wider
// than WELL_KNOWN_RELAYS: measured 2026-11-22, relay.primal.net had most
// of one owner's follows' lists where the other two had few.
export const NETWORK_RELAYS = ["wss://relay.primal.net", "wss://relay.damus.io", "wss://nos.lol"];

// Members' own invites (nip86.ts createinvite from a member). The owner
// and admins are not limited; a member may let in INVITES_PER_MEMBER
// people, and only while they are fewer than INVITE_DEPTH steps from the
// owner (the owner's own invitees are 1 step away), so the tree stays a
// few people wide and a few deep. A slot is a person a code may admit:
// a live code holds all its uses, a revoked or expired one only those
// already used (storage.ts inviteSlotsUsed). "off" on either turns
// member invites off, back to owner and admins only.
export const INVITES_PER_MEMBER_DEFAULT = 5;
export const INVITE_DEPTH_DEFAULT = 3;

export function memberInviteLimits(env: Env): { perMember: number; depth: number } | null {
  const perMember = resolveLimit(env.INVITES_PER_MEMBER, INVITES_PER_MEMBER_DEFAULT);
  const depth = resolveLimit(env.INVITE_DEPTH, INVITE_DEPTH_DEFAULT);
  if (perMember === null || depth === null) return null;
  return { perMember: Math.floor(perMember), depth: Math.floor(depth) };
}

// Own keys per member (nip86.ts addmykey): other keys of the same person,
// e.g. the per-app children a Keykin account makes, let in with a proof
// signed by both keys. They spend no invite place, so this is their own
// cap. Ten is one per app with room to spare. OWN_KEYS_PER_MEMBER
// overrides; "off" turns addmykey off.
export const OWN_KEYS_PER_MEMBER_DEFAULT = 10;

export function ownKeysPerMember(env: Env): number | null {
  const cap = resolveLimit(env.OWN_KEYS_PER_MEMBER, OWN_KEYS_PER_MEMBER_DEFAULT);
  return cap === null ? null : Math.floor(cap);
}

// How far the addmykey proof's created_at may be from now, either way.
export const OWN_KEY_PROOF_MAX_AGE_SECONDS = 60;

// Random bytes in a generated code: 128 bits, hex-encoded to 32
// characters. The relay makes every member code itself, so unlike the
// NIP-29 path (MIN_INVITE_CODE_LENGTH) there is no owner-chosen code to
// put a floor under; guessing one is not a strategy at any request rate.
export const MEMBER_INVITE_CODE_BYTES = 16;

// How long a removed member can still fetch the mail stored for them
// before it is deleted (storage.ts sweepFormerMembers). Long enough for
// their app to notice it has lost its home and fetch what is waiting; new
// mail for them is refused from the moment they are removed.
export const MEMBER_REMOVAL_GRACE_SECONDS = 14 * 24 * 60 * 60;

// Former members one cron tick looks at, and wraps it deletes for them.
// The second is the gift wrap sweep's batch: the same rows, the same cost.
export const FORMER_MEMBER_SWEEP_PUBKEYS = 8;
export const FORMER_MEMBER_SWEEP_BATCH_SIZE = GIFT_WRAP_SWEEP_BATCH_SIZE;

// Distinct `p` values one gift wrap is checked against for membership. A
// NIP-59 wrap names exactly one recipient (TAGS_PER_GIFT_WRAP), so this
// only bounds the lookups a malformed wrap can make a stranger cost.
export const MAX_WRAP_RECIPIENTS_CHECKED = 4;

// ---------------------------------------------------------------------
// Profile photos (src/photos.ts, a Blossom server for exactly one thing).
// Held in this Durable Object's own SQLite, so they share the 5GB with
// everything else; every number below exists to keep that share small and
// visible. docs/principles.md "Restraint" is the rule they follow.
// ---------------------------------------------------------------------

// The largest one photo may be. The apps send a 512px JPEG, which is
// 30-80KB; 100KB leaves room without inviting anything that is not a
// profile photo. PHOTO_MAX_BYTES may raise it, never past the ceiling,
// which is half SQLite's 2MB value limit in a Durable Object
// (developers.cloudflare.com/durable-objects/platform/limits, checked
// 2026-11-21), so a photo is always one row.
export const PHOTO_MAX_BYTES_DEFAULT = 100 * 1024;
export const PHOTO_MAX_BYTES_CEILING = 1024 * 1024;

export function photoMaxBytes(env: Env): number {
  const raw = env.PHOTO_MAX_BYTES === undefined ? NaN : Number(env.PHOTO_MAX_BYTES);
  if (!Number.isFinite(raw) || raw <= 0) return PHOTO_MAX_BYTES_DEFAULT;
  return Math.min(Math.floor(raw), PHOTO_MAX_BYTES_CEILING);
}

// All photos together. At the cap new uploads are refused and nothing
// else changes. "off" turns photos off: no uploads, nothing served, and
// no `blossom` on NIP-11.
//
// 5% of the storage budget (about 51MB at the default 1GB: some 500
// photos at the 100KB cap, ten times what a home of fifty needs). It was a
// fixed 250MB, 5% of the 5GB the relay used to assume.
const PHOTO_SHARE_OF_BUDGET = 0.05;
export const PHOTO_STORAGE_BYTES_DEFAULT = Math.floor(STORAGE_BYTES_LIMIT * PHOTO_SHARE_OF_BUDGET);

export function photoStorageBytes(env: Env): number | null {
  return resolveLimit(env.PHOTO_STORAGE_BYTES, Math.floor(storageBudget(env) * PHOTO_SHARE_OF_BUDGET));
}

// Uploads one pubkey may make in a UTC day. Each replaces their one photo,
// so this bounds rows written (2 per upload), not storage. Five is
// someone changing their mind, not a script.
export const PHOTO_UPLOADS_PER_DAY = 5;

// ---------------------------------------------------------------------
// The restore vault (src/vault.ts): each member's passkey-locked copy of
// their key, which this relay stores and cannot open.
// ---------------------------------------------------------------------

// All vault rows together: 1% of the storage budget (about 10MB at the
// default 1GB, some 5,000 rows at the row cap; real use is a few hundred
// bytes a person). Taken from the part no other share claims: the owner's
// half, mail's 30% and photos' 5% leave about 15% unassigned.
// VAULT_STORAGE_BYTES overrides; "off" removes this cap and leaves the
// non-owner share as the backstop, like the mail cap.
const VAULT_SHARE_OF_BUDGET = 0.01;
export const VAULT_STORAGE_BYTES_DEFAULT = Math.floor(STORAGE_BYTES_LIMIT * VAULT_SHARE_OF_BUDGET);

export function vaultStorageBytes(env: Env): number | null {
  return resolveLimit(env.VAULT_STORAGE_BYTES, Math.floor(storageBudget(env) * VAULT_SHARE_OF_BUDGET));
}

// Rows one person may have: one per passkey. Usually one synced passkey
// covers every phone; ten is room for a few passkey apps and rotations.
export const VAULT_ROWS_PER_MEMBER = 10;

// The locked copy (about 200 bytes in practice), and the whole row:
// credential id, public key, copy and label together.
export const VAULT_BLOB_MAX_BYTES = 1024;
export const VAULT_ROW_MAX_BYTES = 2048;

// A row's label, e.g. the passkey app's name, in characters.
export const VAULT_LABEL_MAX_LENGTH = 64;

// How long a vaultchallenge stays good. Spent by the first vaultopen that
// names it, found or not.
export const VAULT_CHALLENGE_TTL_SECONDS = 120;

// Every vaultopen answer, success or not, leaves the Worker no sooner than
// this after the request arrived, so a row lookup or a signature check
// against a real key cannot be told from one against the dummy key.
export const VAULT_OPEN_FLOOR_MS = 300;

// Per address, per method (vaultchallenge and vaultopen each): ten a
// minute is a person retrying a fingerprint. In memory, like the other
// per-address throttles.
export const VAULT_IP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
export const MAX_VAULT_CALLS_PER_IP_PER_WINDOW = 10;

// Per row hash, counted whether the row exists or not: twenty opens an
// hour. In memory too.
export const VAULT_HASH_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
export const MAX_VAULT_OPENS_PER_HASH_PER_WINDOW = 20;

// How far ahead of now a kind-24242 auth event's `created_at` may be,
// matching nip98.ts HTTP_AUTH_MAX_DRIFT_SECONDS. Its expiry is its own
// `expiration` tag (BUD-01).
export const PHOTO_AUTH_MAX_FUTURE_SECONDS = 60;

// Join requests (nip86.ts requestjoin): somebody with a "Message me" link
// and no code asks to become a member, and the owner approves or declines.
//
// A request waits this long, and a declined one is remembered this long
// after the decline, so the same person cannot ask again at once.
export const JOIN_REQUEST_TTL_SECONDS = 30 * 24 * 60 * 60;

// Requests waiting at once. Each one also costs a message to the owner
// (12 rows written, the gift wrap's cost), and anyone can ask, from any
// number of fresh keys; this is what bounds the owner's inbox against
// that. Past it, requestjoin says to try again later.
export const MAX_PENDING_JOIN_REQUESTS = 50;

// Per address: how often requestjoin may be called (relay.ts, in memory,
// like the NIP-29 join throttle). Three in ten minutes is a person
// retrying, not a script.
export const REQUEST_JOIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
export const MAX_REQUEST_JOINS_PER_IP_PER_WINDOW = 3;

// What a requester may say about themselves, in characters. The name goes
// into the owner's message as "<name> wants to join your home.", so it is
// kept to a name's length; the note is a sentence or two.
export const JOIN_REQUEST_NAME_MAX_LENGTH = 64;
export const JOIN_REQUEST_NOTE_MAX_LENGTH = 280;

// ---------------------------------------------------------------------
// Call presence (push.ts CALL_PRESENCE_KIND; hearth's reference/push.md).
// hearth beats every five seconds during a call and treats a pubkey as
// gone 13 seconds after its last beat. A notification is owed only on the
// transition from absent to present (pushing per beat would be twelve a
// minute per person), and storing every beat would be a row write every
// five seconds per participant. So the watermark is stored coarsely, in
// two tiers:
//
//   memory   relay.ts presenceWrites: a beat within the write interval of
//            that pubkey's last write costs no read and no write (seven
//            beats in eight). Lost on eviction.
//   storage  `presence.last_seen`, one row per pubkey, refreshed at most
//            once per interval; what an evicted object reads to tell an
//            ongoing call from an arrival.
// ---------------------------------------------------------------------

// hearth's HEARTBEAT_MS and PRESENCE_TIMEOUT_MS (app.js). Everything below
// derives from them; a client that changes its beat rate changes what this
// relay must tolerate.
export const PRESENCE_HEARTBEAT_SECONDS = 5;
export const PRESENCE_TIMEOUT_SECONDS = 13;

// The budget: 1% of the daily rows-written ceiling per hour of a ten-person
// call, so a four-hour evening is 4% of the day.
const PRESENCE_HOURLY_ROWS_SHARE = DAILY_ROWS_WRITTEN_LIMIT / 100;
const PRESENCE_REFERENCE_CALL_SIZE = 10;

// Rounded UP to a whole heartbeat, since a write due between beats happens
// at the next beat:
//
//   1,000 rows/hour / 10 people        = 100 writes per person per hour
//   3,600s / 100                       = one write per 36 seconds
//   rounded up to a whole heartbeat    = 8 beats, 40 seconds
//
// Ten people for an hour: 10 x 90 = 900 rows, 0.9% of the day, against
// 72,000 for a write per beat.
export const PRESENCE_WRITE_INTERVAL_SECONDS =
  PRESENCE_HEARTBEAT_SECONDS *
  Math.ceil(
    3600 / (PRESENCE_HOURLY_ROWS_SHARE / PRESENCE_REFERENCE_CALL_SIZE) / PRESENCE_HEARTBEAT_SECONDS,
  );

// How stale a STORED watermark may be and still mean "in the call".
// Derived, not chosen: a beating client refreshes its row on the first
// beat at or after the write interval, so a live row is never older than
// the interval plus one beat; anything older is an arrival. The cost: the
// stored tier resolves presence at 45 seconds rather than hearth's 13, so
// a connection that drops and returns within 45 seconds of an eviction is
// not announced again. That is the right direction to be wrong in -- a
// reconnect is not an arrival.
export const PRESENCE_STALE_SECONDS =
  PRESENCE_WRITE_INTERVAL_SECONDS + PRESENCE_HEARTBEAT_SECONDS;

// Ceiling on relay.ts presenceWrites (pruned in rememberPresenceWrite),
// like PUBKEY_RATE_LIMIT_MAX_TRACKED: keyed by pubkey, and group
// membership is not bounded by anything in this file.
export const PRESENCE_MAX_TRACKED = 1_000;

// ---------------------------------------------------------------------
// Push fan-out (src/push.ts, relay.ts drainPushOutbox). The binding bound
// is subrequests, not rows: every push is an outbound HTTPS request, and
// Workers Free allows 50 per invocation
// (developers.cloudflare.com/workers/platform/limits/, checked 2026-08-30).
// Twenty members with three devices each is sixty endpoints, and an inline
// fan-out would fail at the fifty-first -- a partial delivery nobody
// notices. So the fan-out is queued and drained by the Durable Object's
// alarm, one batch per invocation, each with a fresh allowance.
// ---------------------------------------------------------------------

// Workers Free subrequests per invocation; the two constants below derive
// from it.
export const WORKER_SUBREQUEST_LIMIT = 50;

// Left unspent so the batch never reaches the ceiling. The alarm makes no
// other outbound request today; the reserve is for one added later, which
// would otherwise silently cost the fan-out its last endpoint.
const PUSH_SUBREQUEST_RESERVE = 10;

// Endpoints pushed in one alarm invocation.
export const MAX_PUSHES_PER_TICK = WORKER_SUBREQUEST_LIMIT - PUSH_SUBREQUEST_RESERVE;

// Alarm invocations one notification may span before the rest of its
// endpoints are dropped. A notification goes stale; waking a phone about a
// message from half an hour ago is worse than not waking it. The alarm
// reschedules immediately, so this is four consecutive wakes.
const PUSH_MAX_TICKS = 4;

// The real ceiling on one notification: 160 endpoints, 40 members at the
// four-device cap. Endpoints past it are dropped, loudly (relay.ts logs
// the count with console.warn). Raising it means raising PUSH_MAX_TICKS
// and accepting the extra staleness.
export const MAX_PUSH_ENDPOINTS_PER_NOTIFICATION = MAX_PUSHES_PER_TICK * PUSH_MAX_TICKS;

// Endpoints one pubkey may register: a phone, a laptop, a home-screen
// install and a browser tab (hearth's reference/push.md). Every device is
// a subrequest every message spends. The oldest is evicted rather than the
// new one refused, because browsers rotate endpoints on their own schedule
// and dead rows would otherwise lock a member out of notifications.
export const MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY = 4;

// Android push tokens one pubkey may register (src/fcm.ts), separate from
// the web push devices above: oldest evicted, as there.
export const MAX_FCM_TOKENS_PER_PUBKEY = 4;

// How long a push service may hold an undeliverable notification (RFC
// 8030 TTL). A message stays true for the hour; "somebody is in the call"
// stops being true when they leave, so a voice notification older than
// five minutes would announce an empty room. A ring stops being true when
// it stops ringing, so a call push lives 30 seconds.
export const PUSH_TTL_SECONDS = { message: 3600, voice: 300, call: 30 } as const;

// RFC 8188 record size, written into the body header. One record; the
// payload is a room name and one word, so this sits well clear of the
// 4096-byte body every push service accepts rather than being tight.
export const PUSH_RECORD_SIZE = 4096;

// Most plaintext one record carries: the record less RFC 8188's one-byte
// padding delimiter and AES-GCM's 16-byte tag.
export const PUSH_PAYLOAD_MAX_BYTES = PUSH_RECORD_SIZE - 1 - 16;

// How stale `push_subscriptions.last_ok_at` may get before a successful
// send refreshes it. Writing it on every push would be a row per device
// per notification, for a column whose only reader would be a sweep of
// long-dead endpoints. A 404 or 410 deletes the row immediately and does
// not depend on this.
export const PUSH_LAST_OK_INTERVAL_SECONDS = 24 * 60 * 60;

// Delay before the alarm drains the outbox, and between batches of one
// fan-out. Going out, it is the coalescing window: messages typed in the
// same breath become one notification (as hearth's service worker would
// collapse them anyway, `tag: "hearth:message"`). Between batches it is
// short because the only reason for a next batch is the subrequest
// ceiling.
export const PUSH_ALARM_DELAY_MS = 2000;

// VAPID JWT lifetime. RFC 8292: `exp` "MUST NOT be more than 24 hours from
// the time of the request". Twelve hours is well inside that and outside
// any clock skew; the token is minted per fan-out and never stored.
export const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

// Maximum seconds an event's created_at may lead now. A replaceable kind
// keeps the version with the higher created_at, so a kind-0 or kind-3 dated
// years ahead can never be superseded -- and the kind-3 gates writes, so
// that freezes who may publish here too. Reachable by accident (a wrong
// client clock, often the owner's own), so this is self-inflicted-damage
// prevention. An hour absorbs real clock skew. No lower bound on purpose
// (validate.ts isCreatedAtTooFarInFuture): backfill imports years of
// history, and republishing old work with its real date is a normal use.
//
// Unrelated to nip42.ts AUTH_MAX_DRIFT_SECONDS, NIP-42's two-sided window
// for auth events.
export const MAX_CREATED_AT_FUTURE_SECONDS = 3600;

// Backfill's share of the daily rows-written ceiling, counted from 00:00
// UTC (backfill.ts hasBackfillHeadroom). Half, so the other half is always
// left for the owner's own traffic that day.
export const BACKFILL_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 2;

// Inputs to BACKFILL_PAGE_SIZE, the events requested per relay per cron
// tick. CPU is not the bound: a Durable Object gets 30s of CPU per request
// by default (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-22) and a schnorr verify is ~1.1ms (validate.ts). Rows
// written are: the page uses 80% of BACKFILL_ROWS_SHARE_LIMIT across the
// day's ticks, leaving margin for history heavier than average.
//
// Derived from eventRowCost, never written as a literal: a hand-derived
// page size goes silently wrong whenever an index changes the per-event
// cost. TAGS_PER_REAL_EVENT is measured: real notes carry about five
// single-letter tags (`e` and `p` on replies, plus others).
const TAGS_PER_REAL_EVENT = 5;
const BACKFILL_SHARE_UTILISATION = 0.8;

// wrangler.jsonc's `triggers.crons` ("0 * * * *") as a number; a Worker
// cannot read its own wrangler.jsonc at runtime. test/hibernation.test.ts
// asserts the crontab matches: a more frequent trigger without updating
// this would multiply backfill's and the vanish drain's real daily writes
// with no test failing.
export const CRON_TICKS_PER_DAY = 24;

// Never zero: enough indexes could drive the quotient below one, and
// floor() would silently stop backfill.
export const BACKFILL_PAGE_SIZE = Math.max(
  1,
  Math.floor(
    (BACKFILL_ROWS_SHARE_LIMIT * BACKFILL_SHARE_UTILISATION) /
      (eventRowCost(TAGS_PER_REAL_EVENT) * CRON_TICKS_PER_DAY),
  ),
);

// Events one cron tick removes for a pubkey with a NIP-62 vanish in
// progress (storage.ts drainVanish). Bounded by rows written; reads are
// cheap thanks to idx_event_tags_event. A quarter of the day: larger, and
// one stranger's request, which the relay cannot refuse, spends the
// owner's write budget; smaller, and a NIP-62 MUST takes weeks. A large
// vanish takes days at any share, so what matters is that it finishes and
// is visible meanwhile (/api/stats reports a count, progress total and age
// of draining requests).
export const VANISH_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 4;
// Paced against schema.ts eventRemovalBudget (the pessimistic removal
// figure, tombstone included), not a hand-written `eventRowCost(...) + 2`.
// Never zero, and here that matters: drainVanish treats a short batch as
// "done", so a limit of 0 would delete nothing and leave the request
// pending forever.
export const VANISH_BATCH_SIZE = Math.max(
  1,
  Math.floor(VANISH_ROWS_SHARE_LIMIT / (eventRemovalBudget(TAGS_PER_REAL_EVENT) * CRON_TICKS_PER_DAY)),
);

// ---------------------------------------------------------------------
// Mailbox retention (storage.ts sweepRetention, nip86.ts setretention and
// backedup). Off by default. When the owner turns it on, the hourly tick
// deletes a stored gift wrap once it is older than MAIL_RETENTION_SECONDS
// AND every recipient's app has verified a history backup that holds it
// (their `backedup` watermark). Every number the sweep uses is here.
// ---------------------------------------------------------------------

// How old mail must be before retention may delete it, by when this relay
// stored it (`events.ingested_at`): more than 30 days.
export const MAIL_RETENTION_SECONDS = 30 * 24 * 60 * 60;

// Retention's share of the daily rows-written ceiling, a quarter, as the
// vanish drain's. A first run on a full home has months of mail to clear,
// so unlike the expiry sweep (GIFT_WRAP_SWEEP_BATCH_SIZE) it cannot lean on
// "never more than a day's ingest": it gets a share and drains across days.
export const RETENTION_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 4;

// Wraps one tick may delete: the share spread over the day's ticks, paced
// against the pessimistic removal figure (schema.ts eventRemovalBudget),
// about 57 a tick or 1,380 a day at the defaults. Never zero, so a tick
// always makes progress.
export const RETENTION_SWEEP_BATCH_SIZE = Math.max(
  1,
  Math.floor(RETENTION_ROWS_SHARE_LIMIT / (eventRemovalBudget(TAGS_PER_GIFT_WRAP) * CRON_TICKS_PER_DAY)),
);

// Retention never spends the second half of a day's rows written: a tick
// that finds this many already written since 00:00 UTC deletes nothing
// and waits for the next, so new mail always has room. The same half
// backfill leaves for live traffic (BACKFILL_ROWS_SHARE_LIMIT).
export const RETENTION_PAUSE_AT_ROWS_WRITTEN = DAILY_ROWS_WRITTEN_LIMIT / 2;

// ---------------------------------------------------------------------
// Ephemeral group chat (storage.ts sweepChat, relay.ts runCron). Kind-9
// chat in the group partition is deleted (not hidden or archived) once its
// conversation is over. Four rules, one constant each:
//
//   a conversation ends       when the room has been EMPTY for
//                             CONVERSATION_IDLE_SECONDS; everything said
//                             during it goes.
//   speech                    a message sent while somebody else was in
//                             the room belongs to that conversation.
//   a note                    a message sent to an empty room is not
//                             speech; it waits for the next conversation,
//                             however long that takes.
//   arriving partway through  you see the last CHAT_BACKLOG_SECONDS.
//
// Only the relay can do this: it alone sees everyone's presence, and a
// client expiring its own copy would hide a transcript the relay still
// held. Scoped to the chat kind (groups.ts GROUP_CHAT_KIND); notes,
// backfill, gift wraps, the 39000-series and moderation events are
// untouched.
// ---------------------------------------------------------------------

// How long the room must stay empty before its conversation is over: long
// enough that dinner does not end it, short enough that an evening ends
// when the evening does. A floor, not an exact interval: the sweep runs on
// the hourly cron, so removal comes two to three hours after the last
// person leaves. Erring late is the safe direction.
export const CONVERSATION_IDLE_SECONDS = 2 * 60 * 60;

// How much of a conversation in progress a late arrival is shown: enough
// to know what is being discussed, not enough to replace asking. A READ
// horizon, not a second expiry: the messages remain, and everyone present
// already has them. REQs are clamped to it (filters.ts
// FilterQueryOptions.chatHorizon), which is also most of the rows-read
// saving: a chat read becomes an index range a few minutes wide.
export const CHAT_BACKLOG_SECONDS = 5 * 60;

// There is deliberately no ceiling on how long a note waits: a note has not
// been heard yet, so it has nothing to expire from. Its sender can delete
// it with a NIP-09 kind-5 (storage.ts applyDeletion). The consequence:
// nothing bounds chat if the occupancy watermark wrongly believes the room
// is never empty, e.g. two tabs left open overnight (relay.ts
// groupOccupants).

// How many people make a room not empty. Two: a message is speech when
// SOMEBODY ELSE could hear it, so its author alone is an empty room. A
// definition, not a tunable threshold.
export const MIN_ROOM_OCCUPANTS = 2;

// Coarseness of the stored occupancy watermark,
// `chat_state.last_occupied_at`, while the room is occupied. Derived from
// what it must resolve (a boundary measured in hours) rather than from
// cost, unlike PRESENCE_WRITE_INTERVAL_SECONDS: this is one row for the
// whole room. 7.5 minutes is 192 writes a day with the room occupied
// around the clock, 0.2% of DAILY_ROWS_WRITTEN_LIMIT.
//
// The watermark is the sweep's cutoff, so a lagging one deletes LESS: a
// message from a conversation's last few minutes may be treated as a note
// and wait for the next sweep. That is the safe direction.
const CHAT_OCCUPANCY_RESOLUTION_DIVISOR = 16;
export const CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS =
  CONVERSATION_IDLE_SECONDS / CHAT_OCCUPANCY_RESOLUTION_DIVISOR;

// Single-letter tags on a kind-9 chat message: `h` naming the group, plus
// an `e` on a reply. An assumption, chosen high: over-estimating tags
// over-estimates a removal, which shrinks the batch below (slower, never
// overrunning).
const TAGS_PER_CHAT_MESSAGE = 2;

// Chat messages one cron tick may remove: 5% of the day, 250 messages at
// the charged cost of a two-tag message, so an evening clears in a tick or
// two and a backlog drains at 6,000 a day. storage.ts sweepChat
// checkpoints the remainder.
//
// No daily share, unlike backfill and the vanish drain, whose volume
// somebody else chooses. Every message swept was written here first, at a
// higher cost than removing it (12 rows to store a one-tag message, 5 to
// remove it; test/ephemeral-chat.test.ts), so a day's sweeping
// cannot exceed a day's chat ingest.
const CHAT_SWEEP_TICK_SHARE = DAILY_ROWS_WRITTEN_LIMIT / 20;
export const CHAT_SWEEP_BATCH_SIZE = Math.max(
  1,
  Math.floor(CHAT_SWEEP_TICK_SHARE / eventRowCost(TAGS_PER_CHAT_MESSAGE)),
);

// ---------------------------------------------------------------------
// NIP-29 groups: PAUSED unless GROUPS is the exact string "on". Paused: no
// group-scoped event is accepted from anyone, the owner included; no
// moderation event or join request is honoured; the cron tick neither
// samples occupancy nor sweeps chat; NIP-11 does not list 29. What is
// already in the group partition stays, still hidden from unauthenticated
// reads and readable by the owner and members.
//
// Inverted from the write-path caps (where turning a safety cap OFF is the
// act that must be spelled out): here turning the feature ON admits new
// writers to a partition, so that is the act that must be spelled out.
// ---------------------------------------------------------------------
export function groupsEnabled(env: Env): boolean {
  return env.GROUPS === "on";
}

// ---------------------------------------------------------------------
// The `mentions` write policy (src/write-policy.ts) admits anyone whose
// event p-tags the owner, so its volume is chosen by strangers. The other
// non-owner caps bound bytes, rate and storage share, but not rows written
// PER EVENT: 3 per single-letter tag (4 charged, schema.ts TAG_ROW_COST),
// and a 64KB event can carry ~2,000 tags, ~6,000 rows (6% of the day) per
// event.
//
// So a stranger's event is capped in indexed tags, sized to a real
// conversation: a deep NIP-10 reply (root and parent `e`, a `p` per thread
// participant, a few `t`/`q`/`r`) reaches about twenty. At 32 the worst
// event is charged 12 + 4 x 32 = 140 rows, ~2,800 a minute at the
// per-pubkey rate cap -- visible on the admin page and revocable with
// banpubkey. Not applied to follows or allowlisted pubkeys (ownership.ts
// isAllowedWriter): a follow's kind-3 with hundreds of `p` tags is exactly
// what this cap would refuse.
// ---------------------------------------------------------------------
export const MAX_MENTION_EVENT_INDEXED_TAGS = 32;

export type ChatMode = "off" | "reporting" | "deleting";

// What the relay may DO about ephemeral chat (EPHEMERAL_CHAT):
//
//   unset, or anything else   REPORTING: nothing deleted or withheld from a
//                             read; each cron tick logs what it would
//                             remove, so the owner can watch it be right
//                             first.
//   "on"                      DELETING: the sweep removes, and reads are
//                             clamped to the horizon.
//   "off"                     neither: no sweep, no report, no horizon.
//
// Inverted from DISABLE_VALUE's usual shape for the same reason as
// groupsEnabled: here deletion is the act that must be spelled out.
// Reporting rather than off by default, so the feature is exercised on
// real deployments before anything is deleted.
export function chatMode(env: Env): ChatMode {
  if (env.EPHEMERAL_CHAT === "on") return "deleting";
  if (env.EPHEMERAL_CHAT === DISABLE_VALUE) return "off";
  return "reporting";
}
