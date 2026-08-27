import { type Filter, type NostrEvent, tagFilterEntries } from "./nostr";

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
    conditions.push(
      `id IN (SELECT event_id FROM event_tags WHERE tag_name = ? AND tag_value IN (${placeholders(values.length)}))`,
    );
    params.push(letter, ...values);
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
