// NIP-01 "Kinds" storage conventions (nips/01.md lines 86-105):
// - regular kinds (e.g. 1): every event is stored.
// - replaceable kinds (0, 3, 10000-19999): only the latest per
//   (pubkey, kind) MUST be stored/returned; equal-timestamp ties keep the
//   lowest id.
// - addressable kinds (30000-39999): only the latest per
//   (pubkey, kind, d-tag) MUST be stored/returned.
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
