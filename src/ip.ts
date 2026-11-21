// Canonicalizes an IP string so one address always compares equal. IPv6
// has many textual forms, and while CF-Connecting-IP arrives in
// Cloudflare's canonical form, an address given to NIP-86
// blockip/unblockip is free text (pasted, expanded, hand-typed).
// storage.ts blockIp/unblockIp/isIpBlocked, index.ts's rate-limit key
// and nip86.ts's self-block check must all use this, or a block stored
// under one spelling silently never matches the connection it targets,
// and the self-block warning is skipped.
//
// Only values containing ':' are rewritten (Cloudflare sends IPv4 in one
// form). Anything not parseable as IPv6, including the "unknown" fallback
// for a missing header, is returned trimmed and lowercased.
export function normalizeIp(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.includes(":")) return trimmed;

  // Strip a zone id (e.g. "fe80::1%eth0") -- link-local scope, not part
  // of the address itself, and never present in what Cloudflare sends.
  const withoutZone = trimmed.split("%")[0] ?? trimmed;
  const groups = expandIPv6(withoutZone);
  return groups === null ? trimmed : compressIPv6(groups);
}

// Parses full, "::"-compressed, or embedded-IPv4 IPv6 into exactly 8
// lowercase hex groups without leading zeros. Null (not a throw) for
// anything that doesn't parse.
function expandIPv6(value: string): string[] | null {
  const halves = value.split("::");
  if (halves.length > 2) return null; // more than one "::" is never valid

  const parseSide = (side: string): string[] | null => {
    if (side === "") return [];
    const parts = side.split(":");
    const groups: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      // An embedded IPv4 literal (e.g. "...:ffff:192.168.1.1") is only
      // legal as the last part, and expands to two hex groups.
      if (i === parts.length - 1 && part.includes(".")) {
        const ipv4 = expandIPv4(part);
        if (ipv4 === null) return null;
        groups.push(...ipv4);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      groups.push(part.replace(/^0+(?=.)/, ""));
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseSide(halves[0]!);
    return groups !== null && groups.length === 8 ? groups : null;
  }

  const left = parseSide(halves[0]!);
  const right = parseSide(halves[1]!);
  if (left === null || right === null) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null; // "::" must stand in for at least one group
  return [...left, ...Array(missing).fill("0"), ...right];
}

function expandIPv4(value: string): string[] | null {
  const octets = value.split(".");
  if (octets.length !== 4) return null;
  const bytes = octets.map((o) => (/^\d{1,3}$/.test(o) ? Number(o) : NaN));
  if (bytes.some((b) => !Number.isInteger(b) || b > 255)) return null;
  const [a, b, c, d] = bytes as [number, number, number, number];
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

// RFC 5952 canonical compression: replace the longest run of consecutive
// "0" groups (length >= 2, leftmost run wins a tie) with "::". A single
// zero group is never compressed -- "1:0:2:3:4:5:6:7" stays that way, not
// "1::2:3:4:5:6:7".
function compressIPv6(groups: string[]): string {
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  let runLen = 0;
  for (let i = 0; i <= groups.length; i++) {
    const isZero = i < groups.length && groups[i] === "0";
    if (isZero) {
      if (runStart === -1) runStart = i;
      runLen++;
    } else {
      if (runLen > bestLen) {
        bestStart = runStart;
        bestLen = runLen;
      }
      runStart = -1;
      runLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(":");

  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}
