// NIP-09 Event Deletion Request (nips/09.md): kind 5 with e/a tags marks
// referenced events for deletion. "Relays SHOULD delete or stop
// publishing any referenced events" (line 31); "SHOULD continue to
// publish/share the deletion request events indefinitely" (line 33);
// a-tag deletion removes replaceable/addressable versions up to the
// deletion's created_at (line 35); deleting a deletion request has no
// effect (line 53).
//
// Deletion requests here are always owner-authored, since only the owner
// can write non-gift-wrap events (see test/ownership.test.ts) -- every
// non-gift-wrap event this relay stores necessarily shares the deletion
// request's pubkey, so the "same pubkey" requirement in NIP-09 is
// trivially satisfied for this suite's fixtures. storage.ts applyDeletion
// checks it explicitly anyway (see its comment), since gift wraps
// broke that invariant relay-wide -- the gift-wrap
// carve-out (authorized by `p` tag, not pubkey) and its own tombstone
// durability are tested in test/nip59-deletion.test.ts.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { collectStored, connectRelay, publish } from "./helpers/socket";
import { eventExists } from "../src/storage";

async function stillExists(id: string): Promise<boolean> {
  const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
  let result = false;
  await runInDurableObject(stub, async (_instance, state) => {
    result = eventExists(state.storage.sql, id);
  });
  return result;
}

isolateStorage();

describe("NIP-09 deletion", () => {
  it("an e-tag deletion request removes the referenced event from REQ results", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "posted by accident",
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subDeleted", [{ ids: [target.id] }]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("the deletion request event itself remains queryable", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "",
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subDeletionEvent", [{ ids: [deletion.id] }]);

    expect(events.map((e) => e.id)).toEqual([deletion.id]);
    conn.close();
  });

  it("an a-tag deletion removes replaceable event versions up to its created_at", async () => {
    const conn = await connectRelay();
    const replaceable = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 10002,
      content: "relay list",
      created_at: 100,
    });
    await publish(conn, replaceable);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["a", `10002:${OWNER_PUBKEY_HEX}:`], ["k", "10002"]],
      content: "",
      created_at: 200,
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subADeleteReplaceable", [
      { kinds: [10002], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("an a-tag deletion removes the matching addressable event by d-tag", async () => {
    const conn = await connectRelay();
    const article = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 30023,
      tags: [["d", "my-article"]],
      content: "draft",
      created_at: 100,
    });
    await publish(conn, article);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["a", `30023:${OWNER_PUBKEY_HEX}:my-article`], ["k", "30023"]],
      content: "",
      created_at: 200,
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subADeleteAddressable", [
      { kinds: [30023], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("a deleted event's id cannot be re-published (tombstone durability)", async () => {
    // NIP-09 requires deleted events not be re-broadcastable; without a
    // tombstone, re-sending the exact same signed event after deletion
    // would just re-insert it, since the row is gone and a plain
    // `eventExists` check can't tell "new id" from "deleted id" apart.
    // See schema.ts `deleted_ids` / storage.ts `deleteAndTombstone`.
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "",
    });
    await publish(conn, deletion);

    const [, id, ok, message] = await publish(conn, target);

    expect(id).toBe(target.id);
    expect(ok).toBe(false);
    expect(message.startsWith("blocked:")).toBe(true);

    const events = await collectStored(conn, "subReplay", [{ ids: [target.id] }]);
    expect(events).toEqual([]);
    conn.close();
  });

  it("a deletion request only removes events sharing its pubkey", async () => {
    // storage.ts applyDeletion's e-tag branch now checks this explicitly
    // rather than relying on the write-gate invariant -- seed a
    // foreign-authored event directly (bypassing the write gate, which
    // would otherwise make this untestable over the wire) and confirm
    // the owner's own kind-5 cannot delete it.
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const foreign = signEvent(randomKeypair().secretKeyHex, { kind: 1, content: "not yours" });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        foreign.id,
        foreign.pubkey,
        foreign.created_at,
        foreign.kind,
        JSON.stringify(foreign.tags),
        foreign.content,
        foreign.sig,
        null,
      );
    });

    const conn = await connectRelay();
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", foreign.id], ["k", "1"]],
      content: "",
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subForeign", [{ ids: [foreign.id] }]);
    expect(events.map((e) => e.id)).toEqual([foreign.id]);
    conn.close();
  });

  it("publishing a deletion request against a deletion request has no effect", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "",
    });
    await publish(conn, deletion);

    const undelete = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", deletion.id], ["k", "5"]],
      content: "undo",
    });
    await publish(conn, undelete);

    const events = await collectStored(conn, "subUndelete", [{ ids: [deletion.id] }]);

    expect(events.map((e) => e.id)).toEqual([deletion.id]);
    conn.close();
  });
});

// NIP-09 `a` tags address replaceable and addressable events -- a
// "<kind>:<pubkey>:<d>" coordinate exists only for kinds that have one.
// Regular events are deleted by `e` tag, one id at a time.
//
// Accepting a regular kind was a conformance bug with a sharp edge:
// `1:<pubkey>:` names no single event, so it was read as "every kind-1
// event by that pubkey" and tombstoned all of them. One tag, unbounded N,
// each removal paying storage.ts deleteEventRow. That made
// MAX_EVENT_BYTES a bound on nothing for bulk deletion -- the size cap
// limits a kind-5 to roughly 870 `e` tags, and a single `a` tag reached
// the same N with none of the effort.
describe("NIP-09 `a` tag kind restriction", () => {
  it("ignores an `a` tag naming a regular kind instead of deleting every event of it", async () => {
    const conn = await connectRelay();
    const now = Math.floor(Date.now() / 1000);

    const first = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "one", created_at: now });
    const second = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "two", created_at: now });
    await publish(conn, first);
    await publish(conn, second);

    const bulk = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["a", `1:${OWNER_PUBKEY_HEX}:`]],
      created_at: now + 1,
    });
    await publish(conn, bulk);
    conn.close();

    // Both survive: a regular kind has no coordinate to address.
    expect(await stillExists(first.id)).toBe(true);
    expect(await stillExists(second.id)).toBe(true);
  });

  it("still honours an `a` tag naming a replaceable kind", async () => {
    const conn = await connectRelay();
    const now = Math.floor(Date.now() / 1000);

    const list = signEvent(OWNER_SECRET_KEY_HEX, { kind: 10003, content: "bookmarks", created_at: now });
    await publish(conn, list);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["a", `10003:${OWNER_PUBKEY_HEX}:`]],
      created_at: now + 1,
    });
    await publish(conn, deletion);
    conn.close();

    expect(await stillExists(list.id)).toBe(false);
  });

  it("still honours an `a` tag naming an addressable kind", async () => {
    const conn = await connectRelay();
    const now = Math.floor(Date.now() / 1000);

    const article = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 30023,
      content: "long form",
      tags: [["d", "slug"]],
      created_at: now,
    });
    await publish(conn, article);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["a", `30023:${OWNER_PUBKEY_HEX}:slug`]],
      created_at: now + 1,
    });
    await publish(conn, deletion);
    conn.close();

    expect(await stillExists(article.id)).toBe(false);
  });
});
