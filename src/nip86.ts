// NIP-86 relay management API (nips/86.md), method dispatch. This is the
// half that touches storage, so it runs inside the Durable Object, via
// Relay.manage() -- authentication (src/nip98.ts) has already happened in
// the Worker by the time anything here is called, and nothing here opens
// an outbound connection.
//
// Phase one deliberately implemented only the methods that cost nothing
// on the per-event write path. banpubkey/allowpubkey and their list
// methods (phase two, CLAUDE.md "The budget") are the one addition that costs a
// per-event lookup, added only once a metrics baseline existed to compare
// against. bothy pairs each with its own inverse (unbanpubkey,
// unallowpubkey) for symmetry with blockip/unblockip, rather than
// overloading allowpubkey to mean both "grant write access" and "lift a
// ban" the way allowevent lifts a banevent tombstone -- banned_pubkeys and
// allowed_pubkeys are two independent lists, not opposite ends of one.
// supportedmethods reports exactly what is here, which is what makes a
// partial implementation conformant rather than broken.
import {
  allowEvent,
  allowPubkey,
  banEvent,
  banPubkey,
  blockIp,
  deletePushSubscription,
  listAllowedPubkeys,
  listBannedEvents,
  listBannedPubkeys,
  listBlockedIps,
  listUnusedInvites,
  revokeInvite,
  setRelaySetting,
  unallowPubkey,
  unbanPubkey,
  unblockIp,
  upsertPushSubscription,
} from "./storage";
import { MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY } from "./limits";
import { pushConfigured } from "./push";
import { getOwnerPubkey } from "./ownership";
import { normalizeIp } from "./ip";
import { normalizePubkey } from "./pubkey";

// nips/86.md: "a JSON-RPC-like request-response protocol over HTTP, on
// the same URI as the relay's websocket", distinguished by this
// content-type. Matched as a substring, never by equality -- clients send
// compound types ("application/nostr+json+rpc; charset=utf-8"), the same
// trap eb59501 fixed for the NIP-11 Accept header.
export const MANAGEMENT_CONTENT_TYPE = "application/nostr+json+rpc";

// nips/86.md: {"result": <value>, "error": "<optional error message>"}.
// `error` is not strictly a failure channel here -- the change* methods
// use it to carry an advisory note alongside a successful result, which
// is the only field the protocol gives them to say anything in.
export interface ManagementResponse {
  result?: unknown;
  error?: string;
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
  // bothy's own, not NIP-86's. The spec defines no invite methods at all,
  // so these two are an extension in the same spirit as the empty-string
  // unset convention on the change* methods, and are documented in the
  // README beside it.
  // Named plainly rather than under a vendor prefix, because
  // supportedmethods is the discovery mechanism and a client that reads
  // this list learns what is here without needing to know whose idea it
  // was. If NIP-86 ever standardises these names with different
  // semantics, this is the line that has to change.
  "listunusedinvites",
  "revokeinvite",
  // bothy's own as well, and the one pair on this list a member may call
  // rather than only the owner -- see MEMBER_CALLABLE_METHODS below. The
  // subscription belongs to whoever signed the NIP-98 event, so the call
  // has to be reachable by them and by nobody speaking for them.
  "subscribepush",
  "unsubscribepush",
] as const;

// The methods a GROUP MEMBER may call, not just the owner.
//
// Every other method here administers the relay, and index.ts refuses a
// signature that is not the owner's before dispatch ever happens. These
// two do not administer anything: they register and remove one device's
// push endpoint, and reference/push.md is explicit that "the signer of
// that event is the member the subscription belongs to". A member who
// could not call them could not be notified, which would leave push as
// an owner-only feature in a room built for a group.
//
// Widening the gate this far and no further is the whole point of the
// list being a list. index.ts checks membership only for a method named
// here, so the owner-only refusal is still what every other method gets,
// and a member's signature buys them nothing except their own
// subscription row.
export const MEMBER_CALLABLE_METHODS: readonly string[] = ["subscribepush", "unsubscribepush"];

// The exact string blockip demands back as its `reason` before it will
// block the address the management request itself came from. Chosen to
// be unmistakably deliberate and impossible to send by accident, and
// quoted verbatim in the refusal so the operator never has to guess at
// spelling or punctuation.
export const SELF_BLOCK_CONFIRMATION = "yes, block my own address";

const HEX_ID_RE = /^[0-9a-f]{64}$/;

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

// Accepts npub or hex, same as the relay's own claim endpoint (CLAUDE.md
// "Configuration": "Accept npub1..., and hex, normalize to hex at the
// boundary, store hex only") -- an operator reaching for these methods
// most naturally has an npub in hand, not the hex form.
function pubkeyParam(params: unknown[], index: number): string | null {
  const value = params[index];
  return typeof value === "string" ? normalizePubkey(value) : null;
}

// The advisory note every successful change* call carries back in the
// `error` field. Two things every operator needs and NIP-86 gives them no
// other way to learn: that an empty string is the unset operation (the
// spec defines none, so this is bothy's convention -- README.md "Relay
// management API"), and that the value which actually takes effect is
// whatever the NIP-11 document reports, not necessarily what was just
// stored. When an environment variable outranks the stored value, that is
// said plainly here too, because the alternative -- refusing the call, or
// storing silently -- either loses the operator's input or lies about it.
function identityNote(
  field: "name" | "description" | "icon",
  method: string,
  envVarName: string,
  envValue: string | undefined,
  cleared: boolean,
): string {
  const parts = [
    cleared ? `Cleared the stored relay ${field}.` : `Stored the relay ${field}.`,
  ];
  if (envValue) {
    parts.push(
      `Note: ${envVarName} is set in this deployment's environment and takes precedence over the stored value, ` +
        `so the stored value takes effect only once ${envVarName} is cleared in the Cloudflare dashboard.`,
    );
  }
  parts.push(
    `Calling ${method} with an empty string is what clears the stored value, falling back to the owner's ` +
      `kind-0 profile and then to the built-in default.`,
  );
  parts.push(
    `The value actually in effect is whatever this relay's NIP-11 document reports -- request it with an ` +
      `Accept: application/nostr+json header.`,
  );
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
  return { result: true, error: identityNote(field, method, envVarName, envValue, value === "") };
}

// The subscription object hearth sends as subscribepush's one parameter
// -- `JSON.parse(JSON.stringify(pushSubscription))`, which is the browser's
// own serialization of a PushSubscription.
//
// Validated to the byte here rather than at send time, because a row that
// cannot be encrypted to is a row that fails once per message forever:
// RFC 8291 wants `p256dh` to be an uncompressed P-256 point (65 bytes,
// leading 0x04) and `auth` to be exactly the 16-byte auth secret, and
// neither is something a later check can repair. `expirationTime` is
// accepted and ignored -- it is null in every browser that ships push
// today, and a relay acting on an expiry it was told rather than on the
// 410 the push service will send is trusting the wrong party.
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
  // https only, and length-bounded. The endpoint is a URL this relay will
  // POST to on its own initiative, so it is the one field a caller
  // controls that turns into outbound traffic -- an http:// or file://
  // endpoint is not a push service, and an unbounded one is a stored
  // string with no reason to be long.
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

// `callerIp` is the address the management request itself arrived from
// (CF-Connecting-IP), threaded through from the Worker purely so blockip
// can recognize a self-block. It is never used to authorize anything --
// authorization is the NIP-98 signature and nothing else.
//
// `signer` is the pubkey that signature proved, and it is used by exactly
// one pair of methods: subscribepush/unsubscribepush bind a device to
// their caller. It is not an authorization input either -- index.ts has
// already decided this caller may make this call -- it is the ANSWER to
// "whose device is this", which the request body is deliberately not
// allowed to give (reference/push.md, schema.ts `push_subscriptions`).
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

  switch (method) {
    case "supportedmethods":
      return { result: [...SUPPORTED_METHODS] };

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
      // The one invariant this method can never be allowed to violate --
      // see ownership.ts isAllowedWriter, which trusts that a banned
      // pubkey is never the owner and so never checks for that case on
      // the write path itself.
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

    // A manual allowlist, independent of banned_pubkeys -- see the header
    // comment above. Grants write access to a pubkey the owner doesn't
    // follow (or, with ALLOW_FOLLOWS off, to anyone named individually)
    // without opening writes more broadly.
    case "allowpubkey": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("allowpubkey takes a pubkey, as npub or 64-character hex");
      allowPubkey(sql, pubkey, optionalReason(params, 1), nowSec);
      return { result: true };
    }

    case "unallowpubkey": {
      const pubkey = pubkeyParam(params, 0);
      if (pubkey === null) return err("unallowpubkey takes a pubkey, as npub or 64-character hex");
      unallowPubkey(sql, pubkey);
      return { result: true };
    }

    case "listallowedpubkeys":
      return { result: listAllowedPubkeys(sql) };

    // The admin's window onto NIP-29 invites (src/nip29.ts). Two methods
    // and no create: an invite is CREATED by publishing a kind-9009,
    // which is a signed part of the group's history, and offering a
    // second way in through an HTTP call would put the same act on two
    // paths with only one of them recorded in the group.
    //
    // What the owner cannot do without these is see a link they issued
    // and kill it. Both are answered in full here, spelling out spent
    // from expired from unknown -- the exact distinction the join path
    // refuses to make on the wire (nip29.ts JOIN_REFUSAL_MESSAGE). The
    // difference is who is asking: this endpoint is authenticated by a
    // NIP-98 signature from the owner, and there is nothing to keep from
    // the person who issued the code.
    case "listunusedinvites":
      // Unused means redeemable right now -- unspent, unrevoked and not
      // yet expired. A code that is none of those is not a link the admin
      // can still do anything about, and listing the dead ones would bury
      // the live ones. `expires_at` is on every row because it is the
      // thing that decides whether to re-send a link or reissue it.
      return { result: listUnusedInvites(sql, nowSec) };

    case "revokeinvite": {
      const code = stringParam(params, 0);
      if (code === null || code === "") return err("revokeinvite takes the invite code as a string");
      const outcome = revokeInvite(sql, code, nowSec);
      switch (outcome) {
        case "revoked":
          return { result: true };
        // Reported as failures rather than as an idempotent success,
        // because each one means the admin was looking at something other
        // than what they thought. "Already used" in particular is the
        // answer to a question they urgently have -- revoking a code to
        // stop somebody getting in, and being told somebody already did.
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

    // bothy's own, and the client half is hearth's subscribeToPush
    // (reference/push.md). The pubkey stored is `signer` and nothing else
    // -- the parameters carry a device, not an identity.
    case "subscribepush": {
      // Refused rather than stored when this deployment has no VAPID key,
      // because a stored subscription that can never be pushed to is a
      // device endpoint held for nothing -- and holding one is the whole
      // cost reference/push.md asks the person to weigh. A client only
      // reaches this method after reading `push_key` off the NIP-11
      // document, so the ordinary way to see this error is a key removed
      // between the two.
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
      // `true` whether or not a row went, because the caller's goal is a
      // state ("this device is not registered") and that state holds
      // either way. hearth calls this on its way to `sub.unsubscribe()`
      // and swallows the answer; a failure here would only be noise on a
      // path where nothing is wrong. Scoped to the signer inside
      // deletePushSubscription -- one member must not be able to unhook
      // another's phone.
      deletePushSubscription(sql, signer, endpoint);
      return { result: true };
    }

    case "blockip": {
      const ip = stringParam(params, 0);
      if (ip === null || ip === "") return err("blockip takes a non-empty IP address string");
      const reason = optionalReason(params, 1);
      // Self-block is allowed, but never on the first try. Blocking the
      // address you are calling from is a legitimate thing to want (a
      // shared exit node, a test), and it is also the single most
      // plausible way to lock yourself out of your own relay by
      // accident -- so it costs one extra deliberate call.
      //
      // Compared through normalizeIp (ip.ts), not as raw strings: `ip` is
      // whatever the operator typed, `callerIp` is Cloudflare's own
      // CF-Connecting-IP form, and an IPv6 address written two different
      // ways (expanded vs. compressed) is the same address failing a
      // literal `===`. Missing that would skip this very warning -- and
      // since blockIp below normalizes the same way, the block it then
      // stores would silently never match the operator's own future
      // connections, which is worse than the lockout this check exists to
      // prevent: listblockedips would report it active while it blocks
      // nothing.
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

    // Implemented as an explanation rather than left to the
    // unknown-method fallback below. "Unknown method" would read as
    // "not built yet"; the truth is that bothy stores every kind on
    // purpose (CLAUDE.md "What it refuses to be"), so an operator
    // reaching for a kind allowlist should be told the design answer,
    // not left waiting for a feature that is never coming.
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
