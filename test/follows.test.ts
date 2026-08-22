// ALLOW_FOLLOWS (CLAUDE.md "Configuration": "also accept writes from the
// owner's kind-3 follow list"). Follows are re-derived from the owner's
// own most recent kind-3 event already stored on this relay, not fetched
// from elsewhere -- see ownership.ts refreshFollows(). The global test
// env's ALLOW_FOLLOWS defaults to "false" (wrangler.jsonc), so -- like
// test/claim.test.ts -- the gate itself is exercised against real
// SqlStorage via runInDurableObject with a hand-built env, rather than
// over the wire.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isAllowedWriter, refreshFollows } from "../src/ownership";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { publish, connectRelay } from "./helpers/socket";

isolateStorage();

const FOLLOWS_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, ALLOW_FOLLOWS: "true" } as unknown as Env;
const NO_FOLLOWS_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, ALLOW_FOLLOWS: "false" } as unknown as Env;

describe("ALLOW_FOLLOWS write gate", () => {
  it("a friend in the owner's stored kind-3 contact list may write once follows are refreshed", async () => {
    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: [["p", friend.pubkeyHex]],
    });
    const conn = await connectRelay();
    await publish(conn, contacts);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, friend.pubkeyHex)).toBe(false);

      refreshFollows(state.storage.sql, FOLLOWS_ENV, Math.floor(Date.now() / 1000));

      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, friend.pubkeyHex)).toBe(true);
    });
  });

  it("does not allow a follow's writes when ALLOW_FOLLOWS is off", async () => {
    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: [["p", friend.pubkeyHex]],
    });
    const conn = await connectRelay();
    await publish(conn, contacts);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      refreshFollows(state.storage.sql, NO_FOLLOWS_ENV, Math.floor(Date.now() / 1000));
      expect(isAllowedWriter(state.storage.sql, NO_FOLLOWS_ENV, friend.pubkeyHex)).toBe(false);
    });
  });

  it("a stranger not in the follow list is still rejected", async () => {
    const stranger = randomKeypair().pubkeyHex;
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, stranger)).toBe(false);
    });
  });

  it("the owner can always write regardless of ALLOW_FOLLOWS", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(isAllowedWriter(state.storage.sql, NO_FOLLOWS_ENV, OWNER_PUBKEY_HEX)).toBe(true);
    });
  });
});
