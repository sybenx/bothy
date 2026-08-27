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
  listAllowedPubkeys,
  listBannedEvents,
  listBannedPubkeys,
  listBlockedIps,
  setRelaySetting,
  unallowPubkey,
  unbanPubkey,
  unblockIp,
} from "./storage";
import { getOwnerPubkey } from "./ownership";
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
] as const;

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

// `callerIp` is the address the management request itself arrived from
// (CF-Connecting-IP), threaded through from the Worker purely so blockip
// can recognize a self-block. It is never used to authorize anything --
// authorization is the NIP-98 signature and nothing else.
export function handleManagementCall(
  sql: SqlStorage,
  env: Env,
  method: unknown,
  params: unknown[],
  callerIp: string,
  nowSec: number,
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

    case "blockip": {
      const ip = stringParam(params, 0);
      if (ip === null || ip === "") return err("blockip takes a non-empty IP address string");
      const reason = optionalReason(params, 1);
      // Self-block is allowed, but never on the first try. Blocking the
      // address you are calling from is a legitimate thing to want (a
      // shared exit node, a test), and it is also the single most
      // plausible way to lock yourself out of your own relay by
      // accident -- so it costs one extra deliberate call.
      if (ip === callerIp && reason !== SELF_BLOCK_CONFIRMATION) {
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
