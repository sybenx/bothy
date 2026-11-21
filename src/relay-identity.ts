// This relay's own signing identity, unrelated to the owner's pubkey and
// OWNER_PUBKEY. NIP-29 requires 39000-series group metadata events to be
// "signed by the relay keypair directly"; nip29.ts signs them through
// signAsRelay. Generated once and stored, never configured, so a clean
// deploy asks for nothing.
//
// Seeded at schema init (schema.ts seedRelayIdentity), not at claim:
// claim is skipped entirely when OWNER_PUBKEY is set, and the identity
// must exist in that mode too. Exactly one row, forever.
//
// The public half is published as `self` on NIP-11 and `relayPubkey` on
// /api/stats. The secret half must never leave this file: not in NIP-11,
// /api/stats, NIP-86 or a log line.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { conversationKey } from "./nip44";

export function generateRelayKeypair(): { secretKeyHex: string; publicKeyHex: string } {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secretKeyHex: bytesToHex(secretKey), publicKeyHex: bytesToHex(publicKey) };
}

// The public key only. signAsRelay and relayConversationKey are the only
// readers of the secret key column, and neither returns it.
export function getRelayPubkey(sql: SqlStorage): string {
  const row = sql.exec<{ public_key: string }>(`SELECT public_key FROM relay_identity LIMIT 1`).toArray()[0];
  if (!row) {
    throw new Error("relay_identity has no row -- initSchema seeds it unconditionally on every wake");
  }
  return row.public_key;
}

// `messageHex` is a 32-byte hash (an event id, computed by validate.ts
// computeEventId), so these events verify like any other.
export function signAsRelay(sql: SqlStorage, messageHex: string): string {
  const row = sql.exec<{ secret_key: string }>(`SELECT secret_key FROM relay_identity LIMIT 1`).toArray()[0];
  if (!row) {
    throw new Error("relay_identity has no row -- initSchema seeds it unconditionally on every wake");
  }
  return bytesToHex(schnorr.sign(hexToBytes(messageHex), hexToBytes(row.secret_key)));
}

// The NIP-44 conversation key between this relay and `pubkey`, for the
// seal of a message the relay sends (join-requests.ts). Derived here so
// the secret key still has one reader and never leaves this file.
export function relayConversationKey(sql: SqlStorage, pubkey: string): Uint8Array {
  const row = sql.exec<{ secret_key: string }>(`SELECT secret_key FROM relay_identity LIMIT 1`).toArray()[0];
  if (!row) {
    throw new Error("relay_identity has no row -- initSchema seeds it unconditionally on every wake");
  }
  return conversationKey(row.secret_key, pubkey);
}
