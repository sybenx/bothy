import { tagFilterEntries, type Filter } from "./nostr";

// Read-abuse caps (CLAUDE.md "Threat model": "Reads are public by
// design... anyone can burn the daily 5M rows-read and 100k DO requests
// without touching ownership at all"). These are the structural
// mitigations; per-IP throttling is enforced separately in relay.ts
// since it needs connection-level state these pure functions don't have.

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
