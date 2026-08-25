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

// Gift wrap (NIP-59, ROADMAP.md chunk 6) abuse caps -- CLAUDE.md "Threat
// model" scoped these to kind 1059 specifically: "This is the only
// unbounded write path" (every other write is owner-authored, so the
// owner is trusted not to attack their own relay; a gift wrap sender is
// not).

// Rejects a gift wrap event larger than this many bytes (JSON-serialized
// wire size). Generous for real NIP-17 DM content (encrypted seal +
// rumor, typically low single-digit KB) while bounding how much of the
// 100,000 rows-written/day and 5GB storage ceilings one message can cost.
export const MAX_GIFT_WRAP_BYTES = 64 * 1024;

// Total gift wraps this relay will hold at once. At the byte cap above,
// worst case is MAX_GIFT_WRAPS * MAX_GIFT_WRAP_BYTES = ~128MB, well under
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
// (docs/baselines.json), even this page size costs ~220ms of DO CPU,
// nowhere near that ceiling. So CPU is not what bounds this number.
// What does: backfill runs unattended, for as long as the owner's
// history requires, and must not crowd out the owner's own live writes
// against the shared 100,000 rows-written/day ceiling. At ~5 rows/event
// and one page from exactly one relay per hourly cron tick, worst case is
// 200 * 5 * 24 = 24,000 rows/day from backfill alone -- see
// docs/budget.md chunk 7 note.
export const BACKFILL_PAGE_SIZE = 200;

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

// Backfill (ROADMAP.md chunk 7) must yield to the owner's own live
// traffic, never compete with it for the shared daily rows-written
// ceiling -- see backfill.ts hasBackfillHeadroom for the full reasoning.
// Set at half the daily ceiling: simple to reason about, and it reserves
// the *other* half exclusively for whatever the owner does with their
// own relay that day regardless of how much of backfill's own reserved
// half it has already used earlier in the same rolling 24h window.
export const BACKFILL_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 2;
