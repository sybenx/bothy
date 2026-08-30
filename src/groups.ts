import { dTagValue, type Filter, type NostrEvent } from "./nostr";

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

// The one group this relay hosts, and its id.
//
// NIP-29 has no notion of creating a group -- "what happens is just that
// relays (most likely when asked by users) will create rules around some
// specific ids" -- so a relay with exactly one group needs no id
// negotiation and no kind-9007 create-group event: the id is a constant,
// and the rules around it are this file plus src/nip29.ts. `_` is the
// convention other NIP-29 relays use for a relay's own top-level group,
// and it is chosen here for the same reason bothy has one owner: a
// single-user relay hosting a single group needs no namespace.
//
// Enforced at two different points, on purpose, in two different ways:
//
//   - The WRITE GATE (nip29.ts authorizeGroupWrite) is id-agnostic on
//     ordinary group traffic: an `h` tag naming some OTHER id still marks
//     its event as needing the one member list's say-so (isAnyGroupEvent
//     below), because refusing an unrecognised id at the gate would mean
//     deciding what a group IS at write time rather than at the partition
//     -- and because the alternative is a bypass, a client dodging the
//     member check by tagging `h` with anything other than `_`. Moderation
//     events ARE checked against this id specifically, because the id
//     there selects what gets mutated and there is exactly one thing it
//     can select.
//   - The PARTITION (isGroupEvent below) is not id-agnostic. An event
//     carrying an `h` tag that names some OTHER relay's group -- reached
//     here because backfill fetched it as part of the OWNER's own
//     authored history, published elsewhere, not written to this relay at
//     all -- is not this relay's group and must not be filed in it: doing
//     so made it unreadable to anyone who is not a member of the one group
//     this relay actually hosts, which is a stranger's private content
//     gated behind a membership list that has nothing to do with it.
export const TOP_LEVEL_GROUP_ID = "_";

// The relay-generated group state events (nips/29.md "Group metadata
// events"): 39000 metadata, 39001 admins, 39002 members, and the 39003
// roles / 39004 livekit participants / 39005 pinned events beside them.
//
// These are the exception to "an event belongs to a group when it carries
// an `h` tag", and the exception has teeth: NIP-29 says they "contain the
// group id in a `d` tag instead of the `h` tag", so the `h` rule above
// sees nothing at all in a kind-39001 admin list or a kind-39002 member
// list -- the two events that ARE the group's membership, written out in
// `p` tags. Before this range was recognised here they were stored in the
// PUBLIC partition and served to any unauthenticated client that asked
// for them: the group's exclusion covered every event in the group except
// the list of who is in it.
//
// Recognised by KIND rather than by the `d` tag, and over the whole
// 39000-39005 range rather than only the three bothy generates. `d` is
// the generic addressable identifier every kind in the 30000-39999 range
// carries, so it names a group only in this range and cannot be the test;
// and a kind in this range that bothy does not generate is one no client
// may write either (nip29.ts refuses them), so treating it as group state
// hides an event that should not exist rather than exposing one.
export function isGroupMetadataKind(kind: number): boolean {
  return kind >= 39000 && kind <= 39005;
}

// The three this relay actually generates and signs (src/nip29.ts). NIP-29:
// "Relays are supposed to generate the events that describe group metadata
// and group admins. These are addressable events signed by the relay
// keypair directly, with the group id as the `d` tag."
export const GROUP_METADATA_KIND = 39000;
export const GROUP_ADMINS_KIND = 39001;
export const GROUP_MEMBERS_KIND = 39002;

// NIP-29 kind-9009 create-invite: the one group event the group's own
// MEMBERS may not read.
//
// A kind-9009 carries the invite code it mints in a `code` tag, and an
// invite code is a BEARER TOKEN -- this relay cannot authenticate who
// presents one, which is the whole point of it (limits.ts, the invite
// block). Reading a code is therefore as good as being handed it, so a
// member who could read the group's 9009s could mint memberships at will
// and owner-only invites would stop being owner-only without one line of
// the write path changing. Withheld from everyone but the owner, on both
// read surfaces: filters.ts FilterQueryOptions.excludeInvites for stored
// reads, relay.ts broadcast() for the push.
//
// Withheld by OMISSION and never by refusal, which is where it differs
// from the group partition around it. A filter naming the group is
// refused because the client has already said what it wants; a filter
// naming kind 9009 gets no such treatment, because the only reader
// entitled to one is the owner and refusing everyone else would put a
// new signal on the UNAUTHENTICATED path, where `{"kinds":[9009]}` is
// answered with a plain EOSE today. Omission answers that filter the
// same way whoever sends it.
//
// Named here rather than beside the other moderation kinds in nip29.ts
// because the READ gate is what needs it, and nip29.ts is not reachable
// from the read gate: filters.ts builds the exclusion, and
// filters.ts -> nip29.ts -> limits.ts -> filters.ts is a cycle. groups.ts
// is the read side of NIP-29 (nip29.ts says so in its own header), so a
// kind the read gate has to recognise belongs here; nip29.ts re-exports
// it so the write side still names it from one place.
export const CREATE_INVITE_KIND = 9009;

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

// The partition test: whether an event is IN THIS RELAY'S OWN group, not
// whether it merely looks like group traffic of some kind. One rule,
// keyed to TOP_LEVEL_GROUP_ID, for every kind including the relay-
// generated metadata range: an event counts only when groupIdOf reports
// exactly this relay's own id.
//
// This used to special-case the metadata range, treating a MISSING or
// empty `d` as group state too -- the reasoning being that the safe
// reading of a malformed member/admin list is "hide it", not "here is a
// public event." That reasoning was right for a reader deciding what to
// disclose and wrong for the PARTITION: a malformed-or-foreign 39000-series
// event and this relay's own genuine one are otherwise identical in shape
// (same kind, same read gate), so leaving either of them classified as
// "ours" put two candidate kind-39002 member lists in the one partition a
// bare `{"kinds":[39002]}` reads, with no way for a client to tell which
// one is real. storage.ts storeEvent is what actually closes that: a
// metadata-kind event only reaches insertEventRow (and therefore this
// function) if it was signed by THIS RELAY'S OWN identity, which always
// stamps `d` as TOP_LEVEL_GROUP_ID correctly -- so a stored metadata event
// is guaranteed well-formed, and there is no remaining malformed case for
// this function to special-case. See storeEvent's own comment for why the
// check belongs there (by SIGNER) and not here (by `d` tag): a forged `d`
// that merely reads TOP_LEVEL_GROUP_ID would defeat a check made here.
//
// NARROWER than "carries a group tag of some kind" -- see isAnyGroupEvent
// below for that test, which two callers still need. This one backs the
// PARTITION (storage.ts scopeOf, and the broadcast()/liveBroadcast()
// mirrors of the REQ-time read gate), and an unauthenticated read is
// measured against the partition: an event this relay did not host the
// group for must land in the public partition, or a member of this
// relay's one group ends up the only reader who can ever see somebody
// else's.
export function isGroupEvent(event: NostrEvent): boolean {
  return groupIdOf(event) === TOP_LEVEL_GROUP_ID;
}

// The loose test isGroupEvent used to BE, before it was scoped to this
// relay's own group: does this event carry a group tag at all, whatever
// id it names? Two callers still need exactly that shape, and neither of
// them is asking "is this ours to gate" -- unlike scopeOf and the
// broadcast mirrors, which are:
//
//   - nip29.ts authorizeGroupWrite's early exit, so an event tagged into
//     some OTHER id still reaches the one member list rather than sailing
//     through as an ordinary write. The write gate's bypass concern (see
//     TOP_LEVEL_GROUP_ID above) is about ANY foreign id, not only this
//     relay's own.
//   - relay.ts handleGiftWrap's refusal: a gift wrap addressed by `p` tag
//     to one recipient and ALSO carrying a group tag is not a thing that
//     means anything, whichever id that tag names -- the wrap's own
//     addressing rule already contradicts it, so there is no reason to
//     let a foreign id through where a local one would be refused.
export function isAnyGroupEvent(event: NostrEvent): boolean {
  return isGroupMetadataKind(event.kind) || groupIdOf(event) !== null;
}

// The group an event is addressed to, or null. Empty `h` values do not
// count: an `["h"]` or `["h", ""]` tag names no group, and treating it as
// one would let an author hide an event from public reads by tagging it
// with nothing.
export function groupIdOf(event: NostrEvent): string | null {
  // The relay-generated range names its group in `d`, never in `h` --
  // see isGroupMetadataKind above. An empty `d` names nothing here for
  // the same reason an empty `h` does below; isGroupEvent still counts
  // the event as group state on the strength of its kind alone.
  if (isGroupMetadataKind(event.kind)) {
    const d = dTagValue(event.tags);
    return d === "" ? null : d;
  }
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
// `kinds` counts as naming a group too, on the same terms `kinds`
// counts for the gift wrap gate: a filter asking for kind 39002 has
// asked for this group's member list in as many words, so being told to
// authenticate tells it nothing it did not already say. A filter naming
// only `#d` does NOT count -- `d` identifies every addressable event
// there is, so refusing on it would refuse reads of unrelated kinds that
// happen to share an identifier. That filter is answered by omission
// instead, which is the safe direction: omission returns the same answer
// whether or not the group holds anything.
export function filterNamesGroup(filter: Filter): boolean {
  const values = filter[`#${GROUP_TAG}`];
  if (Array.isArray(values) && values.length > 0) return true;
  return filter.kinds?.some(isGroupMetadataKind) ?? false;
}
