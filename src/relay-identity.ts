// This relay's own signing identity -- distinct from the owner's pubkey
// (ownership.ts getOwnerPubkey) and from OWNER_PUBKEY. NIP-29 requires
// 39000-series group metadata events to be "signed by the relay keypair
// directly," so bothy needs an identity of its own to sign with once that
// work lands. Not configured: a clean deploy asks for nothing (CLAUDE.md
// "Configuration"), so this is generated once and stored, never supplied.
//
// Seeded at schema-init time (schema.ts initSchema, via
// seedRelayIdentity below) rather than tied to the TOFU claim step: the
// claim step is skipped entirely when OWNER_PUBKEY is set (relay.ts
// claim() returns "disabled" before touching storage), and this identity
// has to exist under that mode too -- the same reason
// ownership.ts keeps the follow-list watermark off the `owner` table
// rather than on it. Exactly one row, forever, like relay_meta and
// backfill_meta (schema.ts initSchema).
//
// This change adds the identity only -- nothing calls signAsRelay yet.
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export function generateRelayKeypair(): { secretKeyHex: string; publicKeyHex: string } {
  const { secretKey, publicKey } = schnorr.keygen();
  return { secretKeyHex: bytesToHex(secretKey), publicKeyHex: bytesToHex(publicKey) };
}

// For NIP-11 and /api/stats -- see relay.ts getIdentity/collectStats.
// Never returns the secret key; signAsRelay below is the only reader of
// that column, and it never returns it either.
export function getRelayPubkey(sql: SqlStorage): string {
  const row = sql.exec<{ public_key: string }>(`SELECT public_key FROM relay_identity LIMIT 1`).toArray()[0];
  if (!row) {
    throw new Error("relay_identity has no row -- initSchema seeds it unconditionally on every wake");
  }
  return row.public_key;
}

// `messageHex` is a 32-byte hash, the same shape validate.ts
// verifySignature consumes for event.id. Nothing calls this yet -- see
// the header comment above.
export function signAsRelay(sql: SqlStorage, messageHex: string): string {
  const row = sql.exec<{ secret_key: string }>(`SELECT secret_key FROM relay_identity LIMIT 1`).toArray()[0];
  if (!row) {
    throw new Error("relay_identity has no row -- initSchema seeds it unconditionally on every wake");
  }
  return bytesToHex(schnorr.sign(hexToBytes(messageHex), hexToBytes(row.secret_key)));
}
