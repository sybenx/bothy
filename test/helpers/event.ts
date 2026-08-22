import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

// NIP-01 "Events and signatures": the wire event, exactly as defined by
// the spec (nips/01.md).
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface UnsignedEventInput {
  kind: number;
  content?: string;
  tags?: string[][];
  created_at?: number;
}

// NIP-01 "To obtain the event.id": sha256 of the UTF-8 JSON-serialized
// [0, pubkey, created_at, kind, tags, content] array. JSON.stringify's
// default escaping already matches the spec's required escape table
// (\n \" \\ \r \t \b \f), so no custom serializer is needed here.
function computeId(
  pubkey: string,
  created_at: number,
  kind: number,
  tags: string[][],
  content: string,
): string {
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  return bytesToHex(sha256(new TextEncoder().encode(serialized)));
}

export function signEvent(secretKeyHex: string, input: UnsignedEventInput): NostrEvent {
  const secretKey = hexToBytes(secretKeyHex);
  const pubkey = bytesToHex(schnorr.getPublicKey(secretKey));
  const created_at = input.created_at ?? Math.floor(Date.now() / 1000);
  const tags = input.tags ?? [];
  const content = input.content ?? "";
  const kind = input.kind;
  const id = computeId(pubkey, created_at, kind, tags, content);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), secretKey));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

// Flips one hex nibble so the signature no longer verifies against the
// event's id/pubkey, without touching id/pubkey themselves.
export function withCorruptSignature(event: NostrEvent): NostrEvent {
  const chars = event.sig.split("");
  const i = 0;
  chars[i] = chars[i] === "0" ? "1" : "0";
  return { ...event, sig: chars.join("") };
}

// Changes content after signing, so id and sig no longer match the
// event's actual content -- an id/hash mismatch, not a bad signature.
export function withTamperedContent(event: NostrEvent): NostrEvent {
  return { ...event, content: `${event.content} (tampered)` };
}
