// NIP-29 group writes (nips/29.md): the moderation events a client may
// send, the join requests a stranger may send, and the group state events
// this relay generates and signs in response. The READ side -- which
// partition an event lands in and who may see it -- is groups.ts and the
// gates in relay.ts.
//
// A group is a row in the `groups` table (schema.ts). The owner creates one
// with kind-9007 create-group naming a new id; `_` (groups.ts
// TOP_LEVEL_GROUP_ID) is seeded on every relay. The owner is sole admin of
// every group.
//
// Per-group scoping is incomplete on the write side: put-user, remove-user
// and state regeneration use the id the event names, but the ordinary
// member check in authorizeGroupWrite, the join path in handleJoinRequest,
// and invite creation all pass no group id and so act on `_` only (see
// groups.ts TOP_LEVEL_GROUP_ID).
//
// TWO NESTED LISTS. `allowed_pubkeys` is the outer one: relay-wide write
// access, consulted by ownership.ts isAllowedWriter for every event.
// `group_membership` is the inner one: permission to write an `h`-tagged
// event on top of that. A member needs both, so put-user and a redeemed
// join write both, and remove-user takes back only the outer row the group
// granted (`allowed_pubkeys.source = 'invite'`, schema.ts). A member missing
// from the outer list has their events refused with a message about follows
// that names no group; storage.ts auditMaintainedCounts checks the
// containment daily.
//
// THE RELAY'S OWN EVENTS bypass the GATE, never the BOOKKEEPING. A
// relay-signed 39000-series event never enters relay.ts handleEventInner
// (there is nobody to authorize), but it is stored through storage.ts
// storeEvent like every client write, so it pays the maintained counters,
// both hour buckets, `row_cost`, the `is_group` partition and the
// addressable-replacement rule. There must be no second insert path: a
// partial copy of storeEvent would silently miss budget accounting
// (test/nip29-groups.test.ts runs the daily counter audit over a relay
// whose only events are relay-generated).
import {
  acrossScopes,
  CREATE_INVITE_KIND,
  GROUP_ADMINS_KIND,
  GROUP_CHAT_KIND,
  GROUP_MEMBERS_KIND,
  GROUP_METADATA_KIND,
  GROUP_SCOPE,
  groupIdOf,
  isAnyGroupEvent,
  isGroupEvent,
  isGroupMetadataKind,
  TOP_LEVEL_GROUP_ID,
} from "./groups";
import {
  chatMode,
  groupsEnabled,
  INVITE_DEFAULT_TTL_SECONDS,
  INVITE_MAX_TTL_SECONDS,
  MAX_INVITE_CODE_LENGTH,
  MAX_OUTSTANDING_INVITES,
  MIN_INVITE_CODE_LENGTH,
} from "./limits";
import { type NostrEvent, pTagValues } from "./nostr";
import { getOwnerPubkey } from "./ownership";
import { signAsRelay, getRelayPubkey } from "./relay-identity";
import {
  groupHost,
  hostsGroup,
  invalidateHostedGroups,
  createGroup,
  addGroupMember,
  allowPubkeyForGroup,
  countOutstandingInvites,
  createInvite,
  expirationOf,
  isGroupMember,
  isPubkeyBanned,
  listGroupMembers,
  lookupInvite,
  readChatState,
  redeemInvite,
  removeGroupMember,
  revokeGroupAllowance,
  storeEvent,
} from "./storage";
import { computeEventId } from "./validate";

// The moderation kinds this relay implements (nips/29.md "Group state --
// or moderation"). All carry an `h` tag.
export const PUT_USER_KIND = 9000;
export const REMOVE_USER_KIND = 9001;
export const EDIT_METADATA_KIND = 9002;
// NIP-29 create-group: the ONLY moderation event that may name a group
// this relay does not host yet -- every other kind selects something that
// must already exist. Owner-only like the rest.
export const CREATE_GROUP_KIND = 9007;
// Declared in groups.ts (the read gate needs it); re-exported so the write
// side names it from one place.
export { CREATE_INVITE_KIND };

// kind-9021, the one NIP-29 event a NON-member sends. Not a moderation
// kind (that range stops at 9020) and never reaches authorizeGroupWrite --
// see handleJoinRequest.
export const JOIN_REQUEST_KIND = 9021;

// The answer to every group-scoped write and join request while GROUPS is
// not "on" (limits.ts groupsEnabled). Shared with relay.ts handleJoin and
// nip86.ts so all three say the same thing. It names no configuration: the
// person refused is not the operator.
export const GROUPS_PAUSED_MESSAGE = "restricted: groups are paused on this relay";

// NIP-29 reserves 9000-9020 for moderation. The unimplemented ones are
// REFUSED by name rather than stored as inert group notes: a kind-9005
// delete-event answered `["OK", id, true]` that deletes nothing tells the
// client its moderation action succeeded.
const MODERATION_KIND_MIN = 9000;
const MODERATION_KIND_MAX = 9020;

export function isModerationKind(kind: number): boolean {
  return kind >= MODERATION_KIND_MIN && kind <= MODERATION_KIND_MAX;
}

export function isSupportedModerationKind(kind: number): boolean {
  return (
    kind === CREATE_GROUP_KIND ||
    kind === PUT_USER_KIND ||
    kind === REMOVE_USER_KIND ||
    kind === EDIT_METADATA_KIND ||
    kind === CREATE_INVITE_KIND
  );
}

// The invite code on a kind-9009 create-invite or a kind-9021 join request;
// NIP-29 uses a `code` tag on both.
//
// `code` is a multi-character tag name, so `event_tags` never indexes it: a
// stored 9009 keeps its code in the event body, visible only to a reader of
// the group partition, and no tag filter can target it.
function codeTagValue(tags: string[][]): string | null {
  const value = tags.find((t) => t[0] === "code")?.[1];
  return value === undefined || value === "" ? null : value;
}

// When an invite created by this event stops working. There is no
// never-expiring invite (limits.ts INVITE_DEFAULT_TTL_SECONDS).
function inviteExpiry(event: NostrEvent, nowSec: number): number {
  return expirationOf(event) ?? nowSec + INVITE_DEFAULT_TTL_SECONDS;
}

// The owner's role in the generated kind-39001. NIP-29 leaves role names
// to the relay, and bothy has one. No kind-39003 roles event is generated:
// a single role every admin has and no moderation event can grant is not
// information a client can act on.
const OWNER_ROLE = "owner";

// The kind-39000 fields an operator sets via kind-9002 edit-metadata.
// Everything else on that event is a policy tag the relay states.
const METADATA_FIELDS = ["name", "picture", "banner", "about"] as const;

// The valueless kind-39000 tags. They describe what this relay enforces,
// not operator preferences, so they are always emitted and a 9002 cannot
// change them.
//
//   private     only members may read group messages: relay.ts
//               handleReqInner gates group reads on group membership.
//               Inside the partition, kind-9009 create-invite is owner-only
//               (groups.ts CREATE_INVITE_KIND).
//   restricted  only members may write: authorizeGroupWrite below.
//   hidden      NIP-29: relays should hide group metadata from non-members.
//               Only partly true: the kind-39002 member list is hidden, but
//               39000 and 39001 are served publicly (groups.ts
//               isPubliclyReadableGroupKind). test/nip29-groups.test.ts
//               asserts the tag is emitted.
//   closed      NIP-29: "If a group is `closed`, join requests are not
//               honored unless they include an invite code." Exactly what
//               handleJoinRequest does, so invite-only is `closed`, and
//               `open` would be false here.
const POLICY_TAGS = ["private", "restricted", "hidden", "closed"] as const;

export type GroupWriteAuthorization = { ok: true } | { ok: false; message: string };

// The group half of the write gate, called by relay.ts handleEventInner
// AFTER ownership.ts isAllowedWriter has admitted the pubkey to the relay.
// Under that gate, never beside it: the outer list says whether this pubkey
// may write here at all, this says whether it may write to the group.
//
// Cheapest first: a kind range check and a tag walk, with no storage
// access, dismiss every ordinary event.
//
// Three paths are dispatched by relay.ts before either gate, so this
// function never sees them, and each keeps the group partition safe on its
// own terms:
//
//   gift wrap    refused if it carries a group tag naming ANY id (relay.ts
//                handleGiftWrap, groups.ts isAnyGroupEvent). Storing one
//                would inject an unauthorized event that group members
//                then read; a group tag on a wrap addressed by `p` to one
//                recipient has no legitimate use.
//   vanish       stores no row for the request (relay.ts handleVanish). It
//                deletes only the signer's own rows, in both partitions,
//                which NIP-62 obliges this relay to honour.
//   join request stores no event (handleJoinRequest below). The only group
//                event a join produces is the relay's regenerated 39002.
export function authorizeGroupWrite(
  sql: SqlStorage,
  env: Env,
  event: NostrEvent,
  isOwner: boolean,
  nowSec: number,
): GroupWriteAuthorization {
  // isAnyGroupEvent, not the partition test: an event tagged into an id
  // this relay does not host must still reach the member check below, or
  // naming an unhosted id would bypass it.
  if (!isAnyGroupEvent(event) && !isModerationKind(event.kind)) return { ok: true };

  // NIP-29: these "MUST be created by the relay master key only... Relays
  // shouldn't accept these events if they're signed by anyone else."
  // Refused for every client, the owner included; the relay's own
  // regeneration does not come through here.
  //
  // AHEAD of the pause check: a forged 39000-series event is refused
  // whatever the configuration, and the pause message would wrongly imply
  // that unpausing lets it through. It also keeps the answer uniform across
  // the range -- isGroupEvent excludes 39000/39001 (groups.ts
  // isPubliclyReadableGroupKind), so with the pause check first a forged
  // 39000 and a forged 39002 would get different refusals.
  if (isGroupMetadataKind(event.kind)) {
    return {
      ok: false,
      message:
        `invalid: kind ${event.kind} is group state generated and signed by this relay itself, ` +
        `not accepted from clients`,
    };
  }

  // Paused (limits.ts groupsEnabled): nothing group-shaped is accepted from
  // anyone, the owner included, with one message for every shape since the
  // reason is configuration, not the event.
  //
  // isGroupEvent (a group this relay hosts), not isAnyGroupEvent: an event
  // tagged into an unhosted id is not this relay's group, so pausing says
  // nothing about it and it falls through to the member check.
  //
  // groupsEnabled short-circuits, so the hosted-group lookup (memoised
  // anyway, storage.ts hostsGroup) is reached only while paused.
  if (
    !groupsEnabled(env) &&
    (isGroupEvent(event, groupHost(sql)) || isModerationKind(event.kind))
  ) {
    return { ok: false, message: GROUPS_PAUSED_MESSAGE };
  }

  if (isModerationKind(event.kind)) {
    // The id selects what gets mutated, so it must name a hosted group.
    // Ordinary group traffic is not held to this (groups.ts isGroupEvent).
    // Create-group is the inverse: it must name a group NOT yet hosted.
    const targetGroup = groupIdOf(event);
    if (targetGroup === null) {
      return { ok: false, message: `invalid: a moderation event must carry an "h" tag naming a group` };
    }
    if (event.kind === CREATE_GROUP_KIND) {
      if (hostsGroup(sql, targetGroup)) {
        return { ok: false, message: `duplicate: this relay already hosts a group with id ${targetGroup}` };
      }
    } else if (!hostsGroup(sql, targetGroup)) {
      return { ok: false, message: `invalid: this relay hosts no group with id ${targetGroup}` };
    }
    // Sole admin. Checked before the supported-kind test so an unauthorized
    // caller learns nothing about which kinds are implemented.
    if (!isOwner) {
      return { ok: false, message: "restricted: only the relay owner can moderate this group" };
    }
    if (!isSupportedModerationKind(event.kind)) {
      return {
        ok: false,
        message:
          `invalid: kind ${event.kind} is not implemented -- this relay supports create-group ` +
          `(${CREATE_GROUP_KIND}), put-user (${PUT_USER_KIND}), remove-user (${REMOVE_USER_KIND}) ` +
          `and edit-metadata (${EDIT_METADATA_KIND})`,
      };
    }
    // The owner is a member by exemption, so a remove-user naming them could
    // never take effect. Refused rather than answered `true` and ignored,
    // as nip86.ts banpubkey refuses the owner's pubkey. Every moderation
    // event reaching here is the owner's, so event.pubkey is the owner.
    if (event.kind === REMOVE_USER_KIND && pTagValues(event.tags).includes(event.pubkey)) {
      return { ok: false, message: "invalid: the relay owner cannot be removed from their own group" };
    }
    if (event.kind === CREATE_INVITE_KIND) return authorizeCreateInvite(sql, event, nowSec);
    return { ok: true };
  }

  // A chat message whose conversation has already been swept.
  //
  // This stands in for a tombstone. Other removals write a `deleted_ids`
  // row so a sender cannot replay their signed copy; ephemeral chat does
  // not, because a row per deleted message would be a permanent record of
  // the conversation (storage.ts sweepChat). `swept_through` refuses the
  // replay of every swept message with one integer.
  //
  // Applies to the owner too, before the membership check, because it is
  // not an authorization question: accepting a message the next sweep
  // removes would tell the client it landed when it did not.
  //
  // One row read, chat kind only. Compared on `created_at` because that is
  // the clock the sweep's cutoff uses (and `ingested_at` does not exist yet
  // for an event being decided); different clocks would refuse messages the
  // sweep would keep.
  if (event.kind === GROUP_CHAT_KIND && chatMode(env) === "deleting") {
    const sweptThrough = readChatState(sql).sweptThrough;
    if (event.created_at <= sweptThrough) {
      return {
        ok: false,
        message:
          "invalid: that conversation is over -- this relay keeps group chat only for the " +
          "conversation it was part of",
      };
    }
  }

  // An ordinary `h`-tagged event: the inner list decides. The owner is
  // exempt (the relay does not defend against its owner), which also lets
  // the sole admin write to a group they were never put-user'd into.
  //
  // isGroupMember is called with no group id, so this checks membership of
  // `_`, not of the group the event names (groups.ts TOP_LEVEL_GROUP_ID).
  if (isOwner) return { ok: true };
  if (isGroupMember(sql, event.pubkey)) return { ok: true };
  return { ok: false, message: "restricted: only members of this relay's group can publish to it" };
}

// The limits a kind-9009 must satisfy before its invite row exists.
//
// Reached only from the moderation branch above, so the caller is already
// the owner; these are policy limits (limits.ts), not authorization.
// Refused rather than clamped: an invite silently given a different
// lifetime than requested is a link the client will describe wrongly.
//
// Two storage reads, at owner pace only.
function authorizeCreateInvite(
  sql: SqlStorage,
  event: NostrEvent,
  nowSec: number,
): GroupWriteAuthorization {
  const code = codeTagValue(event.tags);
  if (code === null) {
    return {
      ok: false,
      message: `invalid: a create-invite event must carry a ["code", "<code>"] tag naming the invite code`,
    };
  }
  if (code.length < MIN_INVITE_CODE_LENGTH || code.length > MAX_INVITE_CODE_LENGTH) {
    return {
      ok: false,
      message:
        `invalid: an invite code must be between ${MIN_INVITE_CODE_LENGTH} and ` +
        `${MAX_INVITE_CODE_LENGTH} characters -- it is a bearer token, so length is what makes it ` +
        `worth holding`,
    };
  }

  // A code this relay has ever issued is never reissued: reissuing would
  // give its original redeemer a second admission and overwrite
  // `redeemed_by`, the only record of who it let in.
  if (lookupInvite(sql, code) !== null) {
    return {
      ok: false,
      message:
        "invalid: this relay has already issued that invite code -- codes are single use and are never " +
        "reissued, so pick a new one",
    };
  }

  const expiration = expirationOf(event);
  if (expiration !== null) {
    if (expiration <= nowSec) {
      return { ok: false, message: "invalid: this invite's expiration tag is already in the past" };
    }
    if (expiration - nowSec > INVITE_MAX_TTL_SECONDS) {
      const maxDays = Math.floor(INVITE_MAX_TTL_SECONDS / 86_400);
      return {
        ok: false,
        message:
          `invalid: an invite may last at most ${maxDays} days -- set the expiration tag no further ` +
          `than that ahead, or omit it for the ${Math.floor(INVITE_DEFAULT_TTL_SECONDS / 86_400)}-day default`,
      };
    }
  }

  if (countOutstandingInvites(sql, nowSec) >= MAX_OUTSTANDING_INVITES) {
    return {
      ok: false,
      message:
        `blocked: this relay already has ${MAX_OUTSTANDING_INVITES} unused invites outstanding -- revoke ` +
        `some with the NIP-86 revokeinvite method, or let them expire`,
    };
  }

  return { ok: true };
}

// Applies a moderation event's side effects and regenerates whatever group
// state changed, returning the relay-signed events for the caller to
// broadcast.
//
// Called from relay.ts acceptEvent AFTER storeEvent, where a kind-5 reaches
// applyDeletion: the moderation event is part of the group's canonical
// history, so it is stored first and acted on second.
export function applyModeration(sql: SqlStorage, env: Env, event: NostrEvent, nowSec: number): NostrEvent[] {
  const owner = getOwnerPubkey(sql, env);
  // Unreachable (authorizeGroupWrite admitted only the owner). Returning
  // rather than throwing keeps a future caller from taking the object down.
  if (owner === null) return [];

  // Non-null here (authorizeGroupWrite refused a moderation event naming
  // no group); the fallback satisfies the type.
  const groupId = groupIdOf(event) ?? TOP_LEVEL_GROUP_ID;

  if (event.kind === CREATE_GROUP_KIND) {
    // The row first, so the state generated below is partitioned against a
    // `groups` table that includes this id; otherwise the new group's
    // 39002 would land in the public partition.
    createGroup(sql, groupId, nowSec);
  }

  if (event.kind === PUT_USER_KIND) {
    for (const pubkey of pTagValues(event.tags)) {
      // The owner is a member by exemption and already listed on the
      // generated 39002, and the outer gate never consults their
      // `allowed_pubkeys` row, so both rows would be dead weight.
      if (pubkey === owner) continue;
      addGroupMember(sql, pubkey, nowSec, groupId);
      // Both lists, together: a member without the outer row cannot write.
      allowPubkeyForGroup(sql, pubkey, "added to the group by a NIP-29 put-user event", nowSec);
    }
  } else if (event.kind === CREATE_INVITE_KIND) {
    // authorizeCreateInvite has already validated the code, so this cannot
    // fail; `?? ""` is for the type. createInvite records no group id, so
    // the row takes the column default `_` (schema.ts group_invites).
    createInvite(sql, codeTagValue(event.tags) ?? "", nowSec, inviteExpiry(event, nowSec));
  } else if (event.kind === REMOVE_USER_KIND) {
    for (const pubkey of pTagValues(event.tags)) {
      if (pubkey === owner) continue;
      removeGroupMember(sql, pubkey, groupId);
      // Only what the group granted: an `allowed_pubkeys` row the owner made
      // through NIP-86 allowpubkey survives (storage.ts
      // revokeGroupAllowance).
      revokeGroupAllowance(sql, pubkey);
    }
  }

  // Called even for a kind-9009, which changes nothing and so writes
  // nothing (three rows read): on a group whose owner has sent no other
  // moderation event yet, this is the call that first generates its state.
  return regenerateGroupState(sql, owner, event.kind === EDIT_METADATA_KIND ? event : null, nowSec, groupId);
}

// ---------------------------------------------------------------------
// NIP-29 join requests (kind 9021).
// ---------------------------------------------------------------------

export interface JoinResult {
  accepted: boolean;
  message: string;
  // The relay-signed state this join changed (in practice the regenerated
  // kind-39002), already stored, for the caller to broadcast. Empty on
  // every refusal and for an existing member.
  generated: NostrEvent[];
}

// THE ONE MESSAGE EVERY REFUSED JOIN GETS.
//
// Unknown, spent, expired and revoked must look identical on the wire:
// "spent" or "expired" confirms a code was real (and that this relay hosts
// a group somebody was invited to), and "unknown" confirms a guess was
// wrong, so distinct messages would be an oracle for testing guesses. The
// owner gets the real reason in a log line (`wrangler tail`) and through
// the NIP-86 invite methods.
//
// Not the bare "restricted:" of the write gate: "ask for a new link" is
// the right advice for all four reasons, which is what makes it safe.
//
// Timing is not levelled: a known code costs one more row read than an
// unknown one. An attacker able to measure that reliably over the network
// has better attacks available than a dummy read would stop.
export const JOIN_REFUSAL_MESSAGE =
  "restricted: this invite code was not accepted -- ask whoever invited you for a new link";

// The code as it appears in the owner's log: truncated, and escaped through
// JSON.stringify, because it is attacker-chosen text (unbounded text can
// bury nearby lines; a newline can forge one). Twelve characters is under
// limits.ts MIN_INVITE_CODE_LENGTH, so a prefix identifies an invite
// against the NIP-86 list without logging a live code in full.
function codeLabel(code: string | null): string {
  return code === null ? "(none)" : JSON.stringify(code.slice(0, 12));
}

// A kind-9021 join request: the only write path a pubkey with no prior
// relationship to this relay can use to gain one.
//
// DISPATCHED ABOVE THE RELAY-WIDE WRITE GATE (relay.ts handleEventInner):
// a joiner is by definition not yet in `allowed_pubkeys`, so isAllowedWriter
// would refuse them. The only authority is the invite code, a bearer token
// the owner minted -- which is what lets an invite link work for somebody
// whose npub does not exist until they click it, and why limits.ts bounds
// invites by lifetime, count, length and per-IP rate.
//
// NOTHING IS STORED. A kind-9021 carries an `h` tag, so storing it would put
// a stranger's event into the group partition through a path no group
// authorization gates. The regenerated kind-39002 is the record of the
// membership.
//
// relay.ts handleJoin verifies the signature BEFORE this runs, inverting
// cheapest-first on purpose; see the comment there.
//
// Membership is checked and written with no group id, so a join always
// lands in `_` whichever hosted group the request names, and redeemInvite
// does not compare the invite's group (groups.ts TOP_LEVEL_GROUP_ID).
//
// Redeeming writes the outer `allowed_pubkeys` row too, so an invite link
// grants relay-wide write access, not only access to one room. It is
// bounded by the ordinary writer caps and revoked by a kind-9001
// remove-user or NIP-86 `banpubkey`.
export function handleJoinRequest(
  sql: SqlStorage,
  env: Env,
  event: NostrEvent,
  nowSec: number,
): JoinResult {
  const refuse = (reason: string, code: string | null): JoinResult => {
    console.warn(
      `[nip29] join request refused: ${reason} pubkey=${event.pubkey} code=${codeLabel(code)}`,
    );
    return { accepted: false, message: JOIN_REFUSAL_MESSAGE, generated: [] };
  };

  // The request must name a group this relay hosts (memoised, no row read
  // in the common case). Refused with the uniform message: saying "wrong
  // group id" would tell a stranger which ids do exist.
  const groupId = groupIdOf(event);
  if (groupId === null || !hostsGroup(sql, groupId)) return refuse("not a group this relay hosts", null);
  const code = codeTagValue(event.tags);

  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return refuse("relay is unclaimed", code);

  // Already in? Then accept without touching any code. A retrying client or
  // a second device sends no code, and neither does the owner (a member by
  // exemption). Saying so is safe: the request is signed, so it tells the
  // signer only about themselves.
  //
  // BEFORE the no-code refusal, for correctness: the owner and existing
  // members hold no code, and refusing on that first would lock the owner
  // out of their own group. The cost is up to two row reads on a refused
  // uninvited join, which still gets the uniform message.
  if (event.pubkey === owner || isGroupMember(sql, event.pubkey)) {
    return { accepted: true, message: "already a member of this group", generated: [] };
  }

  // NIP-29: a `closed` group honours join requests only with an invite
  // code. There is no other admission path and no moderator queue to hold
  // an uninvited request in.
  if (code === null) return refuse("no invite code", null);

  // Before redeeming, so a banned pubkey does not burn a live invite. The
  // uniform message here too: confirming the ban tells the banned party to
  // come back under another key.
  if (isPubkeyBanned(sql, event.pubkey)) return refuse("pubkey is banned", code);

  const outcome = redeemInvite(sql, code, event.pubkey, nowSec);
  if (outcome !== "redeemed") return refuse(`invite code ${outcome}`, code);

  // Both nested lists, as put-user writes them (see this file's header).
  addGroupMember(sql, event.pubkey, nowSec);
  allowPubkeyForGroup(sql, event.pubkey, "joined the group with a NIP-29 invite code", nowSec);

  console.warn(`[nip29] join request accepted: pubkey=${event.pubkey} code=${codeLabel(code)}`);
  return {
    accepted: true,
    message: "",
    generated: regenerateGroupState(sql, owner, null, nowSec, groupId),
  };
}

interface StoredGroupState {
  created_at: number;
  tags: string[][];
  content: string;
}

// The relay's own three group state events for one group.
//
// Pinned to the relay's pubkey and run once per partition, so each half is
// an index seek (the partition rule in storage.ts). At most three rows.
//
// BOTH partitions, because 39000/39001 are public and 39002 is not
// (groups.ts isGroupEvent). Pinned to one partition, the lookup misses the
// others, and regenerateGroupState then rewrites them unchanged on every
// call: measured at 38 extra rows written per membership change
// (test/nip29-groups.test.ts).
function readGroupState(
  sql: SqlStorage,
  relayPubkey: string,
  groupId: string,
): Map<number, StoredGroupState> {
  const rows = acrossScopes((scope) =>
    sql
      .exec<{ kind: number; created_at: number; tags: string; content: string }>(
        `SELECT kind, created_at, tags, content FROM events
          WHERE pubkey = ? AND is_group = ? AND kind >= ? AND kind <= ?
            AND EXISTS (
              SELECT 1 FROM event_tags t
               WHERE t.event_id = events.id AND t.tag_name = 'd' AND t.tag_value = ?
            )`,
        relayPubkey,
        scope,
        GROUP_METADATA_KIND,
        GROUP_MEMBERS_KIND,
        groupId,
      )
      .toArray(),
  );
  return new Map(
    rows.map((row) => [
      row.kind,
      { created_at: row.created_at, tags: JSON.parse(row.tags) as string[][], content: row.content },
    ]),
  );
}

// Regenerates the three relay-signed events, writing only those whose
// content changed. A membership change touches neither the admin list nor
// the metadata, and rewriting them anyway would delete and re-insert two
// unchanged addressable events every time -- the same measure-before-writing
// rule ownership.ts refreshFollows applies to the follow cache.
function regenerateGroupState(
  sql: SqlStorage,
  owner: string,
  metadataSource: NostrEvent | null,
  nowSec: number,
  groupId: string,
): NostrEvent[] {
  const relayPubkey = getRelayPubkey(sql);
  const existing = readGroupState(sql, relayPubkey, groupId);
  const generated: NostrEvent[] = [];

  const emit = (kind: number, tags: string[][], content: string): void => {
    const prior = existing.get(kind);
    if (prior && prior.content === content && JSON.stringify(prior.tags) === JSON.stringify(tags)) return;
    // Strictly newer than what it replaces, not merely "now". For
    // addressable events storage.ts isSupersededBy breaks a created_at tie
    // by LOWEST id, so two changes in the same second would lose to the old
    // version about half the time -- silently, since storeEvent returns ok
    // with `stored: null`. A one-second step stays inside
    // limits.ts MAX_CREATED_AT_FUTURE_SECONDS for any plausible burst.
    const created_at = Math.max(nowSec, prior === undefined ? 0 : prior.created_at + 1);
    const event = signGroupState(sql, relayPubkey, kind, created_at, tags, content);
    // The client insert path, gate skipped (see this file's header).
    // storeEvent's addressable branch replaces the previous version.
    storeEvent(sql, event, nowSec);
    generated.push(event);
  };

  emit(
    GROUP_METADATA_KIND,
    metadataTags(metadataSource, existing.get(GROUP_METADATA_KIND), groupId),
    "",
  );
  emit(GROUP_ADMINS_KIND, [["d", groupId], ["p", owner, OWNER_ROLE]], "");
  emit(
    GROUP_MEMBERS_KIND,
    [
      ["d", groupId],
      // The admin first, as in NIP-29's example; listed explicitly because
      // the owner is a member by exemption, not by row.
      ["p", owner],
      ...listGroupMembers(sql, groupId).map((pubkey) => ["p", pubkey]),
    ],
    "",
  );

  return generated;
}

// The kind-39000 tags: the operator's fields, then the policy tags.
//
// `source` is the triggering kind-9002, if any. Otherwise the previous
// document's fields are carried forward, so an unrelated regeneration
// cannot blank the group's name; with neither, only the policy tags.
function metadataTags(
  source: NostrEvent | null,
  prior: StoredGroupState | undefined,
  groupId: string,
): string[][] {
  const from = source?.tags ?? prior?.tags ?? [];
  const tags: string[][] = [["d", groupId]];
  for (const field of METADATA_FIELDS) {
    const value = from.find((tag) => tag[0] === field)?.[1];
    if (value !== undefined && value !== "") tags.push([field, value]);
  }
  for (const policy of POLICY_TAGS) tags.push([policy]);
  return tags;
}

// Builds and signs one group state event with the relay's own key. The id
// goes through validate.ts computeEventId like any event's, so clients
// verify it normally. The secret key never leaves relay-identity.ts: this
// passes it a 32-byte hash and gets a signature back.
function signGroupState(
  sql: SqlStorage,
  relayPubkey: string,
  kind: number,
  created_at: number,
  tags: string[][],
  content: string,
): NostrEvent {
  const unsigned: NostrEvent = { id: "", pubkey: relayPubkey, created_at, kind, tags, content, sig: "" };
  const id = computeEventId(unsigned);
  return { ...unsigned, id, sig: signAsRelay(sql, id) };
}
