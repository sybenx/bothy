// NIP-01 "From client to relay": REQ/CLOSE, and "From relay to client":
// EVENT/EOSE (nips/01.md lines 113-161). Covers subscription lifecycle,
// not filter-matching semantics -- see nip01-filters.test.ts for that.
//
// All fixture events are owner-authored since only the owner can write
// (see test/ownership.test.ts); reads themselves are public per
// CLAUDE.md's threat model, so subscription behavior does not depend on
// who is connected.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { collectStored, connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-01 REQ/EOSE/CLOSE", () => {
  it("sends EOSE for a subscription with no matching stored events", async () => {
    const conn = await connectRelay();
    const nobody = randomKeypair().pubkeyHex;

    const events = await collectStored(conn, "sub1", [{ kinds: [1], authors: [nobody] }]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("returns previously stored matching events before EOSE", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "stored first" });
    await publish(conn, event);

    const events = await collectStored(conn, "sub2", [{ kinds: [1], authors: [event.pubkey] }]);

    expect(events.map((e) => e.id)).toContain(event.id);
    conn.close();
  });

  it("delivers newly published matching events in real time after EOSE", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "sub3", { kinds: [1], authors: [OWNER_PUBKEY_HEX] }]);
    // Drain until EOSE for the initial (empty) query.
    for (;;) {
      const frame = await conn.nextMessage();
      if (frame[0] === "EOSE") break;
    }

    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "live" });
    await publish(conn, event);

    const frame = await conn.nextMessage();
    expect(frame[0]).toBe("EVENT");
    expect(frame[1]).toBe("sub3");
    expect((frame[2] as { id: string }).id).toBe(event.id);
    conn.close();
  });

  it("CLOSE stops further delivery on that subscription id", async () => {
    const conn = await connectRelay();
    await collectStored(conn, "sub4", [{ kinds: [1], authors: [OWNER_PUBKEY_HEX] }]);

    conn.send(["CLOSE", "sub4"]);

    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "after close" });
    await publish(conn, event);

    await expect(conn.nextMessage(200)).rejects.toThrow();
    conn.close();
  });

  it("a new REQ with the same subscription id replaces the old one", async () => {
    const conn = await connectRelay();
    await collectStored(conn, "sub5", [{ kinds: [1], authors: [OWNER_PUBKEY_HEX] }]);

    // Replace sub5 with a filter that only matches kind 7.
    await collectStored(conn, "sub5", [{ kinds: [7], authors: [OWNER_PUBKEY_HEX] }]);

    const kind1 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "should not arrive" });
    await publish(conn, kind1);
    await expect(conn.nextMessage(200)).rejects.toThrow();

    const kind7 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 7, content: "+" });
    await publish(conn, kind7);
    const frame = await conn.nextMessage();
    expect(frame[0]).toBe("EVENT");
    expect(frame[1]).toBe("sub5");
    expect((frame[2] as { id: string }).id).toBe(kind7.id);

    conn.close();
  });
});
