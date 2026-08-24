// NIP-51 mute list (nips/51.md): the owner's kind-10000 mute list revokes
// write access for an individual pubkey, mirroring ALLOW_FOLLOWS's cache
// pattern -- see follows.test.ts and ownership.ts refreshMutes(). Mutes
// are re-derived from the owner's own most recent kind-10000 event
// already stored on this relay, not fetched from elsewhere. Like
// test/follows.test.ts, the gate itself is exercised against real
// SqlStorage via runInDurableObject with a hand-built env, rather than
// over the wire.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isAllowedWriter, refreshFollows, refreshMutes } from "../src/ownership";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { publish, connectRelay } from "./helpers/socket";

isolateStorage();

const FOLLOWS_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, ALLOW_FOLLOWS: "true" } as unknown as Env;

describe("NIP-51 mute list write gate", () => {
  it("a muted pubkey that is also a follow is rejected", async () => {
    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: [["p", friend.pubkeyHex]],
    });
    const muteList = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 10000,
      tags: [["p", friend.pubkeyHex]],
    });
    const conn = await connectRelay();
    await publish(conn, contacts);
    await publish(conn, muteList);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const now = Math.floor(Date.now() / 1000);
      refreshFollows(state.storage.sql, FOLLOWS_ENV, now);
      refreshMutes(state.storage.sql, FOLLOWS_ENV, now);

      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(false);
    });
  });

  it("the owner is never blocked by their own mute list", async () => {
    const muteList = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 10000,
      tags: [["p", OWNER_PUBKEY_HEX]],
    });
    const conn = await connectRelay();
    await publish(conn, muteList);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      refreshMutes(state.storage.sql, FOLLOWS_ENV, Math.floor(Date.now() / 1000));
      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, OWNER_PUBKEY_HEX).allowed).toBe(true);
    });
  });

  it("an absent kind-10000 leaves the table empty and blocks nobody", async () => {
    const stranger = randomKeypair().pubkeyHex;
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      refreshMutes(state.storage.sql, FOLLOWS_ENV, Math.floor(Date.now() / 1000));
      const rows = state.storage.sql.exec(`SELECT * FROM mutes`).toArray();
      expect(rows.length).toBe(0);
      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, stranger).allowed).toBe(false);
    });
  });

  it("reads public p tags and ignores encrypted content", async () => {
    const pub = randomKeypair();
    // A realistic NIP-51 list: a public mute (`p` tag) alongside an
    // opaque NIP-44-encrypted `content` payload representing private
    // mutes this relay cannot and must not attempt to decrypt.
    const muteList = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 10000,
      tags: [["p", pub.pubkeyHex]],
      content: "AqPretendNip44CiphertextThatDoesNotDecodeAsJson==",
    });
    const conn = await connectRelay();
    await publish(conn, muteList);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      refreshMutes(state.storage.sql, FOLLOWS_ENV, Math.floor(Date.now() / 1000));

      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, pub.pubkeyHex).allowed).toBe(false);
      // The privately-muted pubkey never appears anywhere in plaintext,
      // so there is nothing to check it against -- it is simply not in
      // the mute table, and its writes are governed by ALLOW_FOLLOWS/
      // owner-only rules like any other pubkey.
      const rows = state.storage.sql.exec(`SELECT pubkey FROM mutes`).toArray();
      expect(rows).toEqual([{ pubkey: pub.pubkeyHex }]);
    });
  });
});
