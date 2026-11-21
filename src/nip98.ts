// NIP-98 HTTP Auth (nips/98.md), as NIP-86 requires it. Runs in the
// Worker, never inside the Durable Object, so a forged request costs no DO
// time. The DO only ever sees a management call that already passed this.
//
// NIP-86 makes the `payload` tag required ("except the `payload` tag is
// required"), where bare NIP-98 makes it optional, so the signature always
// binds the exact body.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";

// nips/98.md: "kind 27235... referencing RFC 7235".
export const HTTP_AUTH_KIND = 27235;

// nips/98.md: created_at must be "within a reasonable time window
// (suggestion 60 seconds)". Taken as the suggestion, both directions --
// a signature from the future is no more trustworthy than a stale one.
export const HTTP_AUTH_MAX_DRIFT_SECONDS = 60;

export type Nip98Result =
  | { ok: true; pubkey: string }
  // The handler answers 401 either way (nips/98.md); the reason goes in
  // the body so an operator can tell clock skew from a wrong `u` tag.
  | { ok: false; reason: string };

function tagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag?.[1] ?? null;
}

// Compares canonical forms, so a hand-typed URL differing only in what
// `new URL()` normalizes (missing path, default port, percent-encoding
// case) still matches request.url, while host, path and query stay bound
// exactly.
function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

// nips/98.md: "base64 encoded... using the Authorization HTTP header
// with the Nostr scheme". Returns the JSON text, or null if the header
// is missing, uses another scheme, or doesn't decode.
function decodeAuthHeader(header: string | null): string | null {
  if (!header) return null;
  const match = /^Nostr\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  try {
    const binary = atob(match[1]);
    // atob yields one char per byte; the event's content and tags may
    // hold non-ASCII, so decode as UTF-8 rather than trusting the
    // latin1 string.
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

// Refusal reasons for ownerReason below.
export const UNCLAIMED_REASON =
  "this relay has no owner yet -- claim it before using the management API";

export const WRONG_SIGNER_REASON = "Authorization event is not signed by the relay owner";

// Verifies the request carries a correctly signed NIP-98 event over this
// exact method, URL and body, and returns the signer. `body` is the raw
// request bytes, hashed as received so no decode/re-encode can normalize
// them.
//
// Deliberately does NOT know who the owner is: finding out is a Durable
// Object round trip (a hibernation wake, one of the day's 100,000
// requests, row reads), the most expensive thing an unauthenticated caller
// can provoke here. So the schnorr verify (~1.1ms of the 10ms Worker CPU
// budget, see validate.ts) runs last in this chain but BEFORE the owner
// lookup, and index.ts asks the DO only after it passes (ownerReason
// below). The other checks run cheapest-first ahead of it.
export function verifyNip98(request: Request, body: Uint8Array, nowSec: number): Nip98Result {
  const json = decodeAuthHeader(request.headers.get("Authorization"));
  if (json === null) {
    return { ok: false, reason: "missing or malformed Authorization header (expected: Nostr <base64-event>)" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, reason: "Authorization event is not valid JSON" };
  }

  const event = parseEventShape(raw);
  if (event === null) return { ok: false, reason: "Authorization event is not a well-formed nostr event" };

  if (event.kind !== HTTP_AUTH_KIND) {
    return { ok: false, reason: `Authorization event must be kind ${HTTP_AUTH_KIND}, got ${event.kind}` };
  }

  if (Math.abs(nowSec - event.created_at) > HTTP_AUTH_MAX_DRIFT_SECONDS) {
    return {
      ok: false,
      reason: `Authorization event created_at is outside the ${HTTP_AUTH_MAX_DRIFT_SECONDS}s window`,
    };
  }

  const u = tagValue(event.tags, "u");
  if (u === null || !sameUrl(u, request.url)) {
    return { ok: false, reason: `Authorization event 'u' tag must be the request URL (${request.url})` };
  }

  const method = tagValue(event.tags, "method");
  if (method === null || method.toUpperCase() !== request.method.toUpperCase()) {
    return { ok: false, reason: `Authorization event 'method' tag must be ${request.method}` };
  }

  // Required by NIP-86 even though bare NIP-98 calls it optional.
  const payload = tagValue(event.tags, "payload");
  if (payload === null) {
    return { ok: false, reason: "Authorization event is missing the 'payload' tag, which NIP-86 requires" };
  }
  const bodyHash = bytesToHex(sha256(body));
  if (payload.toLowerCase() !== bodyHash) {
    return { ok: false, reason: "Authorization event 'payload' tag is not the SHA256 of the request body" };
  }

  if (!idMatchesContent(event)) return { ok: false, reason: "Authorization event id does not match its content" };
  if (!verifySignature(event)) return { ok: false, reason: "Authorization event signature is invalid" };

  return { ok: true, pubkey: event.pubkey };
}

// Given a verified signer and the owner the DO reported: null if
// authorized, else the refusal reason.
export function ownerReason(signer: string, owner: string | null): string | null {
  if (owner === null) return UNCLAIMED_REASON;
  if (signer !== owner) return WRONG_SIGNER_REASON;
  return null;
}
