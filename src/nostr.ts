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

// Replaceable and addressable kind ranges (nips/01.md "Kinds").
export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
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

// A filter's `#<letter>` keys, e.g. `#e`, `#p` -- the single-letter tag
// names NIP-01 defines filtering over.
export function tagFilterEntries(filter: Filter): [string, string[]][] {
  return Object.entries(filter)
    .filter(([key, value]) => key.length === 2 && key[0] === "#" && Array.isArray(value))
    .map(([key, value]) => [key[1]!, value as string[]]);
}
