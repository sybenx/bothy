// NIP-62 (nips/62.md) Request to Vanish: kind 62, deletes everything
// authored by its own pubkey up to its created_at, plus (nips/62.md:
// "Relays SHOULD delete all NIP-59 Gift Wraps that p-tagged the
// .pubkey") every gift wrap p-tagged to that pubkey. Deliberately NOT
// gated by ownership.ts isAllowedWriter -- nips/62.md: "Paid relays or
// relays that restrict who can post MUST also follow the request to
// vanish regardless of the user's status." See storage.ts applyVanish
// and relay.ts handleVanish for the reasoning; test/nip59-giftwrap.test.ts
// for why a gift wrap p-tagged to anyone but the owner never exists here
// (so the spec's "any pubkey" clause reduces, in practice, to the owner
// vanishing their own inbox).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { eventExists } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

async function stillExists(id: string): Promise<boolean> {
  const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
  let result = false;
  await runInDurableObject(stub, async (_instance, state) => {
    result = eventExists(state.storage.sql, id);
  });
  return result;
}

describe("NIP-62 request to vanish", () => {
  it("bypasses the write gate -- a non-owner's vanish request is accepted", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const vanish = signEvent(stranger.secretKeyHex, {
      kind: 62,
      tags: [["relay", "wss://example.com"]],
      content: "",
    });

    const [, , ok] = await publish(conn, vanish);

    // Any other kind from this same stranger would get "restricted: not
    // allowed to write" (test/ownership.test.ts) -- this proves kind 62
    // takes a different path. It deletes nothing (bothy never stores a
    // gift wrap p-tagged to anyone but the owner), which is fine: the
    // spec's rule still applies, it just has no matching rows here.
    expect(ok).toBe(true);
    conn.close();
  });

  it("deletes the requester's own events up to (not after) the vanish's created_at", async () => {
    const conn = await connectRelay();
    const before = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "before", created_at: 100 });
    const after = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "after", created_at: 200 });
    await publish(conn, before);
    await publish(conn, after);

    const vanish = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 62,
      tags: [["relay", "wss://example.com"]],
      content: "",
      created_at: 150,
    });
    const [, , ok] = await publish(conn, vanish);
    expect(ok).toBe(true);

    expect(await stillExists(before.id)).toBe(false);
    expect(await stillExists(after.id)).toBe(true);
    conn.close();
  });

  it("a vanished event's id cannot be replayed (tombstone durability)", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "gone", created_at: 100 });
    await publish(conn, event);

    const vanish = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 62,
      tags: [["relay", "wss://example.com"]],
      content: "",
      created_at: 200,
    });
    await publish(conn, vanish);

    const [, id, ok, message] = await publish(conn, event);
    expect(id).toBe(event.id);
    expect(ok).toBe(false);
    expect(message.startsWith("blocked:")).toBe(true);
    conn.close();
  });

  it("deletes gift wraps p-tagged to the requester, respecting the cutoff", async () => {
    const conn = await connectRelay();
    const older = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "older",
      created_at: 100,
    });
    const newer = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "newer",
      created_at: 200,
    });
    await publish(conn, older);
    await publish(conn, newer);

    const vanish = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 62,
      tags: [["relay", "wss://example.com"]],
      content: "",
      created_at: 150,
    });
    await publish(conn, vanish);

    expect(await stillExists(older.id)).toBe(false);
    expect(await stillExists(newer.id)).toBe(true);
    conn.close();
  });

  it("ALL_RELAYS targets this relay", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "global vanish", created_at: 100 });
    await publish(conn, event);

    const vanish = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 62,
      tags: [["relay", "ALL_RELAYS"]],
      content: "",
      created_at: 200,
    });
    const [, , ok] = await publish(conn, vanish);

    expect(ok).toBe(true);
    expect(await stillExists(event.id)).toBe(false);
    conn.close();
  });

  it("a relay tag naming a different relay does not trigger deletion", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "not targeted", created_at: 100 });
    await publish(conn, event);

    const vanish = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 62,
      tags: [["relay", "wss://a-different-relay.example"]],
      content: "",
      created_at: 200,
    });
    const [, , ok, message] = await publish(conn, vanish);

    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    expect(await stillExists(event.id)).toBe(true);
    conn.close();
  });

  it("rejects a vanish request with no relay tag", async () => {
    const conn = await connectRelay();
    const vanish = signEvent(OWNER_SECRET_KEY_HEX, { kind: 62, tags: [], content: "" });

    const [, , ok, message] = await publish(conn, vanish);

    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });
});
