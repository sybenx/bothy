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
  removeMember,
  countOutstandingMemberInvites,
  declineJoinRequest,
  giftWrapCount,
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
  MEMBER_INVITE_CODE_BYTES,
  MEMBER_INVITE_DEFAULT_USES,
  MEMBER_INVITE_MAX_USES,
  JOIN_REQUEST_NAME_MAX_LENGTH,
  JOIN_REQUEST_NOTE_MAX_LENGTH,
  JOIN_REQUEST_TTL_SECONDS,
  MAX_PENDING_JOIN_REQUESTS,
  maxGiftWraps,
  MEMBER_REMOVAL_GRACE_SECONDS,
} from "./limits";
import { GROUPS_PAUSED_MESSAGE } from "./nip29";
import { pushConfigured } from "./push";
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
  // bothy's own; the one pair a member may call, not only the owner
  // (MEMBER_CALLABLE_METHODS below).
  "subscribepush",
  "unsubscribepush",
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
export const MEMBER_CALLABLE_METHODS: readonly string[] = ["subscribepush", "unsubscribepush"];

// The method ANY valid signature may call: redeeminvite, whose caller is
// by definition not a member yet. The code is the authority, and the
// signature only says who is joining (the pubkey stored is the signer's,
// never one from the body).
//
// requestjoin likewise: the requester is not a member, and asking is the
// point. relay.ts throttles it per address before dispatch.
export const ANYONE_CALLABLE_METHODS: readonly string[] = ["redeeminvite", "requestjoin"];

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
      return { result: true };
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
      const invited = sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM allowed_pubkeys WHERE invited_by = ?`, pubkey)
        .toArray()[0]?.n ?? 0;
      const removed = removeMember(sql, pubkey, owner, choice, nowSec);
      if (removed.length === 0 || invited === 0) return { result: true };
      if (choice === "remove") {
        const others = removed.length - 1;
        return {
          result: true,
          error: `Also removed ${others === 1 ? "1 person" : `${others} people`} they invited, directly or through someone they invited.`,
        };
      }
      return {
        result: true,
        error:
          invited === 1
            ? "The 1 person they invited is still a member, now listed as invited by you."
            : `The ${invited} people they invited are still members, now listed as invited by you.`,
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
      return { result: [...listUnusedMemberInvites(sql, nowSec), ...listUnusedInvites(sql, nowSec)] };

    case "revokeinvite": {
      const code = stringParam(params, 0);
      if (code === null || code === "") return err("revokeinvite takes the invite code as a string");
      // Member codes first: they are the relay's own 32-hex strings, so a
      // group code the owner chose cannot collide with one by accident.
      const memberOutcome = revokeMemberInvite(sql, code, nowSec);
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
      if (countOutstandingMemberInvites(sql, nowSec) >= MAX_OUTSTANDING_INVITES) {
        return err(
          `createinvite: ${MAX_OUTSTANDING_INVITES} invites are already waiting to be used. ` +
            `Revoke some with revokeinvite (listunusedinvites shows them) and try again.`,
        );
      }
      const code = bytesToHex(crypto.getRandomValues(new Uint8Array(MEMBER_INVITE_CODE_BYTES)));
      const expiresAt = nowSec + ttl;
      // The signer is the creator: always the owner today (only the owner
      // reaches this method), and whoever redeems it hangs from them.
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
          if (giftWrapCount(sql) >= maxGiftWraps(env)) return { result };
          const { wrap } = joinRequestMessage(sql, owner, signer, details.name, details.note, nowSec);
          const stored = storeEvent(sql, wrap, nowSec);
          return { result, ...(stored.stored ? { outbox: [stored.stored] } : {}) };
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
    case "listmembers":
      return { result: listMembers(sql, MEMBER_REMOVAL_GRACE_SECONDS, signer) };

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
      upsertPushSubscription(
        sql,
        { ...parsed, pubkey: signer },
        MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY,
        nowSec,
      );
      return { result: true };
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
