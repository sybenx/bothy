// NIP-29 group writes (nips/29.md): the moderation events a client may
// send, and the group state events this relay generates and signs in
// response. The READ side -- which partition an event lands in, and who is
// allowed to see it -- is src/groups.ts and the gates in relay.ts.
//
// One group, id `_` (groups.ts TOP_LEVEL_GROUP_ID), owner is sole admin.
// NIP-29 has no group creation step ("what happens is just that relays
// will create rules around some specific ids"), so kind-9007 create-group
// has nothing to do on a relay whose only group id is a constant, and it
// is deliberately not implemented: the group exists because this file
// says it does, and kind-9002 edit-metadata is what brings its metadata
// into being.
//
// TWO NESTED LISTS, and every authorization decision below is about which
// one. `allowed_pubkeys` is the outer list: relay-wide write access, what
// ownership.ts isAllowedWriter consults for every event. `group_members`
// is the inner one: permission to write an `h`-tagged event on top of
// that. A member needs both, which is why put-user writes both and why
// remove-user takes back only what put-user gave (schema.ts
// `allowed_pubkeys.source`), and it is why storage.ts
// auditMaintainedCounts checks the containment daily -- a member missing
// from the outer list is a member whose events are refused with a message
// about follows that mentions no group at all.
//
// THE RELAY WRITING ITS OWN EVENTS is new to this codebase, and the rule
// it follows is: bypass the GATE, never the BOOKKEEPING. A relay-signed
// event is not a writer subject to isAllowedWriter -- there is nobody to
// authorize -- so it never enters relay.ts handleEventInner at all. It
// does go through storage.ts storeEvent, the same function every client
// write reaches, so it pays the maintained counters, both hour buckets,
// the stamped `row_cost`, the `is_group` partition and the
// addressable-replacement rule exactly as any other event does. There is
// no second insert path here and there must never be one: half of
// storeEvent reimplemented is half of the budget accounting missing, and
// the accounting is the part nothing would notice was wrong.
import {
  CREATE_INVITE_KIND,
  GROUP_ADMINS_KIND,
  GROUP_MEMBERS_KIND,
  GROUP_METADATA_KIND,
  GROUP_SCOPE,
  groupIdOf,
  isGroupEvent,
  isGroupMetadataKind,
  TOP_LEVEL_GROUP_ID,
} from "./groups";
import {
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
  addGroupMember,
  allowPubkeyForGroup,
  countOutstandingInvites,
  createInvite,
  expirationOf,
  isGroupMember,
  isPubkeyBanned,
  listGroupMembers,
  lookupInvite,
  redeemInvite,
  removeGroupMember,
  revokeGroupAllowance,
  storeEvent,
} from "./storage";
import { computeEventId } from "./validate";

// The three moderation kinds this relay implements (nips/29.md "Group
// state -- or moderation"). All carry an `h` tag, so all three are group
// events by the ordinary rule and land in the group partition.
export const PUT_USER_KIND = 9000;
export const REMOVE_USER_KIND = 9001;
export const EDIT_METADATA_KIND = 9002;
// Defined in groups.ts and re-exported here, so the write side still
// names it from one place. It lives over there because the READ gate is
// what has to recognise it -- see its comment for the bearer-token
// reasoning and for the import cycle that decides the file.
export { CREATE_INVITE_KIND };

// kind-9021, the one NIP-29 event a NON-member sends: "Any user can send
// a kind 9021 event to the relay in order to request admission to the
// group." It is not a moderation kind (the moderation range stops at
// 9020) and it never reaches authorizeGroupWrite -- see handleJoinRequest
// at the bottom of this file for where it is decided and why it has to be
// dispatched above the relay-wide write gate.
export const JOIN_REQUEST_KIND = 9021;

// NIP-29 reserves 9000-9020 for moderation actions. bothy implements
// three of them and REFUSES the rest by name rather than letting them
// fall through to the ordinary write path -- the same call nip86.ts makes
// for the kind allowlist methods. A kind-9005 delete-event stored as an
// inert group note would be answered `["OK", id, true]` and would delete
// nothing, which is worse than a refusal: the client has been told its
// moderation action succeeded.
const MODERATION_KIND_MIN = 9000;
const MODERATION_KIND_MAX = 9020;

export function isModerationKind(kind: number): boolean {
  return kind >= MODERATION_KIND_MIN && kind <= MODERATION_KIND_MAX;
}

export function isSupportedModerationKind(kind: number): boolean {
  return (
    kind === PUT_USER_KIND ||
    kind === REMOVE_USER_KIND ||
    kind === EDIT_METADATA_KIND ||
    kind === CREATE_INVITE_KIND
  );
}

// The invite code carried by a kind-9009 create-invite or a kind-9021
// join request. NIP-29 names the tag on both ("arbitrary `code`" on the
// moderation event, `["code", "<optional-invite-code>"]` on the join
// request), so one reader serves both sides.
//
// `code` is a multi-character tag name, so `event_tags` never indexes it
// (schema.ts) -- a stored kind-9009 keeps its code in the event body
// where only a reader entitled to the group partition can see it, and no
// tag filter can be pointed at it.
function codeTagValue(tags: string[][]): string | null {
  const value = tags.find((t) => t[0] === "code")?.[1];
  return value === undefined || value === "" ? null : value;
}

// When an invite created by this event stops working. See limits.ts
// INVITE_DEFAULT_TTL_SECONDS for why there is no third possibility.
function inviteExpiry(event: NostrEvent, nowSec: number): number {
  return expirationOf(event) ?? nowSec + INVITE_DEFAULT_TTL_SECONDS;
}

// The role the owner carries in the generated kind-39001 admin list.
// NIP-29 leaves role names entirely to the relay ("the exact role name is
// not relevant") and bothy has exactly one: the owner, who can do
// everything. No kind-39003 roles event is generated, because a single
// role that every admin has and that no moderation event can grant is not
// information a client can act on.
const OWNER_ROLE = "owner";

// The kind-39000 fields an operator sets, carried through from a
// kind-9002 edit-metadata event. Everything else on that document is a
// POLICY tag below, which the relay states rather than accepts.
const METADATA_FIELDS = ["name", "picture", "banner", "about"] as const;

// The valueless kind-39000 tags, and they are facts about what this relay
// enforces rather than preferences an operator expresses -- so they are
// emitted unconditionally and a kind-9002 carrying or omitting them
// changes nothing. Each one is true here today:
//
//   private     only members may read group messages. True, and true in
//               the ordinary sense of the word now: relay.ts
//               handleReqInner gates group reads on the same
//               `group_members` list authorizeGroupWrite gates writes on,
//               so a pubkey admitted to the group reads it back. It used
//               to be true only in a stronger and less useful sense --
//               reads were gated on the OWNER's NIP-42 identity, because
//               membership was not modelled on the read side at all, and
//               a member was as unauthorised as a stranger. One exception
//               survives inside the partition: a kind-9009 create-invite
//               is owner-only however private the group is, because its
//               `code` tag is a bearer token (groups.ts
//               CREATE_INVITE_KIND).
//   restricted  only members may write. True -- authorizeGroupWrite below.
//   hidden      relays should hide group metadata from non-members. True,
//               and it is the whole reason groups.ts recognises this kind
//               range at all.
//   closed      NIP-29: "If a group is `closed`, join requests are not
//               honored unless they include an invite code." True, and it
//               is what this relay does exactly -- a kind-9021 with no
//               code is refused, a kind-9021 with a live one is admitted.
//               This tag was expected to come OFF when invites landed, on
//               a reading of `closed` as "join requests are ignored". The
//               spec's own sentence says otherwise: invite-only IS the
//               closed group, and `open` is the tag that would be a lie
//               here. So it stays, and the note that predicted its
//               removal is what changed.
const POLICY_TAGS = ["private", "restricted", "hidden", "closed"] as const;

export type GroupWriteAuthorization = { ok: true } | { ok: false; message: string };

// The group half of the write gate, called by relay.ts handleEventInner
// AFTER ownership.ts isAllowedWriter has admitted the pubkey to the relay
// at all. Under that gate, never beside it: the outer list is what says
// this pubkey may write here, and this function only says whether it may
// write to the group.
//
// Cheapest-first, as every write path in this project is (CLAUDE.md
// "Conventions"). Three integer comparisons decide that an ordinary event
// is none of this file's business, and only an `h`-tagged event from
// somebody other than the owner reaches storage.
//
// THE THREE PATHS THAT DO NOT REACH HERE, and what each of them owes the
// partition instead. relay.ts dispatches NIP-59 gift wraps, NIP-62 vanish
// requests and NIP-29 join requests before either gate, since each has an
// entirely different source of authority -- so none of them can be gated
// by this function, and each has to answer for the group partition on its
// own terms:
//
//   gift wrap    REFUSED OUTRIGHT if it is a group event (relay.ts
//                handleGiftWrap). This was left open for one release on
//                the reasoning that it wrote INTO the partition rather
//                than out of it, and the reasoning was wrong: a member
//                who authenticates and reads the group receives the
//                injected event, so "hidden from unauthenticated reads"
//                described the wrong audience. What made it safe to close
//                is that an `h` tag on a wrap addressed by `p` tag to one
//                recipient names nothing -- there was no legitimate case
//                to preserve.
//   vanish       NOT STORED AT ALL (relay.ts handleVanish stores no row
//                for the request), so it cannot reach a partition. Its
//                side effect deletes only rows whose `pubkey` is the
//                signer's own, across both partitions (storage.ts
//                vanishTargets runs acrossScopes), which is a member
//                erasing their own group history -- exactly what NIP-62
//                obliges this relay to honour.
//   join request SAME SHAPE AS VANISH: handleJoinRequest below decides
//                membership and stores no event, so the one write path
//                open to a stranger who holds an invite code adds no row
//                to the group partition either. The only group event a
//                join produces is the relay's own regenerated kind-39002.
export function authorizeGroupWrite(
  sql: SqlStorage,
  event: NostrEvent,
  isOwner: boolean,
  nowSec: number,
): GroupWriteAuthorization {
  if (!isGroupEvent(event) && !isModerationKind(event.kind)) return { ok: true };

  // NIP-29: these "MUST be created by the relay master key only (as stated
  // by the NIP-11 `self` pubkey)... Relays shouldn't accept these events if
  // they're signed by anyone else." Refused for every client including the
  // owner -- the relay's own regeneration does not come through here.
  if (isGroupMetadataKind(event.kind)) {
    return {
      ok: false,
      message:
        `invalid: kind ${event.kind} is group state generated and signed by this relay itself, ` +
        `not accepted from clients`,
    };
  }

  if (isModerationKind(event.kind)) {
    // The id selects what gets mutated, and there is exactly one thing it
    // can select -- see groups.ts TOP_LEVEL_GROUP_ID for why ordinary group
    // traffic is NOT held to this.
    if (groupIdOf(event) !== TOP_LEVEL_GROUP_ID) {
      return {
        ok: false,
        message: `invalid: a moderation event must carry ["h", "${TOP_LEVEL_GROUP_ID}"], this relay's only group`,
      };
    }
    // Sole admin. Checked before the supported-kind test below so an
    // unauthorized caller learns nothing about which kinds are implemented.
    if (!isOwner) {
      return { ok: false, message: "restricted: only the relay owner can moderate this group" };
    }
    if (!isSupportedModerationKind(event.kind)) {
      return {
        ok: false,
        message:
          `invalid: kind ${event.kind} is not implemented -- this relay supports put-user (${PUT_USER_KIND}), ` +
          `remove-user (${REMOVE_USER_KIND}) and edit-metadata (${EDIT_METADATA_KIND})`,
      };
    }
    // The owner is the sole admin and is a member by exemption, so a
    // remove-user naming them can never take effect. Refused outright
    // rather than accepted and quietly ignored -- the same call nip86.ts
    // banpubkey makes about the owner's own pubkey, and for the same
    // reason: a moderation action answered `["OK", id, true]` that does
    // nothing is worse than one that says why.
    //
    // No storage read to establish who that is: every moderation event
    // reaching this line is the owner's, checked immediately above.
    if (event.kind === REMOVE_USER_KIND && pTagValues(event.tags).includes(event.pubkey)) {
      return { ok: false, message: "invalid: the relay owner cannot be removed from their own group" };
    }
    if (event.kind === CREATE_INVITE_KIND) return authorizeCreateInvite(sql, event, nowSec);
    return { ok: true };
  }

  // An ordinary `h`-tagged event: the inner list decides. The owner is
  // exempt for the reason they are exempt from everything else here --
  // this relay is not defended against its own owner (CLAUDE.md "Threat
  // model") -- and being exempt is also what keeps the sole admin able to
  // moderate a group they were never put-user'd into.
  if (isOwner) return { ok: true };
  if (isGroupMember(sql, event.pubkey)) return { ok: true };
  return { ok: false, message: "restricted: only members of this relay's group can publish to it" };
}

// Everything a kind-9009 has to satisfy before the invite row exists.
//
// Reached only from the moderation branch above, so the caller is already
// established as the owner -- these are not authorization checks, they are
// the policy limits.ts states, applied where there is still a message
// channel to say so on. Refusing here rather than clamping in
// applyModeration is deliberate: an invite quietly given a different
// lifetime than the client asked for is a link the client will describe
// wrongly to the person it is sent to.
//
// Two storage reads, both at owner pace, neither on any path an ordinary
// event takes.
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

  // Never re-open a code this relay has already seen. Without this, an
  // owner reusing a code they had used before -- the same memorable
  // string, months apart -- would hand the person who redeemed it the
  // first time a second admission, and the row's `redeemed_by` would be
  // overwritten with whoever got there next.
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
// state it changed, returning the events the relay signed so the caller can
// broadcast them.
//
// Called from relay.ts acceptEvent AFTER storeEvent, exactly where a
// kind-5 reaches applyDeletion: the moderation event itself is part of the
// group's history ("the group state can be fully reconstructed from the
// canonical sequence of these events"), so it is stored first and acted on
// second.
export function applyModeration(sql: SqlStorage, env: Env, event: NostrEvent, nowSec: number): NostrEvent[] {
  const owner = getOwnerPubkey(sql, env);
  // Unreachable: authorizeGroupWrite refused every non-owner above, and a
  // relay with no owner has no owner to be. Returning rather than throwing
  // keeps a future caller from taking the object down over it.
  if (owner === null) return [];

  if (event.kind === PUT_USER_KIND) {
    for (const pubkey of pTagValues(event.tags)) {
      // The owner is a member by exemption rather than by row
      // (authorizeGroupWrite above), and is already listed as the admin on
      // the generated kind-39002 -- so a put-user naming them would write a
      // membership row nothing reads and an `allowed_pubkeys` row for the
      // one pubkey the outer gate never consults.
      if (pubkey === owner) continue;
      addGroupMember(sql, pubkey, nowSec);
      // Both tables, together, in that order. The write gate reads the
      // OUTER list, so a member without this row is a member who cannot
      // write -- see storage.ts auditMaintainedCounts, which checks daily
      // that these two never came apart.
      allowPubkeyForGroup(sql, pubkey, "added to the group by a NIP-29 put-user event", nowSec);
    }
  } else if (event.kind === CREATE_INVITE_KIND) {
    // authorizeCreateInvite above has already established that the code
    // is present, well-sized, unseen and within the lifetime cap, so
    // this cannot fail and does not re-check. The `?? ""` is for the
    // type, not for a case that can happen.
    createInvite(sql, codeTagValue(event.tags) ?? "", nowSec, inviteExpiry(event, nowSec));
  } else if (event.kind === REMOVE_USER_KIND) {
    for (const pubkey of pTagValues(event.tags)) {
      if (pubkey === owner) continue;
      removeGroupMember(sql, pubkey);
      // Only what put-user granted. An `allowed_pubkeys` row the operator
      // created by hand through NIP-86 allowpubkey survives being removed
      // from the group, because it was never the group's to take back.
      revokeGroupAllowance(sql, pubkey);
    }
  }

  // A kind-9009 changes neither membership nor metadata, so the
  // tag-by-tag comparison inside finds all three unchanged and writes
  // nothing -- three rows read and no rows written. Called anyway rather
  // than special-cased out, because on a relay whose owner has issued an
  // invite before ever sending any other moderation event, this is the
  // call that brings the group's state into being.
  return regenerateGroupState(sql, owner, event.kind === EDIT_METADATA_KIND ? event : null, nowSec);
}

// ---------------------------------------------------------------------
// NIP-29 join requests (kind 9021).
// ---------------------------------------------------------------------

export interface JoinResult {
  accepted: boolean;
  message: string;
  // The relay-signed group state this join changed -- in practice the
  // regenerated kind-39002 member list, already stored, for the caller to
  // broadcast. Empty on every refusal and on a request from somebody who
  // was already a member.
  generated: NostrEvent[];
}

// THE ONE MESSAGE EVERY REFUSAL SENDS, and the point of this file's join
// half.
//
// A stranger presenting a code can be refused for four different reasons
// -- the code is unknown, spent, expired or revoked -- and telling them
// which is telling them things they must not learn. "Spent" and "expired"
// both confirm that the code was REAL, which confirms this relay hosts a
// group somebody was invited to; "unknown" against a code the attacker
// generated confirms the opposite, which turns a join request into an
// oracle for testing guesses one bit at a time. Distinguishing them would
// be the same defect the gift wrap read gate had before it stopped
// deciding by probing storage: the refusal itself becomes the answer.
//
// So the wire gets one string for all four, and the OWNER gets the
// distinction, through a channel a stranger cannot read -- a log line
// naming the reason. The admin who wants to know why their invitee is
// stuck reads `wrangler tail`; the person who made the request learns
// only that this link does not work.
//
// It is deliberately NOT the empty-handed "restricted:" of the ordinary
// write gate. A real invitee whose link has lapsed needs to be told what
// to do about it, and "ask for a new link" is true for all four reasons
// at once, which is exactly what makes it safe to say.
//
// What this does not hide is timing: a known code costs one row read more
// than an unknown one before the same refusal comes back. Measuring that
// across a network is not a thing an attacker gets to do reliably, and
// the alternative -- issuing a dummy read to level it -- would be
// defending against an adversary who can already do better by other
// means.
export const JOIN_REFUSAL_MESSAGE =
  "restricted: this invite code was not accepted -- ask whoever invited you for a new link";

// The code as it appears in the owner's log. Truncated, and escaped
// through JSON.stringify, because this string is chosen by whoever sent
// the request: unbounded attacker text in a log is a way to bury the
// lines around it, and a newline in it is a way to forge one. Twelve
// characters is under the shortest code this relay will issue
// (limits.ts MIN_INVITE_CODE_LENGTH), so a prefix still identifies a real
// invite against the NIP-86 list without reproducing a live code in full.
function codeLabel(code: string | null): string {
  return code === null ? "(none)" : JSON.stringify(code.slice(0, 12));
}

// A kind-9021 join request: NIP-29's admission path, and the only write
// path on this relay that a pubkey with no prior relationship to it can
// use to gain one.
//
// DISPATCHED ABOVE THE RELAY-WIDE WRITE GATE (relay.ts handleEventInner),
// necessarily: a person joining is by definition not yet in
// `allowed_pubkeys`, so ownership.ts isAllowedWriter would refuse them
// before this file ever saw the request. The authority here is the invite
// code and nothing else -- a bearer token the owner minted, presented by
// whoever holds it. That is what makes an invite link work for somebody
// whose npub does not exist until they click it, and it is the whole
// reason the caps in limits.ts around invites are shaped the way they
// are.
//
// NOTHING IS STORED. The request is an action, not content -- the same
// call relay.ts handleVanish makes about its own request event -- and
// here it is also what keeps this path from being the hole the gift wrap
// path was: a kind-9021 carries an `h` tag, so storing one would put a
// stranger's event into the group partition through a path no group
// authorization gates. The only event a successful join produces is this
// relay's own regenerated kind-39002, which is the canonical record of
// the membership anyway.
//
// Ordering is NOT cheapest-first, and that is the one place this file
// departs from the project's convention. Signature verification happens
// in relay.ts before this is called, ahead of any invite lookup, because
// the reverse order is an oracle: a caller could offer a guessed code
// under a junk signature and tell a real code from a fake one by whether
// the refusal complained about the code or about the signature. Paying
// schnorr on an unauthenticated request is the price, and the per-IP join
// throttle is what bounds how often it is paid.
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

  // The group-id check is free -- it reads nothing -- and stays first: a
  // request naming another relay's group is refused before any storage,
  // with the uniform message, since answering "wrong group id" would
  // confirm which id this relay does host.
  if (groupIdOf(event) !== TOP_LEVEL_GROUP_ID) return refuse("not this relay's group", null);
  const code = codeTagValue(event.tags);

  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return refuse("relay is unclaimed", code);

  // Already in? Then the code stays unspent, whatever it is or whether one
  // was even presented. A member re-sending a join request -- a client
  // retrying, a second device -- has no code either, and neither does the
  // owner, who is a member by exemption rather than by row
  // (authorizeGroupWrite above) and is checked as the same case. Saying so
  // plainly is safe: the request is signed, so this tells the signer only
  // about themselves.
  //
  // THIS RUNS BEFORE THE NO-CODE REFUSAL BELOW, which inverts
  // cheapest-first a second time in this function -- the first is the
  // schnorr-before-invite-lookup ordering noted above this function, and
  // that one exists to close an oracle. This one is for correctness, not
  // secrecy: the owner and an existing member never hold a code, so
  // refusing on a missing code before checking membership made the owner
  // unable to join their own group and a member's retry indistinguishable
  // from a stranger's. The cost is two storage reads -- this lookup and
  // the one above it -- on every refused uninvited join instead of zero,
  // and both paths still return the identical uniform message, so a
  // stranger paying that cost learns nothing new for it.
  if (event.pubkey === owner || isGroupMember(sql, event.pubkey)) {
    return { accepted: true, message: "already a member of this group", generated: [] };
  }

  // NIP-29: "If a group is `closed`, join requests are not honored unless
  // they include an invite code." This group is closed and has no other
  // admission path -- there is nobody to hold an uninvited request open
  // for, since a moderator queue is not a thing this relay has.
  if (code === null) return refuse("no invite code", null);

  // Before redeeming, so a banned pubkey does not burn a live invite on
  // its way to being refused. It gets the uniform message like every
  // other refusal: the ban is the owner's business, and confirming one to
  // the banned party tells them how to come back under another key.
  if (isPubkeyBanned(sql, event.pubkey)) return refuse("pubkey is banned", code);

  const outcome = redeemInvite(sql, code, event.pubkey, nowSec);
  if (outcome !== "redeemed") return refuse(`invite code ${outcome}`, code);

  // The same two nested lists put-user writes, in the same order and for
  // the same reason -- a member without the outer row is a member whose
  // events are refused with a message about follows. storage.ts
  // auditMaintainedCounts checks the containment daily whichever path
  // created it.
  addGroupMember(sql, event.pubkey, nowSec);
  allowPubkeyForGroup(sql, event.pubkey, "joined the group with a NIP-29 invite code", nowSec);

  console.warn(`[nip29] join request accepted: pubkey=${event.pubkey} code=${codeLabel(code)}`);
  return { accepted: true, message: "", generated: regenerateGroupState(sql, owner, null, nowSec) };
}

interface StoredGroupState {
  created_at: number;
  tags: string[][];
  content: string;
}

// The relay's own three group state events, in one query.
//
// Pinned to the group partition AND to the relay's own pubkey, which is
// what makes it an index seek on idx_events_pubkey_created_grp rather
// than a scan -- the partition rule in storage.ts, obeyed here like
// everywhere else. Reads at most three rows: exactly the events this
// relay has signed.
function readGroupState(sql: SqlStorage, relayPubkey: string): Map<number, StoredGroupState> {
  const rows = sql
    .exec<{ kind: number; created_at: number; tags: string; content: string }>(
      `SELECT kind, created_at, tags, content FROM events
        WHERE pubkey = ? AND is_group = ? AND kind >= ? AND kind <= ?`,
      relayPubkey,
      GROUP_SCOPE,
      GROUP_METADATA_KIND,
      GROUP_MEMBERS_KIND,
    )
    .toArray();
  return new Map(
    rows.map((row) => [
      row.kind,
      { created_at: row.created_at, tags: JSON.parse(row.tags) as string[][], content: row.content },
    ]),
  );
}

// Regenerates the three relay-signed events, writing only the ones whose
// content actually changed.
//
// THE COMPARISON IS NOT AN OPTIMISATION, it is what makes "regenerated
// whenever membership or metadata changes" true rather than "rewritten
// whenever anything happens". A membership change does not touch the admin
// list or the metadata; rewriting all three anyway would delete and
// re-insert two unchanged addressable events on every put-user, which is
// the same measure-before-writing rule ownership.ts refreshFollows applies
// to the follow cache and for the same reason -- there it was 900 rows per
// cron tick to discover nothing had changed.
function regenerateGroupState(
  sql: SqlStorage,
  owner: string,
  metadataSource: NostrEvent | null,
  nowSec: number,
): NostrEvent[] {
  const relayPubkey = getRelayPubkey(sql);
  const existing = readGroupState(sql, relayPubkey);
  const generated: NostrEvent[] = [];

  const emit = (kind: number, tags: string[][], content: string): void => {
    const prior = existing.get(kind);
    if (prior && prior.content === content && JSON.stringify(prior.tags) === JSON.stringify(tags)) return;
    // Strictly newer than what it replaces, not merely "now".
    //
    // These are addressable events, so storage.ts isSupersededBy decides
    // the replacement -- higher created_at wins, and a TIE is broken by the
    // LOWEST id. Two membership changes inside the same wall-clock second
    // would therefore produce a new member list that loses to the old one
    // about half the time, and lose silently: storeEvent returns ok with
    // `stored: null` and the group's membership would simply stop tracking
    // its own moderation events. A second per change is the whole cost of
    // not having that, and it stays inside
    // limits.ts MAX_CREATED_AT_FUTURE_SECONDS for any plausible burst.
    const created_at = Math.max(nowSec, prior === undefined ? 0 : prior.created_at + 1);
    const event = signGroupState(sql, relayPubkey, kind, created_at, tags, content);
    // The same insert path every client write takes, with only the gate
    // skipped -- see this file's header. storeEvent's addressable branch is
    // what replaces the previous version in place.
    storeEvent(sql, event, nowSec);
    generated.push(event);
  };

  emit(GROUP_METADATA_KIND, metadataTags(metadataSource, existing.get(GROUP_METADATA_KIND)), "");
  emit(GROUP_ADMINS_KIND, [["d", TOP_LEVEL_GROUP_ID], ["p", owner, OWNER_ROLE]], "");
  emit(
    GROUP_MEMBERS_KIND,
    [
      ["d", TOP_LEVEL_GROUP_ID],
      // The admin first, matching NIP-29's own example, and present
      // because the owner is a member by exemption rather than by row.
      ["p", owner],
      ...listGroupMembers(sql).map((pubkey) => ["p", pubkey]),
    ],
    "",
  );

  return generated;
}

// The kind-39000 document: the operator's fields, then the policy tags.
//
// `source` is the kind-9002 that triggered this, when one did. When none
// did -- a membership change, or the first regeneration on a relay whose
// owner has never sent a 9002 -- the previous document's own fields are
// carried forward, so regenerating for an unrelated reason cannot quietly
// blank the group's name. With neither, the document carries the policy
// tags alone, which is a truthful description of a group nobody has named.
function metadataTags(source: NostrEvent | null, prior: StoredGroupState | undefined): string[][] {
  const from = source?.tags ?? prior?.tags ?? [];
  const tags: string[][] = [["d", TOP_LEVEL_GROUP_ID]];
  for (const field of METADATA_FIELDS) {
    const value = from.find((tag) => tag[0] === field)?.[1];
    if (value !== undefined && value !== "") tags.push([field, value]);
  }
  for (const policy of POLICY_TAGS) tags.push([policy]);
  return tags;
}

// Builds and signs one group state event with this relay's own key.
//
// The id is computed the same way every other event's is (validate.ts
// computeEventId), so a client verifies these exactly as it verifies a
// user's event -- there is no relay-specific signing rule in NIP-29
// beyond which key does it. The secret key never leaves relay-identity.ts:
// this hands it a 32-byte hash and gets a signature back.
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
