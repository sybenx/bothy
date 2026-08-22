import { bech32Decode } from "./bech32";
import { bytesToHex } from "@noble/hashes/utils.js";

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

// Accepts `npub1...` or raw hex and normalizes to lowercase hex -- see
// CLAUDE.md "Configuration": "Accept npub1... and hex, normalize to hex
// at the boundary, store hex only." A bad bech32 checksum is rejected
// here; a valid-but-wrong key is not this function's job to catch.
export function normalizePubkey(input: string): string | null {
  const trimmed = input.trim();
  if (HEX_PUBKEY_RE.test(trimmed)) return trimmed;
  if (trimmed.toLowerCase().startsWith("npub1")) {
    const decoded = bech32Decode(trimmed);
    if (!decoded || decoded.hrp !== "npub" || decoded.bytes.length !== 32) return null;
    return bytesToHex(decoded.bytes);
  }
  return null;
}
