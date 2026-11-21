import { REQ_CACHE_MAX_EVENTS } from "./limits";
import type { NostrEvent } from "./nostr";

// ---------------------------------------------------------------------
// The answers to REQ queries, kept in memory until the data they were
// read from changes.
//
// It exists for clients that reconnect every few seconds and re-send the
// same REQs against data that rarely changes: measured on 2026-10-09,
// that traffic was 99.4% of rows read and projected past the 5M/day
// ceiling. A hit costs zero rows read. Refusing such a client would be
// wrong; it is only holding a tab open.
//
// Module state, not instance state: a field on the Relay object is lost
// on every wake from hibernation, while module memory lives as long as
// the isolate, across many wakes. There is one Durable Object per
// deployment, so one database for this state to describe.
//
// What can make an entry wrong, and what handles each:
//   - A write to `events` or `event_tags`, the only two tables REQ SQL
//     reads. read-metrics.ts instrumentSql clears the cache on any write
//     statement naming either, so no path has to remember to; and
//     storage.ts insertEventRow/deleteEventRow clear it again explicitly
//     for callers (tests) holding an un-instrumented handle.
//   - The clock, through NIP-40 `expiration`, which the SQL compares
//     against `nowSec`. Each entry carries the earliest expiration among
//     the events it holds and stops being a hit when that passes. An
//     event that had already expired when the entry was read is not in
//     it and never comes back, so the comparison only runs one way.
//   - Who is asking. Not a hazard: every read-gate decision (partition,
//     the gift wrap and invite exclusions, the group id list, the chat
//     horizon) is already in the SQL text or its parameters, so the owner
//     and an anonymous client can never be handed each other's entry.
//   - Storage changing without passing the wrapper at all: the test
//     harness's reset(), and a raw ctx.storage.sql in a fixture. Both are
//     test-only; test/helpers/isolate.ts clears the cache on reset.
// ---------------------------------------------------------------------

interface Entry {
  events: readonly NostrEvent[];
  minExpiration: number | null;
}

// A Map iterates in insertion order, and a hit re-inserts its entry, so
// the first key is always the least recently used.
const entries = new Map<string, Entry>();
let cachedEvents = 0;
const stats = { hits: 0, misses: 0, clears: 0 };

// params[0] is `nowSec`, the expiration guard filters.ts buildFilterQuery
// puts first on every query. Expiry is handled by minExpiration, so it is
// left out of the key; otherwise no two REQs a second apart could share
// an entry.
export function reqCacheKey(sqlText: string, params: readonly unknown[]): string {
  return sqlText + "\u0000" + JSON.stringify(params.slice(1));
}

export function readReqCache(key: string, nowSec: number): NostrEvent[] | undefined {
  const entry = entries.get(key);
  if (entry === undefined || (entry.minExpiration !== null && entry.minExpiration <= nowSec)) {
    stats.misses++;
    return undefined;
  }
  entries.delete(key);
  entries.set(key, entry);
  stats.hits++;
  // A copy, so a caller sorting in place cannot reorder the entry. The
  // events themselves are frozen at insertion.
  return [...entry.events];
}

export function writeReqCache(
  key: string,
  events: NostrEvent[],
  minExpiration: number | null,
): void {
  if (events.length > REQ_CACHE_MAX_EVENTS) return;
  const previous = entries.get(key);
  if (previous !== undefined) {
    cachedEvents -= previous.events.length;
    entries.delete(key);
  }
  for (const event of events) Object.freeze(event);
  entries.set(key, { events, minExpiration });
  cachedEvents += events.length;
  for (const [oldest, entry] of entries) {
    if (cachedEvents <= REQ_CACHE_MAX_EVENTS) break;
    entries.delete(oldest);
    cachedEvents -= entry.events.length;
  }
}

export function clearReqCache(): void {
  if (entries.size === 0) return;
  entries.clear();
  cachedEvents = 0;
  stats.clears++;
}

export interface ReqCacheSnapshot {
  hits: number;
  misses: number;
  clears: number;
  entries: number;
  cachedEvents: number;
}

export function reqCacheSnapshot(): ReqCacheSnapshot {
  return { ...stats, entries: entries.size, cachedEvents };
}
