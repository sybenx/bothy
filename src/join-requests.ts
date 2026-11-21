// The message this relay sends its owner when somebody asks to join
// (nip86.ts requestjoin). The one message bothy writes itself.
//
// A NIP-17 direct message: a kind-14 rumor from the relay's own identity
// (relay-identity.ts, published as NIP-11 `self`), sealed with the relay's
// key and gift wrapped to the owner. Stored here, in the owner's inbox on
// this relay; the relay opens no outbound connections, so it reaches the
// owner's other inbox relays only if their app copies it.
//
// How an app recognises it (README "Join requests"):
//   - the seal's pubkey, which NIP-17 requires to equal the rumor's, is
//     this relay's NIP-11 `self`;
//   - the rumor carries ["bothy", "joinrequest", "<requester hex pubkey>"].
// Either alone is not enough: anyone can put the tag on a message, and the
// relay key may one day send other kinds of message.
import { npubEncode } from "./bech32";
import { wrapDirectMessage, type Rumor } from "./nip44";
import type { NostrEvent } from "./nostr";
import { getRelayPubkey, relayConversationKey, signAsRelay } from "./relay-identity";

export const JOIN_REQUEST_TAG = "bothy";
export const JOIN_REQUEST_TAG_VALUE = "joinrequest";

// Plain text as the owner reads it. Whatever the requester typed is
// squeezed onto one line, so a name cannot forge a second line of the
// relay's own words.
export function joinRequestText(requester: string, name: string | null, note: string | null): string {
  const who = name ?? "Someone";
  const lines = [`${who} wants to join your home.`, `nostr:${npubEncode(requester)}`];
  if (note !== null) lines.push(`They wrote: ${note}`);
  return lines.join("\n\n");
}

export function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function joinRequestMessage(
  sql: SqlStorage,
  owner: string,
  requester: string,
  name: string | null,
  note: string | null,
  nowSec: number,
): { wrap: NostrEvent; rumor: Rumor } {
  return wrapDirectMessage({
    senderPubkey: getRelayPubkey(sql),
    senderConversationKey: relayConversationKey(sql, owner),
    signSeal: (id) => signAsRelay(sql, id),
    recipientPubkey: owner,
    content: joinRequestText(requester, name, note),
    tags: [[JOIN_REQUEST_TAG, JOIN_REQUEST_TAG_VALUE, requester]],
    nowSec,
  });
}
