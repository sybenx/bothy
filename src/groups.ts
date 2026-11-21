import { dTagValue, type Filter, type NostrEvent } from "./nostr";

// The read side of NIP-29: which events are group events, which partition
// they land in, and which filters name a group. The write side is nip29.ts.
//
// An event belongs to a group when it carries an `h` tag naming one
// (nips/29.md: "Messages sent by users to a group must have an `h` tag with
// the group id"), whatever its kind. NIP-29 lets any kind be scoped to a
// group, so a kind-range test would miss an h-tagged kind 1 and diverge
// from the spec.
//
// `h` is a single-letter tag, so `event_tags` indexes it: `{"#h":[id]}`
// works through the ordinary filter path, and the read gate can tell a
// filter that names a group without touching storage.
export const GROUP_TAG = "h";

// The group every relay hosted before groups became rows in the `groups`
// table (schema.ts). schema.ts seeds a row for it so existing deployments
// keep their group. Otherwise it is an ordinary group: a new group gets
// whatever id kind-9007 create-group names, and an `h` tag naming an id
// with no row is a stranger's tag, not a group.
//
// It is still the DEFAULT `groupId` of storage.ts addGroupMember,
// removeGroupMember, isGroupMember and listGroupMembers, so any caller that
// passes no id is talking about `_` only. Callers that pass none include
// nip29.ts authorizeGroupWrite's member check, nip29.ts handleJoinRequest,
// and index.ts's member-callable NIP-86 gate (via relay.ts isGroupMember).
export const TOP_LEVEL_GROUP_ID = "_";

// The relay-generated group state range (nips/29.md "Group metadata
// events"): 39000 metadata, 39001 admins, 39002 members, 39003 roles,
// 39004 livekit participants, 39005 pinned events.
//
// These name their group in a `d` tag "instead of the `h` tag", so the `h`
// rule above does not see them; without this test the kind-39002 member
// list would land in the public partition and be served to anyone.
//
// Recognised by KIND, not by `d`: `d` is the identifier every addressable
// kind (30000-39999) carries, so it names a group only inside this range.
// The whole range is covered, not just the three bothy generates: nip29.ts
// refuses every kind in it from clients, so treating the rest as group
// state can only hide an event that should not exist. Which of these are
// publicly readable is decided separately (isPubliclyReadableGroupKind).
export function isGroupMetadataKind(kind: number): boolean {
  return kind >= 39000 && kind <= 39005;
}

// The three this relay generates and signs (nip29.ts). NIP-29: these are
// "addressable events signed by the relay keypair directly, with the group
// id as the `d` tag."
export const GROUP_METADATA_KIND = 39000;
export const GROUP_ADMINS_KIND = 39001;
export const GROUP_MEMBERS_KIND = 39002;

// NIP-29's chat kind ("kind 9 is a chat message"), and the only kind in the
// group partition that expires (limits.ts CONVERSATION_IDLE_SECONDS and
// the block around it; storage.ts sweepChat).
//
// Declared here, not in push.ts (which re-exports it), because the read
// gate in filters.ts needs it and filters.ts -> push.ts -> limits.ts ->
// filters.ts would be an import cycle.
export const GROUP_CHAT_KIND = 9;

// NIP-29 kind-9009 create-invite: the one group event the group's own
// members may not read.
//
// Its `code` tag is an invite code, which is a bearer token (limits.ts,
// the invite block): reading one is as good as holding it, so a member who
// could read 9009s could mint memberships. Withheld from everyone but the
// owner on both read surfaces: filters.ts FilterQueryOptions.excludeInvites
// for stored reads, relay.ts broadcast() for live pushes.
//
// Withheld by OMISSION, never refusal. The only entitled reader is the
// owner, so refusing everyone else would add a new signal on the
// unauthenticated path, where `{"kinds":[9009]}` currently gets a plain
// EOSE. Omission answers that filter the same way whoever sends it.
//
// Declared here rather than in nip29.ts (which re-exports it) because the
// read gate needs it and filters.ts -> nip29.ts -> limits.ts -> filters.ts
// would be an import cycle.
export const CREATE_INVITE_KIND = 9009;

// Which partition of `events`/`event_tags` a row lives in, stored as
// `is_group`. EVERY QUERY MUST PIN IT: schema.ts INDEXES declares the
// REQ-serving indexes as partial pairs keyed on this column, and a query
// naming no partition can use neither half and scans the table (measured:
// 51,500 rows against 2 for the same lookup with the pin).
//
// Partial pairs rather than is_group as a leading key column: as a key
// column it changed the plan of queries that do not pin it (measured, the
// owner's {"#p":[owner],"kinds":[1059]} read went from 601 rows to 204,701,
// because SQLite abandoned the primary-key seek). Partial pairs leave the
// key columns untouched, and that read costs 567.
export const PUBLIC_SCOPE = 0;
export const GROUP_SCOPE = 1;
export type GroupScope = typeof PUBLIC_SCOPE | typeof GROUP_SCOPE;

// Both partitions, in the order a merged read wants them.
export const ALL_SCOPES: readonly GroupScope[] = [PUBLIC_SCOPE, GROUP_SCOPE];

// Runs a lookup once per partition and concatenates the results: the form
// every lookup that is not about one partition has to take, since a lookup
// naming neither value scans the table (see PUBLIC_SCOPE above, and the
// partition rule in storage.ts).
export function acrossScopes<T>(run: (scope: GroupScope) => T[]): T[] {
  return ALL_SCOPES.flatMap(run);
}

export function scopeOf(event: NostrEvent, hosts: (id: string) => boolean): GroupScope {
  return isGroupEvent(event, hosts) ? GROUP_SCOPE : PUBLIC_SCOPE;
}

// The partition test, and the whole group privacy rule:
//
//   A GROUP'S EXISTENCE IS PUBLIC. ITS MESSAGES AND ITS MEMBER LIST ARE NOT.
//
// So the group partition means "reading this needs a membership check".
// Kind 39000 (name, picture) and kind 39001 (admins: always the owner,
// whose pubkey NIP-11 already publishes) disclose nothing a stranger may
// not have, and live in the PUBLIC partition. Kind 39002 and every
// `h`-tagged event live in the group partition.
//
// Expressed as which partition a row lands in, not as an exception in the
// read gate: a gate exception would have to be repeated on every read
// surface (REQ, broadcast, the live feed, the public counters) and could
// drift on one of them. A partition is decided once, at write time, and
// `{"kinds":[39000]}` from an unauthenticated client is answered by the
// ordinary public path -- which is what a NIP-29 client listing a relay's
// groups sends.
//
// The event must name a group this relay hosts. An `h` tag naming another
// relay's group (backfill fetches the owner's history from wherever it was
// published) is not ours to gate, and filing it in the group partition
// would hide it behind an unrelated member list.
export function isGroupEvent(event: NostrEvent, hosts: (id: string) => boolean): boolean {
  if (isPubliclyReadableGroupKind(event.kind)) return false;
  const id = groupIdOf(event);
  return id !== null && hosts(id);
}

// The group state that is public: metadata and admins, never members. One
// predicate so the write side (partitioning) and the read side (what a
// filter may see) cannot disagree.
export function isPubliclyReadableGroupKind(kind: number): boolean {
  return kind === GROUP_METADATA_KIND || kind === GROUP_ADMINS_KIND;
}

// Does this event carry a group tag at all, whatever id it names, hosted
// or not? Two callers want this looser test rather than isGroupEvent,
// because neither is asking "is this ours to gate":
//
//   - nip29.ts authorizeGroupWrite's early exit, so an event tagged into
//     an id this relay does not host still reaches the member check
//     instead of bypassing it as an ordinary write.
//   - relay.ts handleGiftWrap's refusal: a gift wrap is addressed by `p`
//     to one recipient, so a group tag on one means nothing whichever id
//     it names, and a foreign id should not pass where a local one is
//     refused.
export function isAnyGroupEvent(event: NostrEvent): boolean {
  return isGroupMetadataKind(event.kind) || groupIdOf(event) !== null;
}

// The group an event is addressed to, or null. An empty `h` value names no
// group; counting it would let an author hide an event from public reads
// by tagging it with nothing.
export function groupIdOf(event: NostrEvent): string | null {
  // The relay-generated range names its group in `d`, never in `h` (see
  // isGroupMetadataKind). An empty `d` names nothing, as an empty `h` does.
  if (isGroupMetadataKind(event.kind)) {
    const d = dTagValue(event.tags);
    return d === "" ? null : d;
  }
  for (const tag of event.tags) {
    if (tag[0] === GROUP_TAG && tag[1] !== undefined && tag[1] !== "") return tag[1];
  }
  return null;
}

// Whether a REQ filter NAMES a group the reader may not read, which decides
// refusal versus omission on the read gate (relay.ts handleReqInner).
//
// A filter that names a group has already said what it wants, so refusing
// it ("authenticate first") reveals nothing. A filter that does not name a
// group is answered normally with group rows omitted; refusing it instead
// would make the refusal itself reveal whether group rows matched, which
// is the leak the gift wrap gate had when it decided by probing storage.
//
// `kinds` naming kind 39002 also counts as naming a group, as naming 1059
// does for the gift wrap gate. A filter naming only `#d` does NOT: `d`
// identifies every addressable event, so refusing on it would refuse
// unrelated reads. That filter is answered by omission, which gives the
// same answer whether or not the group holds anything.
export function filterNamesGroup(filter: Filter, readable?: readonly string[]): boolean {
  const values = filter[`#${GROUP_TAG}`];
  if (Array.isArray(values) && values.length > 0) {
    // Refuse only if it names a group outside the reader's list: a member
    // of A asking for `#h: [A]` is the ordinary case.
    //
    // `undefined` means UNRESTRICTED (the owner), with the same meaning as
    // filters.ts FilterQueryOptions.groupIds. The two must agree -- this
    // decides whether to refuse, that decides what the query returns -- or
    // the owner would be refused their own groups. An empty array is the
    // unauthenticated case and refuses every named group.
    if (readable === undefined) return false;
    return values.some((v) => !readable.includes(v));
  }
  // Only the gated part of the 39000-series counts. 39000/39001 are public,
  // and `{"kinds":[39000]}` is how a client discovers what groups exist,
  // which must not need an account.
  const namesGatedState =
    filter.kinds?.some((k) => isGroupMetadataKind(k) && !isPubliclyReadableGroupKind(k)) ?? false;
  if (!namesGatedState) return false;
  // A kind names no particular group, so the only question is whether the
  // reader may see any group. A member asking for 39002 is entitled to their
  // own groups' member lists, and the query's group scoping limits them to
  // those; refusing here would lock members out of their own membership.
  return readable !== undefined && readable.length === 0;
}
