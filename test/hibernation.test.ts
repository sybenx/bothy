// Confirms the Relay object becomes eligible to hibernate after the last
// message. evictDurableObject() tears down the in-memory instance
// while (by default) hibernating rather than closing any accepted
// WebSockets -- if this object were using ws.accept() instead of
// ctx.acceptWebSocket(), the socket would not survive eviction, and
// re-fetching its state from storage would fail this assertion.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EVENT_BASE_ROW_COST, eventRowCost, indexesOn, TAG_ROW_COST } from "../src/schema";
import { storeEvent } from "../src/storage";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";

isolateStorage();

// Sums SqlStorageCursor.rowsWritten across every statement `fn` issues.
// INSERT/DELETE execute eagerly and their cursor carries a final
// rowsWritten immediately, so no consumption is needed -- unlike rowsRead,
// which only settles once a SELECT cursor is drained (see
// src/read-metrics.ts).
function measureRowsWritten(sql: SqlStorage, fn: (sql: SqlStorage) => void): number {
  let total = 0;
  const proxy = new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return (query: string, ...bindings: unknown[]) => {
          const cursor = target.exec(query, ...bindings);
          total += cursor.rowsWritten;
          return cursor;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as SqlStorage;
  fn(proxy);
  return total;
}

describe("hibernation", () => {
  it("survives eviction with the accepted WebSocket intact", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);

    const response = await stub.fetch("https://example.com/", {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error("expected a websocket response");
    socket.accept();

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      expect(state.getWebSockets()).toHaveLength(1);
    });

    // Default eviction options hibernate rather than close accepted
    // sockets -- this is the behaviour being asserted.
    await evictDurableObject(stub);

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      expect(state.getWebSockets()).toHaveLength(1);
    });

    socket.close(1000, "test done");
  });
});

// The rows-written baseline (CLAUDE.md "The budget").
//
// These assert the DERIVATION in schema.ts against what SQLite actually
// does, which is the only reason it is safe for eventRowCost to compute
// the per-event cost from the index list rather than have it written down
// as a measured constant. Two indexes were added in v0.7.2 to fix the
// rows-READ exhaustion; the rows-written cost that bought is measured
// here, on the real write path, not inferred from counting index
// declarations. This project has already shipped a rows-written figure
// that was wrong by 45x, and it was wrong because nobody measured it.
describe("rows written per stored event", () => {
  it("matches eventRowCost for a bare note", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "no tags" });

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      const measured = measureRowsWritten(state.storage.sql, (sql) =>
        storeEvent(sql, note, Math.floor(Date.now() / 1000)),
      );
      // 1 base row + 1 implicit PK index (id is TEXT, not a rowid alias)
      // + 1 per declared index on `events`.
      expect(measured).toBe(eventRowCost(0));
      expect(measured).toBe(2 + indexesOn("events").length);
    });
  });

  it("matches eventRowCost for a reply carrying #e and #p", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const reply = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "two indexed tags",
      tags: [
        ["e", "a".repeat(64)],
        ["p", "b".repeat(64)],
      ],
    });

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      const measured = measureRowsWritten(state.storage.sql, (sql) =>
        storeEvent(sql, reply, Math.floor(Date.now() / 1000)),
      );
      expect(measured).toBe(eventRowCost(2));
      expect(measured).toBe(EVENT_BASE_ROW_COST + 2 * TAG_ROW_COST);
    });
  });

  it("charges nothing for a multi-character tag, which is stored but never indexed", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "one indexed tag, one not",
      tags: [
        ["e", "a".repeat(64)],
        ["client", "some-app"],
      ],
    });

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      const measured = measureRowsWritten(state.storage.sql, (sql) =>
        storeEvent(sql, event, Math.floor(Date.now() / 1000)),
      );
      expect(measured).toBe(eventRowCost(1));
    });
  });

  it("stamps the same figure into events.row_cost, which is what the 24h estimate sums", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const reply = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "stamped",
      tags: [
        ["e", "a".repeat(64)],
        ["p", "b".repeat(64)],
      ],
    });

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const measured = measureRowsWritten(sql, (s) => storeEvent(s, reply, Math.floor(Date.now() / 1000)));
      const stamped = sql
        .exec<{ row_cost: number }>(`SELECT row_cost FROM events WHERE id = ?`, reply.id)
        .toArray()[0]?.row_cost;
      // The stamp is what backfill.ts hasBackfillHeadroom throttles
      // against and what the admin page displays, so it has to equal what
      // SQLite actually wrote -- not merely equal the formula.
      expect(stamped).toBe(measured);
    });
  });
});
