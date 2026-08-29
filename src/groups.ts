import type { Filter, NostrEvent } from "./nostr";

// NIP-29 group membership, as this relay decides it: an event belongs to a
// group when it carries an `h` tag naming one (nips/29.md, "Messages sent
// by users to a group must have an `h` tag with the group id").
//
// KIND-AGNOSTIC, deliberately. NIP-29 puts no ceiling on what a group may
// carry -- a chat message, a reaction, a long-form post, a picture event,
// anything a client wants to scope to the group gets an `h` tag and is a
// group event. Deciding group membership from a kind range instead would
// have made the exclusion below free on every kind-pinned filter (measured:
// `{"kinds":[1],"limit":20}` never touches a group row when the kinds are
// disjoint), and it would have been a subset of NIP-29 rather than NIP-29 --
// a divergence to document, and a trap the first time a client sent an
// h-tagged kind 1.
//
// `h` is a single-letter tag, so `event_tags` already indexes it and a
// member can ask for a group's events with `{"#h":["<group id>"]}` through
// the ordinary filter path. That is also what makes the read gate in
// relay.ts able to recognise a filter that NAMES a group without inspecting
// storage.
export const GROUP_TAG = "h";

// Which partition of `events`/`event_tags` a row lives in. Stored as
// `is_group`, and PINNED BY EVERY QUERY -- see schema.ts INDEXES, where the
// three REQ-serving indexes are partial pairs keyed on this column. A query
// that names no partition can use neither half of a pair and scans the
// table instead: measured at 51,500 rows against 2 for the same lookup with
// the pin. Carrying is_group as a leading KEY column instead of a partial
// pair would have made this cheap at the cost of every query that does not
// pin it -- measured, the owner's own authenticated {"#p":[owner],
// "kinds":[1059]} read went from 601 rows to 204,701 with is_group in the
// key, because SQLite abandoned the primary-key seek for a partition scan.
// A partial pair leaves the key columns untouched, so that same read costs
// 567: a query pinning the partition gets the plan it had before the
// column existed, and a query pinning the other one gets the mirror image.
export const PUBLIC_SCOPE = 0;
export const GROUP_SCOPE = 1;
export type GroupScope = typeof PUBLIC_SCOPE | typeof GROUP_SCOPE;

// Both partitions, in the order a merged read wants them. Every internal
// query that is not about one partition in particular iterates this.
export const ALL_SCOPES: readonly GroupScope[] = [PUBLIC_SCOPE, GROUP_SCOPE];

// Runs a lookup once per partition and concatenates the results.
//
// Every query against `events`/`event_tags` has to name a partition --
// schema.ts declares the REQ-serving indexes as partial pairs keyed on
// `is_group`, and SQLite uses a partial index only for a query whose WHERE
// clause implies its predicate, so a lookup naming neither value scans the
// table. A lookup that is not about one partition in particular therefore
// runs twice. See the partition rule in storage.ts for the measurements.
export function acrossScopes<T>(run: (scope: GroupScope) => T[]): T[] {
  return ALL_SCOPES.flatMap(run);
}

export function scopeOf(event: NostrEvent): GroupScope {
  return isGroupEvent(event) ? GROUP_SCOPE : PUBLIC_SCOPE;
}

export function isGroupEvent(event: NostrEvent): boolean {
  return groupIdOf(event) !== null;
}

// The group an event is addressed to, or null. Empty `h` values do not
// count: an `["h"]` or `["h", ""]` tag names no group, and treating it as
// one would let an author hide an event from public reads by tagging it
// with nothing.
export function groupIdOf(event: NostrEvent): string | null {
  for (const tag of event.tags) {
    if (tag[0] === GROUP_TAG && tag[1] !== undefined && tag[1] !== "") return tag[1];
  }
  return null;
}

// Whether a REQ filter NAMES a group, which is what decides refusal versus
// omission on the read gate (relay.ts handleReqInner).
//
// The same split the gift wrap gate makes, for the same reason: a filter
// that says `{"#h":["<id>"]}` has already told the relay what it wants, so
// answering "authenticate first" tells it nothing it did not know. A filter
// that does not name a group is answered normally with the group's events
// omitted -- refusing THAT would make the refusal itself the answer, which
// is the leak the gift wrap storage probe turned out to be.
export function filterNamesGroup(filter: Filter): boolean {
  const values = filter[`#${GROUP_TAG}`];
  return Array.isArray(values) && values.length > 0;
}
