import { tagFilterEntries, type Filter } from "./nostr";

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

// Clamps a filter's `limit` to MAX_FILTER_LIMIT, defaulting to it when
// the filter doesn't specify one -- every filter this relay executes
// against storage carries a bounded limit.
export function clampFilterLimit(filter: Filter): Filter {
  const limit = filter.limit === undefined ? MAX_FILTER_LIMIT : Math.min(filter.limit, MAX_FILTER_LIMIT);
  return { ...filter, limit };
}

// ---------------------------------------------------------------------
// Write-path abuse caps. Everything below this line bounds what a writer
// who is *allowed* to write can cost -- a separate concern from the read
// caps above, and from ownership.ts, which decides who may write at all.
//
// The original threat model (CLAUDE.md, chunk 6) had exactly one
// untrusted write path: kind-1059 gift wraps, "the only unbounded write
// path", since every other write was the owner's own and the owner is
// trusted not to attack their own relay. v0.2.0 made ALLOW_FOLLOWS an
// opt-OUT, which quietly turned "one trusted author" into "hundreds of
// pubkeys the owner has merely followed" -- without moving any of the
// gift wrap caps across. A single compromised or malicious follow was
// then bounded only by the per-IP message rate limit in relay.ts: at 300
// messages/minute and the measured 13 rows/event (docs/budget.md), about
// 26 minutes to exhaust the daily rows-written ceiling, and -- far worse,
// because storage does not reset daily -- an afternoon to fill 5GB
// permanently with events of unbounded size.
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

// Total gift wraps this relay will hold at once. At the byte cap above,
// worst case is MAX_GIFT_WRAPS * MAX_EVENT_BYTES = ~128MB, well under
// the 5GB SQLite ceiling even alongside the owner's own data -- generous
// for a real personal inbox, bounded against storage exhaustion from an
// anonymous write path. New gift wraps are refused once reached; the
// owner deleting old ones (or vanishing them) frees room.
export const MAX_GIFT_WRAPS = 2000;

// Per-IP gift wrap write throttle, separate from the general per-message
// rate limit in relay.ts (which counts REQ/CLOSE/AUTH too and is tuned
// for connection-level spam, not specifically for rows-written risk). At
// 100,000 rows-written/day and ~5 rows per stored gift wrap (see
// docs/budget.md), an unthrottled flood could exhaust the daily write
// budget in minutes; this window is generous for real DM traffic
// (nobody legitimately sends more than a handful of messages a minute)
// while keeping a sustained flood far below the daily ceiling.
export const GIFT_WRAP_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_GIFT_WRAPS_PER_IP_PER_WINDOW = 5;

// A filter with none of `ids`, `authors`, `kinds`, or a `#<letter>` tag
// constraint has no equality condition to bound how much of the table
// it can scan -- CLAUDE.md "Threat model": "Reject filters with no
// authors and no kinds constraint." `ids` and tag filters are just as
// bounding (both go through an index or direct equality -- see
// filters.ts buildFilterQuery) so they count too; only a filter that is
// nothing but since/until/limit is truly unconstrained.
export function isUnconstrainedFilter(filter: Filter): boolean {
  return (
    filter.ids === undefined &&
    filter.authors === undefined &&
    filter.kinds === undefined &&
    tagFilterEntries(filter).length === 0
  );
}

// Live feed (ROADMAP.md chunk 7) caps -- unlike the nostr protocol path
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

// One-shot backfill (ROADMAP.md chunk 7) -- events requested per relay
// per cron tick. Cloudflare's own docs distinguish the Worker's 10ms/
// request CPU limit (CLAUDE.md "The budget" table) from a Durable
// Object's own CPU allowance, which defaults to 30 seconds per incoming
// request/RPC call (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-22) -- at the ~1.1ms/schnorr-verify baseline
// (docs/baselines.json), this page size costs ~140ms of DO CPU, nowhere
// near that ceiling. So CPU is not what bounds this number.
// What does: backfill runs unattended, for as long as the owner's
// history requires, and must not crowd out the owner's own live writes
// against the shared 100,000 rows-written/day ceiling.
//
// This number was originally derived from an assumed ~5 rows per stored
// event, which was wrong. Measured against real backfilled history (200
// events ingested in one tick, 2,600 rows written -- the first honest
// figure available, since the rows-written estimate itself was measuring
// the wrong clock until v0.3.1):
//
//   13.0 rows per backfilled event
//     = 3 base rows + 2 * 5 indexed tags   (see schema.ts)
//
// A real note carries roughly five single-letter tags -- `e` and `p` on
// replies, plus the rest -- not the one or two the old estimate assumed.
// At the old page size that projects to:
//
//   200 events * 13 rows * 24 ticks/day = 62,400 rows/day
//
// which is 125% of BACKFILL_ROWS_SHARE_LIMIT below. Backfill was sized to
// overrun its own reserved half, and only ever got away with it because
// hasBackfillHeadroom was measuring by created_at and so could not see a
// single row backfill wrote. Now that the guard works, the old page size
// would simply throttle backfill most of the way through each day rather
// than pacing it -- the guard is right and the page size was wrong.
//
// Sized so the daily worst case lands at ~80% of the reserved share,
// leaving headroom for history heavier than the measured average:
//
//   128 events * 13 rows * 24 ticks/day = 39,936 rows/day  (80% of 50,000)
//
// The remaining margin absorbs up to ~16 rows/event (about 6.5 indexed
// tags) before the projection would reach the share at all.
export const BACKFILL_PAGE_SIZE = 128;

// How long the Worker's cron tick keeps one outbound backfill socket open
// waiting for EOSE before giving up for this tick -- mirrors
// profile-lookup.ts's LOOKUP_TIMEOUT_MS shape, scoped to backfill so a
// slow/unreachable relay can't stall the whole cron invocation.
export const BACKFILL_FETCH_TIMEOUT_MS = 8000;

// Cloudflare Workers Free's daily rows-written ceiling (CLAUDE.md "The
// budget"). Named here, not just left as the bare `100000` already
// hardcoded in public/index.html's admin-page display, because
// backfill's headroom check below needs the actual number to reason
// about, not just a copy used for a progress bar.
export const DAILY_ROWS_WRITTEN_LIMIT = 100_000;

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

// Backfill (ROADMAP.md chunk 7) must yield to the owner's own live
// traffic, never compete with it for the shared daily rows-written
// ceiling -- see backfill.ts hasBackfillHeadroom for the full reasoning.
// Set at half the daily ceiling: simple to reason about, and it reserves
// the *other* half exclusively for whatever the owner does with their
// own relay that day regardless of how much of backfill's own reserved
// half it has already used earlier in the same rolling 24h window.
export const BACKFILL_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 2;
