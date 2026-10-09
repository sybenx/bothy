import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readMetricsSnapshot } from "../src/read-metrics";
import { clearReqCache, readReqCache, reqCacheKey, reqCacheSnapshot, writeReqCache } from "../src/req-cache";
import type { NostrEvent as RelayEvent } from "../src/nostr";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { callManagement } from "./helpers/management";
import { collectStored, connectRelay, publish, type RelayConn } from "./helpers/socket";

// src/req-cache.ts: a REQ repeated against unchanged data reads zero rows,
// and anything that changes `events`/`event_tags` makes the next one read
// again. The second half is the one that matters -- a cache that serves a
// deleted event, or the owner's gift wraps to a stranger, is worse than
// the read bill it saves -- so most of this file is invalidation.

isolateStorage();

function stub(): DurableObjectStub<Relay> {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

async function reqRowsRead(): Promise<number> {
  const snapshot = await runInDurableObject(stub(), async () => readMetricsSnapshot());
  return snapshot.paths.find((p) => p.path === "req")?.rowsRead ?? 0;
}

async function ids(conn: RelayConn, subId: string, filter: Record<string, unknown>): Promise<string[]> {
  const events = await collectStored(conn, subId, [filter]);
  // Closed, so a later publish on this connection is not pushed to it live
  // and mistaken for the next REQ's stored answer.
  conn.send(["CLOSE", subId]);
  return events.map((e) => e.id);
}

async function authenticateAsOwner(conn: RelayConn): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage(); // CLOSED, auth-required
  conn.send([
    "AUTH",
    signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", challenge as string],
      ],
    }),
  ]);
  const [, , ok] = await conn.nextMessage();
  expect(ok).toBe(true);
}

describe("REQ result cache", () => {
  it("answers an identical REQ from memory, reading zero rows", async () => {
    const conn = await connectRelay();
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "cached" });
    expect((await publish(conn, note))[2]).toBe(true);

    const filter = { authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 };
    expect(await ids(conn, "first", filter)).toEqual([note.id]);
    const before = await reqRowsRead();
    const hitsBefore = reqCacheSnapshot().hits;

    expect(await ids(conn, "second", filter)).toEqual([note.id]);
    expect(await reqRowsRead()).toBe(before);
    expect(reqCacheSnapshot().hits).toBeGreaterThan(hitsBefore);
    conn.close();
  });

  it("survives a reconnect -- the traffic it exists for", async () => {
    const filter = { authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 };
    const first = await connectRelay();
    expect((await publish(first, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "x" })))[2]).toBe(true);
    await ids(first, "a", filter);
    first.close();

    const before = await reqRowsRead();
    const second = await connectRelay();
    expect(await ids(second, "b", filter)).toHaveLength(1);
    expect(await reqRowsRead()).toBe(before);
    second.close();
  });

  it("sees a newly published event on the next REQ", async () => {
    const conn = await connectRelay();
    const filter = { authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 };
    const a = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "a", created_at: 1_790_000_000 });
    expect((await publish(conn, a))[2]).toBe(true);
    expect(await ids(conn, "s1", filter)).toEqual([a.id]);

    const b = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "b", created_at: 1_790_000_001 });
    expect((await publish(conn, b))[2]).toBe(true);
    expect(await ids(conn, "s2", filter)).toEqual([b.id, a.id]);
    conn.close();
  });

  it("drops an event deleted by NIP-09 from the next REQ", async () => {
    const conn = await connectRelay();
    const filter = { authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 };
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "regret" });
    expect((await publish(conn, note))[2]).toBe(true);
    expect(await ids(conn, "s1", filter)).toEqual([note.id]);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, { kind: 5, tags: [["e", note.id]] });
    expect((await publish(conn, deletion))[2]).toBe(true);
    expect(await ids(conn, "s2", filter)).toEqual([]);
    conn.close();
  });

  it("drops an event banned over NIP-86 from the next REQ", async () => {
    const conn = await connectRelay();
    const filter = { authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 };
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "banned" });
    expect((await publish(conn, note))[2]).toBe(true);
    expect(await ids(conn, "s1", filter)).toEqual([note.id]);

    expect((await callManagement("banevent", [note.id, "test"])).status).toBe(200);
    expect(await ids(conn, "s2", filter)).toEqual([]);
    conn.close();
  });

  it("never hands the owner's gift wraps to an anonymous reader of the same filter", async () => {
    const stranger = randomKeypair();
    const wrap = signEvent(stranger.secretKeyHex, { kind: 1059, tags: [["p", OWNER_PUBKEY_HEX]] });
    const writer = await connectRelay();
    expect((await publish(writer, wrap))[2]).toBe(true);
    writer.close();

    // Same filter, both orders, so neither reader can be served the
    // other's entry whichever one fills the cache first.
    const filter = { "#p": [OWNER_PUBKEY_HEX], limit: 20 };
    const owner = await connectRelay();
    await authenticateAsOwner(owner);
    expect(await ids(owner, "o1", filter)).toEqual([wrap.id]);
    const anon = await connectRelay();
    expect(await ids(anon, "a1", filter)).toEqual([]);
    expect(await ids(anon, "a2", filter)).toEqual([]);
    expect(await ids(owner, "o2", filter)).toEqual([wrap.id]);
    owner.close();
    anon.close();
  });
});

describe("req-cache.ts", () => {
  const event = (id: string): RelayEvent => ({
    id,
    pubkey: OWNER_PUBKEY_HEX,
    created_at: 1,
    kind: 1,
    tags: [],
    content: "",
    sig: "",
  });

  it("leaves `nowSec` (params[0]) out of the key and keeps every other parameter in it", () => {
    expect(reqCacheKey("SELECT 1", [100, "a"])).toBe(reqCacheKey("SELECT 1", [200, "a"]));
    expect(reqCacheKey("SELECT 1", [100, "a"])).not.toBe(reqCacheKey("SELECT 1", [100, "b"]));
    expect(reqCacheKey("SELECT 1", [100, "a"])).not.toBe(reqCacheKey("SELECT 2", [100, "a"]));
  });

  it("stops serving an entry once its earliest expiration has passed", () => {
    clearReqCache();
    writeReqCache("k", [event("e1")], 1_000);
    expect(readReqCache("k", 999)?.map((e) => e.id)).toEqual(["e1"]);
    expect(readReqCache("k", 1_000)).toBeUndefined();
    writeReqCache("forever", [event("e2")], null);
    expect(readReqCache("forever", Number.MAX_SAFE_INTEGER)?.map((e) => e.id)).toEqual(["e2"]);
    clearReqCache();
  });

  it("hands out a copy, so a caller sorting in place cannot reorder the entry", () => {
    clearReqCache();
    writeReqCache("k", [event("a"), event("b")], null);
    readReqCache("k", 0)!.reverse();
    expect(readReqCache("k", 0)!.map((e) => e.id)).toEqual(["a", "b"]);
    clearReqCache();
  });
});

describe("what clears the cache (read-metrics.ts instrumentSql)", () => {
  async function clearsAfter(statement: string, ...params: unknown[]): Promise<boolean> {
    return runInDurableObject(stub(), async (instance) => {
      writeReqCache("probe", [], null);
      const sql = (instance as unknown as { sql: SqlStorage }).sql;
      sql.exec(statement, ...params);
      return reqCacheSnapshot().entries === 0;
    });
  }

  it("is cleared by a write to events or event_tags", async () => {
    expect(await clearsAfter(`DELETE FROM events WHERE id = 'none'`)).toBe(true);
    expect(await clearsAfter(`DELETE FROM event_tags WHERE event_id = 'none'`)).toBe(true);
    expect(await clearsAfter(`UPDATE events SET is_group = 0 WHERE id = 'none'`)).toBe(true);
  });

  it("is NOT cleared by the writes every wake and every connect make, which change no REQ answer", async () => {
    expect(await clearsAfter(`CREATE TABLE IF NOT EXISTS schema_meta (hash TEXT)`)).toBe(false);
    expect(await clearsAfter(`UPDATE relay_meta SET host = host WHERE 0`)).toBe(false);
    // `events` as a column name, not a table.
    expect(await clearsAfter(`UPDATE maintained_counts SET events = events WHERE 0`)).toBe(false);
    expect(await clearsAfter(`SELECT id FROM events LIMIT 0`)).toBe(false);
  });
});
