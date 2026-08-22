// Minimal bech32 decoder (BIP-173) -- just enough to turn an `npub1...`
// string into its 32-byte payload. No encoder: the relay only ever needs
// to accept npubs a client pastes in, never mint its own. Not a
// general-purpose bech32/bech32m library.
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
    }
  }
  return chk;
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >>> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

function verifyChecksum(hrp: string, data: number[]): boolean {
  return polymod([...hrpExpand(hrp), ...data]) === 1;
}

function convertBits(data: number[], fromBits: number, toBits: number): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    if (value < 0 || value >>> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      out.push((acc >>> bits) & maxv);
    }
  }
  if (bits >= fromBits || ((acc << (toBits - bits)) & maxv) !== 0) return null;
  return out;
}

// Decodes a bech32 string, returning its human-readable part and 8-bit
// payload bytes -- or null if the checksum doesn't verify. A bad checksum
// catches a typo; it does not catch a valid-but-wrong key (see CLAUDE.md
// "Claim implementation").
export function bech32Decode(input: string): { hrp: string; bytes: Uint8Array } | null {
  const lower = input.toLowerCase();
  if (lower !== input && input.toUpperCase() !== input) return null;
  const sep = lower.lastIndexOf("1");
  if (sep < 1 || lower.length - sep - 1 < 6 || lower.length > 90) return null;
  const hrp = lower.slice(0, sep);
  const dataPart = lower.slice(sep + 1);
  const data: number[] = [];
  for (const c of dataPart) {
    const idx = CHARSET.indexOf(c);
    if (idx === -1) return null;
    data.push(idx);
  }
  if (!verifyChecksum(hrp, data)) return null;
  const payload = data.slice(0, -6);
  const bytes = convertBits(payload, 5, 8);
  if (bytes === null) return null;
  return { hrp, bytes: Uint8Array.from(bytes) };
}
