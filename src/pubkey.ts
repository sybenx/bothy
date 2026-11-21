import { bech32Decode } from "./bech32";
import { bytesToHex } from "@noble/hashes/utils.js";

const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/;

// Accepts `npub1...` or lowercase hex and returns lowercase hex, the only
// form stored or compared anywhere. Uppercase hex is refused, not
// lowercased (test/ownership.test.ts). A bad bech32 checksum is refused;
// a well-formed key for the wrong person cannot be caught here.
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
