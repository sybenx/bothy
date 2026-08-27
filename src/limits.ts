import { tagFilterEntries, type Filter } from "./nostr";
import { expandFilterCount } from "./filters";
import { indexesOn } from "./schema";

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
// CLAUDE.md "The budget"), an unthrottled flood could exhaust the daily write
// budget in minutes; this window is generous for real DM traffic
// (nobody legitimately sends more than a handful of messages a minute)
// while keeping a sustained flood far below the daily ceiling.
export const GIFT_WRAP_RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_GIFT_WRAPS_PER_IP_PER_WINDOW = 5;

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
// ---------------------------------------------------------------------

// Cloudflare Workers Free's daily rows-READ ceiling, the companion to
// DAILY_ROWS_WRITTEN_LIMIT below (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-26). Named here because it is the number the relay
// actually died on, and because the per-filter cap below is derived from
// it rather than picked.
export const DAILY_ROWS_READ_LIMIT = 5_000_000;

// The most one REQ filter may read. A five-hundredth of the daily
// ceiling: it takes 500 filters at the cap to spend a day's budget,
// against the 125 it took before this guard existed. Not a ceiling on
// what a connection can spend over time -- the per-IP message throttle in
// relay.ts is what bounds that -- only on what any single filter can cost
// in one go.
export const MAX_FILTER_ROWS_READ = DAILY_ROWS_READ_LIMIT / 500;

// Rows read per row returned by an ordered index scan: the index entry,
// then the table row it points at. Measured (test/read-cost.test.ts), not
// derived -- 41 rows for a limit of 20.
const ROWS_READ_PER_MATCH = 2;

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
  // primary key. Carried so the test harness and any future diagnostic
  // can say WHY a filter is cheap, not just that it is.
  via: string;
}

// The cheapest bounded way to answer this filter, or null when nothing
// bounds it below the size of the table.
//
// `limit` is taken as given: callers pass an already-clamped filter, and
// boundFilter below is what does the clamping.
export function filterReadCost(filter: Filter): FilterReadCost | null {
  const limit = filter.limit ?? MAX_FILTER_LIMIT;
  const candidates: FilterReadCost[] = [];

  // The primary key. `id TEXT PRIMARY KEY` is a unique index, so an
  // `ids` filter is one seek per id and needs no ordering at all -- the
  // rows it can return are already bounded by how many ids were named.
  if (filter.ids !== undefined && filter.ids.length > 0) {
    candidates.push({ rowsRead: filter.ids.length, via: "events primary key" });
  }

  // Tag filters, through idx_event_tags_lookup. buildFilterQuery
  // resolves these as `id IN (SELECT event_id FROM event_tags WHERE
  // tag_name = ? AND tag_value IN (...))`, an exact seek per named
  // value.
  //
  // Be honest about this one: it is the single estimate here that can be
  // wrong LOW. The subquery is not bounded by `limit` -- it reads every
  // tag row carrying a named value -- so a filter like
  // `{"#p":[owner]}` on a relay where most events p-tag the owner costs
  // far more than this says. It is modelled as limit-bounded because
  // every tag value a real client asks about is a specific event id or
  // pubkey matching a handful of rows (measured: 5 rows for one match),
  // and because pricing it correctly would take a COUNT query, i.e. a
  // read, to decide whether a read is affordable. Recorded rather than
  // fixed, and unchanged from the behaviour before this guard -- tag
  // filters were always accepted.
  const tags = tagFilterEntries(filter);
  if (tags.length > 0) {
    const values = tags.reduce((n, [, v]) => n + v.length, 0);
    if (values > 0) {
      candidates.push({
        rowsRead: values * ROWS_READ_PER_MATCH * limit,
        via: "idx_event_tags_lookup",
      });
    }
  }

  // The ordered indexes on `events`. An index qualifies when every one
  // of its key columns is pinned by the filter at all -- once
  // filters.ts expandFilter has split the filter, each of those columns
  // holds exactly one value in every query that actually runs.
  //
  // `combinations` is the number of queries filters.ts expandFilter will
  // run, NOT the product of the chosen index's own key columns, and that
  // distinction is a correctness condition rather than a nicety. A filter
  // naming one author and two kinds runs TWO queries whichever index
  // serves them; pricing it from idx_events_pubkey_created's single key
  // column called it one query and understated the cost by half, which a
  // test caught and reading did not.
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
  const combinations = expandFilterCount(filter);
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

  if (candidates.length === 0) return null;
  // SQLite picks one access path; the cheapest available is the honest
  // estimate of what it will pick, and the pessimistic direction is
  // already covered by rejecting anything above MAX_FILTER_ROWS_READ.
  return candidates.reduce((best, c) => (c.rowsRead < best.rowsRead ? c : best));
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
export function boundFilter(filter: Filter): FilterBound {
  const requested = filter.limit === undefined ? MAX_FILTER_LIMIT : Math.min(filter.limit, MAX_FILTER_LIMIT);

  // Halving rather than solving for the largest affordable limit
  // directly: the search does not need to know the shape of the cost
  // function, so a change to that function cannot leave a stale inverse
  // behind it. It terminates in at most nine steps from
  // MAX_FILTER_LIMIT, and the cost of the coarseness is that a client
  // occasionally gets 62 events where 100 would also have fit.
  for (let limit = requested; limit >= 1; limit = Math.floor(limit / 2)) {
    const candidate = { ...filter, limit };
    const cost = filterReadCost(candidate);
    if (cost === null) {
      // Unbounded at any limit -- the limit is not what is wrong with it.
      return {
        ok: false,
        reason:
          "invalid: filter must constrain ids, kinds, authors or a #<letter> tag; " +
          "since/until alone would scan the whole table",
      };
    }
    if (cost.rowsRead <= MAX_FILTER_ROWS_READ) return { ok: true, filter: candidate, cost };
  }

  // Reached only when the cost does not fall with the limit. Two shapes
  // do that: a cross-product of `authors` x `kinds` large enough that
  // even one row each is too many, and an `ids` list long enough that
  // seeking every id exceeds the cap on its own (an `ids` seek costs one
  // row per id no matter how few of them the client says it wants back).
  // The message names both rather than guessing which one applies, since
  // guessing wrong sends the client to fix the field that was fine.
  return {
    ok: false,
    reason:
      `invalid: filter is too broad to answer within ${MAX_FILTER_ROWS_READ} rows read ` +
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

// One-shot backfill -- events requested per relay
// per cron tick. Cloudflare's own docs distinguish the Worker's 10ms/
// request CPU limit (CLAUDE.md "The budget" table) from a Durable
// Object's own CPU allowance, which defaults to 30 seconds per incoming
// request/RPC call (developers.cloudflare.com/durable-objects/platform/limits/,
// checked 2026-08-22) -- at the ~1.1ms/schnorr-verify baseline
// (src/validate.ts), this page size costs ~140ms of DO CPU, nowhere
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

// Backfill must yield to the owner's own live
// traffic, never compete with it for the shared daily rows-written
// ceiling -- see backfill.ts hasBackfillHeadroom for the full reasoning.
// Set at half the daily ceiling: simple to reason about, and it reserves
// the *other* half exclusively for whatever the owner does with their
// own relay that day regardless of how much of backfill's own reserved
// half it has already used earlier in the same rolling 24h window.
export const BACKFILL_ROWS_SHARE_LIMIT = DAILY_ROWS_WRITTEN_LIMIT / 2;
