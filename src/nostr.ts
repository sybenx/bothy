// NIP-01 wire types (nips/01.md "Events and signatures", "From client to
// relay"). Kept minimal -- just enough shape for the relay's own
// handling, not a general-purpose SDK.
export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export type Filter = {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  [tagKey: `#${string}`]: unknown;
};

// Replaceable, ephemeral, and addressable kind ranges (nips/01.md
// "Kinds"). Everything outside these three -- regular kinds, and the
// spec-undefined 45-999 and >=40000 ranges -- falls through storage.ts's
// default branch and is stored like a regular event.
export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

export function isEphemeralKind(kind: number): boolean {
  return kind >= 20000 && kind < 30000;
}

export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}

// The `d` tag value that identifies one addressable event among all
// events sharing a (pubkey, kind). Absent means "" (nips/01.md).
export function dTagValue(tags: string[][]): string {
  const tag = tags.find((t) => t[0] === "d");
  return tag?.[1] ?? "";
}

// NIP-59 (nips/59.md) Gift Wrap. Signed by a random one-time key, never
// the real sender's -- the `p` tag is the only identity information a
// relay can see, which is why deletion/read authorization for this kind
// works off `p` tags rather than `pubkey` everywhere else in this
// codebase (relay.ts, storage.ts, ownership.ts).
export const GIFT_WRAP_KIND = 1059;

// NIP-62 (nips/62.md) Request to Vanish.
export const VANISH_KIND = 62;

// All `p` tag values on an event -- used to find a gift wrap's
// recipient(s), since `pubkey` on a gift wrap is a random one-time key
// and carries no identity.
export function pTagValues(tags: string[][]): string[] {
  return tags.filter((t) => t[0] === "p" && t[1] !== undefined).map((t) => t[1] as string);
}

// A filter's `#<letter>` keys, e.g. `#e`, `#p` -- the single-letter tag
// names NIP-01 defines filtering over.
export function tagFilterEntries(filter: Filter): [string, string[]][] {
  return Object.entries(filter)
    .filter(([key, value]) => key.length === 2 && key[0] === "#" && Array.isArray(value))
    .map(([key, value]) => [key[1]!, value as string[]]);
}
