// One-shot backfill (ROADMAP.md chunk 7). backfill.ts is pure over
// SqlStorage, like ownership.ts/storage.ts, so it's exercised directly
// via runInDurableObject against real storage rather than over the wire
// -- see test/follows.test.ts for the same pattern.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { applyBackfillPage, getBackfillStatus, hasBackfillHeadroom, seedBackfillRelays } from "../src/backfill";
import { recordHost } from "../src/host";
import { BACKFILL_ROWS_SHARE_LIMIT } from "../src/limits";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const PAGE_SIZE = 200;

function eventRows(sql: SqlStorage, extra = ""): { id: string; kind: number; content: string }[] {
  return sql
    .exec<{ id: string; kind: number; content: string }>(`SELECT id, kind, content FROM events ${extra}`)
    .toArray();
}

// Cheap stand-in for real live traffic -- 3 rows/event (a bare kind-1
// note, schema.ts's write-cost formula), inserted directly rather than
// through storeEvent/signEvent so the test can push the rolling 24h
// rows-written estimate over BACKFILL_ROWS_SHARE_LIMIT without actually
// signing and storing tens of thousands of events.
function insertSyntheticLiveRows(sql: SqlStorage, idPrefix: string, count: number, createdAt: number): void {
  // Cloudflare's SqlStorage caps bound parameters per statement well
  // below stock SQLite's default -- keep each batch's param count (7
  // columns/row) comfortably under that.
  const BATCH = 10;
  let inserted = 0;
  while (inserted < count) {
    const batchCount = Math.min(BATCH, count - inserted);
    const values = Array(batchCount).fill("(?, ?, ?, ?, ?, ?, ?, NULL)").join(", ");
    const params: (string | number)[] = [];
    for (let i = 0; i < batchCount; i++) {
      params.push(`${idPrefix}-${inserted + i}`, "f".repeat(64), createdAt, 1, "[]", "", "0".repeat(128));
    }
    sql.exec(
      `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration) VALUES ${values}`,
      ...params,
    );
    inserted += batchCount;
  }
}

describe("backfill ingest", () => {
  it("dedupes an event returned by more than one relay -- checked before signature verification", async () => {
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "posted once, seen on two relays" });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;

      const first = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [note], PAGE_SIZE, 1000);
      expect(first.stored).toBe(1);

      const second = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-b", [note], PAGE_SIZE, 1000);
      expect(second.stored).toBe(0);

      expect(eventRows(sql, `WHERE id = '${note.id}'`)).toHaveLength(1);
    });
  });

  it("never resurrects a tombstoned id -- a deletion made here must survive backfill from a relay that still has it", async () => {
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });

    const conn = await connectRelay();
    await publish(conn, target);
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, { kind: 5, tags: [["e", target.id]] });
    await publish(conn, deletion);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(eventRows(sql, `WHERE id = '${target.id}'`)).toHaveLength(0);

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [target], PAGE_SIZE, 1000);
      expect(result.stored).toBe(0);
      expect(eventRows(sql, `WHERE id = '${target.id}'`)).toHaveLength(0);
    });
  });

  it("a page with several versions of the owner's kind 0 collapses to exactly one row", async () => {
    const v1 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: '{"name":"old"}', created_at: 1000 });
    const v2 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: '{"name":"newer"}', created_at: 2000 });
    const v3 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: '{"name":"newest"}', created_at: 1500 });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;

      // Deliberately out of chronological order -- a real relay page
      // isn't guaranteed to arrive sorted, and storeEvent's own
      // newest-wins comparison must not depend on arrival order.
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [v1, v3, v2], PAGE_SIZE, 1000);

      const rows = eventRows(sql, `WHERE pubkey = '${OWNER_PUBKEY_HEX}' AND kind = 0`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe(v2.content);
    });
  });

  it("drops ephemeral kinds instead of storing them", async () => {
    const ephemeral = signEvent(OWNER_SECRET_KEY_HEX, { kind: 25000, content: "should not persist" });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [ephemeral], PAGE_SIZE, 1000);
      expect(result.stored).toBe(0);
      expect(eventRows(sql, `WHERE id = '${ephemeral.id}'`)).toHaveLength(0);
    });
  });

  it("ignores events from a pubkey other than the owner, even inside an authors-filtered page", async () => {
    const stranger = randomKeypair();
    const spoofed = signEvent(stranger.secretKeyHex, { kind: 1, content: "not the owner" });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [spoofed], PAGE_SIZE, 1000);
      expect(result.stored).toBe(0);
      expect(eventRows(sql, `WHERE id = '${spoofed.id}'`)).toHaveLength(0);
    });
  });

  it("advances the cursor backward and marks a relay exhausted once its page comes back short", async () => {
    const older = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "older", created_at: 1000 });
    const newer = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "newer", created_at: 2000 });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], 5000);

      // A full page (== pageSize) does not mark exhaustion yet.
      const full = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [newer, older], 2, 5000);
      expect(full.exhausted).toBe(false);
      let status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.nextUntil).toBe(older.created_at - 1);

      // A short page (< pageSize) signals the relay has no more history.
      const short = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [], 2, 6000);
      expect(short.exhausted).toBe(true);
      status = getBackfillStatus(sql);
      expect(status.status).toBe("done");
      expect(status.nextRelay).toBeNull();
    });
  });

  it("seedBackfillRelays only seeds once and flips status to running", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(getBackfillStatus(sql).status).toBe("pending");

      seedBackfillRelays(sql, ["wss://relay-a", "wss://relay-b"], 1000);
      let status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.relayCount).toBe(2);

      // A repeat call (e.g. a retried discovery) must not reset progress.
      seedBackfillRelays(sql, ["wss://relay-c"], 2000);
      status = getBackfillStatus(sql);
      expect(status.relayCount).toBe(2);
    });
  });

  it("skips its own host in the owner's write-relay list, however the deployment is named", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Whatever the deployer named their Worker -- the bug this guards
      // against was string-matching "bothy" in the URL, which a
      // differently-named deployment would never trip.
      recordHost(sql, "my-notes-thing.someusername.workers.dev");

      seedBackfillRelays(
        sql,
        ["wss://my-notes-thing.someusername.workers.dev/", "wss://relay-a", "wss://relay-b"],
        1000,
      );

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.relayCount).toBe(2);
      const relays = sql
        .exec<{ relay_url: string }>(`SELECT relay_url FROM backfill_relays ORDER BY relay_url`)
        .toArray()
        .map((r) => r.relay_url);
      expect(relays).toEqual(["wss://relay-a", "wss://relay-b"]);
    });
  });

  it("skips its own host when it's a custom domain, case- and slash-insensitively", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, "notes.example.com");

      seedBackfillRelays(sql, ["wss://NOTES.example.com", "wss://relay-a"], 1000);

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.relayCount).toBe(1);
      const relays = sql.exec<{ relay_url: string }>(`SELECT relay_url FROM backfill_relays`).toArray();
      expect(relays).toEqual([{ relay_url: "wss://relay-a" }]);
    });
  });

  it("marks backfill done, not stuck pending, when every listed write relay is itself", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, "notes.example.com");

      seedBackfillRelays(sql, ["wss://notes.example.com/"], 1000);

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("done");
      expect(status.relayCount).toBe(0);
    });
  });

  it("a budget failure mid-page stops without advancing past the failed event, and does not mark exhaustion", async () => {
    const a = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "a", created_at: 3000 });
    const b = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "b", created_at: 2000 });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], 5000);

      const real = sql.exec.bind(sql);
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sql as any).exec = (...args: unknown[]) => {
        const sqlText = String(args[0]);
        if (sqlText.startsWith("INSERT INTO events") && ++calls === 1) {
          throw new Error("simulated rows-written quota exceeded");
        }
        return real(...(args as Parameters<typeof real>));
      };

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [a, b], 2, 6000);
      expect(result.stored).toBe(0);
      expect(result.exhausted).toBe(false);

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("paused-budget");
      // Cursor must not move past `a` (the event that failed to store) --
      // it needs to be retried once the daily quota resets, not skipped.
      expect(status.nextUntil).toBe(5000);
    });
  });

  it("yields to live traffic once it already holds more than its reserved share of the daily write budget", async () => {
    const now = Math.floor(Date.now() / 1000);
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "posted while backfill waits" });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], now);

      // Below BACKFILL_ROWS_SHARE_LIMIT/3 bare-note-equivalent rows --
      // still plenty of headroom.
      insertSyntheticLiveRows(sql, "under", Math.floor(BACKFILL_ROWS_SHARE_LIMIT / 3) - 100, now);
      expect(hasBackfillHeadroom(sql, now)).toBe(true);

      // Cross the reserved share -- live traffic (real or, here,
      // synthetic) has used more than half the daily ceiling.
      insertSyntheticLiveRows(sql, "over", 200, now);
      expect(hasBackfillHeadroom(sql, now)).toBe(false);

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [note], PAGE_SIZE, now);
      expect(result).toEqual({ stored: 0, exhausted: false });
      // Nothing this call would otherwise have done actually happened:
      // no row for the fetched event, and the relay's cursor/exhausted
      // state is untouched so the same page is retried once headroom
      // reopens.
      expect(eventRows(sql, `WHERE id = '${note.id}'`)).toHaveLength(0);
      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.nextUntil).toBe(now);
    });
  });
});
