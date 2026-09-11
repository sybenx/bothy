// NIP-42 Authentication of clients to relays (nips/42.md) -- the
// verification checklist, factored out of relay.ts so it runs once rather
// than twice.
//
// It grew a second caller when the QR/signed claim path
// (src/index.ts handleClaimSigned) needed to verify the same event shape
// over HTTP instead of over an open WebSocket. The two callers differ in
// exactly one respect -- what counts as "the right challenge" -- so this
// file exports each check as its own small function rather than one
// monolithic verifier, and each caller composes them in its own order:
//
//   relay.ts handleAuth (WebSocket AUTH) already knows the challenge it
//   issued to this connection (state.challenge), so it compares the
//   event's challenge tag to that directly, inline, in the same place it
//   always has -- preserving the exact original check order
//   (kind -> drift -> challenge-match -> relay-tag) so a doubly-wrong AUTH
//   event still gets the same reason string test/nip42-auth.test.ts
//   already asserts.
//
//   verifyClaimAuthEvent below (HTTP) has no live connection to compare
//   against -- the "right" challenge is whatever storage says is a live,
//   unexpired claim nonce, which is a DB read best done last, after every
//   free check has passed. So it checks kind/drift and the relay tag here,
//   then hands the extracted (not yet validated) challenge value back to
//   the caller, which looks it up.
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

// The Worker-side entry point for POST /api/claim-signed (src/index.ts).
// Mirrors nip98.ts verifyNip98's shape -- parse, then id, then signature,
// then the event-specific checklist -- and like it, is pure and does no
// I/O, so it runs before the Durable Object is ever touched.
//
// Ordering here is new (nothing existing constrains it, unlike
// relay.ts's handleAuth): kind/drift and the relay tag are both free, so
// they run first; the challenge is only extracted, not validated, because
// deciding whether it names a live claim nonce is a storage read and
// belongs one level up, in the DO call that also has to consume it.
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
