// ALLOW_FOLLOWS (CLAUDE.md "Configuration": "also accept writes from the
// owner's kind-3 follow list"). Follows are re-derived from the owner's
// own most recent kind-3 event already stored on this relay, not fetched
// from elsewhere -- see ownership.ts refreshFollows(). ALLOW_FOLLOWS is an
// opt-out (ownership.ts allowFollowsEnabled), so both states are exercised
// explicitly below with a hand-built env against real SqlStorage via
// runInDurableObject, rather than relying on whatever the global test env
// happens to default to.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isAllowedWriter, refreshFollows } from "../src/ownership";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { publish, connectRelay } from "./helpers/socket";
import { storeEvent } from "../src/storage";

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

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      // Stored directly via storeEvent rather than published over the
      // wire -- publishing would go through relay.ts's own handleEvent,
      // which (now that ALLOW_FOLLOWS is an opt-out, see
      // ownership.ts allowFollowsEnabled) immediately refreshes the
      // follow cache on an owner kind-3, defeating the point of this
      // test's explicit before/after refreshFollows assertions.
      storeEvent(state.storage.sql, contacts);

      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(false);

      refreshFollows(state.storage.sql, FOLLOWS_ENV, Math.floor(Date.now() / 1000));

      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(true);
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
      expect(isAllowedWriter(state.storage.sql, NO_FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(false);
    });
  });

  it("a stranger not in the follow list is still rejected", async () => {
    const stranger = randomKeypair().pubkeyHex;
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, stranger).allowed).toBe(false);
    });
  });

  it("the owner can always write regardless of ALLOW_FOLLOWS", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(isAllowedWriter(state.storage.sql, NO_FOLLOWS_ENV, OWNER_PUBKEY_HEX).allowed).toBe(true);
    });
  });
});
