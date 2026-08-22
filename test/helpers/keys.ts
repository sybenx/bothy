import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/hashes/utils.js";

// Fixed test keypair for the relay owner. The public half is injected as
// the OWNER_PUBKEY binding in vitest.config.ts (miniflare.bindings) --
// deliberately NOT in wrangler.jsonc, so a real deploy stays unclaimed
// (TOFU) by default. See CLAUDE.md "Ownership" for the env-override path
// this fixture exercises.
export const OWNER_SECRET_KEY_HEX =
  "030a11181f262d343b424950575e656c737a81888f969da4abb2b9c0c7ced5dc";
export const OWNER_PUBKEY_HEX =
  "f324133f92f203537cd7f9c4f1cf1078020159111a18457809ce3c11950d87eb";

export interface Keypair {
  secretKeyHex: string;
  pubkeyHex: string;
}

export function randomKeypair(): Keypair {
  const { secretKey, publicKey } = schnorr.keygen();
  return {
    secretKeyHex: bytesToHex(secretKey),
    pubkeyHex: bytesToHex(publicKey),
  };
}
