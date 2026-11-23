import { GIFT_WRAP_KIND, type Filter, type NostrEvent, tagFilterEntries } from "./nostr";
import {
  GROUP_SCOPE, CREATE_INVITE_KIND, GROUP_CHAT_KIND, type GroupScope, PUBLIC_SCOPE } from "./groups";

// How many tag rows one `#<letter>` condition may look at, per event the
// client asked for.
//
// A tag condition is `id IN (SELECT event_id FROM event_tags WHERE ...)`.
// Unbounded, that subquery reads every row carrying the tag value whatever
// the `limit` (measured: `{"#p":[owner]}` read 4,000 rows at E=1,000 at
// both limit 20 and limit 1), so limits.ts boundFilter could not price or
// clamp it -- and `#p:<owner>` is the highest-cardinality tag value here,
// since every gift wrap p-tags the owner. With `ORDER BY created_at DESC
// LIMIT n` the subquery streams idx_event_tags_lookup_* (tag_name,
// tag_value, created_at) and stops, costing 4 x n (measured: 400 at limit
// 20, 4 at limit 1).
//
// Derived, not chosen: at MAX_FILTER_LIMIT a single-value tag filter costs
// exactly the per-filter ceiling:
//
//   TAG_SCAN_DEPTH = MAX_FILTER_ROWS_READ / (TAG_ROWS_READ_PER_MATCH x MAX_FILTER_LIMIT)
//                  = 10,000 / (4 x 500) = 5
//
// Declared here rather than in limits.ts because limits.ts imports this
// module. test/read-cost.test.ts asserts the identity.
//
// Trade-off: other conditions (`kinds` especially) narrow the newest
// TAG_SCAN_DEPTH x limit candidates, so a page can come back short even
// though more matches exist. NIP-01 `limit` is a maximum, so that is
// legal, and the since/until pushdown in buildFilterQuery lets `until`
// pagination still walk the whole history. Raising this constant buys
// fuller pages with rows read.
export const TAG_SCAN_DEPTH = 5;

export function tagScanLimit(limit: number): number {
  return limit * TAG_SCAN_DEPTH;
}

// The same budget split across the partitions one read covers
// (FilterQueryOptions.tagScanDivisor). At least 1, so a tag filter never
// looks at nothing.
export function scopedTagScanLimit(limit: number, divisor = 1): number {
  return Math.max(1, Math.ceil(tagScanLimit(limit) / Math.max(1, divisor)));
}

// Turns one REQ filter into SQL. Every query excludes events whose NIP-40
// `expiration` has passed (nips/40.md: "SHOULD NOT send expired events to
// clients, even if they are stored").
//
// No prefix matching for ids/authors: NIP-01 makes it optional (see
// docs/test-notes.md).
export interface FilterQueryOptions {
  // Omit kind-1059 rows: the gift wrap read gate for a session not
  // authenticated as the recipient.
  //
  // OMISSION, never refusal. A refusal that depends on what is stored is
  // itself the answer: if an unauthenticated `{"#p":[owner],"since":S,
  // "until":U,"limit":1}` were refused when a wrap fell in the window,
  // bisecting since/until would reveal exact arrival times and the inbox
  // count without ever naming 1059. Omission answers the same way whether
  // or not the inbox holds anything.
  //
  // Applied only when the filter names no `kinds`. A filter naming 1059 is
  // refused by relay.ts handleReqInner from `kinds` alone, with no storage
  // access (that leaks nothing); a filter naming other kinds cannot match
  // a wrap.
  //
  // In SQL, never in memory after the query: a client asking for 20 and
  // receiving 8 would have counted the wraps in its window. The rows must
  // be gone before LIMIT applies.
  //
  // Cost: this is the one place a query can read more than limits.ts
  // filterReadCost prices, since skipped rows are still read. Measured at
  // a 2,000-wrap inbox (test/read-cost.test.ts):
  //
  //   {"#p":[owner],"limit":20}       priced 400   reads 301
  //   {"authors":[X],"limit":20}      priced  41   reads 2,002
  //
  // The tag shape cannot overshoot (its subquery has its own LIMIT). The
  // index shape can, up to the wraps that author holds, which is why
  // limits.ts maxGiftWraps is bounded by MAX_FILTER_ROWS_READ.
  excludeGiftWraps?: boolean;

  // Omit kind-9009 create-invite rows: the invite-code read gate for every
  // session but the owner's (groups.ts CREATE_INVITE_KIND explains why
  // members are excluded too).
  //
  // Applied WHATEVER `kinds` says, unlike excludeGiftWraps: a filter
  // naming 9009 is answered by omission rather than refused (refusing
  // would add a signal on the unauthenticated path, where
  // `{"kinds":[9009]}` gets a plain EOSE), so gating on `kinds ===
  // undefined` would let exactly that filter through.
  //
  // Also emitted on the public half of a two-partition read, where it can
  // match nothing (a 9009 always carries `h`, nip29.ts enforces that).
  // Deliberate: the read gate should not depend silently on the write gate
  // holding.
  excludeInvites?: boolean;

  // Which partition of `events` to read (src/groups.ts). Defaults to
  // public, which is what every unauthenticated read gets.
  //
  // `is_group = ?` is emitted on EVERY query and every tag subquery. The
  // REQ-serving indexes are partial pairs keyed on this column (schema.ts
  // INDEXES), so a query that names no partition can use neither half and
  // scans `events` (measured at 50,000 group events: `{"kinds":[1],
  // "limit":20}` read 92,033 rows unpinned, 82 pinned and run once per
  // partition). A reader entitled to both partitions runs the filter
  // twice; storage.ts queryFilter merges and re-slices.
  scope?: GroupScope;

  // Which groups this reader may see, on the group partition. Needed
  // because the partition alone would hand a member of group A everything
  // in group B.
  //
  // `undefined` = unrestricted, used for the owner (in every group by
  // construction; an IN list would cost a bound parameter per group,
  // counted against MAX_QUERY_BOUND_PARAMS, to exclude nothing).
  //
  // An EMPTY array means no group at all and must not be conflated with
  // `undefined`. Callers should not reach the group partition with one
  // (relay.ts reads only PUBLIC_SCOPE then); if they do, it emits a
  // condition matching nothing, so it fails closed.
  groupIds?: readonly string[];

  // How many partitions the caller reads in total; splits the tag
  // subquery's scan depth between them. Without it a two-partition read
  // costs twice what filterReadCost priced, and one busy partition can
  // starve the other (measured at 50,000 group events: the owner's
  // `{"#p":[owner],"kinds":[1059]}` returned 0 wraps unsplit, 16 split).
  tagScanDivisor?: number;

  // Oldest `created_at` at which a kind-9 chat message may be returned
  // (storage.ts chatHorizon, limits.ts CHAT_BACKLOG_SECONDS): somebody
  // joining a conversation sees only the last few minutes. When ephemeral
  // chat is acting, relay.ts sets it for every session, the owner's
  // included; it is not a permission.
  //
  // FOLDED INTO `since` when the query is pinned to kind 9 (expandFilter
  // has split `kinds` into singletons), so it bounds the index range of
  // idx_events_kind_created_grp. As a residual `(kind != 9 OR created_at
  // >= ?)` on a kind-9 query it would bound nothing: the DESC scan would
  // read the whole partition looking for a LIMIT it cannot fill.
  //
  // The residual is used only when the filter names no `kinds`. It can
  // overshoot like excludeGiftWraps, bounded by the tag subquery's LIMIT
  // or by the group's chat volume.
  chatHorizon?: number;

  // Private profiles (README "Private profiles"): which members' kind 0
  // this reader may NOT see. Omitted for the owner and admins, who read
  // every profile here, the removed-in-grace ones included.
  //
  //   "all"     current members AND people removed and still in grace:
  //             a stranger, an unauthenticated socket, a removed person.
  //   "former"  only the removed-in-grace ones: a plain member.
  //
  // `owner` and `self` are never hidden: the owner's profile is his
  // public identity, and reading your own profile tells you nothing.
  // `requireAuthors` (MEMBER_LIST=hidden, plain member) widens "former" to
  // "all" on a filter that names no `authors`, so a member cannot list the
  // home by asking for every kind 0.
  //
  // OMISSION in SQL, like excludeGiftWraps, so the answer is the same
  // whether or not a member's profile is stored. Applied only when the
  // filter can match kind 0. The subqueries read `allowed_pubkeys` and
  // `former_members`, which is why read-metrics.ts clears the REQ cache
  // on writes to them.
  hideMemberProfiles?: {
    hide: "all" | "former";
    owner: string;
    self: string;
    requireAuthors: boolean;
  };
}

// Kind 0, the profile (NIP-01).
export const PROFILE_KIND = 0;

export function buildFilterQuery(
  filter: Filter,
  nowSec: number,
  options: FilterQueryOptions = {},
): { sql: string; params: unknown[] } | null {
  const conditions: string[] = ["(expiration IS NULL OR expiration > ?)"];
  const params: unknown[] = [nowSec];

  // See FilterQueryOptions.chatHorizon. `filter.kinds` is a singleton or
  // absent here (expandFilter ran first).
  const horizon = options.chatHorizon;
  const pinnedToChat = filter.kinds?.length === 1 && filter.kinds[0] === GROUP_CHAT_KIND;
  const since =
    horizon !== undefined && pinnedToChat
      ? Math.max(filter.since ?? horizon, horizon)
      : filter.since;

  // The partition pin, on every query without exception (see
  // FilterQueryOptions.scope).
  conditions.push("is_group = ?");
  params.push(options.scope ?? PUBLIC_SCOPE);

  // Group partition only: a public row has NULL group_id, so `IN` would
  // silently match nothing there.
  if ((options.scope ?? PUBLIC_SCOPE) === GROUP_SCOPE && options.groupIds !== undefined) {
    if (options.groupIds.length === 0) {
      conditions.push("0");
    } else {
      conditions.push(`group_id IN (${placeholders(options.groupIds.length)})`);
      params.push(...options.groupIds);
    }
  }

  if (filter.ids !== undefined) {
    if (filter.ids.length === 0) return null;
    conditions.push(`id IN (${placeholders(filter.ids.length)})`);
    params.push(...filter.ids);
  }
  if (filter.authors !== undefined) {
    if (filter.authors.length === 0) return null;
    conditions.push(`pubkey IN (${placeholders(filter.authors.length)})`);
    params.push(...filter.authors);
  }
  if (filter.kinds !== undefined) {
    if (filter.kinds.length === 0) return null;
    conditions.push(`kind IN (${placeholders(filter.kinds.length)})`);
    params.push(...filter.kinds);
  }
  // See FilterQueryOptions.excludeGiftWraps (`kinds` absent only).
  if (options.excludeGiftWraps && filter.kinds === undefined) {
    conditions.push("kind != ?");
    params.push(GIFT_WRAP_KIND);
  }
  // See FilterQueryOptions.excludeInvites (whatever `kinds` says).
  if (options.excludeInvites) {
    conditions.push("kind != ?");
    params.push(CREATE_INVITE_KIND);
  }
  // See FilterQueryOptions.hideMemberProfiles.
  const gate = options.hideMemberProfiles;
  if (gate !== undefined && (filter.kinds === undefined || filter.kinds.includes(PROFILE_KIND))) {
    const hide = gate.requireAuthors && filter.authors === undefined ? "all" : gate.hide;
    const hidden =
      hide === "all"
        ? "(pubkey IN (SELECT pubkey FROM allowed_pubkeys) OR pubkey IN (SELECT pubkey FROM former_members))"
        : "pubkey IN (SELECT pubkey FROM former_members)";
    conditions.push(`NOT (kind = ? AND pubkey NOT IN (?, ?) AND ${hidden})`);
    params.push(PROFILE_KIND, gate.owner, gate.self);
  }
  // The residual horizon, only where it could not fold into `since` (see
  // FilterQueryOptions.chatHorizon).
  if (horizon !== undefined && filter.kinds === undefined) {
    conditions.push("(kind != ? OR created_at >= ?)");
    params.push(GROUP_CHAT_KIND, horizon);
  }
  if (since !== undefined) {
    conditions.push("created_at >= ?");
    params.push(since);
  }
  if (filter.until !== undefined) {
    conditions.push("created_at <= ?");
    params.push(filter.until);
  }
  for (const [letter, values] of tagFilterEntries(filter)) {
    if (values.length === 0) return null;
    // The partition pin again, needed here for a second reason besides the
    // index: the subquery's LIMIT applies before the outer conditions, so
    // the other partition's rows would crowd out real candidates
    // (measured at 50,000 group events, `{"#p":[owner],"limit":20}`
    // returned 20 events pinned, 1 unpinned).
    const subConditions = [
      "is_group = ?",
      `tag_name = ? AND tag_value IN (${placeholders(values.length)})`,
    ];
    const subParams: unknown[] = [options.scope ?? PUBLIC_SCOPE, letter, ...values];
    // Group scoping again, for the same reason: this subquery reads
    // event_tags alone, and its LIMIT would otherwise be spent on groups
    // the reader cannot see.
    if ((options.scope ?? PUBLIC_SCOPE) === GROUP_SCOPE && options.groupIds !== undefined) {
      if (options.groupIds.length === 0) {
        subConditions.push("0");
      } else {
        subConditions.push(`group_id IN (${placeholders(options.groupIds.length)})`);
        subParams.push(...options.groupIds);
      }
    }
    // since/until pushed down: `event_tags.created_at` is the event's own
    // (storage.ts insertEventRow copies it), so this narrows the index
    // range scanned, and it is what makes `until` pagination work under
    // the LIMIT below.
    if (since !== undefined) {
      subConditions.push("created_at >= ?");
      subParams.push(since);
    }
    if (filter.until !== undefined) {
      subConditions.push("created_at <= ?");
      subParams.push(filter.until);
    }
    let subquery = `SELECT event_id FROM event_tags WHERE ${subConditions.join(" AND ")}`;
    if (filter.limit !== undefined) {
      subquery += " ORDER BY created_at DESC LIMIT ?";
      subParams.push(scopedTagScanLimit(filter.limit, options.tagScanDivisor));
    }
    conditions.push(`id IN (${subquery})`);
    params.push(...subParams);
  }

  let sql = `SELECT id, pubkey, created_at, kind, tags, content, sig FROM events WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id ASC`;
  if (filter.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(filter.limit);
  }
  return { sql, params };
}

function placeholders(count: number): string {
  return Array(count).fill("?").join(", ");
}

// How many bound `?` parameters ONE buildFilterQuery call binds, for a
// filter already split by expandFilter (so `authors` and `kinds` are at
// most one value each). limits.ts boundFilter needs it before any query is
// built, to enforce MAX_QUERY_BOUND_PARAMS (see there). `ids` and tag
// value lists are not split, so they carry their full length into every
// query, and rows-read pricing does not bound them.
//
// Mirrors buildFilterQuery term for term; keep the two in step.
// test/read-limits.test.ts asserts it against a built query's
// params.length.
export function filterParamCount(filter: Filter): number {
  // The filter's own parameters only. The read gates (excludeGiftWraps,
  // excludeInvites, chatHorizon, groupIds) add more depending on the
  // session, which boundFilter cannot see; MAX_QUERY_BOUND_PARAMS sits
  // below SQLite's real ceiling of 100 to leave room for them.
  let count = 1; // the "(expiration IS NULL OR expiration > ?)" guard on every query
  count += 1; // the "is_group = ?" partition pin, also on every query
  if (filter.ids !== undefined && filter.ids.length > 0) count += filter.ids.length;
  if (filter.authors !== undefined && filter.authors.length > 0) count += 1;
  if (filter.kinds !== undefined && filter.kinds.length > 0) count += 1;
  if (filter.since !== undefined) count += 1;
  if (filter.until !== undefined) count += 1;
  for (const [, values] of tagFilterEntries(filter)) {
    if (values.length === 0) continue;
    count += 1; // the subquery's own "is_group = ?" pin
    count += 1; // tag_name
    count += values.length;
    if (filter.since !== undefined) count += 1;
    if (filter.until !== undefined) count += 1;
    if (filter.limit !== undefined) count += 1; // tagScanLimit
  }
  if (filter.limit !== undefined) count += 1;
  return count;
}

// How many queries expandFilter would produce, without producing them.
// limits.ts filterReadCost needs this before the filter is known to be
// affordable, and `authors` arrives uncapped, so materialising the
// cross-product to price it would itself be a cheap DoS.
// test/read-cost.test.ts asserts it agrees with expandFilter.
export function expandFilterCount(filter: Filter): number {
  return Math.max(1, filter.authors?.length ?? 1) * Math.max(1, filter.kinds?.length ?? 1);
}

// Splits one filter into the cross-product of its `authors` x `kinds`
// singletons, so every query pins each index key column to ONE value.
//
// An index serves `ORDER BY created_at DESC LIMIT n` cheaply only when the
// key columns ahead of `created_at` are each pinned; `kind IN (1, 7)` is
// not, so SQLite reads and sorts every match. Measured at E=2,000
// (test/read-cost.test.ts):
//
//   {"kinds":[1,7],"limit":20}            one query   3,983 rows
//                                         split           82 rows
//   {"authors":[owner],"kinds":[1,7]}     one query   3,584 rows
//                                         split           42 rows
//
// Splitting also makes the cost predictable (authors x kinds x (2 x limit)
// whichever index the planner picks), which is what limits.ts
// filterReadCost assumes.
//
// `ids` (a primary-key seek) and `#<letter>` (a tag subquery) gain nothing
// from splitting, so they are left alone.
//
// Callers must re-merge: each sub-filter returns up to `limit` events.
// storage.ts queryFilter dedupes, re-sorts and slices back to `limit`, so
// the result is identical to the unsplit filter's.
export function expandFilter(filter: Filter): Filter[] {
  const authors = filter.authors;
  const kinds = filter.kinds;
  // The common case: nothing to expand, and the caller skips its merge.
  if ((authors?.length ?? 1) <= 1 && (kinds?.length ?? 1) <= 1) return [filter];

  const expanded: Filter[] = [];
  for (const author of authors ?? [undefined]) {
    for (const kind of kinds ?? [undefined]) {
      const sub: Filter = { ...filter };
      if (author !== undefined) sub.authors = [author];
      if (kind !== undefined) sub.kinds = [kind];
      expanded.push(sub);
    }
  }
  return expanded;
}

// Newest first, ties by lowest id: must match buildFilterQuery's
// `ORDER BY created_at DESC, id ASC`, since storage.ts queryFilter and
// queryFilters re-merge results with it.
export function compareEvents(a: NostrEvent, b: NostrEvent): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// In-memory equivalent of buildFilterQuery's filter conditions, for
// testing a freshly stored event against live subscriptions. It applies
// none of the FilterQueryOptions read gates; broadcast callers must apply
// those themselves.
export function matchesFilter(event: NostrEvent, filter: Filter): boolean {
  if (filter.ids !== undefined && !filter.ids.includes(event.id)) return false;
  if (filter.authors !== undefined && !filter.authors.includes(event.pubkey)) return false;
  if (filter.kinds !== undefined && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [letter, values] of tagFilterEntries(filter)) {
    const hasMatch = event.tags.some((t) => t[0] === letter && t[1] !== undefined && values.includes(t[1]));
    if (!hasMatch) return false;
  }
  return true;
}

export function matchesAnyFilter(event: NostrEvent, filters: Filter[]): boolean {
  return filters.some((f) => matchesFilter(event, f));
}

// Loose parse of a REQ filter off the wire. Bounds nothing (array lengths
// included); limits.ts boundFilter does that.
export function parseFilter(raw: unknown): Filter | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const filter: Filter = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "ids" || key === "authors") {
      if (!isStringArray(value)) return null;
      filter[key] = value;
    } else if (key === "kinds") {
      if (!isNumberArray(value)) return null;
      filter.kinds = value;
    } else if (key === "since" || key === "until" || key === "limit") {
      if (typeof value !== "number") return null;
      filter[key] = value;
    } else if (key.length === 2 && key[0] === "#") {
      if (!isStringArray(value)) return null;
      filter[key as `#${string}`] = value;
    }
    // Unknown keys are ignored per NIP-01 forward-compatibility.
  }
  return filter;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((v) => typeof v === "number");
}
