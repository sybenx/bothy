import { type Filter, type NostrEvent, tagFilterEntries } from "./nostr";

// How many tag rows one `#<letter>` condition is allowed to look at, per
// event the client asked for.
//
// A tag condition is resolved as `id IN (SELECT event_id FROM event_tags
// WHERE ...)`, and until v0.7.7 that subquery was bounded by nothing at
// all: it read every row carrying a named tag value, whatever the
// filter's `limit`. Measured at E=1,000 with every event p-tagging the
// owner, `{"#p":[owner],"limit":20}` read 4,000 rows -- and 4,000 again
// at `limit: 1`. Flat in the limit, linear in the table. That made
// limits.ts boundFilter structurally inert on the shape: halving a limit
// that the cost does not depend on can neither clamp the filter nor ever
// refuse it, so the one filter shape the read guard could not price was
// also the one NIP-17 clients send on every connect (relay.ts
// handleGiftWrap requires every gift wrap to p-tag the owner, which by
// construction makes `#p:<owner>` the highest-cardinality tag value in
// the table).
//
// Bounding the subquery is what makes the cost model in limits.ts true
// rather than aspirational: `ORDER BY created_at DESC LIMIT n` against
// idx_event_tags_lookup (tag_name, tag_value, created_at) streams the
// index in the order the outer query already wants and stops, so the
// cost becomes 4 x n and falls with the limit like every other admitted
// shape. Measured, same fixture: 400 rows at `limit: 20`, 4 at
// `limit: 1`.
//
// The depth is DERIVED, not chosen: at MAX_FILTER_LIMIT a single-value
// tag filter should cost exactly the per-filter ceiling and no more, so
//
//   TAG_SCAN_DEPTH = MAX_FILTER_ROWS_READ / (TAG_ROWS_READ_PER_MATCH x MAX_FILTER_LIMIT)
//                  = 10,000 / (4 x 500) = 5
//
// It lives here rather than in limits.ts with the other caps only because
// limits.ts already imports this module; test/read-cost.test.ts asserts
// the identity above against those three constants so the number cannot
// go stale when one of them moves.
//
// What this trades away, stated plainly: completeness in one page. The
// subquery returns the newest TAG_SCAN_DEPTH x limit tag rows, and any
// other condition in the filter -- `kinds` most of all -- then narrows
// what survives, so a client can be handed fewer events than it asked
// for even though more exist. NIP-01 makes `limit` a maximum rather than
// a quota (nips/01.md), so a short page is legal; what makes it workable
// is the `since`/`until` pushdown below, which slides the window, so a
// client paginating with `until` still walks the whole history, just in
// smaller steps. The assumption underneath is density: a `#p:<owner>`
// filter for kind 1059 is short-paged in proportion to how few of the
// owner's p-tagged events are gift wraps, and on a personal relay whose
// non-owner write traffic is mostly gift wraps that ratio is high. If it
// ever is not, this constant is the dial -- and paying for it means
// paying rows read, which is the ceiling that took this relay down.
export const TAG_SCAN_DEPTH = 5;

export function tagScanLimit(limit: number): number {
  return limit * TAG_SCAN_DEPTH;
}

// Turns one REQ filter into a SQL query against the frozen schema
// (schema.ts). Every query also excludes events whose `expiration` has
// passed -- NIP-40 "SHOULD NOT send expired events to clients, even if
// they are stored" (nips/40.md line 46).
//
// `#<letter>` conditions go through the `event_tags` index; ids/authors/
// kinds go through equality/membership on `events` directly. No prefix
// matching for ids/authors -- NIP-01 only says relays MAY support it, and
// this suite doesn't require it (see docs/test-notes.md).
export function buildFilterQuery(
  filter: Filter,
  nowSec: number,
): { sql: string; params: unknown[] } | null {
  const conditions: string[] = ["(expiration IS NULL OR expiration > ?)"];
  const params: unknown[] = [nowSec];

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
  if (filter.since !== undefined) {
    conditions.push("created_at >= ?");
    params.push(filter.since);
  }
  if (filter.until !== undefined) {
    conditions.push("created_at <= ?");
    params.push(filter.until);
  }
  for (const [letter, values] of tagFilterEntries(filter)) {
    if (values.length === 0) return null;
    const subConditions = [`tag_name = ? AND tag_value IN (${placeholders(values.length)})`];
    const subParams: unknown[] = [letter, ...values];
    // `since`/`until` are pushed down into the subquery, not left to the
    // outer query. `event_tags.created_at` IS the event's own created_at
    // (storage.ts insertEventRow copies it), so this is the same bound
    // expressed against the index that serves the lookup -- it narrows
    // the range scanned rather than discarding rows after they have been
    // read, and it is what makes `until` pagination work underneath the
    // LIMIT below.
    if (filter.since !== undefined) {
      subConditions.push("created_at >= ?");
      subParams.push(filter.since);
    }
    if (filter.until !== undefined) {
      subConditions.push("created_at <= ?");
      subParams.push(filter.until);
    }
    let subquery = `SELECT event_id FROM event_tags WHERE ${subConditions.join(" AND ")}`;
    if (filter.limit !== undefined) {
      subquery += " ORDER BY created_at DESC LIMIT ?";
      subParams.push(tagScanLimit(filter.limit));
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

// Splits one filter into the cross-product of its `authors` x `kinds`
// singletons, so every query that reaches SQLite pins each index key
// column to ONE value.
//
// This is what turns limits.ts filterReadCost from an assertion into a
// fact. An index can serve `ORDER BY created_at DESC LIMIT n` cheaply
// only when the key columns ahead of `created_at` are pinned to a single
// value each; `kind IN (1, 7)` pins nothing, so SQLite reads every
// matching row and sorts it before LIMIT can discard any. Measured at
// E=2,000 (test/read-cost.test.ts):
//
//   {"kinds":[1,7],"limit":20}            one query   3,983 rows
//                                         split           82 rows
//   {"authors":[owner],"kinds":[1,7]}     one query   3,584 rows
//                                         split           42 rows
//
// Two queries at 41 rows each beat one query at 3,983, and the gap
// widens linearly with the table. Splitting is also what makes the cost
// PREDICTABLE rather than left to the query planner: measuring the
// unsplit forms across candidate index sets produced answers that swung
// between 41 and 3,584 for the same filter depending on which index
// SQLite happened to choose. The split form costs
// authors x kinds x (2 x limit) whichever index it picks.
//
// Only `authors` and `kinds` are expanded. `ids` is a primary-key seek
// that needs no ordering at all and already costs one row per id, and a
// `#<letter>` filter is resolved by a subquery against
// idx_event_tags_lookup rather than by the ordered scan -- neither is
// made cheaper by splitting, and both would multiply the query count for
// nothing.
//
// Callers must re-merge: each sub-filter returns up to `limit` events of
// its own, so the union can exceed what the client asked for. storage.ts
// queryFilter dedupes, re-sorts and slices back to `limit`, which is what
// keeps this an implementation detail rather than a protocol change --
// NIP-01's `limit` is "the maximum number of events relays SHOULD return
// in the initial query" (nips/01.md), and the split result set is
// identical to the unsplit one.
// How many queries expandFilter would produce, without producing them.
//
// limits.ts filterReadCost needs this count on every REQ filter from
// every client, BEFORE anything has decided the filter is affordable, and
// `authors` arrives off the wire uncapped (parseFilter does not bound it).
// Materialising a ten-thousand-element cross-product to discover that it
// is too expensive to run would be a cheap denial of service against the
// guard that exists to prevent one. test/read-cost.test.ts asserts this
// agrees with expandFilter, so the two cannot drift.
export function expandFilterCount(filter: Filter): number {
  return Math.max(1, filter.authors?.length ?? 1) * Math.max(1, filter.kinds?.length ?? 1);
}

export function expandFilter(filter: Filter): Filter[] {
  const authors = filter.authors;
  const kinds = filter.kinds;
  // The common case by a wide margin -- nothing to expand, and the
  // caller skips its merge entirely.
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

// Newest first, ties broken by lowest id -- the ordering
// buildFilterQuery's `ORDER BY created_at DESC, id ASC` produces, stated
// once here because both queryFilter (re-merging a split filter) and
// queryFilters (ORing several filters) have to reproduce it exactly.
export function compareEvents(a: NostrEvent, b: NostrEvent): number {
  if (a.created_at !== b.created_at) return b.created_at - a.created_at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// In-memory equivalent of buildFilterQuery, used to test a single
// freshly-stored event against a live subscription's filters without a
// round trip through SQL.
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

// Loose parse of a REQ filter object off the wire -- narrows to the
// shape buildFilterQuery/matchesFilter expect without pulling in a full
// schema validator for a single-user relay's own subscriptions.
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
