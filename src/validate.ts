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

// Structural shape only -- id/signature validity is checked separately,
// since the reject-path tests need to distinguish "malformed" from
// "invalid: bad signature" from "invalid: id mismatch".
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

// See limits.ts MAX_CREATED_AT_FUTURE_SECONDS for why this exists.
// Deliberately one-sided -- no lower bound, since backfilled and
// republished history is expected to carry old timestamps forever.
// Shared by both write paths (relay.ts acceptEvent, backfill.ts
// applyBackfillPage) and checked before id/signature verification on
// each, so a rejected event never pays for a schnorr verify.
export function isCreatedAtTooFarInFuture(event: NostrEvent, nowSec: number): boolean {
  return event.created_at > nowSec + MAX_CREATED_AT_FUTURE_SECONDS;
}

export function idMatchesContent(event: NostrEvent): boolean {
  return computeEventId(event) === event.id;
}

// The CPU-expensive step -- see docs/baselines.json for the measured
// cost per call and CLAUDE.md "The budget" for the 10ms/request ceiling
// it's measured against.
export function verifySignature(event: NostrEvent): boolean {
  try {
    return schnorr.verify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}
