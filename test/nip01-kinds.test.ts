// NIP-01 "Kinds" storage conventions (nips/01.md lines 86-105):
// - regular kinds (e.g. 1): every event is stored.
// - replaceable kinds (0, 3, 10000-19999): only the latest per
//   (pubkey, kind) MUST be stored/returned; equal-timestamp ties keep the
//   lowest id.
// - ephemeral kinds (20000-29999): not stored at all, but still relayed
//   live to matching open subscriptions.
// - addressable kinds (30000-39999): only the latest per
//   (pubkey, kind, d-tag) MUST be stored/returned.
// - undefined ranges (45-999, >=40000): stored like regular kinds --
//   see the comment at storage.ts's default branch for why. Locked in
//   by a test so this doesn't get "hardened" into a rejection later.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { collectStored, connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-01 regular kinds", () => {
  it("stores every regular-kind event, not just the latest", async () => {
    const conn = await connectRelay();
    const first = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "first", created_at: 100 });
    const second = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "second", created_at: 200 });
    await publish(conn, first);
    await publish(conn, second);

    const events = await collectStored(conn, "subRegular", [
      { kinds: [1], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id).sort()).toEqual([first.id, second.id].sort());
    conn.close();
  });
});

describe("NIP-01 undefined kind ranges", () => {
  it("stores every event of an undefined kind in 45-999, not just the latest", async () => {
    const conn = await connectRelay();
    const first = signEvent(OWNER_SECRET_KEY_HEX, { kind: 500, content: "first", created_at: 100 });
    const second = signEvent(OWNER_SECRET_KEY_HEX, { kind: 500, content: "second", created_at: 200 });
    await publish(conn, first);
    await publish(conn, second);

    const events = await collectStored(conn, "subUndefinedLow", [
      { kinds: [500], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id).sort()).toEqual([first.id, second.id].sort());
    conn.close();
  });

  it("stores every event of an undefined kind >= 40000, not just the latest", async () => {
    const conn = await connectRelay();
    const first = signEvent(OWNER_SECRET_KEY_HEX, { kind: 40001, content: "first", created_at: 100 });
    const second = signEvent(OWNER_SECRET_KEY_HEX, { kind: 40001, content: "second", created_at: 200 });
    await publish(conn, first);
    await publish(conn, second);

    const events = await collectStored(conn, "subUndefinedHigh", [
      { kinds: [40001], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id).sort()).toEqual([first.id, second.id].sort());
    conn.close();
  });
});

describe("NIP-01 replaceable kinds", () => {
  it("keeps only the latest event per (pubkey, kind) for kind 0", async () => {
    const conn = await connectRelay();
    const older = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 0,
      content: JSON.stringify({ name: "old" }),
      created_at: 100,
    });
    const newer = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 0,
      content: JSON.stringify({ name: "new" }),
      created_at: 200,
    });
    await publish(conn, older);
    await publish(conn, newer);

    const events = await collectStored(conn, "subReplace0", [
      { kinds: [0], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id)).toEqual([newer.id]);
    conn.close();
  });

  it("keeps only the latest event per (pubkey, kind) for kind 3", async () => {
    const conn = await connectRelay();
    const older = signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, content: "", created_at: 100 });
    const newer = signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, content: "", created_at: 200 });
    await publish(conn, older);
    await publish(conn, newer);

    const events = await collectStored(conn, "subReplace3", [
      { kinds: [3], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id)).toEqual([newer.id]);
    conn.close();
  });

  it("keeps only the latest event per (pubkey, kind) in the 10000-19999 range", async () => {
    const conn = await connectRelay();
    const older = signEvent(OWNER_SECRET_KEY_HEX, { kind: 10002, content: "old relays", created_at: 100 });
    const newer = signEvent(OWNER_SECRET_KEY_HEX, { kind: 10002, content: "new relays", created_at: 200 });
    await publish(conn, older);
    await publish(conn, newer);

    const events = await collectStored(conn, "subReplace1x", [
      { kinds: [10002], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id)).toEqual([newer.id]);
    conn.close();
  });

  it("replacement is by created_at, not arrival order", async () => {
    const conn = await connectRelay();
    const newer = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: "newer", created_at: 200 });
    const older = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: "older", created_at: 100 });
    // Publish the newer-timestamped event first, then an older-timestamped
    // one arriving second -- the later arrival must not win.
    await publish(conn, newer);
    await publish(conn, older);

    const events = await collectStored(conn, "subReplaceOrder", [
      { kinds: [0], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id)).toEqual([newer.id]);
    conn.close();
  });

  it("on equal created_at, keeps the event with the lowest id", async () => {
    const conn = await connectRelay();
    const a = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: "variant a", created_at: 100 });
    const b = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: "variant b", created_at: 100 });
    await publish(conn, a);
    await publish(conn, b);

    const [expected] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    const events = await collectStored(conn, "subReplaceTie", [
      { kinds: [0], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id)).toEqual([expected!.id]);
    conn.close();
  });
});

describe("NIP-01 ephemeral kinds", () => {
  it("does not persist an ephemeral-kind event", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 20000, content: "ephemeral" });
    const [, , ok] = await publish(conn, event);
    expect(ok).toBe(true);

    const events = await collectStored(conn, "subEphemeral", [
      { kinds: [20000], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("does not persist an ephemeral-kind event at the top of its range", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 29999, content: "ephemeral" });
    await publish(conn, event);

    const events = await collectStored(conn, "subEphemeralTop", [
      { kinds: [29999], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("still relays an ephemeral event live to an open subscription", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "subLive", { kinds: [20001], authors: [OWNER_PUBKEY_HEX] }]);
    await conn.nextMessage(); // EOSE for the (empty) initial snapshot

    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 20001, content: "live" });
    await publish(conn, event); // consumes the OK frame

    const frame = await conn.nextMessage();
    expect(frame[0]).toBe("EVENT");
    expect(frame[1]).toBe("subLive");
    expect((frame[2] as { id: string }).id).toBe(event.id);
    conn.close();
  });
});

describe("NIP-01 addressable kinds", () => {
  it("keeps only the latest event per (pubkey, kind, d-tag)", async () => {
    const conn = await connectRelay();
    const older = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 30023,
      tags: [["d", "my-article"]],
      content: "draft",
      created_at: 100,
    });
    const newer = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 30023,
      tags: [["d", "my-article"]],
      content: "published",
      created_at: 200,
    });
    await publish(conn, older);
    await publish(conn, newer);

    const events = await collectStored(conn, "subAddr", [
      { kinds: [30023], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id)).toEqual([newer.id]);
    conn.close();
  });

  it("different d-tag values under the same kind+pubkey are independent", async () => {
    const conn = await connectRelay();
    const articleOne = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 30023,
      tags: [["d", "article-one"]],
      content: "one",
      created_at: 100,
    });
    const articleTwo = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 30023,
      tags: [["d", "article-two"]],
      content: "two",
      created_at: 100,
    });
    await publish(conn, articleOne);
    await publish(conn, articleTwo);

    const events = await collectStored(conn, "subAddrIndependent", [
      { kinds: [30023], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id).sort()).toEqual([articleOne.id, articleTwo.id].sort());
    conn.close();
  });
});
