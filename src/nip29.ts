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
  GROUP_ADMINS_KIND,
  GROUP_MEMBERS_KIND,
  GROUP_METADATA_KIND,
  GROUP_SCOPE,
  groupIdOf,
  isGroupEvent,
  isGroupMetadataKind,
  TOP_LEVEL_GROUP_ID,
} from "./groups";
import { type NostrEvent, pTagValues } from "./nostr";
import { getOwnerPubkey } from "./ownership";
import { signAsRelay, getRelayPubkey } from "./relay-identity";
import {
  addGroupMember,
  allowPubkeyForGroup,
  isGroupMember,
  listGroupMembers,
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
  return kind === PUT_USER_KIND || kind === REMOVE_USER_KIND || kind === EDIT_METADATA_KIND;
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
//   private     only members may read group messages. True, and stronger
//               than the word suggests: reads are gated on the owner's own
//               NIP-42 identity because membership is not yet modelled on
//               the read side (relay.ts handleReqInner), so a member is
//               currently as unauthorised as a stranger.
//   restricted  only members may write. True -- authorizeGroupWrite below.
//   hidden      relays should hide group metadata from non-members. True,
//               and it is the whole reason groups.ts recognises this kind
//               range at all.
//   closed      join requests are ignored. True TODAY, because there is no
//               kind-9021 join path and no invites; membership is created
//               by the owner sending put-user. This is the one tag here
//               that is expected to come off, when invites land.
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
// WHAT IT DOES NOT COVER, and deliberately: relay.ts dispatches NIP-59
// gift wraps and NIP-62 vanish requests before reaching either gate, since
// each has an entirely different source of authority. So a gift wrap
// carrying an `h` tag lands in the group partition without passing here.
// That is a stranger writing into the partition, not out of it -- the
// event is hidden from unauthenticated reads like everything else there,
// and is still bounded by the gift wrap caps. Worth knowing rather than
// worth closing: closing it would mean this file having an opinion about
// a write path whose whole point is that ownership does not gate it.
export function authorizeGroupWrite(
  sql: SqlStorage,
  event: NostrEvent,
  isOwner: boolean,
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
      allowPubkeyForGroup(sql, pubkey, nowSec);
    }
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

  return regenerateGroupState(sql, owner, event.kind === EDIT_METADATA_KIND ? event : null, nowSec);
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
