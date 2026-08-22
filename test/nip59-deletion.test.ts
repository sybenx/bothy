// NIP-59 (nips/59.md) Gift Wrap deletion -- ROADMAP.md chunk 6's
// recipient-authorized carve-out to NIP-09 (nips/09.md): a gift wrap is
// signed by a random one-time key, so the ordinary "same pubkey" rule
// can never fire for it. NIP-59 authorizes the tagged recipient instead
// (always the owner, on this relay -- see test/nip59-giftwrap.test.ts,
// "rejects a kind-1059 event whose p tag does not name the owner"). See
// storage.ts applyDeletion's comment for the full reasoning, and
// test/nip09-deletion.test.ts for the general same-pubkey rule this
// branches from and for tombstone durability on a non-gift-wrap event.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eventExists } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-59 gift wrap deletion", () => {
  it("the owner can delete a gift wrap addressed to them, authorized by its p tag", async () => {
    const conn = await connectRelay();
    const giftWrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "delete me",
    });
    await publish(conn, giftWrap);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", giftWrap.id], ["k", "1059"]],
      content: "",
    });
    const [, , ok] = await publish(conn, deletion);
    expect(ok).toBe(true);

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(eventExists(state.storage.sql, giftWrap.id)).toBe(false);
    });
    conn.close();
  });

  it("a deleted gift wrap's id cannot be replayed by its sender (tombstone durability)", async () => {
    // The whole point of recipient-authorized deletion: the sender still
    // holds their own signed copy and has every reason to resend it --
    // NIP-59/NIP-09 require the deletion to actually stick.
    const conn = await connectRelay();
    const sender = randomKeypair();
    const giftWrap = signEvent(sender.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "delete me",
    });
    await publish(conn, giftWrap);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", giftWrap.id], ["k", "1059"]],
      content: "",
    });
    await publish(conn, deletion);

    const [, id, ok, message] = await publish(conn, giftWrap);

    expect(id).toBe(giftWrap.id);
    expect(ok).toBe(false);
    expect(message.startsWith("blocked:")).toBe(true);
    conn.close();
  });
});
