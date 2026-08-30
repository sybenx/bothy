// Rows-WRITTEN cost measurement, attributed per code path -- the write-side
// companion to test/read-cost.test.ts, which does the same for rows read.
//
// This file exists because a live relay reported rowsWrittenToday at 42,006
// of 100,000 with only 146 events ingested that day -- roughly 3,000 of that
// is event storage (CLAUDE.md "The budget"'s per-event figures), and nothing
// before this file could say what the other ~39,000 was. src/read-metrics.ts
// WriteMetricsSnapshot answers "which path", mirroring the rows-read
// attribution row for row; this file asserts that mirror is wired correctly
// and uses it (plus direct measurement, for the paths the shared "cron"
// bucket cannot itself distinguish) to test one specific hypothesis: that
// ownership.ts refreshFollows is rebuilding the follow cache on every cron
// tick because backfill keeps ingesting a kind-3 older than the one already
// cached.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";
import { resetReadMetrics, writeMetricsSnapshot } from "../src/read-metrics";
import { refreshFollows } from "../src/ownership";
import { storeEvent } from "../src/storage";
import type { Relay } from "../src/relay";

isolateStorage();

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

const FOLLOWS_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, ALLOW_FOLLOWS: "true" } as unknown as Env;

// The same local instrument test/follows.test.ts and test/hibernation.test.ts
// use for a real SqlStorageCursor.rowsWritten total, independent of
// src/read-metrics.ts's own wrapper -- so the follows-hypothesis test below
// does not depend on the very instrumentation it exists to double-check.
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

describe("write attribution", () => {
  beforeEach(async () => {
    await runInDurableObject(stub(), async () => resetReadMetrics());
  });

  it("bills a stored event's rows to the write path", async () => {
    const conn = await connectRelay();
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "hi" });
    const [, , ok] = await publish(conn, note);
    conn.close();
    expect(ok).toBe(true);

    const snapshot = await runInDurableObject(stub(), async () => writeMetricsSnapshot());
    const write = snapshot.paths.find((p) => p.path === "write");
    expect(write?.calls).toBe(1);
    // A bare kind-1 costs 9 rows measured (schema.ts EVENT_BASE_ROW_COST_MEASURED)
    // plus whatever tags this note carries (none here) -- asserted loosely
    // since the exact figure is already pinned in test/hibernation.test.ts,
    // and this test is about ATTRIBUTION, not the per-event cost itself.
    expect(write?.rowsWritten ?? 0).toBeGreaterThan(0);
    expect(snapshot.totalRowsWritten).toBeGreaterThanOrEqual(write?.rowsWritten ?? 0);
  });

  it("surfaces the write breakdown on /api/stats, mirroring the read breakdown", async () => {
    const conn = await connectRelay();
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "hi" });
    await publish(conn, note);
    conn.close();

    const response = await SELF.fetch("https://example.com/api/stats");
    const stats = (await response.json()) as {
      writes: { totalRowsWritten: number; sinceMs: number; paths: { path: string; rowsWritten: number }[] };
    };
    expect(stats.writes.totalRowsWritten).toBeGreaterThan(0);
    expect(stats.writes.sinceMs).toBeGreaterThanOrEqual(0);
    expect(stats.writes.paths.map((p) => p.path)).toContain("write");
  });

  it("does not attribute a read-only REQ to any write path", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "sub", { kinds: [1], limit: 1 }]);
    let frame = await conn.nextMessage();
    while (frame[0] !== "EOSE") frame = await conn.nextMessage();
    conn.close();

    const snapshot = await runInDurableObject(stub(), async () => writeMetricsSnapshot());
    const req = snapshot.paths.find((p) => p.path === "req");
    expect(req?.rowsWritten ?? 0).toBe(0);
  });
});

// CLAUDE.md "The budget" ascribes refreshFollows's own cost to "3 rows per
// member on the insert and 1 on the removal" for a NIP-29 membership
// change; a full follow-cache rebuild is the same shape (delete all, insert
// all) over a much larger N. The hypothesis under test: does an ordinary
// cron tick, finding backfill has ingested a kind-3 OLDER than the one
// already cached, rebuild the cache anyway?
describe("follow cache rebuild: does an unchanged or backfill-superseded kind-3 retrigger it", () => {
  it("costs ~0 rows on a tick that finds the cache already current", async () => {
    const FOLLOWS = 100;
    const tags: string[][] = Array.from({ length: FOLLOWS }, () => ["p", randomKeypair().pubkeyHex]);
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags });

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, contacts, Math.floor(Date.now() / 1000));
      // Seeds the cache once -- this is the real rebuild, and it costs
      // real rows. Not the thing under test.
      refreshFollows(sql, FOLLOWS_ENV);

      const cachedBefore = sql.exec(`SELECT COUNT(*) AS n FROM follows`).toArray()[0] as { n: number };
      expect(cachedBefore.n).toBe(FOLLOWS);

      // 24 more ticks -- one hour apart in a real deployment -- with
      // NOTHING about the stored kind-3 changed in between.
      const cost = measureRowsWritten(sql, (proxied) => {
        for (let i = 0; i < 24; i++) refreshFollows(proxied, FOLLOWS_ENV);
      });

      console.log(`MEASURED refreshFollows x24, unchanged cache: ${cost} rows`);
      // `cachedFrom === latest.created_at` short-circuits before any
      // DELETE/INSERT -- this should be exactly 0, not just small.
      expect(cost).toBe(0);
    });
  });

  it("does not rebuild when backfill stores a kind-3 OLDER than the cached one", async () => {
    const FOLLOWS = 100;
    const currentTags: string[][] = Array.from({ length: FOLLOWS }, () => [
      "p",
      randomKeypair().pubkeyHex,
    ]);
    const nowSec = Math.floor(Date.now() / 1000);
    // The real, current contact list -- as if published directly to this
    // relay, or discovered by backfill long ago.
    const current = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: currentTags,
      created_at: nowSec,
    });

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, current, nowSec);
      refreshFollows(sql, FOLLOWS_ENV);
      expect(
        (sql.exec(`SELECT COUNT(*) AS n FROM follows`).toArray()[0] as { n: number }).n,
      ).toBe(FOLLOWS);

      // 24 ticks, each simulating one cron cycle: backfill ingests ONE
      // OLDER kind-3 it has never seen before (a different id, an earlier
      // created_at -- e.g. a stale copy from a third relay backfill is
      // still walking), via storeEvent exactly as applyBackfillPage calls
      // it, immediately followed by the cron's own refreshFollows.
      const cost = measureRowsWritten(sql, (proxied) => {
        for (let i = 0; i < 24; i++) {
          const older = signEvent(OWNER_SECRET_KEY_HEX, {
            kind: 3,
            tags: [["p", randomKeypair().pubkeyHex]],
            created_at: nowSec - 86400 * (i + 1) * 30, // months further back each tick
          });
          // backfill.ts applyBackfillPage stamps ingestedAt = nowSec
          // (wall-clock), not the backfilled event's own created_at --
          // see storage.ts insertEventRow's comment on why.
          storeEvent(proxied, older, nowSec);
          refreshFollows(proxied, FOLLOWS_ENV);
        }
      });

      console.log(`MEASURED 24x(backfill older kind-3 + refreshFollows): ${cost} rows`);
      // storeEvent's replaceable-kind branch refuses every one of these
      // (isSupersededBy: existing.created_at > candidate.created_at) --
      // "stored: null", no DELETE, no INSERT. The cached kind-3 never
      // changes, so refreshFollows finds nothing to do on every one of
      // the 24 subsequent calls too.
      //
      // If this is nonzero, the hypothesis as stated -- backfill ingesting
      // OLDER history retriggers the rebuild -- is confirmed. It was zero,
      // and the unaccounted rows were subsequently traced to the MIRROR
      // case this test's fixture could not produce: a genuinely NEWER
      // kind-3 carrying an UNCHANGED follow set, which clients republish
      // as a matter of course and which the then-current created_at
      // watermark could not tell from a real change. That case is fixed
      // by comparing the set itself (ownership.ts computeFollowsHash) and
      // pinned in test/follows.test.ts's identical-republish test; this
      // one stays as the record of the hypothesis that was tested first
      // and the direction it ruled out.
      expect(cost).toBe(0);

      const stillCached = sql.exec(`SELECT COUNT(*) AS n FROM follows`).toArray()[0] as { n: number };
      expect(stillCached.n).toBe(FOLLOWS);
    });
  });
});
