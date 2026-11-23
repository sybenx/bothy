// NIP-86 relay management API (nips/86.md), method dispatch. Runs inside
// the Durable Object via Relay.manage(), after the Worker has
// authenticated the request (src/nip98.ts). Nothing here opens an outbound
// connection.
//
// banpubkey/allowpubkey are the only methods whose lists the per-event
// write path consults (ownership.ts isAllowedWriter); everything else
// costs nothing per event. The allowlist is also the member list
// (storage.ts isMember): unallowpubkey is how a member is removed, and
// createinvite/redeeminvite are how one joins. Each has its own inverse (unbanpubkey,
// unallowpubkey) rather than allowpubkey also lifting a ban the way
// allowevent lifts a banevent tombstone: banned_pubkeys and
// allowed_pubkeys are two independent lists, not opposite ends of one.
// supportedmethods reports exactly what is here, which is what makes a
// partial implementation conformant.
import {
  allowEvent,
  allowPubkey,
  banEvent,
  banPubkey,
  blockIp,
  approveJoinRequest,
  areClose,
  isBelow,
  isClose,
  setClose,
  homeMemberPubkeys,
  getRelaySettings,
  eraseMember,
  listInvitees,
  backedUpMemberCount,
  hasBackRoom,
  mailRetentionOn,
  recordBackedUp,
  addOwnKey,
  clearRemovalMark,
  markRemovedOnPurpose,
  ownKeysOf,
  mailTimes,
  memberKeys,
  deleteFcmToken,
  upsertFcmToken,
  addAdmin,
  invitedSubtree,
  isAdmin,
  listAdmins,
  removeAdmin,
  removeMember,
  roleOf,
  homeStats,
  inviteDepth,
  inviteSlotsUsed,
  countOutstandingMemberInvites,
  declineJoinRequest,
  mailRoom,
  mailLeftFor,
  mailUsage,
  wrapBytes,
  isMember,
  isPubkeyBanned,
  listJoinRequests,
  listMembers,
  recordJoinRequest,
  storeEvent,
  createMemberInvite,
  deletePushSubscription,
  getStoredWritePolicy,
  listAllowedPubkeys,
  listBannedEvents,
  listBannedPubkeys,
  listBlockedIps,
  listUnusedInvites,
  listUnusedMemberInvites,
  redeemMemberInvite,
  revokeInvite,
  revokeMemberInvite,
  setRelaySetting,
  unbanPubkey,
  unblockIp,
  upsertPushSubscription,
} from "./storage";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  groupsEnabled,
  INVITE_DEFAULT_TTL_SECONDS,
  INVITE_MAX_TTL_SECONDS,
  MAX_OUTSTANDING_INVITES,
  MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY,
  MAX_FCM_TOKENS_PER_PUBKEY,
  MEMBER_INVITE_CODE_BYTES,
  MEMBER_INVITE_DEFAULT_USES,
  MEMBER_INVITE_MAX_USES,
  JOIN_REQUEST_NAME_MAX_LENGTH,
  JOIN_REQUEST_NOTE_MAX_LENGTH,
  JOIN_REQUEST_TTL_SECONDS,
  MAX_PENDING_JOIN_REQUESTS,
  ERASE_MAIL_BATCH,
  MAIL_RETENTION_SECONDS,
  mailBytesPerMember,
  mailStorageBytes,
  MEMBER_REMOVAL_GRACE_SECONDS,
  memberInviteLimits,
  memberListVisibility,
  HOME_STATS_DAYS,
  HOME_STATS_WEEKS,
  photoStorageBytes,
  ownKeysPerMember,
} from "./limits";
import { sqlitePhotoStore } from "./photos";
import { deleteVaultRow, isVaultHash, listVaultRows, parseVaultPut, storeVaultRow } from "./vault";
import { GROUPS_PAUSED_MESSAGE } from "./nip29";
import { HOME_GROUP_METHODS, KEEPER_METHODS, handleGroupCall, removeFromAllGroups, type GroupOutboxEntry } from "./home-groups";
import { pushConfigured } from "./push";
import { fcmConfigured } from "./fcm";
import { joinRequestMessage, oneLine } from "./join-requests";
import type { NostrEvent } from "./nostr";
import { getOwnerPubkey } from "./ownership";
import { normalizeIp } from "./ip";
import { normalizePubkey } from "./pubkey";
import {
  envOverridesPolicy,
  OPEN_POLICY_CONFIRMATION,
  parsePolicy,
  POLICY_DESCRIPTIONS,
  resolveWritePolicy,
  WRITE_POLICIES,
} from "./write-policy";

// nips/86.md: "a JSON-RPC-like request-response protocol over HTTP, on
// the same URI as the relay's websocket", distinguished by this
// content-type. Matched as a substring, never by equality: clients send
// compound types ("application/nostr+json+rpc; charset=utf-8"). index.ts
// explains why it is checked before NIP-11.
export const MANAGEMENT_CONTENT_TYPE = "application/nostr+json+rpc";

// nips/86.md: {"result": <value>, "error": "<optional error message>"}.
// `error` is not strictly a failure channel here -- the change* methods
// use it to carry an advisory note alongside a successful result, which
// is the only field the protocol gives them to say anything in.
export interface ManagementResponse {
  result?: unknown;
  error?: string;
  // Not part of the response: events this call stored that relay.ts
  // manage() must also deliver (live subscriptions, push) and then strip
  // before answering. Today only requestjoin's message to the owner.
  outbox?: NostrEvent[];
  // Home groups (src/home-groups.ts): groupchange's current version on a
  // conflict, sent to the caller beside `error`.
  version?: number;
  // Not part of the response either: group changes relay.ts manage() must
  // deliver to the group's live subscriptions and wake its members for.
  groupOutbox?: GroupOutboxEntry[];
  // Not part of the response: people to wake with nothing to deliver.
  wake?: string[];
}

// Exactly the methods implemented below, and the value supportedmethods
// returns. Adding a method means adding it here in the same commit --
// this list is the discovery mechanism, so a stale entry is worse than a
// missing one: a client that trusts it will call something that isn't
// there.
export const SUPPORTED_METHODS = [
  "supportedmethods",
  "banevent",
  "allowevent",
  "listbannedevents",
  "banpubkey",
  "unbanpubkey",
  "listbannedpubkeys",
  "allowpubkey",
  "unallowpubkey",
  "listallowedpubkeys",
  "blockip",
  "unblockip",
  "listblockedips",
  "changerelayname",
  "changerelaydescription",
  "changerelayicon",
  // bothy's own (NIP-86 has no write policy). changewritepolicy follows the
  // change* conventions: empty string clears, and the response says when
  // an environment variable outranks the stored value. getwritepolicy
  // reads back the policy in force and its source, which NIP-11 cannot.
  "changewritepolicy",
  "getwritepolicy",
  // bothy's own; NIP-86 defines no invite methods (documented in the
  // README). Named plainly rather than vendor-prefixed so supportedmethods
  // stays self-explanatory; if NIP-86 ever standardises these names with
  // different semantics, these must change.
  //
  // createinvite makes a member invite (schema.ts `member_invites`);
  // redeeminvite spends one. listunusedinvites and revokeinvite cover both
  // member invites and NIP-29 group invites, so there is one place to see
  // and kill a live code whichever kind it is.
  "createinvite",
  "redeeminvite",
  "listunusedinvites",
  "revokeinvite",
  // bothy's own. requestjoin is how someone without a code asks to become
  // a member; the owner answers with approvejoin or declinejoin.
  // listmembers is the owner's member screen: more than
  // listallowedpubkeys says, and the removed members still in their grace.
  "requestjoin",
  "listjoinrequests",
  "approvejoin",
  "declinejoin",
  "listmembers",
  // bothy's own. The owner's admins (schema.ts `admins`), and myrole, which
  // tells any signer what they may do here.
  "addadmin",
  "removeadmin",
  "listadmins",
  "myrole",
  // bothy's own: what a member's invite allowance is right now.
  "myinvites",
  // bothy's own: how the home is used, in counts (owner and admins).
  "homestats",
  // bothy's own; the one pair a member may call, not only the owner
  // (MEMBER_CALLABLE_METHODS below).
  "subscribepush",
  "unsubscribepush",
  // bothy's own: the same for an Android app, with an FCM token (src/fcm.ts).
  "subscribefcm",
  "unsubscribefcm",
  // bothy's own: the home's file server (owner sets it; its key reads the
  // member list), and when this relay stored a member's mail.
  "setstorage",
  "getstorage",
  "memberkeys",
  "mailtimes",
  // bothy's own: how full the signer's mailbox and the home's are.
  "mymailbox",
  // bothy's own: a member deleting their own account.
  "eraseme",
  // bothy's own: who else is in the home, for any member to see.
  "homemembers",
  // bothy's own: location trust, set by the owner and admins and asked
  // about by members.
  "setclose",
  "areclose",
  // bothy's own: the restore vault (src/vault.ts). The first three are a
  // member's own rows; vaultchallenge and vaultopen are UNSIGNED
  // (UNSIGNED_METHODS below).
  "vaultput",
  "vaultlist",
  "vaultdelete",
  "vaultchallenge",
  "vaultopen",
  // bothy's own: a member letting in another key of their own, and the
  // owner forgetting that someone was removed on purpose.
  "addmykey",
  "forgetremoval",
  // bothy's own: listmembers' rows for the caller's own branch.
  "myinvitees",
  // bothy's own: history backup and mailbox retention. backedup is a
  // member's app saying its verified backup holds their mail up to a
  // stored time; setretention and getretention are the owner's switch.
  "backedup",
  "setretention",
  "getretention",
  // bothy's own: home groups (src/home-groups.ts), the DMs app's groups
  // with a group key.
  "groupcreate",
  "groupchange",
  "groupinfo",
  "mygroups",
  "groupkeys",
  "groupleave",
  "groupsince",
  "groupjoin",
  "groupseal",
  "keepergroups",
  "groupkept",
] as const;

// The methods a MEMBER may call, not just the owner.
//
// Every other method administers the relay, and index.ts refuses a
// non-owner signature before dispatch. These two only register and remove
// the caller's own push endpoint (hearth's reference/push.md: "the signer
// of that event is the member the subscription belongs to"); without them
// a member could not be notified at all.
//
// index.ts checks membership only for a method named here, so every other
// method stays owner-only. "Member" there is relay.ts isMember: a member
// of the relay (storage.ts isMember), or of the group `_`.
//
// The invite methods are member-callable too, with limits: a member makes
// codes within their own allowance and sees and revokes only their own
// (memberInviteStanding). Owner and admins pass the same gate unlimited.
export const MEMBER_CALLABLE_METHODS: readonly string[] = [
  "unallowpubkey",
  "areclose",
  "eraseme",
  "homemembers",
  "mymailbox",
  "mailtimes",
  "subscribepush",
  "unsubscribepush",
  "subscribefcm",
  "unsubscribefcm",
  "createinvite",
  "listunusedinvites",
  "revokeinvite",
  "myinvites",
  "vaultput",
  "vaultlist",
  "vaultdelete",
  "addmykey",
  "myinvitees",
  "backedup",
  // Starting a home group is for people in the home; the other group calls
  // are for anyone on a group's roster, guests included (ANYONE_CALLABLE).
  "groupcreate",
];

// The methods that take NO signature, an exception to NIP-86's NIP-98
// rule: a new phone restoring with a passkey has no key yet, and the
// passkey assertion is the credential (src/vault.ts). index.ts routes them
// before NIP-98 verification, to relay.ts vaultChallenge and vaultOpen;
// they never reach handleManagementCall.
export const UNSIGNED_METHODS: readonly string[] = ["vaultchallenge", "vaultopen"];

// The method ANY valid signature may call: redeeminvite, whose caller is
// by definition not a member yet. The code is the authority, and the
// signature only says who is joining (the pubkey stored is the signer's,
// never one from the body).
//
// requestjoin likewise: the requester is not a member, and asking is the
// point. relay.ts throttles it per address before dispatch.
//
// myrole answers any signer with their own role, so an app can decide what
// to show without trying a method and reading the 401.
// The one method the storage service's key may call (setstorage), and the
// only key that may call it: not the owner, not a member. index.ts checks
// the signer against the stored pubkey before dispatch.
export const STORAGE_CALLABLE_METHODS: readonly string[] = ["memberkeys", ...KEEPER_METHODS];

export const STORAGE_ONLY_REASON = "memberkeys is only for this relay's storage service";

export const ANYONE_CALLABLE_METHODS: readonly string[] = [
  "redeeminvite",
  "requestjoin",
  "myrole",
  // Home groups: each checks the signer is on that group's roster
  // (home-groups.ts), so a guest from another home can use their groups.
  ...HOME_GROUP_METHODS.filter((m) => m !== "groupcreate" && !KEEPER_METHODS.includes(m)),
];

// The push methods a group guest (on a home group's roster here, not a
// member of the home) may call too, so their phone is woken for the group.
export const GUEST_PUSH_METHODS: readonly string[] = ["subscribepush", "unsubscribepush", "subscribefcm", "unsubscribefcm"];

// The methods an ADMIN may call besides the member's own: running the
// member list, invites and join requests. Everything else stays with the
// owner: admins themselves, the write policy, bans, blocks, the relay's
// name, description and icon, and anything else relay-level. The
// owner-side guard against an admin removing another admin is in
// unallowpubkey below.
//
// The invite methods are not here: members may call them too
// (MEMBER_CALLABLE_METHODS), and admins pass that gate as well.
//
// unallowpubkey is not here: members may call it too, within their own
// subtree (MEMBER_CALLABLE_METHODS), and admins pass that gate as well.
export const ADMIN_CALLABLE_METHODS: readonly string[] = [
  "setclose",
  "homestats",
  "listjoinrequests",
  "approvejoin",
  "declinejoin",
  "listmembers",
  "allowpubkey",
];

// The 401 a member or stranger gets for an admin method (index.ts).
export function adminOnlyReason(method: string): string {
  return `${method} is for this relay's owner and admins`;
}

// The 401 a non-member gets for a MEMBER_CALLABLE_METHODS call (index.ts).
// Stable on purpose: an app that sees it knows its user is not, or is no
// longer, a member here.
export const NOT_A_MEMBER_REASON = "you are not a member of this relay";

// The methods that belong to the group feature (limits.ts groupsEnabled).
// While groups are paused they are left out of supportedmethods and
// answer with the same refusal every other group path gives: the
// discovery list is what a client trusts, and a listed method that
// belongs to a feature the relay is not running is an advertisement for
// something that does not work.
//
// Empty now: invites and push used to be group-only and are now how
// members join and are notified, which does not depend on groups. Kept so
// a future group-only method has its place.
export const GROUP_METHODS: readonly string[] = [];

export function supportedMethods(env: Env): string[] {
  return groupsEnabled(env)
    ? [...SUPPORTED_METHODS]
    : SUPPORTED_METHODS.filter((method) => !GROUP_METHODS.includes(method));
}

// The exact string blockip demands back as its `reason` before it will
// block the address the management request itself came from. Chosen to
// be unmistakably deliberate and impossible to send by accident, and
// quoted verbatim in the refusal so the operator never has to guess at
// spelling or punctuation.
export const SELF_BLOCK_CONFIRMATION = "yes, block my own address";

const HEX_ID_RE = /^[0-9a-f]{64}$/;

// What a plain member hears from unallowpubkey outside their reach.
// Stable: apps may show them as they are.
export const REMOVE_OUTSIDE_SUBTREE_MESSAGE =
  "unallowpubkey: you can remove only people you invited, or people they invited";
export const REMOVE_SELF_MESSAGE = "unallowpubkey: to leave this home yourself, use eraseme";

// What a member hears from homemembers when the owner keeps the list
// private (MEMBER_LIST=hidden). Stable: apps may show it as it is.
export const MEMBER_LIST_HIDDEN_NOTE = "The owner keeps this home's member list private.";

// Ids one mailtimes call may ask about: a sync's worth.
export const MAX_MAILTIMES_IDS = 500;

// Pubkeys one areclose call may ask about.
export const MAX_ARECLOSE_PUBKEYS = 500;

// What backedup and setretention answer to a call they cannot take.
// Stable: apps may show them or match them, and every refusal the two
// give starts with the method's name.
export const BACKEDUP_PARAM_MESSAGE =
  "backedup: it takes [mailThrough], the latest stored time your backup holds, as whole unix seconds";
export const SETRETENTION_PARAM_MESSAGE = "setretention: it takes true or false";
export const RETENTION_NEEDS_STORAGE_MESSAGE =
  "setretention: this home has no file server for your members' history backups, and old messages " +
  "are deleted only once a backup holds them. Connect one with setstorage first.";

// A member who is neither the owner nor an admin: the caller whose view
// of invites is limited to their own.
function isPlainMember(sql: SqlStorage, env: Env, signer: string): boolean {
  return roleOf(sql, signer, getOwnerPubkey(sql, env)) === "member";
}

// subscribepush's label: short, and from an alphabet with no room for an
// npub (63 characters) or a sentence.
const PUSH_LABEL_RE = /^[A-Za-z0-9_-]{1,16}$/;

// An FCM registration token: Google's own format, base64url-ish with ":"
// and usually about 160 characters. Bounded so the column cannot be used
// as storage.
const FCM_TOKEN_RE = /^[A-Za-z0-9_:.-]{20,4096}$/;

// The label, null for none, undefined when the parameter is malformed.
function parsePushLabel(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const label = (value as { label?: unknown }).label;
  if (label === undefined || label === null) return null;
  return typeof label === "string" && PUSH_LABEL_RE.test(label) ? label : undefined;
}

// The one refusal redeeminvite gives for every dead code, unknown,
// revoked, used up or expired alike, so a presenter cannot tell which (the
// NIP-29 join path's rule, nip29.ts JOIN_REFUSAL_MESSAGE). The owner sees
// the distinction through revokeinvite.
export const REDEEM_REFUSAL_MESSAGE =
  "redeeminvite: this invite cannot be used. Ask whoever sent it for a new one.";

// requestjoin's one optional parameter, {"name", "note", "via"}: name and
// note optional strings, squeezed onto one line and length-bounded; via
// an optional pubkey (npub or hex), whose "Message me" link this came
// through. A message when it is not that shape.
function parseJoinDetails(
  value: unknown,
): { name: string | null; note: string | null; via: string | null } | string {
  if (value === undefined || value === null) return { name: null, note: null, via: null };
  if (typeof value !== "object" || Array.isArray(value)) {
    return 'requestjoin takes one optional object, {"name": "...", "note": "...", "via": "<npub>"}';
  }
  const raw = value as { name?: unknown; note?: unknown; via?: unknown };
  let via: string | null = null;
  if (raw.via !== undefined && raw.via !== null) {
    via = typeof raw.via === "string" ? normalizePubkey(raw.via) : null;
    if (via === null) return "requestjoin: via must be a pubkey, as npub or 64-character hex";
  }
  const field = (v: unknown, label: string, max: number): string | null | { error: string } => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return { error: `requestjoin: ${label} must be a string` };
    const text = oneLine(v);
    if (text.length > max) return { error: `requestjoin: ${label} can be at most ${max} characters` };
    return text === "" ? null : text;
  };
  const name = field(raw.name, "name", JOIN_REQUEST_NAME_MAX_LENGTH);
  if (typeof name === "object" && name !== null) return name.error;
  const note = field(raw.note, "note", JOIN_REQUEST_NOTE_MAX_LENGTH);
  if (typeof note === "object" && note !== null) return note.error;
  return { name, note, via };
}

// Where a caller stands on invites. The owner and admins: unlimited
// (`left` and `limit` null). A member: limits.ts memberInviteLimits, with
// `reason` set to the refusal createinvite would give when `canInvite` is
// false. These strings are stable: apps may show them or match them.
export interface InviteStanding {
  left: number | null;
  limit: number | null;
  depth: number;
  canInvite: boolean;
  reason?: string;
}

export const INVITES_OFF_MESSAGE = "createinvite: on this relay only the owner and admins make invites";

export function invitesUsedUpMessage(limit: number): string {
  return `createinvite: you have used all ${limit} of your invites`;
}

export function inviteDepthMessage(depth: number): string {
  return `createinvite: invites go ${depth} steps from the owner, and the people you invite would be one step further, so invites stop here`;
}

function inviteStanding(sql: SqlStorage, env: Env, signer: string, nowSec: number): InviteStanding {
  const owner = getOwnerPubkey(sql, env);
  const role = roleOf(sql, signer, owner);
  const limits = memberInviteLimits(env);
  const depth = inviteDepth(sql, signer, owner, (limits?.depth ?? 3) + 1);
  if (role === "owner" || role === "admin") return { left: null, limit: null, depth, canInvite: true };
  if (limits === null) return { left: 0, limit: 0, depth, canInvite: false, reason: INVITES_OFF_MESSAGE };
  const left = Math.max(0, limits.perMember - inviteSlotsUsed(sql, signer, nowSec));
  if (depth >= limits.depth) {
    return { left, limit: limits.perMember, depth, canInvite: false, reason: inviteDepthMessage(limits.depth) };
  }
  if (left === 0) {
    return { left, limit: limits.perMember, depth, canInvite: false, reason: invitesUsedUpMessage(limits.perMember) };
  }
  return { left, limit: limits.perMember, depth, canInvite: true };
}

// An optional positive integer parameter, or the default when absent.
// Null when present but not a whole number in [1, max].
function optionalCount(params: unknown[], index: number, fallback: number, max: number): number | null {
  const value = params[index];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) return null;
  return value;
}

function err(message: string): ManagementResponse {
  return { error: message };
}

function stringParam(params: unknown[], index: number): string | null {
  const value = params[index];
  return typeof value === "string" ? value : null;
}

// NIP-86's reason arguments are all optional trailing strings.
function optionalReason(params: unknown[], index: number): string | null {
  const value = params[index];
  return typeof value === "string" && value !== "" ? value : null;
}

// Accepts npub or hex and normalizes to hex, like the claim endpoint: an
// operator most likely has an npub in hand.
function pubkeyParam(params: unknown[], index: number): string | null {
  const value = params[index];
  return typeof value === "string" ? normalizePubkey(value) : null;
}

// The note a successful change* call carries back in the `error` field,
// which is the one field NIP-86 offers for saying anything beside a
// result. It states what happened, and adds one sentence only when an
// environment variable is outranking the value just stored -- the case
// where the call otherwise appears to have done nothing. How to clear a
// value and where to read it back are in the README, once, rather than
// repeated on every call.
function identityNote(
  field: "name" | "description" | "icon",
  envVarName: string,
  envValue: string | undefined,
  cleared: boolean,
): string {
  const parts = [cleared ? `Cleared the stored relay ${field}.` : `Stored the relay ${field}.`];
  if (envValue) {
    parts.push(
      `Note: ${envVarName} is set in this deployment's environment and takes precedence over the stored value, ` +
        `so the stored value takes effect only once ${envVarName} is cleared in the Cloudflare dashboard.`,
    );
  }
  return parts.join(" ");
}

// The advisory note on every changewritepolicy response (in `error`, as
// for identityNote). It always ends with the policy actually IN FORCE,
// which can differ from what was just stored in two ways: WRITE_POLICY in
// the environment outranks it, and clearing it falls back to the default.
// Store and warn, never silently discard.
function writePolicyNote(sql: SqlStorage, env: Env, headline: string): string {
  const parts = [headline];
  if (envOverridesPolicy(env)) {
    parts.push(
      `Note: WRITE_POLICY is set in this deployment's environment and takes precedence over the stored ` +
        `value, so the stored value takes effect only once WRITE_POLICY is cleared in the Cloudflare dashboard.`,
    );
  }
  const resolved = resolveWritePolicy(env, getStoredWritePolicy(sql));
  parts.push(`The write policy now in force is "${resolved.policy}": ${POLICY_DESCRIPTIONS[resolved.policy]}`);
  return parts.join(" ");
}

function changeIdentity(
  sql: SqlStorage,
  params: unknown[],
  field: "name" | "description" | "icon",
  method: string,
  envVarName: string,
  envValue: string | undefined,
): ManagementResponse {
  const value = stringParam(params, 0);
  if (value === null) return err(`${method} takes one string parameter`);
  setRelaySetting(sql, field, value);
  // A successful call returns result true AND an error-field note -- see
  // identityNote. The note is advisory; the write already happened.
  return { result: true, error: identityNote(field, envVarName, envValue, value === "") };
}

// The subscription object hearth sends as subscribepush's one parameter
// -- `JSON.parse(JSON.stringify(pushSubscription))`, which is the browser's
// own serialization of a PushSubscription.
//
// Validated to the byte here rather than at send time, because a row that
// cannot be encrypted to fails once per message forever: RFC 8291 needs
// `p256dh` as an uncompressed P-256 point (65 bytes, leading 0x04) and
// `auth` as exactly 16 bytes. `expirationTime` is ignored: browsers send
// null, and the push service's 404/410 is the authority on expiry.
function parsePushSubscription(
  value: unknown,
): { endpoint: string; p256dh: string; auth: string } | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "subscribepush takes one PushSubscription object";
  }
  const sub = value as { endpoint?: unknown; keys?: unknown };
  if (typeof sub.endpoint !== "string" || sub.endpoint === "") {
    return "subscribepush: the subscription has no endpoint";
  }
  // https only, and length-bounded: this is a URL the relay will POST to on
  // its own initiative, the one caller-controlled field that becomes
  // outbound traffic.
  try {
    if (new URL(sub.endpoint).protocol !== "https:") {
      return "subscribepush: the endpoint must be an https URL";
    }
  } catch {
    return "subscribepush: the endpoint is not a URL";
  }
  if (sub.endpoint.length > MAX_PUSH_ENDPOINT_LENGTH) {
    return `subscribepush: the endpoint is longer than ${MAX_PUSH_ENDPOINT_LENGTH} characters`;
  }
  const keys = (sub.keys ?? {}) as { p256dh?: unknown; auth?: unknown };
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    return "subscribepush: the subscription is missing its p256dh/auth keys";
  }
  const p256dh = decodeBase64Url(keys.p256dh);
  const auth = decodeBase64Url(keys.auth);
  if (p256dh === null || p256dh.length !== 65 || p256dh[0] !== 0x04) {
    return "subscribepush: p256dh must be a base64url uncompressed P-256 public key";
  }
  if (auth === null || auth.length !== 16) {
    return "subscribepush: auth must be a base64url 16-byte secret";
  }
  return { endpoint: sub.endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

// Long enough for every push service in use (FCM's are ~200 characters,
// Mozilla's ~100), short enough that the column cannot be used as
// storage.
const MAX_PUSH_ENDPOINT_LENGTH = 1024;

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
      c.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

// `callerIp` (CF-Connecting-IP) is used only so blockip can recognize a
// self-block, never to authorize anything; authorization is the NIP-98
// signature alone.
//
// `signer` is the pubkey that signature proved. Not an authorization input
// either (index.ts has already decided): subscribepush/unsubscribepush use
// it as the answer to "whose device is this", which the request body is
// deliberately not allowed to give (schema.ts `push_subscriptions`).
export function handleManagementCall(
  sql: SqlStorage,
  env: Env,
  method: unknown,
  params: unknown[],
  callerIp: string,
  nowSec: number,
  signer: string,
): ManagementResponse {
  if (typeof method !== "string") return err("request is missing a string 'method'");

  // See GROUP_METHODS: a paused feature's methods answer the way every
  // other group path answers, ahead of any parameter parsing.
  if (GROUP_METHODS.includes(method) && !groupsEnabled(env)) {
    return err(GROUPS_PAUSED_MESSAGE.replace(/^restricted: /, ""));
  }

  if (HOME_GROUP_METHODS.includes(method)) {
    return handleGroupCall(sql, getOwnerPubkey(sql, env), method, params, signer, nowSec);
  }

  switch (method) {
    case "supportedmethods":
      return { result: supportedMethods(env) };

    case "banevent": {
      const id = stringParam(params, 0);
      if (id === null || !HEX_ID_RE.test(id)) return err("banevent takes a 64-character hex event id");
      // Deliberately not conditional on the event being stored. An id
      // banned before it ever arrives is refused on arrival by the
      // tombstone -- see storage.ts banEvent.
      banEvent(sql, id, optionalReason(params, 1), nowSec);
      return { result: true };
    }

    case "allowevent": {
      const id = stringParam(params, 0);
      if (id === null || !HEX_ID_RE.test(id)) return err("allowevent takes a 64-character hex event id");
      allowEvent(sql, id);
      return { result: true };
    }

    case "listbannedevents":
      return { result: listBannedEvents(sql) };

    case "banpubkey": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("banpubkey takes a pubkey, as npub or 64-character hex");
      // ownership.ts isAllowedWriter admits the owner before it consults
      // bans, so banning the owner would do nothing; refused rather than
      // answered `true`.
      if (pubkey === getOwnerPubkey(sql, env)) {
        return err("banpubkey: the relay owner's own pubkey can never be banned");
      }
      banPubkey(sql, pubkey, optionalReason(params, 1), nowSec);
      // Cut off: out of every home group too (home-groups.ts GROUP_DECISIONS).
      return { result: true, groupOutbox: removeFromAllGroups(sql, getOwnerPubkey(sql, env), [pubkey], "cutoff", nowSec) };
    }

    case "unbanpubkey": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("unbanpubkey takes a pubkey, as npub or 64-character hex");
      unbanPubkey(sql, pubkey);
      return { result: true };
    }

    case "listbannedpubkeys":
      return { result: listBannedPubkeys(sql) };

    // A manual allowlist, independent of banned_pubkeys (see the header):
    // an allowed pubkey writes under every write policy. On a row a group
    // put-user or join created, this PROMOTES it to owner-granted, so a
    // later remove-user cannot revoke it (storage.ts allowPubkey).
    case "allowpubkey": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("allowpubkey takes a pubkey, as npub or 64-character hex");
      allowPubkey(sql, pubkey, optionalReason(params, 1), nowSec, signer);
      return { result: true };
    }

    // Also removes a member (storage.ts unallowPubkey): new mail for them
    // is refused from now on, their devices are dropped, and the mail
    // already here is deleted after limits.ts MEMBER_REMOVAL_GRACE_SECONDS.
    //
    // An optional second parameter, {"invitees": "keep" | "remove"}, says
    // what happens to the people they invited (storage.ts removeMember).
    // Without it, "keep". The note in `error` says what happened to them,
    // when there was anyone.
    case "unallowpubkey": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("unallowpubkey takes a pubkey, as npub or 64-character hex");
      const option = params[1] as { invitees?: unknown } | undefined | null;
      const choice = option?.invitees ?? "keep";
      if (
        (option !== undefined && option !== null && (typeof option !== "object" || Array.isArray(option))) ||
        (choice !== "keep" && choice !== "remove")
      ) {
        return err(
          'unallowpubkey: the second parameter is optional, {"invitees": "keep"} or {"invitees": "remove"}',
        );
      }
      const owner = getOwnerPubkey(sql, env) ?? signer;
      // A plain member may remove only people below them in the invite
      // tree (people they invited, and theirs), never themselves (that is
      // eraseme), and "keep" hangs the invitees under the member. The
      // owner and admins act on the whole tree, and "keep" hangs them
      // under the owner.
      const byMember = roleOf(sql, signer, owner) === "member";
      if (byMember) {
        if (pubkey === signer) return err(REMOVE_SELF_MESSAGE);
        if (!isBelow(sql, signer, pubkey, owner)) return err(REMOVE_OUTSIDE_SUBTREE_MESSAGE);
      }
      const newParent = byMember ? signer : owner;
      // Nobody but the owner removes an admin, directly or as part of a
      // subtree: admins are the owner's to give and take away.
      if (signer !== owner) {
        const affected =
          choice === "remove" ? invitedSubtree(sql, pubkey, owner) : [pubkey, ...ownKeysOf(sql, pubkey)];
        if (affected.some((member) => isAdmin(sql, member))) {
          return err(
            affected[0] !== undefined && isAdmin(sql, affected[0])
              ? "unallowpubkey: that member is an admin, and only the owner can remove an admin"
              : "unallowpubkey: someone they invited is an admin, and only the owner can remove an admin",
          );
        }
      }
      // Their own keys (addmykey) leave with them and are not "people they
      // invited".
      const invited = sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM allowed_pubkeys WHERE invited_by = ? AND source != 'own'`,
          pubkey,
        )
        .toArray()[0]?.n ?? 0;
      const removed = removeMember(sql, pubkey, owner, choice, nowSec, newParent);
      // The owner or an admin removing someone is on purpose: addmykey will
      // not bring any of these keys back until they are let back in
      // (storage.ts markRemovedOnPurpose).
      if (!byMember) markRemovedOnPurpose(sql, removed, nowSec);
      // Cut off from the home: out of its home groups too (home-groups.ts
      // GROUP_DECISIONS.cutOffLeavesGroups).
      const groupOutbox = removeFromAllGroups(sql, owner, removed, "cutoff", nowSec);
      if (removed.length === 0 || invited === 0) return { result: true, groupOutbox };
      if (choice === "remove") {
        const others = removed.length - 1;
        return {
          result: true,
          groupOutbox,
          error: `Also removed ${others === 1 ? "1 person" : `${others} people`} they invited, directly or through someone they invited.`,
        };
      }
      const by = newParent === signer ? "you" : "the owner";
      return {
        result: true,
        groupOutbox,
        error:
          invited === 1
            ? `The 1 person they invited is still a member, now listed as invited by ${by}.`
            : `The ${invited} people they invited are still members, now listed as invited by ${by}.`,
      };
    }

    case "listallowedpubkeys":
      return { result: listAllowedPubkeys(sql) };

    // The owner's view of NIP-29 invites (src/nip29.ts). No create method:
    // an invite is created by publishing a kind-9009, a signed part of the
    // group's history, and an HTTP path would be a second, unrecorded way
    // to do the same thing.
    //
    // These name spent, expired and unknown in full -- the distinction the
    // join path withholds on the wire (nip29.ts JOIN_REFUSAL_MESSAGE) --
    // because the caller here is the owner, who issued the codes.
    case "listunusedinvites":
      // Only invites redeemable right now; dead ones would bury the live
      // ones. Member invites carry `uses_left`; group invites are single
      // use and do not.
      // A member sees only their own member codes; the owner and admins
      // see every code, group ones included.
      if (isPlainMember(sql, env, signer)) return { result: listUnusedMemberInvites(sql, nowSec, signer) };
      return { result: [...listUnusedMemberInvites(sql, nowSec), ...listUnusedInvites(sql, nowSec)] };

    // Counts only, never a pubkey: how many members were seen lately, how
    // many messages arrived a day, how many joined a week, how many get
    // push, and what photos take. Owner and admins, who can already see
    // more than this (listmembers); never on the public /api/stats.
    case "homestats": {
      const photos = sqlitePhotoStore(sql).usedBytes();
      return {
        result: {
          ...homeStats(sql, nowSec, HOME_STATS_DAYS, HOME_STATS_WEEKS),
          photoBytes: photos,
          photoStorageLimit: photoStorageBytes(env),
        },
      };
    }

    case "myinvites": {
      const standing = inviteStanding(sql, env, signer, nowSec);
      return {
        result: {
          left: standing.left,
          limit: standing.limit,
          depth: standing.depth,
          canInvite: standing.canInvite,
          ...(standing.reason === undefined ? {} : { reason: standing.reason }),
        },
      };
    }

    case "revokeinvite": {
      const code = stringParam(params, 0);
      if (code === null || code === "") return err("revokeinvite takes the invite code as a string");
      // Member codes first: they are the relay's own 32-hex strings, so a
      // group code the owner chose cannot collide with one by accident.
      // A member can revoke only their own; anything else is "never
      // issued" to them, group codes included.
      const plain = isPlainMember(sql, env, signer);
      const memberOutcome = revokeMemberInvite(sql, code, nowSec, plain ? signer : null);
      if (plain && memberOutcome === "unknown") return err("revokeinvite: you have no invite with that code");
      switch (memberOutcome) {
        case "revoked":
          return { result: true };
        case "used-up":
          return err(
            "revokeinvite: that invite has been used as many times as it allows, so there is nothing left " +
              "to revoke. To remove someone it let in, call unallowpubkey with their pubkey.",
          );
        case "already-revoked":
          return err("revokeinvite: that invite was already revoked");
        case "unknown":
          break;
      }
      const outcome = revokeInvite(sql, code, nowSec);
      switch (outcome) {
        case "revoked":
          return { result: true };
        // Failures, not idempotent success: each means the owner's picture
        // was wrong, and "already redeemed" tells them somebody already
        // got in.
        case "spent":
          return err(
            "revokeinvite: that invite has already been redeemed, so there is nothing left to revoke -- " +
              "remove the member with a NIP-29 kind-9001 remove-user event instead",
          );
        case "already-revoked":
          return err("revokeinvite: that invite was already revoked");
        case "unknown":
          return err("revokeinvite: this relay has never issued that invite code");
      }
    }

    // A member invite: a code the relay generates, good for `uses`
    // redemptions (default 1) until it expires (default 7 days, at most
    // 30). Parameters are positional and both optional: [uses, seconds].
    // The response is the code and what it now allows, which is what the
    // owner shares.
    case "createinvite": {
      const uses = optionalCount(params, 0, MEMBER_INVITE_DEFAULT_USES, MEMBER_INVITE_MAX_USES);
      if (uses === null) {
        return err(`createinvite: uses must be a whole number from 1 to ${MEMBER_INVITE_MAX_USES}`);
      }
      const ttl = optionalCount(params, 1, INVITE_DEFAULT_TTL_SECONDS, INVITE_MAX_TTL_SECONDS);
      if (ttl === null) {
        return err(
          `createinvite: the lifetime must be a whole number of seconds from 1 to ${INVITE_MAX_TTL_SECONDS} (30 days)`,
        );
      }
      // A member makes codes within their allowance: refused outright when
      // they have none, and a code may admit at most the people they have
      // left.
      const standing = inviteStanding(sql, env, signer, nowSec);
      if (!standing.canInvite) return err(standing.reason!);
      if (standing.left !== null && uses > standing.left) {
        return err(
          `createinvite: you have ${standing.left} ${standing.left === 1 ? "invite" : "invites"} left, ` +
            `so a code can admit at most ${standing.left} ${standing.left === 1 ? "person" : "people"}`,
        );
      }
      if (countOutstandingMemberInvites(sql, nowSec, signer) >= MAX_OUTSTANDING_INVITES) {
        return err(
          `createinvite: ${MAX_OUTSTANDING_INVITES} invites are already waiting to be used. ` +
            `Revoke some with revokeinvite (listunusedinvites shows them) and try again.`,
        );
      }
      const code = bytesToHex(crypto.getRandomValues(new Uint8Array(MEMBER_INVITE_CODE_BYTES)));
      const expiresAt = nowSec + ttl;
      // The signer is the creator (owner, admin or member), and whoever
      // redeems it hangs from them.
      createMemberInvite(sql, code, uses, nowSec, expiresAt, signer);
      return { result: { code, uses, expires_at: expiresAt } };
    }

    // Any valid signature may call this (ANYONE_CALLABLE_METHODS); the
    // signer becomes the member. An existing member gets `true` without
    // spending a use, so a retry is safe. Every dead code gets the same
    // refusal (REDEEM_REFUSAL_MESSAGE).
    case "redeeminvite": {
      const code = stringParam(params, 0);
      if (code === null || code === "") return err("redeeminvite takes the invite code as a string");
      if (getOwnerPubkey(sql, env) === signer) return { result: true };
      const outcome = redeemMemberInvite(sql, code, signer, nowSec, getOwnerPubkey(sql, env));
      if (outcome === "joined" || outcome === "already-member") return { result: true };
      return err(REDEEM_REFUSAL_MESSAGE);
    }

    // Anyone may call this (ANYONE_CALLABLE_METHODS); the signer is who
    // asks. The result says where they stand, so their app can call it
    // again on every open: {"status": "pending", "expires_at"} while it
    // waits, "member" once approved (or if they already were), "declined"
    // for JOIN_REQUEST_TTL_SECONDS after a decline. Only a new request
    // messages the owner.
    case "requestjoin": {
      const owner = getOwnerPubkey(sql, env);
      if (owner === null) return err("requestjoin: this relay has no owner yet, so there is nobody to ask");
      if (signer === owner || isMember(sql, signer)) return { result: { status: "member" } };
      if (isPubkeyBanned(sql, signer)) return err("requestjoin: this relay does not accept requests from you");
      const details = parseJoinDetails(params[0]);
      if (typeof details === "string") return err(details);
      const outcome = recordJoinRequest(
        sql,
        signer,
        details.name,
        details.note,
        nowSec,
        JOIN_REQUEST_TTL_SECONDS,
        MAX_PENDING_JOIN_REQUESTS,
        details.via,
      );
      switch (outcome.status) {
        case "full":
          return err("requestjoin: too many requests are waiting for an answer here. Try again later.");
        case "declined":
          return { result: { status: "declined" } };
        case "pending":
          return { result: { status: "pending", expires_at: outcome.expiresAt } };
        case "created": {
          const result = { status: "pending", expires_at: outcome.expiresAt };
          // The request stands even if the owner's inbox is full; they
          // still see it in listjoinrequests.
          // One message per person who can answer: the owner and every
          // admin. Each is its own wrap, sealed to that person.
          const outbox: NostrEvent[] = [];
          for (const recipient of [owner, ...listAdmins(sql).map((a) => a.pubkey)]) {
            const { wrap } = joinRequestMessage(sql, recipient, signer, details.name, details.note, nowSec);
            const fits = mailRoom(
              sql,
              [recipient],
              wrapBytes(wrap.content, JSON.stringify(wrap.tags)),
              mailStorageBytes(env),
              mailBytesPerMember(env),
            );
            if (fits !== "ok") continue;
            const stored = storeEvent(sql, wrap, nowSec);
            if (stored.stored) outbox.push(stored.stored);
          }
          return { result, ...(outbox.length > 0 ? { outbox } : {}) };
        }
      }
    }

    case "listjoinrequests":
      return { result: listJoinRequests(sql, nowSec) };

    // Makes the requester a member with the owner as inviter. Nothing is
    // sent to them: their app learns it on its next requestjoin,
    // subscribepush or unsubscribepush.
    case "approvejoin": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("approvejoin takes a pubkey, as npub or 64-character hex");
      if (!approveJoinRequest(sql, pubkey, signer, nowSec)) {
        return err(
          "approvejoin: no request from that pubkey is waiting. To let someone in without one, use allowpubkey.",
        );
      }
      return { result: true };
    }

    case "declinejoin": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("declinejoin takes a pubkey, as npub or 64-character hex");
      if (!declineJoinRequest(sql, pubkey, nowSec, JOIN_REQUEST_TTL_SECONDS)) {
        return err("declinejoin: no request from that pubkey is waiting");
      }
      return { result: true };
    }

    // Members, and the removed ones whose mail has not been deleted yet.
    // Letting a removed one back in is allowpubkey, which stops the clock.
    // listmembers for the caller's own branch (storage.ts listInvitees):
    // the same row shape, for any member's "People you invited".
    // A plain member gets the rows without the activity fields (lastSeen,
    // push, waiting), which stay the owner's and admins' (v0.29): a member
    // does not see when a friend was last online. Owner and admins keep them.
    case "myinvitees": {
      const owner = getOwnerPubkey(sql, env) ?? signer;
      const listing = listInvitees(sql, MEMBER_REMOVAL_GRACE_SECONDS, owner, signer, nowSec);
      if (roleOf(sql, signer, owner) !== "member") return { result: listing };
      const strip = <T extends { lastSeen: unknown; push: unknown; waiting: unknown }>(row: T) => {
        const { lastSeen: _seen, push: _push, waiting: _waiting, ...rest } = row;
        return rest;
      };
      return { result: { members: listing.members.map(strip), removed: listing.removed.map(strip) } };
    }

    case "listmembers":
      return { result: listMembers(sql, MEMBER_REMOVAL_GRACE_SECONDS, getOwnerPubkey(sql, env) ?? signer) };

    // Owner only. An admin is a member too (made one if not already), with
    // the owner's member methods (ADMIN_CALLABLE_METHODS) and nothing
    // relay-level. Their join-request messages arrive like the owner's.
    case "addadmin": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("addadmin takes a pubkey, as npub or 64-character hex");
      const owner = getOwnerPubkey(sql, env);
      if (owner === null || pubkey === owner) {
        return err("addadmin: that is the owner's own key, which can already do everything an admin can");
      }
      addAdmin(sql, pubkey, owner, nowSec);
      return { result: true };
    }

    // Takes the role away; they stay a member. To remove them altogether,
    // unallowpubkey.
    case "removeadmin": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("removeadmin takes a pubkey, as npub or 64-character hex");
      if (!removeAdmin(sql, pubkey)) return err("removeadmin: that pubkey is not an admin");
      return { result: true };
    }

    case "listadmins":
      return { result: listAdmins(sql) };

    // The caller's role, and whether they have location trust (close).
    case "myrole": {
      const owner = getOwnerPubkey(sql, env);
      return { result: { role: roleOf(sql, signer, owner), close: isClose(sql, signer, owner) } };
    }

    // Location trust: the owner and admins turn it on or off for any
    // member (schema.ts `allowed_pubkeys.close`). The owner always has it.
    case "setclose": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null || typeof params[1] !== "boolean") {
        return err("setclose takes a pubkey, as npub or hex, and true or false");
      }
      switch (setClose(sql, pubkey, params[1], getOwnerPubkey(sql, env))) {
        case "ok":
          return { result: true };
        case "owner":
          return err("setclose: the owner always sees where photos were taken");
        case "not-member":
          return err("setclose: that pubkey is not a member of this home");
      }
    }

    // For each named pubkey, whether it and the caller may see each
    // other's photo locations: true only when both are close, so a caller
    // without the flag gets all false. Works whatever MEMBER_LIST says,
    // since the caller names them.
    case "areclose": {
      const pubkeys = params[0];
      if (
        !Array.isArray(pubkeys) ||
        pubkeys.length === 0 ||
        pubkeys.length > MAX_ARECLOSE_PUBKEYS ||
        !pubkeys.every((p) => typeof p === "string" && HEX_ID_RE.test(p))
      ) {
        return err(`areclose takes an array of 1 to ${MAX_ARECLOSE_PUBKEYS} pubkeys, as 64-character hex`);
      }
      return { result: areClose(sql, signer, pubkeys as string[], getOwnerPubkey(sql, env)) };
    }

    // bothy's own; the client half is hearth's subscribeToPush. The pubkey
    // stored is `signer` and nothing else -- the parameters carry a
    // device, not an identity.
    case "subscribepush": {
      // Refused without a VAPID key: a subscription that can never be
      // pushed to is a device endpoint held for nothing. Clients only call
      // this after reading `push_key` from NIP-11, so this normally means
      // the key was removed in between.
      if (!pushConfigured(env)) {
        return err(
          "subscribepush: this relay advertises no push_key, so it cannot send push notifications and " +
            "will not keep a subscription it can never use",
        );
      }
      const parsed = parsePushSubscription(params[0]);
      if (typeof parsed === "string") return err(parsed);
      // Optional {"label": "..."}: the app's own tag for this account,
      // echoed in every push to this device (push.ts PushPayload). Short
      // and plain so it cannot carry a pubkey or anything else the push
      // service should not read.
      const label = parsePushLabel(params[1]);
      if (label === undefined) {
        return err(
          'subscribepush: the second parameter is optional, {"label": "..."} with 1 to 16 letters, digits, "_" or "-"',
        );
      }
      upsertPushSubscription(
        sql,
        { ...parsed, pubkey: signer, label },
        MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY,
        nowSec,
      );
      return { result: true };
    }

    // Android's subscribepush: an FCM registration token instead of a web
    // push subscription, and the same optional label. Refused without a
    // service account, as subscribepush is without a VAPID key.
    case "subscribefcm": {
      if (!fcmConfigured(env)) {
        return err(
          "subscribefcm: this relay has no FCM service account, so it cannot send Android notifications and " +
            "will not keep a token it can never use",
        );
      }
      const token = stringParam(params, 0);
      if (token === null || !FCM_TOKEN_RE.test(token)) {
        return err("subscribefcm takes the app's FCM registration token as a string");
      }
      const label = parsePushLabel(params[1]);
      if (label === undefined) {
        return err(
          'subscribefcm: the second parameter is optional, {"label": "..."} with 1 to 16 letters, digits, "_" or "-"',
        );
      }
      upsertFcmToken(sql, { token, pubkey: signer, label }, MAX_FCM_TOKENS_PER_PUBKEY, nowSec);
      return { result: true };
    }

    // `true` whether or not a row went, and only the signer's, as
    // unsubscribepush.
    case "unsubscribefcm": {
      const token = stringParam(params, 0);
      if (token === null || token === "") return err("unsubscribefcm takes the FCM registration token as a string");
      deleteFcmToken(sql, signer, token);
      return { result: true };
    }

    // The home's file server: its URL (advertised as NIP-11 `storage`)
    // and the pubkey its memberkeys calls are signed with. Owner only.
    // An empty URL clears both.
    case "setstorage": {
      const url = stringParam(params, 0);
      if (url === "") {
        setRelaySetting(sql, "storage_url", "");
        setRelaySetting(sql, "storage_pubkey", "");
        return { result: true };
      }
      let valid = false;
      try {
        valid = url !== null && url.length <= 512 && new URL(url).protocol === "https:";
      } catch {
        valid = false;
      }
      if (!valid) {
        return err('setstorage takes the storage server\'s https URL and its pubkey; "" as the URL clears both');
      }
      const pubkey = pubkeyParam(params, 1);
      if (pubkey === null) return err("setstorage: the second parameter is the storage service's pubkey, as npub or hex");
      setRelaySetting(sql, "storage_url", url!);
      setRelaySetting(sql, "storage_pubkey", pubkey);
      return { result: true };
    }

    // Owner only: what setstorage last stored, for the admin page's File
    // server section. {url, pubkey}, or null when none is set.
    case "getstorage": {
      const settings = getRelaySettings(sql);
      return {
        result:
          settings.storageUrl && settings.storagePubkey
            ? { url: settings.storageUrl, pubkey: settings.storagePubkey }
            : null,
      };
    }

    // For the storage service alone (STORAGE_CALLABLE_METHODS): who may
    // upload and who has left. Pubkeys only.
    case "memberkeys":
      return { result: memberKeys(sql, getOwnerPubkey(sql, env), MEMBER_REMOVAL_GRACE_SECONDS) };

    // When this relay stored each of the signer's own gift wraps, for
    // ordering ties. Up to 500 ids; ids that are not the signer's mail are
    // left out of the answer.
    case "mailtimes": {
      const ids = params[0];
      if (
        !Array.isArray(ids) ||
        ids.length === 0 ||
        ids.length > MAX_MAILTIMES_IDS ||
        !ids.every((id) => typeof id === "string" && HEX_ID_RE.test(id))
      ) {
        return err(`mailtimes takes an array of 1 to ${MAX_MAILTIMES_IDS} event ids, as 64-character hex`);
      }
      // Optional {"seq": true}: each value becomes {storedAt, seq}, adding
      // the home's sequence number for the wrap (schema.ts events.seq).
      // Without it the answer stays a number per id, as before.
      const option = params[1] as { seq?: unknown } | undefined | null;
      if (option !== undefined && option !== null && (typeof option !== "object" || Array.isArray(option))) {
        return err('mailtimes: the second parameter is optional, {"seq": true}');
      }
      return { result: mailTimes(sql, signer, ids as string[], option?.seq === true) };
    }

    // A member deleting their own account (storage.ts eraseMember): the
    // membership ends, their devices are dropped, their mail and photo
    // here are deleted at once, their place goes back to whoever invited
    // them, and the people they invited stay, under that person. An admin
    // stops being one. The owner cannot: the relay is theirs.
    case "eraseme": {
      const owner = getOwnerPubkey(sql, env);
      if (signer === owner) {
        return err("eraseme: the relay owner cannot erase themselves; the relay itself is your account here");
      }
      // A first batch now; any rest goes on the hourly sweep at once (no
      // grace), since one call deleting a large mailbox could spend the
      // day's rows written (limits.ts ERASE_MAIL_BATCH).
      const erased = [signer, ...ownKeysOf(sql, signer)];
      const deleted = eraseMember(sql, signer, owner, nowSec, ERASE_MAIL_BATCH);
      const left = mailLeftFor(sql, signer, owner, ERASE_MAIL_BATCH);
      // Out of every home group, by a bothy-signed removal; their past
      // messages stay for the others.
      const groupOutbox = removeFromAllGroups(sql, owner, erased, "erased", nowSec);
      return { result: { erased: true, messagesDeleted: deleted, messagesLeft: left }, groupOutbox };
    }

    // The signer's own mailbox here, and the home's: how much is stored
    // against each cap (limits.ts mailBytesPerMember, mailStorageBytes),
    // so an app can say "your mailbox is 80% full" before a sender hears
    // it is full. Limits are null when off.
    // Who is in the home: every member and the owner, as hex pubkeys, and
    // nothing else (no inviter, dates, roles or removed list; listmembers
    // keeps those for the owner and admins). With MEMBER_LIST=hidden a
    // plain member gets an empty list and MEMBER_LIST_HIDDEN_NOTE; the
    // owner and admins still get it.
    // The restore vault (src/vault.ts), a member's own rows. vaultput's key
    // was imported by relay.ts manage before this ran.
    case "vaultput": {
      const input = parseVaultPut(params, signer);
      if (typeof input === "string") return err(input);
      const refusal = storeVaultRow(sql, env, input, signer, nowSec);
      return refusal === null ? { result: true } : err(refusal);
    }

    case "vaultlist":
      return { result: listVaultRows(sql, signer) };

    case "vaultdelete": {
      const [hash] = params;
      if (!isVaultHash(hash)) return err("vaultdelete: the parameter must be the row's hash");
      deleteVaultRow(sql, hash, signer);
      return { result: true };
    }

    // Another key of the caller's own (src/own-keys.ts). The Worker has
    // checked the proof signed by that key; this decides whether it may
    // join: not a member already, not banned, not removed on purpose, and
    // within limits.ts ownKeysPerMember. It joins under the caller, at the
    // caller's depth, spending no invite place.
    case "addmykey": {
      const cap = ownKeysPerMember(env);
      if (cap === null) return err("addmykey: this home does not take own keys");
      const child = pubkeyParam(params, 0);
      if (child === null) return err("addmykey: it takes [your other key, as npub or hex, and its proof event]");
      if (child === signer) return err("addmykey: that is the key you are signing with");
      switch (addOwnKey(sql, signer, child, nowSec, cap)) {
        case "added":
          return { result: true };
        case "already-member":
          return err("addmykey: that key is already a member here");
        case "banned":
          return err("addmykey: that key is banned here");
        case "removed-on-purpose":
          return err("addmykey: that account was removed from this home. Ask the owner or an admin to let it back in.");
        case "too-many":
          return err(`addmykey: at most ${cap} own keys each`);
      }
    }

    // The owner forgetting that someone was removed on purpose, so their
    // key can come back through addmykey. Letting them back in does the
    // same.
    case "forgetremoval": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("forgetremoval takes a pubkey, as npub or 64-character hex");
      return { result: { forgotten: clearRemovalMark(sql, pubkey) } };
    }

    // History backup (storage.ts recordBackedUp): the caller's app has
    // verified a backup that holds their mail up to `mailThrough`, a stored
    // time (mailtimes' storedAt). The watermark moves forward only, never
    // past now, and the answer is what is stored after the call. The owner
    // may call it too: it is stored like anyone's, and changes nothing,
    // since the owner's mail is never deleted.
    case "backedup": {
      const [mailThrough] = params;
      if (typeof mailThrough !== "number" || !Number.isSafeInteger(mailThrough) || mailThrough < 0) {
        return err(BACKEDUP_PARAM_MESSAGE);
      }
      return { result: { watermark: recordBackedUp(sql, signer, mailThrough, nowSec) } };
    }

    // Owner only: mailbox retention on or off (storage.ts sweepRetention).
    // Off by default. On is refused while the home has nowhere for
    // backups to go (storage.ts hasBackRoom). Clearing the file server
    // later leaves the switch on but stops the deleting, at the next tick.
    case "setretention": {
      const [on] = params;
      if (typeof on !== "boolean") return err(SETRETENTION_PARAM_MESSAGE);
      if (on && !hasBackRoom(sql)) return err(RETENTION_NEEDS_STORAGE_MESSAGE);
      setRelaySetting(sql, "mail_retention", on ? "on" : "");
      return { result: true };
    }

    // Owner only: the switch, whether a file server is set (deleting
    // happens only with both), how many members' apps have reported a
    // backup, and after how many days.
    case "getretention":
      return {
        result: {
          on: mailRetentionOn(sql),
          storage: hasBackRoom(sql),
          backedUp: backedUpMemberCount(sql),
          days: MAIL_RETENTION_SECONDS / 86400,
        },
      };

    case "homemembers": {
      const owner = getOwnerPubkey(sql, env);
      const role = roleOf(sql, signer, owner);
      if (memberListVisibility(env) === "hidden" && role !== "owner" && role !== "admin") {
        return { result: { members: [], hidden: true, note: MEMBER_LIST_HIDDEN_NOTE } };
      }
      return { result: { members: homeMemberPubkeys(sql, owner) } };
    }

    case "mymailbox": {
      const own = mailUsage(sql, signer);
      const home = mailUsage(sql, null);
      return {
        result: {
          messages: own.messages,
          usedBytes: own.bytes,
          limitBytes: mailBytesPerMember(env),
          homeUsedBytes: home.bytes,
          homeLimitBytes: mailStorageBytes(env),
        },
      };
    }

    case "unsubscribepush": {
      const endpoint = stringParam(params, 0);
      if (endpoint === null || endpoint === "") {
        return err("unsubscribepush takes the subscription endpoint as a string");
      }
      // `true` whether or not a row went: the goal is the state "this
      // device is not registered", which holds either way. Scoped to the
      // signer inside deletePushSubscription, so one member cannot unhook
      // another's device (endpoints are not secret).
      deletePushSubscription(sql, signer, endpoint);
      return { result: true };
    }

    case "blockip": {
      const ip = stringParam(params, 0);
      if (ip === null || ip === "") return err("blockip takes a non-empty IP address string");
      const reason = optionalReason(params, 1);
      // Self-block is allowed, but never on the first try: it is a
      // legitimate want (a shared exit node, a test) and also the likeliest
      // accidental lockout, so it costs one extra deliberate call.
      //
      // Compared through normalizeIp (ip.ts), not as raw strings: the
      // operator's typed form and Cloudflare's CF-Connecting-IP form can
      // spell the same IPv6 address differently, and a literal `===` would
      // skip this warning.
      if (normalizeIp(ip) === normalizeIp(callerIp) && reason !== SELF_BLOCK_CONFIRMATION) {
        return err(
          `${ip} is the address this management request arrived from. Blocking it will refuse WebSocket ` +
            `connections from this address. The management API is never IP-blocked, so you will still be able ` +
            `to call unblockip from here afterwards. To proceed, call blockip again with the reason parameter ` +
            `set to exactly: ${SELF_BLOCK_CONFIRMATION}`,
        );
      }
      blockIp(sql, ip, reason, nowSec);
      return { result: true };
    }

    case "unblockip": {
      const ip = stringParam(params, 0);
      if (ip === null || ip === "") return err("unblockip takes a non-empty IP address string");
      unblockIp(sql, ip);
      return { result: true };
    }

    case "listblockedips":
      return { result: listBlockedIps(sql) };

    case "changerelayname":
      return changeIdentity(sql, params, "name", method, "RELAY_NAME", env.RELAY_NAME);

    case "changerelaydescription":
      return changeIdentity(sql, params, "description", method, "RELAY_DESCRIPTION", env.RELAY_DESCRIPTION);

    case "changerelayicon":
      return changeIdentity(sql, params, "icon", method, "RELAY_ICON", env.RELAY_ICON);

    // The write policy (src/write-policy.ts), resolved env, then stored,
    // then default. relay.ts clears its cached policy after every
    // management call, so a change applies to the next event.
    case "changewritepolicy": {
      const raw = params[0];
      if (raw === "") {
        setRelaySetting(sql, "write_policy", "");
        return { result: true, error: writePolicyNote(sql, env, "Cleared the stored write policy.") };
      }
      const policy = parsePolicy(raw);
      if (policy === null) {
        return err(
          `changewritepolicy takes one parameter, a policy name: ${WRITE_POLICIES.join(", ")}. ` +
            `An empty string clears the stored policy.`,
        );
      }
      // `all` is never accepted on the first try (the blockip self-block
      // shape): it is the one policy not bounded by people the owner
      // chose, and the command is one word long.
      if (policy === "all" && params[1] !== OPEN_POLICY_CONFIRMATION) {
        return err(
          `changewritepolicy: "all" lets anyone publish any event to this relay, bounded only by the ` +
            `per-event size cap, the per-pubkey rate cap and the storage share reserved for you. ` +
            `Every other policy is bounded by people you chose. To proceed, call changewritepolicy again ` +
            `with "all" and a second parameter set to exactly: ${OPEN_POLICY_CONFIRMATION}`,
        );
      }
      setRelaySetting(sql, "write_policy", policy);
      return { result: true, error: writePolicyNote(sql, env, `Stored write policy "${policy}".`) };
    }

    case "getwritepolicy": {
      const resolved = resolveWritePolicy(env, getStoredWritePolicy(sql));
      return {
        result: {
          policy: resolved.policy,
          source: resolved.source,
          description: POLICY_DESCRIPTIONS[resolved.policy],
          policies: WRITE_POLICIES.map((name) => ({ name, description: POLICY_DESCRIPTIONS[name] })),
        },
      };
    }

    // Answered with an explanation rather than the unknown-method
    // fallback, which would read as "not built yet": bothy stores every
    // kind on purpose and will never have a kind allowlist.
    case "allowkind":
    case "disallowkind":
    case "listallowedkinds":
      return err(
        `${method} is not supported: bothy stores every event kind deliberately and keeps no kind allowlist, ` +
          `so there is nothing to allow or disallow. Use banevent to remove a specific event.`,
      );

    default:
      return err(`unknown method '${method}' -- call supportedmethods for the list this relay implements`);
  }
}
