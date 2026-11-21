import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { MAX_CREATED_AT_FUTURE_SECONDS } from "./limits";
import type { NostrEvent } from "./nostr";

const HEX_ID_RE = /^[0-9a-f]{64}$/;
const HEX_SIG_RE = /^[0-9a-f]{128}$/;

// NIP-01 "To obtain the event.id": sha256 of the UTF-8 JSON-serialized
// [0, pubkey, created_at, kind, tags, content] array.
export function computeEventId(event: NostrEvent): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

// Structural shape only. id and signature are checked separately so a
// refusal can say which failed: malformed, id mismatch, or bad signature.
export function parseEventShape(raw: unknown): NostrEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.id !== "string" || !HEX_ID_RE.test(e.id)) return null;
  if (typeof e.pubkey !== "string" || !HEX_ID_RE.test(e.pubkey)) return null;
  if (typeof e.sig !== "string" || !HEX_SIG_RE.test(e.sig)) return null;
  if (typeof e.created_at !== "number" || !Number.isInteger(e.created_at)) return null;
  if (typeof e.kind !== "number" || !Number.isInteger(e.kind)) return null;
  if (typeof e.content !== "string") return null;
  if (!Array.isArray(e.tags) || !e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))) {
    return null;
  }
  return {
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags as string[][],
    content: e.content,
    sig: e.sig,
  };
}

// See limits.ts MAX_CREATED_AT_FUTURE_SECONDS. One-sided on purpose:
// backfilled and republished history legitimately carries old
// timestamps. Checked before id/signature verification on both write
// paths (relay.ts acceptEvent, backfill.ts applyBackfillPage).
export function isCreatedAtTooFarInFuture(event: NostrEvent, nowSec: number): boolean {
  return event.created_at > nowSec + MAX_CREATED_AT_FUTURE_SECONDS;
}

export function idMatchesContent(event: NostrEvent): boolean {
  return computeEventId(event) === event.id;
}

// The CPU-expensive step: every cheaper rejection on a write path runs
// ahead of it (relay.ts acceptEvent).
//
// ~1.11ms per verify (mean of 5,000 @noble/curves schnorr.verify calls)
// against Workers Free's 10ms CPU per request: roughly nine verifies to
// the ceiling. Measured in Node, not workerd; the test harness does not
// expose isolate CPU time, so the suite cannot assert it. Both are V8, so
// it is a proxy, not a measurement: re-measure under `wrangler dev` or in
// production before relying on the margin.
export function verifySignature(event: NostrEvent): boolean {
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}
