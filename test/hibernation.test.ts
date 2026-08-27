// Confirms the Relay object becomes eligible to hibernate after the last
// message. evictDurableObject() tears down the in-memory instance
// while (by default) hibernating rather than closing any accepted
// WebSockets -- if this object were using ws.accept() instead of
// ctx.acceptWebSocket(), the socket would not survive eviction, and
// re-fetching its state from storage would fail this assertion.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  EVENT_BASE_ROW_COST,
  eventRemovalBudget,
  eventRemovalRowsWritten,
  eventRowCost,
  indexesOn,
  TAG_ROW_COST,
  TOMBSTONE_ROW_COST,
} from "../src/schema";
import {
  BACKFILL_PAGE_SIZE,
  BACKFILL_ROWS_SHARE_LIMIT,
  CRON_TICKS_PER_DAY,
  VANISH_BATCH_SIZE,
  VANISH_ROWS_SHARE_LIMIT,
} from "../src/limits";
import { applyDeletion, storeEvent as store } from "../src/storage";
import { storeEvent } from "../src/storage";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import wranglerConfig from "../wrangler.jsonc?raw";
import { cronTicksPerDay } from "./helpers/cron";

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

// Removing an event is a write too, and it is the figure the NIP-62
// vanish drain is paced against. Measured, like the insert cost above,
// because limits.ts VANISH_BATCH_SIZE divides the vanish share by it --
// if this derivation is wrong the drain either overruns its share or
// crawls, and neither is visible from the outside.
describe("rows written per removed event", () => {
  it("matches eventRemovalRowsWritten for a reply carrying #e and #p", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const now = Math.floor(Date.now() / 1000);
    const target = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "to be deleted",
      created_at: now,
      tags: [
        ["e", "a".repeat(64)],
        ["p", "b".repeat(64)],
      ],
    });
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id]],
      created_at: now + 1,
    });

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      store(sql, target, now);
      // applyDeletion is the real removal path: it deletes the tag rows,
      // the event row, and writes the tombstone that stops a replay.
      const measured = measureRowsWritten(sql, (s) => applyDeletion(s, deletion));
      // Two tag rows + the event row + the tombstone. NOT
      // eventRowCost(2) + TOMBSTONE_ROW_COST: the cursor counts index
      // maintenance on INSERT and not on DELETE, which is why schema.ts
      // carries two figures for a removal rather than one.
      expect(measured).toBe(eventRemovalRowsWritten(2));
      expect(measured).toBeLessThan(eventRemovalBudget(2));
    });
  });
});

// The derived work-per-tick constants are asserted against their SHARE,
// not against the number they currently resolve to. Asserting the number
// would just be the hand-derived literal again, one level removed: it
// would have to be edited by hand every time an index moved, which is the
// failure both constants exist to end. What must hold is the invariant --
// each stays inside the fraction of the daily write ceiling it was given,
// whatever the schema does.
describe("work-per-tick constants stay inside their share", () => {
  const TAGS_PER_REAL_EVENT = 5;

  it("matches the actual cron trigger in wrangler.jsonc", () => {
    // limits.ts CRON_TICKS_PER_DAY restates this project's crontab as a
    // number, because BACKFILL_PAGE_SIZE and VANISH_BATCH_SIZE need to
    // divide a per-tick share by it and a Worker cannot read its own
    // wrangler.jsonc at runtime -- that file is consumed by the `wrangler`
    // CLI at deploy time, not bundled into what runs. So it is a fact
    // about wrangler.jsonc living in a second file, and this is the test
    // that keeps the two from drifting: change the trigger to, say,
    // `*/15 * * * *` for tighter backfill/vanish latency without updating
    // CRON_TICKS_PER_DAY, and this fails instead of BACKFILL_PAGE_SIZE
    // silently projecting 4x its actual reserved share.
    const match = wranglerConfig.match(/"crons"\s*:\s*\[\s*"([^"]+)"/);
    if (!match) throw new Error("could not find triggers.crons in wrangler.jsonc");
    expect(cronTicksPerDay(match[1]!)).toBe(CRON_TICKS_PER_DAY);
  });

  it("keeps backfill inside its reserved share", () => {
    const perDay = BACKFILL_PAGE_SIZE * eventRowCost(TAGS_PER_REAL_EVENT) * CRON_TICKS_PER_DAY;
    expect(perDay).toBeLessThanOrEqual(BACKFILL_ROWS_SHARE_LIMIT);
  });

  it("keeps the vanish drain inside its reserved share", () => {
    const perDay = VANISH_BATCH_SIZE * eventRemovalBudget(TAGS_PER_REAL_EVENT) * CRON_TICKS_PER_DAY;
    expect(perDay).toBeLessThanOrEqual(VANISH_ROWS_SHARE_LIMIT);
  });

  it("never derives zero work per tick", () => {
    // A derived constant that can collapse to a no-op is worse than the
    // literal it replaced. For the vanish drain it is worse still:
    // drainVanish reads "fewer rows than the limit" as "nothing left", so
    // a limit of 0 would delete nothing, never report done, and leave the
    // request pending forever.
    expect(BACKFILL_PAGE_SIZE).toBeGreaterThanOrEqual(1);
    expect(VANISH_BATCH_SIZE).toBeGreaterThanOrEqual(1);
  });
});
