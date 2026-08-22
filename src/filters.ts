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
