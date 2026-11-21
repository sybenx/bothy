// NIP-42 Authentication of clients to relays (nips/42.md): the AUTH
// verification checklist, shared by two callers that differ only in what
// counts as "the right challenge". So each check is its own function and
// each caller composes them in its own order:
//
//   relay.ts handleAuth (WebSocket AUTH) compares the challenge tag to the
//   one it issued this connection (state.challenge), inline, in the order
//   kind -> drift -> challenge-match -> relay-tag. Keep that order: a
//   doubly-wrong AUTH event must get the reason string
//   test/nip42-auth.test.ts asserts.
//
//   verifyClaimAuthEvent below (HTTP, index.ts handleClaimSigned) has no
//   connection; the right challenge is a live claim nonce in storage. It
//   runs the free checks and hands the extracted, unvalidated challenge
//   back to the caller to look up.
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";
import type { NostrEvent } from "./nostr";

// nips/42.md's own kind for AUTH events.
export const AUTH_KIND = 22242;

// How far a client's AUTH `created_at` may drift from "now" before it's
// rejected as stale -- NIP-42 doesn't fix a number, this mirrors the
// ~10 minute window other relays use.
export const AUTH_MAX_DRIFT_SECONDS = 600;

// NIP-42 (nips/42.md "Signed Event Verification"): "checking if the
// domain name is correct should be enough." Also used for NIP-62's
// `relay` tag, which additionally allows the literal sentinel
// `ALL_RELAYS` (nips/62.md) -- checked by the caller, not here.
export function relayTagMatchesHost(tagValue: string, host: string): boolean {
  try {
    return new URL(tagValue).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export type AuthCheckResult = { ok: true } | { ok: false; reason: string };

// Kind and freshness, in that order -- the two checks that need nothing
// but the event itself.
export function checkAuthFreshness(event: NostrEvent, nowSec: number): AuthCheckResult {
  if (event.kind !== AUTH_KIND) {
    return { ok: false, reason: `invalid: kind must be ${AUTH_KIND}` };
  }
  if (Math.abs(nowSec - event.created_at) > AUTH_MAX_DRIFT_SECONDS) {
    return { ok: false, reason: "invalid: created_at is too far from now" };
  }
  return { ok: true };
}

// NIP-42 "Signed Event Verification": "that the relay tag matches the
// relay URL." Without this, an AUTH event signed for a *different*
// relay's challenge could be replayed here to claim the owner's identity.
export function checkAuthRelayTag(event: NostrEvent, host: string): AuthCheckResult {
  const relayTag = event.tags.find((t) => t[0] === "relay")?.[1];
  if (!relayTag || !relayTagMatchesHost(relayTag, host)) {
    return { ok: false, reason: "invalid: relay tag does not name this relay" };
  }
  return { ok: true };
}

export function authChallenge(event: NostrEvent): string | undefined {
  return event.tags.find((t) => t[0] === "challenge")?.[1];
}

export type ClaimAuthResult =
  | { ok: true; pubkey: string; challenge: string }
  | { ok: false; reason: string };

// Worker-side entry point for POST /api/claim-signed (src/index.ts).
// Pure, no I/O, so a forged claim costs no Durable Object time. The
// challenge is only extracted here: whether it names a live claim nonce is
// a storage read, done by the DO call that also consumes it.
export function verifyClaimAuthEvent(raw: unknown, host: string, nowSec: number): ClaimAuthResult {
  const event = parseEventShape(raw);
  if (event === null) return { ok: false, reason: "invalid: malformed event" };
  if (!idMatchesContent(event)) return { ok: false, reason: "invalid: id does not match the hash of its contents" };
  if (!verifySignature(event)) return { ok: false, reason: "invalid: signature verification failed" };

  const fresh = checkAuthFreshness(event, nowSec);
  if (!fresh.ok) return fresh;

  const relay = checkAuthRelayTag(event, host);
  if (!relay.ok) return relay;

  const challenge = authChallenge(event);
  if (!challenge) return { ok: false, reason: "invalid: no matching challenge was issued" };

  return { ok: true, pubkey: event.pubkey, challenge };
}
