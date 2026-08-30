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
  EVENT_BASE_ROW_COST_MEASURED,
  EVENT_COUNTER_ROW_COST,
  eventRemovalBudget,
  eventRemovalRowsWritten,
  eventRowCost,
  eventRowCostMeasured,
  partialIndexPairsOn,
  indexesOn,
  TAG_ROW_COST_MEASURED,
  TOMBSTONE_ROW_COST,
} from "../src/schema";
import {
  BACKFILL_PAGE_SIZE,
  BACKFILL_ROWS_SHARE_LIMIT,
  CRON_TICKS_PER_DAY,
  VANISH_BATCH_SIZE,
  VANISH_ROWS_SHARE_LIMIT,
} from "../src/limits";
import { TOP_LEVEL_GROUP_ID } from "../src/groups";
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
  // ------------------------------------------------------------------
  // THE DERIVATION IS DELIBERATELY WRONG, AND THIS IS WHERE THAT IS
  // RECORDED. Do not "fix" a failure here by editing the numbers.
  //
  // schema.ts declares the three REQ-serving indexes on `events`, and the
  // tag lookup index, as partial PAIRS keyed on `is_group` (one half over
  // the public partition, one over the group partition). A stored row
  // satisfies exactly one half of each pair, so it pays one index entry
  // per pair -- but EVENT_BASE_ROW_COST is `2 + indexesOn("events").length`
  // and TAG_ROW_COST is `1 + indexesOn("event_tags").length`, and both
  // count the halves separately:
  //
  //   eventRowCost(T)          12 + 4T   charged
  //   eventRowCostMeasured(T)   9 + 3T   spent
  //   over-charge               3 +  T   per stored event
  //
  // Left wrong on purpose: every consumer of eventRowCost is a guard, and
  // an over-estimate makes each of them stricter -- smaller backfill
  // pages, smaller vanish batches, an earlier headroom stop. Slower, never
  // overrunning. schema.ts EVENT_BASE_ROW_COST carries the full argument.
  //
  // These tests exist so that (a) the wrongness cannot drift -- the gap is
  // pinned, not merely tolerated -- and (b) a future fix cannot land
  // quietly: making the derivation right turns every `eventRowCost`
  // expectation below into a failure, and the fix is then to delete the
  // over-charge assertions and schema.ts's eventRowCostMeasured with them.
  // ------------------------------------------------------------------
  it("costs eventRowCostMeasured for a bare note, and eventRowCost over-charges it", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "no tags" });

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      const measured = measureRowsWritten(state.storage.sql, (sql) =>
        storeEvent(sql, note, Math.floor(Date.now() / 1000)),
      );
      // 1 base row + 1 implicit PK index (id is TEXT, not a rowid alias)
      // + 1 per index a public row actually pays (three partial halves and
      // idx_events_ingested), + the three maintained counters
      // storage.ts insertEventRow moves in the same breath as the row
      // (schema.ts EVENT_COUNTER_ROW_COST). The counters are part of what
      // storing an event costs, so they are part of what this asserts --
      // they are not free and the budget must not be told they are.
      expect(measured).toBe(9);
      expect(measured).toBe(eventRowCostMeasured(0));
      expect(measured).toBe(
        2 + indexesOn("events").length - partialIndexPairsOn("events") + EVENT_COUNTER_ROW_COST,
      );

      // And the figure the guards use, which is higher on purpose.
      expect(eventRowCost(0)).toBe(12);
      expect(eventRowCost(0) - measured).toBe(partialIndexPairsOn("events"));
    });
  });

  it("costs eventRowCostMeasured for a reply carrying #e and #p, over-charged by one per tag", async () => {
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
      expect(measured).toBe(15);
      expect(measured).toBe(eventRowCostMeasured(2));
      expect(measured).toBe(
        EVENT_BASE_ROW_COST_MEASURED + EVENT_COUNTER_ROW_COST + 2 * TAG_ROW_COST_MEASURED,
      );

      // The tag half of the over-charge: `event_tags` carries a partial
      // pair too, so each tag row is charged 4 and costs 3.
      expect(eventRowCost(2)).toBe(20);
      expect(eventRowCost(2) - measured).toBe(
        partialIndexPairsOn("events") + 2 * partialIndexPairsOn("event_tags"),
      );
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
      expect(measured).toBe(eventRowCostMeasured(1));
    });
  });

  it("costs a group event exactly what a public one costs", async () => {
    // The whole reason the indexes are partial PAIRS rather than one
    // widened index or one index plus a flag: a row pays for its own
    // partition and not the other. If this ever diverges, the group
    // partition has stopped being free and every figure in
    // CLAUDE.md "The budget" needs redoing.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const now = Math.floor(Date.now() / 1000);
    const publicNote = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "public",
      created_at: now,
      tags: [["e", "c".repeat(64)]],
    });
    const groupNote = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "in the group",
      created_at: now,
      // `h` is a single-letter tag, so it costs a tag row of its own --
      // hence one indexed tag each, not one against two. Tagged with
      // TOP_LEVEL_GROUP_ID specifically -- isGroupEvent (groups.ts) now
      // scopes the partition to this relay's own group id, so an
      // arbitrary id would land in the PUBLIC partition instead and the
      // comparison below would not be testing what it says it is.
      tags: [["h", TOP_LEVEL_GROUP_ID]],
    });

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const publicCost = measureRowsWritten(sql, (s) => storeEvent(s, publicNote, now));
      const groupCost = measureRowsWritten(sql, (s) => storeEvent(s, groupNote, now));
      expect(groupCost).toBe(publicCost);
      expect(groupCost).toBe(eventRowCostMeasured(1));
      // And it landed in the group partition, which is what made the
      // comparison worth making.
      expect(
        sql.exec<{ is_group: number }>(`SELECT is_group FROM events WHERE id = ?`, groupNote.id).toArray()[0]
          ?.is_group,
      ).toBe(1);
    });
  });

  it("stamps the OVER-CHARGED figure into events.row_cost, which is what the 24h estimate sums", async () => {
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
      // It used to equal what SQLite actually wrote, and no longer does:
      // the stamp is eventRowCost, which over-charges. backfill.ts
      // hasBackfillHeadroom sums this column and so stops sooner than it
      // needs to -- the safe direction, and the reason this reads as an
      // inequality rather than an equality.
      expect(stamped).toBe(eventRowCost(2));
      expect(stamped).toBeGreaterThan(measured);
      expect((stamped ?? 0) - measured).toBe(
        partialIndexPairsOn("events") + 2 * partialIndexPairsOn("event_tags"),
      );
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
