// NIP-98 HTTP Auth (nips/98.md), as NIP-86 requires it. Runs in the
// Worker, never inside the Durable Object -- schnorr verification is the
// CPU-expensive step (validate.ts) and there is no
// reason to spend DO time on a request that may turn out to be forged.
// The DO only ever sees a management call that already passed this gate.
//
// NIP-86 tightens bare NIP-98 in one place: "The request must contain an
// Authorization header with a valid NIP-98 event, except the `payload`
// tag is required." So `payload` is checked unconditionally here rather
// than "optionally, for POST/PUT/PATCH" as nips/98.md puts it -- an
// operator sending a management command must bind that exact body to
// that exact signature.
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
  // Never surfaced to the caller verbatim as the whole story -- the
  // handler answers 401 either way (nips/98.md: "Failed validation should
  // return a 401 Unauthorized response"). Carried so the response body
  // can say which check failed, which is the difference between an
  // operator fixing a clock skew in seconds and guessing for an hour.
  | { ok: false; reason: string };

function tagValue(tags: string[][], name: string): string | null {
  const tag = tags.find((t) => t[0] === name);
  return tag?.[1] ?? null;
}

// Two URLs that differ only in the ways `new URL()` canonicalizes away
// (a missing path, a default port, percent-encoding case) address the
// same request, and a signer typing the relay's own wss:// URL by hand
// will produce one of those forms rather than whatever exact string the
// runtime hands back as request.url. Comparing canonical forms keeps the
// binding to host, path, and query exact -- URL canonicalization changes
// none of those -- while not failing an operator over a trailing slash.
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

// The reason returned when a management call arrives at a relay nobody
// has claimed. Lives here rather than at the call site so the two halves
// of the check -- this file proving *who* signed, index.ts comparing that
// to the owner -- still speak with one voice. See ownerReason below.
export const UNCLAIMED_REASON =
  "this relay has no owner yet -- claim it before using the management API";

// The reason returned when the signature is valid but belongs to someone
// other than the owner.
export const WRONG_SIGNER_REASON = "Authorization event is not signed by the relay owner";

// Verifies the request carries a well-formed, correctly signed NIP-98
// event over this exact method, URL, and body, and returns the pubkey
// that signed it. `body` is the raw request bytes, already read by the
// caller -- the payload tag binds the bytes that were actually sent, so
// they are hashed as received rather than after a decode-and-reencode
// round trip that could normalize them.
//
// It deliberately does NOT know who the owner is. Establishing that costs
// a Durable Object round trip, and a round trip is the single most
// expensive thing an unauthenticated caller can provoke here: it wakes the
// object from hibernation, spends one of the day's 100,000 requests, and
// reads rows -- all before anything has shown the caller is even holding a
// signature. So this function answers the question that can be answered
// from the request alone, and index.ts asks the DO only once the answer is
// yes. Confirming the signer is the owner is index.ts's job (ownerReason
// below), not this file's.
//
// The checks still run cheapest-first (CLAUDE.md "Conventions"), but the
// schnorr verify now sits at the end of the *whole* chain rather than
// behind a free string comparison against the owner. That comparison used
// to come first precisely because it was free -- it is not free any more,
// because obtaining the owner is what costs. ~1.1ms of Worker CPU
// (validate.ts), out of a 10ms per-request budget, is the cheaper of the
// two, and it is spent only by a caller who produced a valid signature
// over this exact request.
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

// The second half of the check, split out so it stays beside the first:
// given a verified signer and the owner the Durable Object reported,
// answer whether this caller is authorized, and if not, why. Returns null
// when they are. A stranger's perfectly valid signature is still not
// authorized here.
export function ownerReason(signer: string, owner: string | null): string | null {
  if (owner === null) return UNCLAIMED_REASON;
  if (signer !== owner) return WRONG_SIGNER_REASON;
  return null;
}
