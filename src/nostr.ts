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
// "Kinds"). Everything else, including the spec-undefined 45-999 and
// >=40000 ranges, is stored as a regular event.
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

// NIP-65 (nips/65.md) Relay List Metadata: the owner's outbox/inbox
// relays. Backfill reads it to find the owner's history.
export const RELAY_LIST_KIND = 10002;

// NIP-65: an `r` tag with no marker means both read and write, so a relay
// is a write relay unless marked "read". Malformed tags are skipped, not
// thrown on: the event arrives via a third-party relay.
export function writeRelaysFrom(tags: string[][]): string[] {
  const urls = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "r" || !tag[1]) continue;
    if (tag[2] === "read") continue;
    urls.add(tag[1]);
  }
  return [...urls];
}

// NIP-59 (nips/59.md) Gift Wrap. Signed by a random one-time key, so the
// `p` tag is the only identity a relay sees; read and deletion
// authorization for this kind use the `p` tag, not `pubkey`.
export const GIFT_WRAP_KIND = 1059;

// bothy's sealed signal: a gift wrap of the same shape (a `p` tag to the
// recipient) in the ephemeral range, for typing, seen receipts and call
// setup. Never stored; delivered live to the recipient only (relay.ts
// handleSignal).
export const SIGNAL_KIND = 21059;

// A ring: a gift wrap (kind 1059) carrying the outer, plain tag
// `["ring"]`, the invite to a call. Its content stays sealed like any
// wrap's; the tag only tells the relay to keep it briefly, limit it as a
// ring and push it at once (relay.ts handleGiftWrap).
export function isRing(event: NostrEvent): boolean {
  return event.kind === GIFT_WRAP_KIND && event.tags.some((tag) => tag[0] === "ring");
}

// NIP-62 (nips/62.md) Request to Vanish.
export const VANISH_KIND = 62;

// True for a tag this relay writes an `event_tags` row for: single-letter
// names only (the only ones NIP-01 `#<letter>` filters can query), first
// value only. The one definition used by storage.ts insertEventRow, its row-cost
// stamp, and write-policy.ts's mention tag cap, so all three count the
// same tags.
export function isIndexedTag(tag: string[]): boolean {
  return tag[0]?.length === 1 && tag[1] !== undefined;
}

// All `p` tag values on an event.
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
