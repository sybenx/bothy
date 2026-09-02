import { tagFilterEntries, type Filter } from "./nostr";
import { expandFilterCount, filterParamCount, tagScanLimit } from "./filters";
import { eventRemovalBudget, eventRowCost, indexesOn } from "./schema";

// Hijacking is not the threat here. Read abuse is. The write path is
// already owner-gated (ownership.ts isAllowedWriter), so these caps
// aren't defending against someone taking over the relay -- they're
// bounding a completely different risk: reads are public by design,
// so anyone can burn the daily 5M rows-read and 100k DO-request
// ceilings without ever touching ownership at all. These are the
// structural mitigations; per-IP throttling is enforced separately in
// relay.ts since it needs connection-level state these pure functions
// don't have.

// Concurrent subscriptions a single WebSocket connection may hold open.
export const MAX_SUBSCRIPTIONS_PER_CONNECTION = 10;

// A filter's own `limit` field is capped at this even if the client asks
// for more.
export const MAX_FILTER_LIMIT = 500;

// Total events returned across all filters in one REQ, after ORing and
// deduping (storage.ts queryFilters) -- caps the worst case of several
// filters each returning MAX_FILTER_LIMIT.
export const MAX_EVENTS_PER_REQ = 500;

// ---------------------------------------------------------------------
// Write-path abuse caps. Everything below this line bounds what a writer
// who is *allowed* to write can cost -- a separate concern from the read
// caps above, and from ownership.ts, which decides who may write at all.
//
// The original threat model had exactly one
// untrusted write path: kind-1059 gift wraps, "the only unbounded write
// path", since every other write was the owner's own and the owner is
// trusted not to attack their own relay. v0.2.0 made ALLOW_FOLLOWS an
// opt-OUT, which quietly turned "one trusted author" into "hundreds of
// pubkeys the owner has merely followed" -- without moving any of the
// gift wrap caps across. A single compromised or malicious follow was
// then bounded only by the per-IP message rate limit in relay.ts: at 300
// messages/minute and the measured 13 rows/event (CLAUDE.md "The budget"), about
// 26 minutes to exhaust the daily rows-written ceiling, and -- far worse,
// because storage does not reset daily -- under ten minutes to fill the
// free tier's whole 5GB permanently. Nothing in this codebase bounded an
// event's size; the only thing that did was SQLite's own 2MB maximum row
// size (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-25), which is a limit on what can be stored, not a
// defence. 5GB / 2MB is 2,560 events, and 2,560 events at 300/minute is
// eight and a half minutes. See CLAUDE.md "The budget" for the full before/after.
//
// Each cap is raisable or disablable through an environment variable
// (see resolveLimit below), since none of these ceilings apply on a paid
// plan.
// ---------------------------------------------------------------------

// The exact string that turns a cap off. Same shape as ALLOW_FOLLOWS
// (ownership.ts allowFollowsEnabled) and for the same reason: removing a
// safety cap must be a deliberate, spelled-out act, never something any
// truthy value does by accident. A malformed or empty value falls back
// to the default rather than resolving to "no limit" -- a typo in the
// Cloudflare dashboard should cost you the override, not the cap.
const DISABLE_VALUE = "off";

// Resolves one of the three env-overridable caps below. Null means the
// cap is disabled; callers skip the check entirely rather than comparing
// against Infinity. Read defensively (`env.X` may be undefined) because
// none of these are declared in wrangler.jsonc -- see src/env.d.ts.
function resolveLimit(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (raw === DISABLE_VALUE) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

// Rejects any event larger than this many bytes (JSON-serialized wire
// size), applied uniformly to every writer including the owner.
//
// This was MAX_GIFT_WRAP_BYTES, scoped to kind 1059 alone, and that
// constant is gone rather than kept alongside this one: two caps
// expressing the same idea are two caps that have to agree forever. Its
// reasoning carries over unchanged and now covers every kind. 64KB is
// generous for real content -- a NIP-17 DM (encrypted seal + rumor) is
// typically low single-digit KB, and even long-form (kind 30023) rarely
// approaches it -- while bounding how much of the 100,000
// rows-written/day and 5GB storage ceilings any single event can cost.
//
// This is the cap that bounds the *permanent* damage. The two below only
// slow an abuser down; rows-written resets every day, stored bytes never
// do, so an unbounded event size is the one way a single author can cost
// the relay something the next morning doesn't undo.
export const MAX_EVENT_BYTES = 64 * 1024;

export function maxEventBytes(env: Env): number | null {
  return resolveLimit(env.MAX_EVENT_BYTES, MAX_EVENT_BYTES);
}

// Total gift wraps this relay will hold at once -- see maxGiftWraps below
// (moved next to STORAGE_BYTES_LIMIT, which it is now derived from) for
// the cap itself and why it is a function of env rather than a constant.

// Per-IP gift wrap write throttle, separate from the general per-message
// rate limit in relay.ts (which counts REQ/CLOSE/AUTH too and is tuned
// for connection-level spam, not specifically for rows-written risk). At
// 100,000 rows-written/day and ~5 rows per stored gift wrap (see
// CLAUDE.md "The budget"), an unthrottled flood could exhaust the daily write
// budget in minutes; this window is generous for real DM traffic
// (nobody legitimately sends more than a handful of messages a minute)
// while keeping a sustained flood far below the daily ceiling.
export const GIFT_WRAP_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_GIFT_WRAPS_PER_IP_PER_WINDOW = 5;

// ---------------------------------------------------------------------
// NIP-29 invites (src/nip29.ts). An invite code is a BEARER TOKEN, and
// every cap below exists because of that one word.
//
// The relay cannot authenticate the person who will present it -- that is
// the point, not a shortcoming: the whole reason an invite link works for
// onboarding is that the person clicking it may not have an npub until
// they click. So the code is the credential, whoever holds it, and the
// only controls available are how long it lives, how many exist, how hard
// it is to guess, and how fast it can be guessed at. One each, below.
// ---------------------------------------------------------------------

// How long an invite lives when the kind-9009 that created it names no
// expiry of its own, and the longest one it may name.
//
// EXPIRY IS MANDATORY -- an invite with no `expiration` tag gets the
// default rather than living forever, and one asking for longer than the
// maximum is refused rather than clamped. NIP-29 says nothing about
// either (it describes kind-9009 as carrying an "arbitrary `code`" and
// stops there), so this is bothy's policy and is documented as such in
// the README.
//
// The reasoning is the bearer-token one again: a credential with no
// expiry outlives every reason it was issued, and it does so silently.
// An invite link pasted into a chat, a screenshot, a synced note, a
// browser history -- each is a copy the owner cannot count and will not
// remember, and without an expiry each stays live until somebody thinks
// to revoke a code they have long since forgotten issuing. A revocation
// the owner has to remember to perform is a revocation that does not
// happen; an expiry happens on its own.
//
// Refused rather than clamped, because clamping is a silent
// disagreement: the client that asked for a year would be told `["OK",
// id, true]` and would go on believing the link it just generated lasts a
// year. The refusal names the maximum, so the client can ask again for
// something this relay will actually honour.
export const INVITE_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;
export const INVITE_MAX_TTL_SECONDS = 30 * 24 * 60 * 60;

// The code itself, bounded at both ends.
//
// The minimum is the only guessing defence this relay can enforce, and it
// is a weak one: length is not entropy, and an owner who picks a
// sixteen-character English sentence has satisfied it while producing a
// code worth nothing. Nothing here can check entropy -- the code arrives
// already chosen, inside a signed event -- so the honest statement is
// that this floor stops the accidents (a code typed by hand, a client
// with a lazy generator) and the per-IP throttle below is what bounds the
// deliberate case. A client generating 16 random hex characters is at 64
// bits, which the throttle puts far out of reach.
//
// The maximum is a storage bound and nothing more: the code is stored
// verbatim in `group_invites` and echoed back by the NIP-86 list method,
// so it needs an end.
export const MIN_INVITE_CODE_LENGTH = 16;
export const MAX_INVITE_CODE_LENGTH = 128;

// How many invites may be outstanding -- unspent, unexpired, unrevoked --
// at one time.
//
// Not a defence against the owner, who is the only pubkey that can create
// one and whom this relay does not defend against (CLAUDE.md "Threat
// model"). It is a bound on the LIST: the NIP-86 listunusedinvites method
// returns every outstanding code in one response, and an admin who cannot
// read the list cannot use it to revoke anything. Sixty-four live invites
// is far past what a single-owner relay hands out and still a response a
// person can look at.
export const MAX_OUTSTANDING_INVITES = 64;

// Per-IP join request throttle, the same shape and the same reasoning as
// the gift wrap one above: kind-9021 is the second write path a stranger
// can reach without being authorized by anything this relay stored in
// advance, so it gets its own counter rather than sharing the general
// per-message limit, which is tuned for connection spam.
//
// This is the cap that actually bounds guessing. The general per-message
// throttle (relay.ts RATE_LIMIT_MAX_MESSAGES: 50 per 10s) would permit
// ~432,000 attempts a day from one address, which is a real threat to a
// weak code and no threat at all to a strong one. Five a minute is
// generous for a person following a link and turns even a deliberately
// short code into days of work per address.
//
// Counted in memory (relay.ts joinRateLimits), so it costs no rows and is
// lost on eviction -- the same honest caveat as every other throttle in
// this file. An attacker pacing themselves around hibernation gets fresh
// windows; what they do not get is a fast one.
export const JOIN_REQUEST_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW = 5;

// Per-PUBKEY write throttle. Per pubkey, not per IP, because the two
// existing throttles (RATE_LIMIT_MAX_MESSAGES in relay.ts, and the gift
// wrap one above) are both keyed by IP, and an author with several
// addresses -- a phone on cellular, a laptop on wifi, anything behind a
// VPN -- walks around an IP-keyed limit entirely. A follow's authority to
// write here comes from their pubkey, so that is what the limit should
// be attached to.
//
// Sized against rows-written, not intuition. At the measured 13 rows per
// stored event (CLAUDE.md "The budget", the corrected figure) and the free tier's
// 100,000 rows-written/day:
//
//   100,000 / 13 = 7,692 events to exhaust the daily write budget
//
// Against the per-IP limit as the only bound (50 messages / 10s = 300
// events/minute):
//
//   7,692 / 300 = 25.6 minutes
//
// At 20 events/minute per pubkey:
//
//   7,692 / (20 * 60) = 6.4 hours
//
// The goal is not to make abuse impossible -- a determined attacker with
// the owner's follow list can still spend the daily budget eventually. It
// is to make it slow enough that the owner notices and revokes (unfollow,
// or NIP-86 banpubkey) before the day is gone, while sitting far above
// any human posting rate: 20 notes a minute, sustained, is not a person.
//
// Counted in memory (relay.ts pubkeyRateLimits), like the two throttles
// above, so it costs no rows to enforce. Be honest about what that means:
// the counter is lost when the Durable Object is evicted, so an attacker
// who pauses long enough for hibernation gets a fresh window. It is not
// airtight and is not claimed to be. What it does cover is the case it
// exists for -- sustained traffic keeps the object awake, so the window
// that matters is exactly the one that survives.
// Ephemeral kinds (nostr.ts isEphemeralKind, 20000-29999) are exempt from
// this throttle -- see relay.ts acceptEvent. The arithmetic above prices
// what a stored event costs in rows written, and an ephemeral event costs
// zero: storage.ts storeEvent drops it before any row is touched. Counting
// it here bounds a quantity it never consumes, and at 20/minute it made
// WebRTC signalling (NIP-100-ish call setup, dozens of candidates in the
// first second) impossible on a non-owner pubkey. What an ephemeral event
// actually costs is a schnorr verify and a broadcast, and the existing
// per-IP message throttle (relay.ts RATE_LIMIT_MAX_MESSAGES: 50 per 10s)
// already shapes both -- so it is left to bound them alone. That throttle
// is per IP and covers every frame type on the connection, not ephemeral
// events alone, so a signalling burst has to fit inside 50 messages / 10s
// = 5 events/second/connection, shared with whatever else that connection
// sends in the same window.
export const PUBKEY_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_EVENTS_PER_PUBKEY_PER_WINDOW = 20;

export function maxEventsPerPubkeyPerWindow(env: Env): number | null {
  return resolveLimit(env.MAX_EVENTS_PER_PUBKEY_PER_MINUTE, MAX_EVENTS_PER_PUBKEY_PER_WINDOW);
}

// Ceiling on how many pubkeys the in-memory throttle map tracks at once.
// Unlike the per-IP maps, this one is keyed by something an attacker can
// mint for free: every NIP-59 gift wrap is signed by a fresh one-time key
// (nips/59.md), so a busy inbox would add an entry per message and never
// reuse one. Stale windows are dropped once the map reaches this size --
// see relay.ts prunePubkeyRateLimits. Sized so a real relay never reaches
// it (the owner plus their follows is hundreds of keys, not thousands)
// while keeping a DO's memory bounded regardless of traffic.
export const PUBKEY_RATE_LIMIT_MAX_TRACKED = 10_000;

// ---------------------------------------------------------------------
// The read-abuse guard, derived from the index set.
//
// The rule this replaces was `isUnconstrainedFilter`: reject a filter
// carrying none of `ids`, `authors`, `kinds` or a `#<letter>` tag. It was
// a list of permitted field combinations, and it was wrong in the way
// every list of permitted shapes eventually is -- it reasoned about
// whether a field was PRESENT and never about what the resulting query
// COST. `{"kinds":[1],"limit":20}` satisfied it and read the entire
// table; so did `{"authors":[owner],"limit":20}`, on a relay where every
// row carries the owner's pubkey. 125 such REQs a day cleared the whole
// 5,000,000 rows-read ceiling, and an ordinary client that re-subscribes
// on reconnect issues far more than 125 (CLAUDE.md "The budget" "Rows read, by
// path").
//
// What replaces it asks a different question: WHICH INDEX SERVES THIS
// FILTER, AND WHAT DOES ITS `limit` COST AGAINST THAT INDEX. The answer
// is computed from schema.ts INDEXES, so it is the real index set that
// decides -- add an index and the filters it makes affordable become
// legal, drop one and they stop being legal, with nothing here to edit
// either way. That is the property the old rule lacked: its verdict and
// the schema could drift apart silently, and they did, for two releases.
//
// The cost model, and why each term is what it is:
//
//   rows read  =  combinations x (2 x limit + 1)
//
// `combinations` is the number of queries filters.ts expandFilter will
// actually run -- the cross-product of the filter's `authors` and
// `kinds` values. One query per combination, each pinning its index key
// columns to a single value, each stopping at `limit`.
//
// The 2 is measured, not assumed: an ordered index scan reads the index
// entry and then the table row it points at, and a filter naming one
// author and one kind at limit 20 reads 41 rows (test/read-cost.test.ts).
// 2 x 20 + 1 = 41.
//
// An index qualifies only when EVERY key column ahead of its ordering
// column is pinned to one value. `since`/`until` do not pin anything --
// they bound a range, and a range ahead of the sort column still leaves
// SQLite a sort to do -- which is why a filter of nothing but
// since/until/limit remains rejected, exactly as before.
//
// A `#<letter>` condition adds a second term rather than choosing
// between paths, since it is a conjunct and is evaluated whatever else
// the filter names:
//
//   rows read  =  combinations x (2 x limit + 1)  +  values x 4 x TAG_SCAN_DEPTH x limit
//
// Both terms scale with `limit`, which is the property the whole guard
// rests on and the one the tag term did not have until v0.7.7 -- see
// filters.ts TAG_SCAN_DEPTH.
// ---------------------------------------------------------------------

// The second the current allowance window began: the most recent 00:00
// UTC. Cloudflare's free-tier allowances reset then
// (developers.cloudflare.com/durable-objects/platform/limits/, checked
// 2026-08-26), so this -- not "now minus 24 hours" -- is the cutoff that
// answers "how much of today's budget has been spent".
//
// The two are not interchangeable and the difference is worst exactly
// when it matters most. A rolling window carries yesterday's traffic
// across the reset: at 00:05 UTC the write-budget meter on the admin page
// could read 85% against a ceiling that had been empty for five minutes,
// and backfill.ts hasBackfillHeadroom would keep refusing to write for
// most of a day on the strength of rows the account had already been
// forgiven. The panel exists to be read during an outage, and a rolling
// window makes it wrong during the recovery from one.
export function utcDayStartSeconds(nowMs: number): number {
  const msPerDay = 86_400_000;
  return Math.floor((nowMs - (nowMs % msPerDay)) / 1000);
}

// The other end of the same window: how long until the allowances reset.
// Used for the Retry-After on the 503 an exhausted allowance produces
// (src/index.ts) -- a real retry time rather than a guess.
export function secondsUntilUtcMidnight(nowMs: number): number {
  const msPerDay = 86_400_000;
  return Math.ceil((msPerDay - (nowMs % msPerDay)) / 1000);
}

// Cloudflare Workers Free's daily rows-READ ceiling, the companion to
// DAILY_ROWS_WRITTEN_LIMIT below (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-26). Named here because it is the number the relay
// actually died on, and because the per-filter cap below is derived from
// it rather than picked.
export const DAILY_ROWS_READ_LIMIT = 5_000_000;

// The most one REQ may read. A five-hundredth of the daily ceiling: it
// takes 500 REQ frames at the cap to spend a day's budget, against the
// 125 it took before this guard existed.
//
// It says REQ and it now means REQ. For a long time it was enforced per
// FILTER while reading as though it were per message, and a REQ frame may
// carry any number of filters -- so one message could stack this cap as
// many times as fit in 1MiB while the per-IP throttle in relay.ts counted
// the message once. Measured before the fix: a REQ carrying 200 filters
// was answered with EOSE, having run all 200, and ~540 of them fit in the
// 16KiB the connection state can hold -- a single frame able to ask for
// the whole day's rows-read allowance.
//
// relay.ts handleReqInner divides this figure by the number of filters in
// the frame and passes each one a share (boundFilter's `budget`
// parameter), so the frame as a whole stays inside it. The common
// single-filter REQ gets the whole cap and is unaffected.
//
// Still not a ceiling on what a connection can spend over TIME. The
// per-IP message throttle (relay.ts RATE_LIMIT_MAX_MESSAGES: 50 per 10s)
// is the only thing bounding that, and 5 REQs/second at this cap is
// 50,000 rows/second -- the daily ceiling in 100 seconds from one
// address. Nothing here closes that; it would take a per-connection
// rows-read budget, which this relay does not have.
export const MAX_FILTER_ROWS_READ = DAILY_ROWS_READ_LIMIT / 500;

// Filters one REQ frame may carry.
//
// NIP-01 puts no bound on the count ("REQ messages may contain multiple
// filter objects", nips/01.md) and neither did this relay, so one
// message could carry as many filters as fit in a WebSocket frame --
// each independently admitted at up to MAX_FILTER_ROWS_READ, while the
// per-IP throttle in relay.ts counted the message as one. Measured
// before this cap: a single REQ carrying 200 filters was answered with
// EOSE.
//
// Ten rather than a derived number, because there is nothing to derive
// it from: no index cost or row count says how many filters a client
// ought to send. It matches MAX_SUBSCRIPTIONS_PER_CONNECTION for the
// reason those two numbers describe the same thing from either end --
// how much concurrent read work one connection may have outstanding --
// and it is comfortably above what real clients send (NIP-01 REQs in the
// wild carry one to five).
//
// It is not what bounds the rows a REQ may read -- MAX_FILTER_ROWS_READ
// above is, shared out across however many filters arrive. What this
// bounds is the share getting so thin that every filter in the frame is
// clamped to uselessness, and the statement count behind them.
export const MAX_FILTERS_PER_REQ = 10;

// Bytes of serialized connection state (relay.ts ConnState: every open
// subscription's filters, plus the ip/host/challenge/authedPubkey beside
// them) a connection may hold.
//
// Not a budget cap like the rest of this file -- a platform one.
// Subscriptions are persisted in the WebSocket attachment so they survive
// hibernation, and `serializeAttachment` THROWS above 16KiB
// (developers.cloudflare.com/durable-objects/api/websockets/, checked
// 2026-08-28). Nothing checked, so a REQ whose filters serialized past it
// -- an ordinary `{"authors":[<400 keys>],"kinds":[1]}` is ~26KB, and
// every cap in this file admitted it -- threw inside webSocketMessage
// after the query had run: no CLOSED, no NOTICE, an uncaught exception in
// the Durable Object and a client left waiting on a reply that was never
// coming.
//
// Set below the real ceiling, not at it. The check happens before the
// state is stored, and what is stored also carries the challenge, the
// host and the authenticated pubkey; leaving a margin means a REQ that
// passes cannot be defeated by a later AUTH pushing the same state over.
export const MAX_CONN_STATE_BYTES = 15 * 1024;

// Rows read per row returned by an ordered index scan: the index entry,
// then the table row it points at. Measured (test/read-cost.test.ts), not
// derived -- 41 rows for a limit of 20.
const ROWS_READ_PER_MATCH = 2;

// Rows read per tag row a `#<letter>` condition looks at. Twice the
// figure above, because a tag lookup pays the same two rows twice over:
// idx_event_tags_lookup is (tag_name, tag_value, created_at) and carries
// no `event_id`, so each match costs an index entry plus the
// `event_tags` row it points at to learn the id -- and then the outer
// `id IN (...)` costs the primary key entry plus the `events` row.
// Measured at 4 exactly for a single tag value (test/read-cost.test.ts:
// 400 rows for a scan of 100).
//
// It is charged per named value, which for more than one value is
// deliberately pessimistic: SQLite merges the ranges and stops at the
// subquery's LIMIT, so two values cost ~4.5 rows per scanned row rather
// than 8. The worst case that cannot be exceeded is each named value
// contributing a full scan's worth of index entries and table rows
// (2 x values) plus the outer key lookups (2), which is what this
// bounds.
export const TAG_ROWS_READ_PER_MATCH = 4;

// Queries one filter may be expanded into -- filters.ts expandFilter's
// `authors` x `kinds` cross-product, capped independently of what those
// queries are estimated to READ.
//
// Independently, because the two are not the same quantity and pricing
// alone cannot bound the second. filterReadCost below returns the
// CHEAPEST access path, and a filter naming ids has a cheap one: seeking
// n ids costs n rows however many statements it takes. Before this cap,
// `{"ids":[<one id>],"authors":[<5,000 keys>]}` priced at 1 row and read
// 5,000 across 5,000 statements in 71ms of Durable Object time, while
// the identical filter without the single id was refused as too broad at
// any limit. One 64-hex string turned a refused filter into a free one.
//
// Fixing the price (it is now combinations x ids.length) closes the
// mispricing but not the shape: statements cost CPU whether or not they
// read rows, and rows-read pricing cannot see that. So the query count
// gets its own ceiling.
//
// Derived rather than picked, and deliberately set to the bound the
// index path already implied: an index-served filter at a limit of 1
// costs combinations x (ROWS_READ_PER_MATCH + 1) rows, so anything above
// MAX_FILTER_ROWS_READ / 3 combinations was already refused at every
// limit. This changes nothing for filters an index serves -- it makes
// the same ceiling apply to the one access path that was escaping it.
export const MAX_FILTER_COMBINATIONS = Math.floor(MAX_FILTER_ROWS_READ / (ROWS_READ_PER_MATCH + 1));

// Cloudflare's SQLite-backed Durable Object storage bounds every SqlStorage
// query to at most 100 bound parameters
// (developers.cloudflare.com/durable-objects/platform/limits/, checked
// 2026-08-28), and nothing in this file priced that quantity -- a live
// deployment hit it: "too many SQL variables at offset 517: SQLITE_ERROR",
// uncaught, the same shape of bug MAX_CONN_STATE_BYTES exists to catch on
// the subscription-storage side rather than let a WebSocket throw mid-reply.
//
// filterReadCost prices `ids.length` and each `#<letter>` tag's value count
// by ROWS READ, and that is a different quantity from how many `?`
// placeholders buildFilterQuery binds into one exec() call. An `ids`
// filter with no `authors`/`kinds` prices at 1 row per id, so up to
// MAX_FILTER_ROWS_READ (10,000) ids passed the cost check -- two orders of
// magnitude past SQLite's own ceiling -- and neither of those array
// lengths shrinks when boundFilter halves `limit`, so this has to be
// checked once, structurally, the same way MAX_FILTER_COMBINATIONS is.
//
// Set below the real ceiling (100), not at it -- the same margin
// MAX_CONN_STATE_BYTES leaves below the WebSocket attachment's real 16KiB,
// and for the same reason: filterParamCount counts the query boundFilter
// can see, but the read gate's own exclusions each add a `kind != ?`
// parameter AFTER boundFilter has already admitted the filter, so a filter
// sized exactly to the real ceiling here could still be pushed over it by
// one of those later additions. There are two of them now -- excludeGiftWraps
// on an unauthenticated read and excludeInvites on a member's read -- and
// both apply at once on a member's kinds-less filter, which is the
// worst case at TWO parameters over what this counts. Ten is still four
// times that.
export const MAX_QUERY_BOUND_PARAMS = 90;

// Which filter field pins which indexed column to a value.
//
// `created_at` is deliberately absent. `since`/`until` constrain it to a
// range, and a range is not a pin: an index whose key columns are only
// range-constrained still hands SQLite rows out of sort order, so every
// match is read and sorted before LIMIT applies. Treating since/until as
// bounding is precisely the mistake that let `{"since":0}`-shaped
// reasoning feel safe.
const PINS: Record<string, (filter: Filter) => readonly unknown[] | undefined> = {
  pubkey: (filter) => filter.authors,
  kind: (filter) => filter.kinds,
};

export interface FilterReadCost {
  // Estimated rows read to answer this filter.
  rowsRead: number;
  // Which access path produces that estimate -- an index name, or the
  // primary key, or a driver and a tag conjunct joined by `+` when the
  // filter pays for both. Carried so the test harness and any future
  // diagnostic can say WHY a filter is cheap, not just that it is.
  via: string;
}

// The cheapest bounded way to answer this filter, or null when nothing
// bounds it below the size of the table.
//
// Two parts, and they compose differently. The access paths (primary key
// and the ordered indexes on `events`) are ALTERNATIVES -- SQLite picks
// one, so the cheapest is the estimate. A `#<letter>` condition is not
// an alternative but an addition: it is a conjunct, its subquery runs
// whatever else the filter names, and its cost is added to whichever
// path drives.
//
// `limit` is taken as given: callers pass an already-clamped filter, and
// boundFilter below is what does the clamping.
// `scopes` is how many partitions of `events` the reader is entitled to
// (src/groups.ts): 1 for every unauthenticated client, 2 for an authorised
// one. It multiplies the query count for the same reason `combinations`
// does -- storage.ts queryFilter runs the filter once per partition,
// because a partial index pair can only serve a query that pins one --
// and it is a separate argument rather than something read off the filter
// because it is a property of the READER, not of what was asked for.
//
// The tag term below is NOT multiplied: filters.ts splits the tag scan
// budget across the partitions instead, so a two-partition read looks at
// the same number of tag rows in total as a one-partition read.
export function filterReadCost(filter: Filter, scopes = 1): FilterReadCost | null {
  const limit = filter.limit ?? MAX_FILTER_LIMIT;
  const candidates: FilterReadCost[] = [];

  // How many queries filters.ts expandFilter will run for this filter.
  // Hoisted above every access path below because EVERY path pays it:
  // the expansion happens before storage sees the filter at all, so each
  // sub-filter carries the whole of the rest of the filter with it.
  //
  // It used to be computed further down, where only the index paths
  // could see it, and the `ids` path below was priced as though the
  // filter were run once. It is not run once. `{"ids":[<one id>],
  // "authors":[<5,000 keys>]}` was priced at 1 row and read 5,000, one
  // per statement -- while dropping the single id from that same filter
  // made it 5,005,000 and refused it. Whichever path prices cheapest,
  // the query count is the same, so it belongs to all of them.
  //
  // Counted arithmetically rather than as `expandFilter(filter).length`.
  // Same number -- expandFilterCount and expandFilter are asserted equal
  // in test/read-cost.test.ts -- but this function runs on every REQ
  // filter from every client, before anything has decided the filter is
  // affordable, and `authors` is an unbounded array off the wire
  // (filters.ts parseFilter does not cap it). Materialising the
  // cross-product to measure it would mean allocating ten thousand filter
  // objects to discover that a filter is too expensive to run, which is a
  // cheap denial of service against the guard that exists to prevent one.
  const combinations = expandFilterCount(filter) * scopes;

  // The primary key. `id TEXT PRIMARY KEY` is a unique index, so an
  // `ids` filter is one seek per id and needs no ordering at all -- the
  // rows it can return are already bounded by how many ids were named.
  // Times `combinations`, because each of the expanded queries carries
  // the same `id IN (...)` list and seeks every one of them again.
  if (filter.ids !== undefined && filter.ids.length > 0) {
    candidates.push({ rowsRead: combinations * filter.ids.length, via: "events primary key" });
  }

  // Tag conditions are handled after the access paths below, because
  // they are not an access path. See the block above `return` at the
  // bottom of this function.

  // The ordered indexes on `events`. An index qualifies when every one
  // of its key columns is pinned by the filter at all -- once
  // filters.ts expandFilter has split the filter, each of those columns
  // holds exactly one value in every query that actually runs.
  //
  // `combinations` (hoisted above) is the number of queries filters.ts
  // expandFilter will run, NOT the product of the chosen index's own key
  // columns, and that distinction is a correctness condition rather than
  // a nicety. A filter naming one author and two kinds runs TWO queries
  // whichever index serves them; pricing it from
  // idx_events_pubkey_created's single key column called it one query and
  // understated the cost by half, which a test caught and reading did not.
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

  // SQLite picks one access path; the cheapest available is the honest
  // estimate of what it will pick, and the pessimistic direction is
  // already covered by rejecting anything above MAX_FILTER_ROWS_READ.
  const driver =
    candidates.length === 0
      ? null
      : candidates.reduce((best, c) => (c.rowsRead < best.rowsRead ? c : best));

  // Tag conditions, through idx_event_tags_lookup. These are priced
  // ADDED to whatever drives the query rather than offered as an
  // alternative to it, which is the correction v0.7.7 made: a
  // `#<letter>` condition is a conjunct, so its subquery is evaluated
  // whatever else the filter names, and taking the cheaper of the two
  // priced a query that runs both as though it ran one. Measured, at
  // E=1,000 with every event p-tagging the owner:
  // `{"#p":[owner],"kinds":[1059],"limit":20}` reads 127 rows, against
  // the 41 the `kinds` index alone was charged for.
  //
  // The estimate is now bounded rather than hopeful, because the query
  // is: filters.ts tagScanLimit caps how far into the tag index the
  // subquery may read, so this scales with the filter's `limit` instead
  // of with the number of rows in the table that happen to carry the
  // named value. That is what lets boundFilter below do anything at all
  // with the shape -- see the comment on TAG_SCAN_DEPTH for the
  // measurement that forced the change, and for what a bounded scan
  // gives up in exchange.
  //
  // The bound only exists when the filter carries a `limit`, so neither
  // does the estimate: a limitless tag filter is priced as unbounded and
  // refused unless something else in the filter can carry it. Nothing
  // reaches storage that way in practice -- boundFilter always supplies
  // one -- but the two must agree on when the subquery is capped, or
  // this function is describing a query the relay does not run.
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

// Clamps a filter's `limit` until the query it produces is affordable,
// and refuses it if no limit is small enough.
//
// Replaces the old clampFilterLimit + isUnconstrainedFilter pair, which
// ran in that order and could not see each other: the clamp bounded how
// many rows came BACK, and the guard bounded nothing at all about how
// many were READ to produce them. On the shapes that broke this relay
// those two numbers differed by three orders of magnitude.
//
// Clamping before refusing, deliberately. A client asking for 20 events
// each from 400 follows is not abusive, it is a client with 400 follows;
// reducing what it may ask for per author is a better answer than
// refusing it. Refusal is reserved for the two cases no limit can fix:
// a filter no index can serve at all, and one whose combination count
// alone puts it over the cap at a limit of 1.
//
// `budget` defaults to MAX_FILTER_ROWS_READ -- one filter alone gets the
// whole of it -- and relay.ts handleReqInner passes a SHARE of it when a
// REQ carries several, so the frame as a whole stays inside the number
// this file has always claimed for it. Divided equally rather than spent
// first-come, so the answer does not depend on the order the client
// happened to write its filters in.
export function boundFilter(
  filter: Filter,
  budget: number = MAX_FILTER_ROWS_READ,
  scopes = 1,
): FilterBound {
  // The query count, refused ahead of the cost model rather than through
  // it. filterReadCost prices the cheapest access path, and the cheapest
  // path can be cheap in rows while still being thousands of statements
  // -- see MAX_FILTER_COMBINATIONS. Statements cost Durable Object CPU
  // whether or not they read anything, and a lowered `limit` does not
  // remove one of them, so this belongs before the halving loop rather
  // than inside it.
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

  // Bound-parameter count, refused ahead of the cost model like
  // `combinations` above and for the same reason: neither `ids.length` nor
  // a tag's value count falls when `limit` is halved below, so a filter
  // that binds too many parameters at the requested limit binds exactly as
  // many at limit 1. Computed against `requested` rather than the smaller
  // limit the halving loop might land on, since it is invariant to which
  // one runs -- see filterParamCount.
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

  // Halving rather than solving for the largest affordable limit
  // directly: the search does not need to know the shape of the cost
  // function, so a change to that function cannot leave a stale inverse
  // behind it. It terminates in at most nine steps from
  // MAX_FILTER_LIMIT, and the cost of the coarseness is that a client
  // occasionally gets 62 events where 100 would also have fit.
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

  // Reached only when the cost does not fall with the limit. Two shapes
  // do that: a cross-product of `authors` x `kinds` large enough that
  // even one row each is too many, and an `ids` list long enough that
  // seeking every id exceeds the cap on its own (an `ids` seek costs one
  // row per id, times the combination count, no matter how few of them
  // the client says it wants back).
  // The message names both rather than guessing which one applies, since
  // guessing wrong sends the client to fix the field that was fine.
  return {
    ok: false,
    reason:
      `invalid: filter is too broad to answer within ${budget} rows read ` +
      `at any limit; name fewer ids, or fewer authors x kinds combinations, ` +
      `and split it across several REQs`,
  };
}

// Live feed caps -- unlike the nostr protocol path
// above, /live has no filters, no auth, and no per-message rate limit to
// bound it with, so it gets its own two caps in relay.ts: a ceiling on
// how many can be open at once (rejected at the WebSocket upgrade, before
// ctx.acceptWebSocket), and a max lifetime per connection enforced by a
// DO alarm regardless of client behavior -- the admin page's own
// tab-hidden idle timeout (public/index.html) is cooperative, not
// authoritative, since nothing stops a client from staying visible
// forever or speaking the /live protocol directly without ever closing.
export const MAX_LIVE_FEED_CONNECTIONS = 5;
export const LIVE_FEED_MAX_LIFETIME_MS = 10 * 60 * 1000;


// ---------------------------------------------------------------------
// HTTP rate limiting.
//
// The per-IP throttle in relay.ts covers WebSocket *messages* only.
// Nothing bounded the HTTP side at all, so every HTTP path that reaches
// the Durable Object -- /api/stats, /api/claim, the NIP-11 document, the
// NIP-86 management POST, and the WebSocket upgrade itself -- was
// defended by its per-request cost alone, against a caller who pays
// nothing per request.
//
// The cap itself is NOT declared here, and that is the one exception to
// this file being where every numeric cap lives. It is enforced by
// Cloudflare's Rate Limiting binding, which reads its limit and period
// from wrangler.jsonc's `ratelimits` block and applies them in the
// runtime *before* the Worker's own code runs -- so a number here would
// be decorative, and worse, could silently disagree with the number
// actually in force. wrangler.jsonc is the source of truth; the reasoning
// for the values chosen is in the comment there.
//
// Chosen over a hand-rolled limiter for the reason that shapes every
// other decision in this project: a counter of our own would have to live
// somewhere, and the only two places available are the Durable Object
// (a row write per request, to measure a request -- the mistake CLAUDE.md
// "The budget" already rejected once for read-metrics.ts) or isolate
// memory (which the flood evicts). The binding runs outside the thing it
// protects and costs neither.
// ---------------------------------------------------------------------

// The Retry-After the 429 carries, in seconds. Must match `period` in
// wrangler.jsonc's ratelimits block -- a caller told to come back sooner
// than the window resets just spends another rejected request.
export const HTTP_RATE_LIMIT_PERIOD_SECONDS = 60;

// ---------------------------------------------------------------------
// /api/profile's kind-0 cache (profile-lookup.ts lookupProfileCached).
//
// The TTL is set by how often the answer changes, not by how often it is
// asked for: a kind-0 is a profile, edited a handful of times a year. Five
// minutes is far shorter than that and still collapses every realistic
// burst -- the endpoint's whole traffic pattern is one person typing a
// pubkey into a form once, so a stale entry costs nothing and a fresh
// fetch buys nothing.
export const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;

// Entries held before the oldest is evicted. Sized for the shape the
// endpoint actually has -- a single relay's single claim -- with enough
// headroom that ordinary use never evicts; the number exists to bound
// isolate memory under a flood of distinct pubkeys, not to serve one.
export const PROFILE_CACHE_MAX_ENTRIES = 256;

// ---------------------------------------------------------------------
// The upstream version check (upstream-version.ts), which /api/stats
// answers with so the admin page can say a newer release exists.
//
// Same cache shape and the same reasoning as the block above: isolate-
// local, because caches.default needs a custom domain and bothy deploys
// to workers.dev. What differs is the traffic it absorbs. /api/stats is
// unauthenticated and is loaded on every visit to a public page, and the
// answer is a version string that changes a few times a month, so an
// uncached check would point this deployment's IP at githubusercontent
// once per page view to learn something that was already true an hour
// ago. Six hours is well under "a release you have not noticed yet" and
// well over any burst.
export const UPSTREAM_VERSION_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// The failure this one bounds is different, so it is cached for minutes
// rather than hours: a check that failed says nothing about upstream, and
// retrying an unreachable host every six hours would leave a relay
// wrongly quiet about an update for a quarter of a day after one blip.
// Long enough that a githubusercontent outage cannot turn each page view
// into another outbound attempt, short enough to recover on its own.
export const UPSTREAM_VERSION_ERROR_CACHE_TTL_MS = 10 * 60 * 1000;

// How long the check waits before giving up, matching profile-lookup.ts's
// LOOKUP_TIMEOUT_MS shape. It runs concurrently with the getStats round
// trip (index.ts handleStats), so this is the ceiling on how much a slow
// GitHub can add to a page load -- and it is a courtesy notice, so the
// right behaviour when it is slow is to answer without it.
export const UPSTREAM_VERSION_TIMEOUT_MS = 2500;

// A ceiling on what the check will read before deciding upstream is not
// serving a package.json. The real file is around 800 bytes; this is
// generous room above that and still refuses to pull an unbounded body
// into a Worker's memory because a URL that used to be a small JSON file
// stopped being one.
export const UPSTREAM_VERSION_MAX_BYTES = 16 * 1024;



// How long the Worker's cron tick keeps one outbound backfill socket open
// waiting for EOSE before giving up for this tick -- mirrors
// profile-lookup.ts's LOOKUP_TIMEOUT_MS shape, scoped to backfill so a
// slow/unreachable relay can't stall the whole cron invocation.
export const BACKFILL_FETCH_TIMEOUT_MS = 8000;

// Cloudflare Workers Free's SQLite storage ceiling per Durable Object
// (5GB -- developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-25; the same number public/index.html draws its storage
// bar against). Named here because the reserved share below needs the
// actual figure to reason about.
export const STORAGE_BYTES_LIMIT = 5 * 1024 * 1024 * 1024;

// Non-owner writes stop once the database passes this size, reserving
// what's left for the owner. Same shape and same reasoning as
// hasBackfillHeadroom (backfill.ts), which already reserves half the
// daily write budget on exactly this argument: the relay exists to hold
// the owner's own archive, so nothing else may consume the last of a
// ceiling the owner still needs.
//
// Half, mirroring BACKFILL_ROWS_SHARE_LIMIT below -- simple to reason
// about, and the guarantee it buys is stated exactly: at the moment
// non-owner writes start being refused, at least 2.5GB of the ceiling is
// still free for the owner.
//
// Note what this measures -- total database size, not the non-owner share
// of it. Attributing stored bytes per author would mean either a running
// per-pubkey total (a row write per event, the cost schema.ts's
// `ingested_at` column exists to avoid) or a scan; `sql.databaseSize` is
// a property read that getStats already makes, so this check costs no new
// query type at all. The tradeoff is that the owner's own data counts
// toward the threshold that cuts off everyone else, which is the correct
// direction: it is the owner's remaining headroom being protected, and
// it should shrink as they use it.
//
// This is the cap that actually stops permanent exhaustion. MAX_EVENT_BYTES
// bounds what one event costs and the per-pubkey throttle bounds the rate;
// only this one bounds the total.
export const NON_OWNER_STORAGE_SHARE_LIMIT = STORAGE_BYTES_LIMIT / 2;

export function nonOwnerStorageLimit(env: Env): number | null {
  return resolveLimit(env.NON_OWNER_STORAGE_BYTES, NON_OWNER_STORAGE_SHARE_LIMIT);
}

// Share of total storage the gift wrap inbox may occupy: 1/40 of the 5GB
// ceiling, ~128MB, well under it even alongside the owner's own data.
// Generous for a real personal inbox, bounded against storage exhaustion
// from an anonymous write path -- kind-1059 is the one write path with no
// ownership check at all (CLAUDE.md "Threat model"), so this cap doesn't
// get to trust the size of anything it admits the way NON_OWNER_STORAGE_-
// SHARE_LIMIT above already bounds non-owner writers generally.
const GIFT_WRAP_STORAGE_SHARE = STORAGE_BYTES_LIMIT / 40;

// Total gift wraps this relay will hold at once, DERIVED from the share
// above and the ACTUAL per-event byte cap in effect (maxEventBytes(env)),
// not the compile-time MAX_EVENT_BYTES default this used to multiply
// while ignoring env entirely. That was wrong in both directions: an
// operator who raised MAX_EVENT_BYTES to, say, 1MB was still billed
// against the 64KB default, so the documented ~128MB worst case was
// actually 2000 * 1MB = ~2GB; an operator who disabled it (`"off"`) got
// no derived bound at all, since there is no per-event size to multiply a
// fixed count by.
//
// A disabled byte cap is priced against the compile-time default here
// instead of making this count unbounded -- there is no real per-event
// ceiling to derive a count from in that state, and pricing it at the
// default keeps this cap meaningful rather than silently no-op. The
// actual backstop when the byte cap is off is nonOwnerStorageLimit /
// NON_OWNER_STORAGE_SHARE_LIMIT above, which bounds total bytes
// regardless of event size or count.
//
// New gift wraps are refused once reached; the owner deleting old ones
// (or vanishing them) frees room -- and so does the expiry sweep below,
// which is what keeps this a count of mail rather than a count of rows.
//
// Bounded by MAX_FILTER_ROWS_READ as well as by the storage share, and
// the second bound is a READ cost sitting on a write-path cap, which
// needs saying. Gift wraps are omitted from an unauthenticated read
// rather than refused (filters.ts excludeGiftWraps), and omitting a row
// still costs reading it: an `authors`-pinned filter naming a pubkey
// that authored nothing but gift wraps reads past every one of them to
// reach the first event it may return. Measured at a 2,000-wrap inbox:
// 41 rows without the exclusion, 2,002 with it. So the inbox count is
// the ceiling on that skip, which makes it a per-filter read cost, which
// makes MAX_FILTER_ROWS_READ the number it has to fit inside -- or the
// read guard would be stating a bound the storage cap could lift it past.
//
// It binds only where an operator has lowered MAX_EVENT_BYTES below
// ~26KB; at the default the storage share already yields 2,048, well
// under this. Divided by ROWS_READ_PER_MATCH because each skipped wrap
// costs the index entry and the table row behind it.
export function maxGiftWraps(env: Env): number {
  const perEventBytes = maxEventBytes(env) ?? MAX_EVENT_BYTES;
  return Math.max(
    1,
    Math.min(
      Math.floor(MAX_FILTER_ROWS_READ / ROWS_READ_PER_MATCH),
      Math.floor(GIFT_WRAP_STORAGE_SHARE / perEventBytes),
    ),
  );
}

// Cloudflare Workers Free's daily rows-written ceiling (CLAUDE.md "The
// budget"). Named here, not just left as the bare `100000` already
// hardcoded in public/index.html's admin-page display, because
// backfill's headroom check below needs the actual number to reason
// about, not just a copy used for a progress bar.
export const DAILY_ROWS_WRITTEN_LIMIT = 100_000;

// Single-letter tags on a gift wrap: the one `p` tag naming its
// recipient. NIP-59 puts nothing else there -- the sender is a random
// one-time key and the contents are sealed -- so unlike
// TAGS_PER_CHAT_MESSAGE above this is the shape of the kind rather than
// an estimate that had to err high.
const TAGS_PER_GIFT_WRAP = 1;

// What one cron tick may spend removing expired gift wraps.
//
// Bounded TWICE, and the second bound is what makes this one cheap
// insurance rather than the thing doing the work. maxGiftWraps above is
// a ceiling on how many gift wraps exist at all, so the largest backlog
// this sweep can ever face is that ceiling -- 2,048 at the defaults,
// which at the charged cost of a one-tag event is ~32,000 rows written,
// inside a single day and very nearly inside a single tick. A per-tick
// share is still declared, for the reason CHAT_SWEEP_BATCH_SIZE declares
// one: a backlog that arrives all at once -- every wrap of a 30-day TTL
// expiring in the same hour -- should drain across ticks rather than be
// attempted in one, and the remainder costs nothing to carry because the
// next tick finds it exactly where it left it.
//
// Five percent of the day, matching the chat sweep, which at a one-tag
// event is ~312 wraps a tick and ~7,500 a day: more than the inbox can
// hold, so the cap is reached in hours and never binds twice.
//
// NO DAILY SHARE, for the reason the chat sweep gives and one more. Every
// wrap this removes was written by this relay first, and writing one cost
// more than removing it does, so a day's sweeping cannot exceed a day's
// gift wrap ingest. And that ingest is itself bounded by
// MAX_GIFT_WRAPS_PER_IP_PER_WINDOW and by maxGiftWraps, which is more
// than the chat sweep can say about its own input.
const GIFT_WRAP_SWEEP_TICK_SHARE = DAILY_ROWS_WRITTEN_LIMIT / 20;
export const GIFT_WRAP_SWEEP_BATCH_SIZE = Math.max(
  1,
  Math.floor(GIFT_WRAP_SWEEP_TICK_SHARE / eventRowCost(TAGS_PER_GIFT_WRAP)),
);

// ---------------------------------------------------------------------
// Call presence (src/push.ts CALL_PRESENCE_KIND, reference/push.md).
//
// hearth heartbeats every five seconds while somebody is in a call, and
// treats a pubkey as gone thirteen seconds after its last beat. The relay
// has to keep the same picture for one reason only: a notification is
// owed on the transition from absent to present, and on nothing else. A
// relay that pushed on the event rather than on the transition would send
// twelve notifications a minute per person in the call.
//
// The naive way to know the transition is to store the last beat, and
// that costs a row write every five seconds per participant -- ten people
// for an evening is tens of thousands of writes against a ceiling of
// 100,000 a day, on a relay that has already been taken offline by
// resource exhaustion once. So the watermark is written COARSELY and read
// at the coarseness it was written: a beat that finds the stored value
// younger than the interval below writes nothing at all.
//
// Two tiers, and the second one is what makes the first affordable:
//
//   memory   relay.ts presenceWrites, keyed by pubkey. A beat whose
//            pubkey was written within the interval costs no read and no
//            write -- the ordinary case for every beat but one in eight.
//            Lost on eviction, like every other in-memory throttle in
//            this file, which is exactly what the stored tier is for.
//   storage  `presence.last_seen`, one row per pubkey, refreshed at most
//            once per interval. This is what an evicted object reads to
//            tell an ongoing call from a new arrival.
// ---------------------------------------------------------------------

// hearth's own two numbers, from reference/push.md and its app.js
// (HEARTBEAT_MS, PRESENCE_TIMEOUT_MS). Named here rather than inlined
// because everything below is derived from them, and because a client
// that changes its beat rate changes what this relay has to tolerate.
export const PRESENCE_HEARTBEAT_SECONDS = 5;
export const PRESENCE_TIMEOUT_SECONDS = 13;

// What one hour of a ten-person call may spend, and the reference call it
// is measured against. One percent of the day's rows-written ceiling per
// hour of call is the budget: an evening of four hours is then 4% of the
// day, which leaves the owner's own traffic, backfill's reserved half and
// the vanish drain's reserved quarter untouched by a room being used for
// what it is for.
const PRESENCE_HOURLY_ROWS_SHARE = DAILY_ROWS_WRITTEN_LIMIT / 100;
const PRESENCE_REFERENCE_CALL_SIZE = 10;

// The interval falls straight out of those two, rounded UP to a whole
// heartbeat -- a write that would land between beats is a write that does
// not happen until the next one, so expressing the interval in anything
// finer than a beat is expressing a precision the beat rate cannot
// deliver.
//
//   1,000 rows/hour / 10 people        = 100 writes per person per hour
//   3,600s / 100                       = one write per 36 seconds
//   rounded up to a whole heartbeat    = 8 beats, 40 seconds
//
// Measured against the ceiling that produced it: ten people in a call for
// an hour is 10 x 90 = 900 rows written, 0.9% of the day. The same ten
// people at a per-beat write would have cost 72,000.
export const PRESENCE_WRITE_INTERVAL_SECONDS =
  PRESENCE_HEARTBEAT_SECONDS *
  Math.ceil(
    3600 / (PRESENCE_HOURLY_ROWS_SHARE / PRESENCE_REFERENCE_CALL_SIZE) / PRESENCE_HEARTBEAT_SECONDS,
  );

// How stale a STORED watermark may be and still mean "in the call".
//
// Derived, not chosen, and it is the whole correctness argument for
// writing coarsely. Somebody who is beating refreshes their row on the
// first beat at or after PRESENCE_WRITE_INTERVAL_SECONDS, so a live row
// is never older than that interval plus one beat. Anything older cannot
// belong to somebody who has been beating continuously, and is therefore
// an arrival.
//
// The cost of the coarseness, stated plainly: the stored tier resolves
// presence at 45 seconds rather than hearth's 13, so somebody whose
// connection drops and comes back inside 45 seconds of an eviction is
// treated as having been there all along and is not announced a second
// time. That is the right direction to be wrong in -- a reconnect is not
// an arrival, and announcing one would be the same twelve-a-minute noise
// this section exists to avoid, just rarer.
export const PRESENCE_STALE_SECONDS =
  PRESENCE_WRITE_INTERVAL_SECONDS + PRESENCE_HEARTBEAT_SECONDS;

// Ceiling on the in-memory presence map, the same guard and the same
// reason as PUBKEY_RATE_LIMIT_MAX_TRACKED above: the map is keyed by
// pubkey, and although only a member of the group can beat at all, the
// membership list is not bounded by anything in this file. Stale entries
// are dropped once the map reaches this size (relay.ts prunePresence).
export const PRESENCE_MAX_TRACKED = 1_000;

// ---------------------------------------------------------------------
// Push fan-out (src/push.ts, relay.ts drainPushOutbox).
//
// THE BOUND THAT MATTERS IS SUBREQUESTS, NOT ROWS. Every push is an
// outbound HTTPS request, and Workers Free allows fifty subrequests per
// invocation (developers.cloudflare.com/workers/platform/limits/, checked
// 2026-08-30). Twenty members with a phone, a laptop and a home-screen
// install each is sixty endpoints -- so a fan-out written inline inside
// the request that stored the message starts failing at exactly the group
// size this is being built for, and fails at the fifty-first request
// rather than at the first, which makes it a partial delivery nobody
// notices rather than an error.
//
// So the fan-out is queued and drained by the Durable Object's alarm, one
// batch per invocation, with a fresh subrequest allowance each time.
// ---------------------------------------------------------------------

// Cloudflare Workers Free, per invocation. Named rather than inlined
// because the two constants below are derived from it and a change to the
// plan changes both.
export const WORKER_SUBREQUEST_LIMIT = 50;

// Left unspent, so the batch is never the thing that reaches the ceiling.
// The alarm makes no other outbound request today; the reserve is for the
// one that gets added later, which would otherwise turn a working fan-out
// into a fan-out that silently loses its last endpoint.
const PUSH_SUBREQUEST_RESERVE = 10;

// Endpoints pushed in one alarm invocation.
export const MAX_PUSHES_PER_TICK = WORKER_SUBREQUEST_LIMIT - PUSH_SUBREQUEST_RESERVE;

// How many alarm invocations one notification may span before the rest of
// its endpoints are dropped.
//
// A notification is news, and news goes stale: a queue that retried
// forever would eventually wake somebody's phone about a message from
// half an hour ago, which is worse than not waking it. Four ticks is the
// bound, and the alarm reschedules itself immediately, so it is four
// consecutive wakes rather than four of anything slower.
const PUSH_MAX_TICKS = 4;

// The real ceiling on one notification's fan-out, and what it means in
// people: 160 endpoints is 40 members at the four-device cap below. A
// group larger than that has its tail DROPPED, and dropped loudly --
// relay.ts names the count in a console.warn rather than letting the
// queue quietly stop. Raising it means raising PUSH_MAX_TICKS and
// accepting the extra staleness, which is a decision with a cost rather
// than a number to nudge.
export const MAX_PUSH_ENDPOINTS_PER_NOTIFICATION = MAX_PUSHES_PER_TICK * PUSH_MAX_TICKS;

// Endpoints one pubkey may register. reference/push.md names the shape:
// "a phone, a laptop, a home screen install and a browser tab are four
// different endpoints". Four is that list, and it is a bound on the
// fan-out as much as on the table -- every device a member adds is a
// subrequest every message spends.
//
// The oldest is evicted rather than the new one refused: a browser that
// rotates its endpoint (which they do, on their own schedule) would
// otherwise fill the allowance with dead rows and lock the member out of
// their own notifications.
export const MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY = 4;

// How long a push service may hold an undeliverable notification (RFC
// 8030's TTL header). Two answers, because the two notifications go stale
// at completely different rates: it stays true that somebody said
// something in the room, so a message is worth delivering to a phone that
// comes back online within the hour; it stops being true that somebody is
// at the fire the moment they leave, so a voice notification held past
// five minutes is a phone buzzing about an empty room.
export const PUSH_TTL_SECONDS = { message: 3600, voice: 300 } as const;

// RFC 8188's record size, written into the body header. One record, and
// the payload is a room name and one word, so this is chosen to sit well
// clear of the 4096-byte body every push service accepts rather than to
// be tight.
export const PUSH_RECORD_SIZE = 4096;

// The most plaintext one record can carry: the record, less RFC 8188's
// one-byte padding delimiter and AES-GCM's sixteen-byte tag. Derived so
// that changing the record size above cannot leave this behind.
export const PUSH_PAYLOAD_MAX_BYTES = PUSH_RECORD_SIZE - 1 - 16;

// How stale `push_subscriptions.last_ok_at` may get before a successful
// send refreshes it.
//
// Coarsened for exactly the reason presence is, and it is the same
// mistake avoided twice: writing it on every successful push would be one
// row per device per notification -- sixty devices and a busy day is
// thousands of rows to maintain a column whose only conceivable reader is
// a sweep of endpoints that have been dead for a long time. A day is far
// finer than that reader would need. The disposal that actually matters
// does not wait for it at all: a 404 or 410 deletes the row on the spot.
export const PUSH_LAST_OK_INTERVAL_SECONDS = 24 * 60 * 60;

// How long the alarm waits before draining the outbox, and how long it
// waits between the batches of one fan-out.
//
// Two seconds, doing two jobs. Going out: it is the coalescing window --
// a handful of messages typed in the same breath queue one notification
// and one fan-out rather than one each, which is what hearth's service
// worker would collapse them into anyway (`tag: "hearth:message"`).
// Coming back: it is the gap between one batch of MAX_PUSHES_PER_TICK and
// the next, and it is short because the only reason there is a next one
// is a subrequest ceiling, not anything worth waiting for.
export const PUSH_ALARM_DELAY_MS = 2000;

// How long a VAPID JWT stays valid (RFC 8292 "the `exp` claim... MUST NOT
// be more than 24 hours from the time of the request"). Twelve hours is
// comfortably inside that and comfortably outside any clock skew; the
// token is minted per fan-out and never stored, so nothing is gained by
// making it longer.
export const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

// Maximum seconds an event's created_at may lead wall-clock now. Every
// kind sorts by created_at descending, and a replaceable kind (kind-0,
// kind-3, ...) keeps whichever stored version has the higher created_at
// -- so a kind-0 or kind-3 dated years ahead can never be superseded: it
// permanently freezes the owner's profile or follow list, and since the
// follow list gates writes (ownership.ts), freezing it also freezes who
// may publish here. That's reachable by accident (a wrong client clock),
// and the author gate doesn't help since the person doing it is the
// owner -- this is self-inflicted-damage prevention, not abuse
// prevention. An hour absorbs genuine client clock skew while admitting
// nothing intentional. Deliberately no lower bound -- see validate.ts
// isCreatedAtTooFarInFuture and CLAUDE.md: backfill imports history
// going back years, and republishing old work with its real date is a
// first-class use of a personal archive.
//
// Unrelated to AUTH_MAX_DRIFT_SECONDS in relay.ts, which is NIP-42's own
// two-sided window for auth events only.
export const MAX_CREATED_AT_FUTURE_SECONDS = 3600;

// This file used to declare a second stats cap here,
// STATS_SNAPSHOT_MAX_AGE_MS, bounding how stale /api/stats' expensive
// counts could get. It is gone, and the reason it is gone belongs in the
// file that priced it.
//
// It guarded ~3E rows read per refresh: a COUNT over `events`, a scan by
// `created_at`, and a GROUP BY over every author. Six hours was the
// arithmetic that made four refreshes a day (12E) fit under the ceiling.
// But rationing the RATE of an expensive read is the second-best answer;
// the best is for the read not to be expensive, and every one of those
// three fields could be. `totalEvents` and `events24h` became maintained
// counters (schema.ts `maintained_counts`/`event_hour_counts`),
// `largestNonOwnerAuthor` was deleted as a scan answering a question
// nothing asked, and `followCount` followed the same route -- maintained
// by ownership.ts refreshFollows, the only function that writes the table
// it counts, at one row per contact-list change. `followsListAt` needed
// no counter at all: every row in `follows` carries the same value, so
// `LIMIT 1` is the column rather than a sample of it.
//
// With nothing left that walked a table, `stats_snapshot`, this constant,
// relay.ts refreshStatsSnapshot and its cron call were a mechanism
// rationing a cost that no longer existed, and were removed together.
//
// The general lesson, since this file is where costs get priced: a TTL
// over an expensive read is a bound on how often you pay it, not on what
// it costs, and it survives only as long as nobody can make the read
// cheap. Reach for the counter first and the clock second.

// A second stats cap lived here after that one, LIVE_STATS_MAX_AGE_MS,
// bounding how stale the other half of /api/stats could get:
// `ingested24h` and `rowsWrittenToday`, the two windowed scans left when
// the counts that walked a table became counters. It is gone too, and it
// went the same way, one release later.
//
// It guarded ~1,200 rows per refresh -- both figures seek
// idx_events_ingested, so neither scaled with E, but both scaled with the
// ingest WINDOW, and GET /api/stats is unauthenticated with nothing in
// front of it. ~4,100 requests took the whole 5,000,000 rows-read/day
// allowance, from anywhere, at no cost to the caller. Five minutes was
// the arithmetic that bounded the recompute rate at 288/day however many
// requests arrived, chosen against
//
//   flood floor = (86,400 / T) x 1.5D   (D = events ingested per day)
//
// which at T = 60s admits only D <= 2,315 events/day and at T = 300s
// admits D <= 11,574 -- above anything the 100,000 rows-written ceiling
// lets this relay ingest.
//
// Both figures are hourly bucket counters now (schema.ts
// `ingest_hour_counts`), keyed by ingest time and read as at most 25 rows
// in one statement. That was named in this file as THE NEXT STEP if the
// TTL stopped being enough, with the caveat that these two were harder
// than `events24h`: `ingested24h` would want its own bucket table, and
// `rowsWrittenToday` is a sum over a window that empties at 00:00 UTC,
// which no per-event increment expresses. Both objections dissolved in
// the same table: one bucket row per ingest hour carries both figures, so
// the "third row written per event" is the same row as the second, and a
// UTC day boundary falls on a whole hour, so the reset is a range start
// rather than something a counter has to express.
//
// So the lesson above got its second demonstration in two releases, which
// is why it is stated as a rule rather than as a story: reach for the
// counter first and the clock second. There is no stats cache left, and
// nothing on /api/stats answers to a clock.

// Backfill must yield to the owner's own live
// traffic, never compete with it for the shared daily rows-written
// ceiling -- see backfill.ts hasBackfillHeadroom for the full reasoning.
// Set at half the daily ceiling: simple to reason about, and it reserves
// the *other* half exclusively for whatever the owner does with their
// own relay that day regardless of how much of backfill's own reserved
// half it has already used earlier in the same rolling 24h window.
export const BACKFILL_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 2;

// One-shot backfill -- events requested per relay per cron tick.
// Cloudflare's own docs distinguish the Worker's 10ms/request CPU limit
// (CLAUDE.md "The budget" table) from a Durable Object's own CPU
// allowance, which defaults to 30 seconds per incoming request/RPC call
// (developers.cloudflare.com/durable-objects/platform/limits/, checked
// 2026-08-22) -- at the ~1.1ms/schnorr-verify baseline (src/validate.ts),
// this page size costs well under that ceiling. So CPU is not what
// bounds this number.
//
// What does: backfill runs unattended, for as long as the owner's
// history requires, and must not crowd out the owner's own live writes
// against the shared 100,000 rows-written/day ceiling. It gets half
// (BACKFILL_ROWS_SHARE_LIMIT) and is sized to use about 80% of that half,
// leaving margin for history heavier than the measured average.
//
// COMPUTED, not written down, and that is the point. This constant has
// been wrong twice, both times silently, because it was a literal derived
// by hand from a per-event row cost that later changed underneath it:
//
//   - it was sized against an assumed ~5 rows/event when the real figure
//     was 13, so it was set to 200 and projected 62,400 rows/day, 125% of
//     the share it was supposed to stay inside;
//   - it was then re-derived by hand as 128 against 13 rows/event, and
//     v0.7.2's two `events` indexes took the real figure to 15 without
//     anyone revisiting the arithmetic. The event_tags index in v0.7.3
//     takes it to 20, at which 128 would project 61,440 rows/day -- 123%
//     of the share, overrunning it again in exactly the same way.
//
// So it is derived from eventRowCost, which is itself derived from the
// index set. Add an index and this shrinks to stay inside the share,
// with nothing to remember.
//
// TAGS_PER_REAL_EVENT is measured, not assumed: 200 backfilled events
// wrote 2,600 rows at a 13-rows/event schema, which is 3 base + 2 * 5
// indexed tags. A real note carries about five single-letter tags -- `e`
// and `p` on replies, plus the rest -- not the one or two the original
// estimate assumed.
const TAGS_PER_REAL_EVENT = 5;
const BACKFILL_SHARE_UTILISATION = 0.8;

// Restates wrangler.jsonc's `triggers.crons` ("0 * * * *", hourly) as a
// number, because BACKFILL_PAGE_SIZE and VANISH_BATCH_SIZE below need to
// divide a per-tick share by ticks-per-day and a Worker cannot read its
// own wrangler.jsonc at runtime to derive it -- that file is consumed by
// the `wrangler` CLI at deploy time, not bundled in. So this is a second
// place that has to agree with the crontab, and it is exported (rather
// than kept private the way the rest of this section's inputs are) so
// test/hibernation.test.ts can assert the crontab actually says what this
// number claims.
//
// That assertion is load-bearing, not decorative: changing the trigger to
// something more frequent -- `*/15 * * * *` for tighter backfill/vanish
// latency, say -- without updating this constant would leave
// BACKFILL_PAGE_SIZE and VANISH_BATCH_SIZE sized for 24 ticks/day while
// the relay actually ran 96, quadrupling both paths' real daily rows
// written with no test failing to say so.
export const CRON_TICKS_PER_DAY = 24;

// Never zero. Enough declared indexes would drive the quotient below one
// and floor() would silently stop backfill entirely -- a derived constant
// that can collapse to a no-op is worse than the literal it replaced.
export const BACKFILL_PAGE_SIZE = Math.max(
  1,
  Math.floor(
    (BACKFILL_ROWS_SHARE_LIMIT * BACKFILL_SHARE_UTILISATION) /
      (eventRowCost(TAGS_PER_REAL_EVENT) * CRON_TICKS_PER_DAY),
  ),
);

// How many events one cron tick will remove for a pubkey with a NIP-62
// vanish in progress (storage.ts drainVanish).
//
// Bounded by rows WRITTEN, not rows read -- the index added in v0.7.3
// made the reads cheap and left the writes exactly where they were.
// Paced against schema.ts eventRemovalBudget, which is deliberately the
// pessimistic of the two real figures for a removal; see the comment
// there for why a budget guard takes the larger number.
//
// A quarter of the daily ceiling, which is half of backfill's share and
// chosen against the two failure modes rather than as a round number.
//
// Too large and one stranger's request -- arriving without warning, at a
// size the relay does not choose and cannot refuse -- spends the owner's
// write budget in an afternoon. Too small and the relay takes weeks to
// do a thing NIP-62 says it MUST do, which is not compliance either.
//
// The arithmetic that bounds this is not really the share, it is the
// ceiling. A pubkey with tens of thousands of stored events takes days to
// vanish at ANY share of 100,000 rows/day, so the property worth
// engineering is that it finishes and stays visible while it does --
// /api/stats reports every draining request and how far it has got --
// rather than that it finishes quickly.
export const VANISH_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 4;
// Derived from eventRemovalBudget, not from `eventRowCost(...) + 2`. The
// `+ 2` was the tombstone, which is a function of the schema -- so
// writing it as a number here was the same hand-derived-literal mistake
// this file removed from BACKFILL_PAGE_SIZE in the very commit that
// introduced it. schema.ts owns the arithmetic; this file owns the share.
//
// Never zero, and here that guard is load-bearing rather than defensive:
// drainVanish treats "returned fewer rows than the limit" as "nothing
// left", so a limit of 0 would delete nothing, never report done, and
// leave the request pending forever -- a vanish that can never complete,
// which is the exact failure the checkpoint exists to prevent.
export const VANISH_BATCH_SIZE = Math.max(
  1,
  Math.floor(VANISH_ROWS_SHARE_LIMIT / (eventRemovalBudget(TAGS_PER_REAL_EVENT) * CRON_TICKS_PER_DAY)),
);

// ---------------------------------------------------------------------
// Ephemeral group chat (src/storage.ts sweepChat, relay.ts runCron).
//
// A conversation among friends is remembered rather than reread. Writing
// it down permanently turns talk into a record and changes what it was --
// the voice calls this relay already carries work that way and nobody
// expects to replay one, and the text sitting beside them had been
// quietly claiming a different status than the speech it transcribes. So
// the group's chat expires: not hidden, not archived, deleted.
//
// Four rules, and every constant below is one of them:
//
//   a conversation ends       when the room has been EMPTY for
//                             CONVERSATION_IDLE_SECONDS. Everything said
//                             during it goes when it goes.
//   speech                    a message sent while somebody else was in
//                             the room belongs to that conversation.
//   a note                    a message sent to an empty room is not
//                             speech. It waits for the next
//                             conversation, for as long as that takes.
//   arriving partway through  you see the last CHAT_BACKLOG_SECONDS, not
//                             the whole session.
//
// THE RELAY IS THE ONLY PARTY THAT CAN DO THIS, which is why it is here
// and not in a client: it is the only one that sees everyone's presence
// at once, and a client that expired its own copy would be hiding a
// transcript this relay still held.
//
// Scoped to the group's chat and to nothing else. The owner's own notes,
// backfilled history, gift wraps, the relay-generated 39000-series and
// the moderation events that produced it are all untouched -- see
// storage.ts sweepChat for the one kind this covers and why the scope is
// stated as a kind rather than as a partition.
// ---------------------------------------------------------------------

// How long the room must stay empty before the conversation it held is
// over. "Long enough that dinner does not end it, short enough that an
// evening ends when the evening does."
//
// It is a floor rather than an exact interval: the sweep runs on the
// hourly cron (CRON_TICKS_PER_DAY above), so a conversation is removed
// between two and three hours after the last person leaves. Erring long
// is the safe direction -- the failure of being early is deleting
// something somebody was still going to come back to.
export const CONVERSATION_IDLE_SECONDS = 2 * 60 * 60;

// How much of a conversation in progress somebody arriving partway
// through is shown. "Enough to know what is being talked about, not
// enough to replace asking."
//
// This is a READ horizon and not a second expiry: the messages are still
// there, and everyone who was in the room already has them from their own
// live subscription. It is what a REQ is clamped to (filters.ts
// FilterQueryOptions.chatHorizon), and it is also most of where the
// rows-read saving comes from -- a client that used to page the whole
// evening back now reads an index range a few minutes wide.
export const CHAT_BACKLOG_SECONDS = 5 * 60;

// THERE IS NO CEILING ON A NOTE, and its absence is a decision rather
// than an omission -- stated here because this is where a reader will
// come looking for the constant that is not here.
//
// An earlier draft of this gave a note about a week to be read, on the
// reasoning that nothing should wait forever on a friend who has gone
// quiet. That reasoning confuses two different things. Speech is
// ephemeral because it was heard and is over; a note has not been heard
// yet, and a thing that has not happened cannot expire. Mail does not
// vanish because the person it was addressed to is on holiday. The
// sender is the one who gets to change their mind about a note, and they
// already can: a NIP-09 kind-5 naming their own message deletes it
// outright (storage.ts applyDeletion, which reaches the group partition
// by primary key and tombstones the id like any other deletion).
//
// What this costs, plainly, because it is the price of getting the rule
// right. NOTE_MAX_WAIT_SECONDS was also serving as a backstop under
// everything else here -- whatever the occupancy watermark believed,
// nothing outlived a week -- and there is now no such floor. If the
// watermark is wrong in the direction of "somebody is always here", chat
// accumulates for as long as it stays wrong. See relay.ts groupOccupants
// for the one way that happens (a client that holds its socket open
// indefinitely) and why it is the rule working rather than failing.

// How many people make a room not-empty.
//
// TWO, and the second one is the whole distinction between speech and a
// note: a message is speech when SOMEBODY ELSE could hear it, so the
// author alone in the room is an empty room from the point of view of the
// only rule that cares. Named rather than written as a bare `2` in
// relay.ts because it is a definition and not a threshold.
export const MIN_ROOM_OCCUPANTS = 2;

// How stale the STORED occupancy watermark may be while the room is
// occupied -- the coarseness of `chat_state.last_occupied_at`.
//
// Derived from what it has to resolve rather than from what it costs,
// which is the opposite way round from PRESENCE_WRITE_INTERVAL_SECONDS
// above and deliberately so: presence is written per participant against
// a five-second beat, so the budget was the binding constraint there,
// while this is one row for the whole room and the budget is not close.
// A sixteenth of the idle window is comfortably finer than a boundary
// measured in hours needs.
//
// Checked against the ceiling afterwards, since a derivation that is not
// is a derivation nobody has priced: 7.5 minutes is 192 writes a day with
// somebody in the room around the clock, 0.2% of DAILY_ROWS_WRITTEN_LIMIT.
//
// Which way the coarseness errs matters more than its size. The watermark
// is the sweep's cutoff, so a watermark lagging the truth deletes LESS
// than the rule strictly says -- a message sent in the last few minutes
// of a conversation may be treated as a note and wait for the next one.
// That is the right direction: it keeps something a moment too long
// rather than deleting something a moment too early, and the next
// conversation's sweep collects it anyway.
const CHAT_OCCUPANCY_RESOLUTION_DIVISOR = 16;
export const CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS =
  CONVERSATION_IDLE_SECONDS / CHAT_OCCUPANCY_RESOLUTION_DIVISOR;

// Single-letter tags on a kind-9 chat message: `h` naming the group,
// plus an `e` on a reply. Two, and it is an assumption rather than a
// measurement -- the only one in this section -- so it is stated where it
// is used and chosen to err high. Over-estimating tags over-estimates a
// removal, which shrinks the batch below: slower, never overrunning, the
// direction TAGS_PER_REAL_EVENT and eventRemovalBudget are both wrong in.
const TAGS_PER_CHAT_MESSAGE = 2;

// What one cron tick may spend removing chat, and how many messages that
// buys.
//
// NO DAILY SHARE, unlike backfill and the vanish drain above, and the
// reason is worth stating because its absence looks like an omission.
// Those two are paced against a share of the day because their volume is
// chosen by somebody else -- a stranger's vanish request, a relay list of
// unknown size. This one is bounded by what this relay already stored:
// every message the sweep removes was written first, and writing one
// costs MORE than removing it does (eventRowCost against the tag rows,
// the event row and the three counters). A day's sweeping can therefore
// never exceed a day's chat ingest, and a day's chat ingest is already
// inside the ceiling or the relay had a bigger problem than this.
//
// What IS needed is a per-tick ceiling, so that a large accumulated
// backlog -- the first live sweep after an observation period, most
// obviously -- is drained across ticks rather than attempted at once.
// Five percent of the day per tick, which at the charged cost of a two-tag
// message is 250 messages: an ordinary evening's conversation of a few
// hundred clears in one or two ticks, and a backlog drains at 6,000 a day.
// storage.ts sweepChat checkpoints the rest, exactly as drainVanish does.
const CHAT_SWEEP_TICK_SHARE = DAILY_ROWS_WRITTEN_LIMIT / 20;
export const CHAT_SWEEP_BATCH_SIZE = Math.max(
  1,
  Math.floor(CHAT_SWEEP_TICK_SHARE / eventRowCost(TAGS_PER_CHAT_MESSAGE)),
);

// What the relay is allowed to DO about all of the above.
//
// Three states, and the default is the cautious one, which inverts this
// file's usual only-one-exact-string-disables-it shape (DISABLE_VALUE
// above, ALLOW_FOLLOWS, UPDATE_CHECK). Those guard a SAFETY limit, so the
// dangerous act is turning one off and that is what must be spelled out.
// Here the dangerous act is deletion itself, so it is deletion that has to
// be spelled out and everything else defaults to watching:
//
//   unset, or anything else   REPORTING. Nothing is deleted and nothing is
//                             withheld from a read. Each cron tick logs
//                             what it would have removed, so an owner can
//                             watch it be right for a few days first.
//   "on"                      DELETING. The sweep removes, and reads are
//                             clamped to the horizon.
//   "off"                     Neither. No sweep, no report, no horizon --
//                             the relay this was before.
//
// Reporting rather than off as the default because a feature that ships
// switched off ships untested on the only deployment that matters.
export type ChatMode = "off" | "reporting" | "deleting";

export function chatMode(env: Env): ChatMode {
  if (env.EPHEMERAL_CHAT === "on") return "deleting";
  if (env.EPHEMERAL_CHAT === DISABLE_VALUE) return "off";
  return "reporting";
}
