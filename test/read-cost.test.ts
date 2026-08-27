// Rows-read cost measurement, the read-side companion to
// test/hibernation.test.ts's write/CPU regressions.
//
// This file exists because the live relay exhausted the Workers Free
// plan's 5,000,000 rows-read/day allowance under ordinary single-owner
// operation and nothing here could say which path spent them --
// CLAUDE.md "The budget" had measured rows *written* per event to four decimal
// places and rows *read* only at the two places somebody was already
// suspicious of. The figures below are the ones CLAUDE.md "The budget"'s
// "Rows read, by path" section reasons from; if a change moves one,
// that section's arithmetic is stale and has to be redone.
//
// Most costs here are measured BOTH ways -- the pre-v0.7.2 form and the
// current one, against the same rows in the same Durable Object -- so the
// before/after table in CLAUDE.md "The budget" is a measurement rather than two
// runs compared from memory. Where an index is what changed, the "before"
// case is reproduced with SQLite's unary + operator, which suppresses
// index use on a term (sqlite.org/optoverview.html). Dropping the index
// instead would leave this file's shared Durable Object in a different
// state for whatever test ran next.
//
// One assertion is still shaped as "this is expensive and scales with the
// table" rather than "this must stay under N": the event_tags delete. It
// records a cost that was deliberately NOT fixed, for a reason
// CLAUDE.md "The budget" states, and a test that pretended otherwise would hide
// it.
//
// Rows are inserted straight into `events`/`event_tags` rather than
// published over the wire -- the same deliberate exception
// docs/test-notes.md records for nip40-expiration.test.ts, for the same
// kind of reason: these costs only become legible at a table size that
// would take thousands of schnorr signatures to reach through the
// protocol, and nothing about the read cost of a row depends on how it
// got there.
import { env, runInDurableObject, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { buildFilterQuery, expandFilter, expandFilterCount } from "../src/filters";
import { boundFilter, MAX_FILTER_ROWS_READ } from "../src/limits";
import type { Filter } from "../src/nostr";
import { queryFilter, readStatsSnapshot } from "../src/storage";
import { readMetricsSnapshot, resetReadMetrics } from "../src/read-metrics";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay } from "./helpers/socket";

// Small enough to seed quickly, large enough that a full scan is
// unmistakably distinct from an index seek. Every expectation below is
// written against these two numbers rather than against a bare
// constant, so the *shape* of each cost (bounded, ~E, ~T) is what is
// actually asserted.
const EVENTS = 1000;
const TAGS_PER_EVENT = 5;
const TAG_ROWS = EVENTS * TAGS_PER_EVENT;
// How many of the seeded rows carry an `ingested_at` inside the rolling
// 24h window estimateRowsWritten24h measures. Ten, not zero, and the
// difference matters twice over.
//
// It mattered for the pre-v0.7.2 join: with nothing in the window SQLite
// scanned `events` and stopped, never touching `event_tags`; with
// anything in it the unindexed join engaged and the whole of
// `event_tags` was read to satisfy ten rows.
//
// It matters again for idx_events_ingested (v0.7.6), and this is the
// number the "after" case is now asserted against. The whole claim of
// that index is that the query costs the size of the WINDOW rather than
// the size of the table, and a window of zero could not tell a working
// index from a query that found nothing to add up.
const RECENTLY_INGESTED = 10;

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

// Rows read by one query, straight off the cursor -- the same mechanism
// test/hibernation.test.ts uses for rowsWritten.
function rowsRead(sql: SqlStorage, query: string, ...bindings: unknown[]): number {
  const cursor = sql.exec(query, ...bindings);
  cursor.toArray();
  return cursor.rowsRead;
}

beforeAll(async () => {
  await runInDurableObject(stub(), async (_instance: Relay, state) => {
    const sql = state.storage.sql;
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < EVENTS; i++) {
      const id = i.toString(16).padStart(64, "0");
      sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        OWNER_PUBKEY_HEX,
        now - (EVENTS - i) * 60,
        // A minority of a second kind, so a kinds filter is selective
        // enough to be worth an index if one existed.
        i % 40 === 0 ? 7 : 1,
        "[]",
        "x",
        "sig",
        null,
        i >= EVENTS - RECENTLY_INGESTED ? now - 100 : now - 200_000,
      );
      for (let t = 0; t < TAGS_PER_EVENT; t++) {
        sql.exec(
          `INSERT INTO event_tags (tag_name, tag_value, event_id, created_at) VALUES (?, ?, ?, ?)`,
          t % 2 === 0 ? "e" : "p",
          `v${i}_${t}`,
          id,
          now,
        );
      }
    }
  });
});

describe("rows read by query shape", () => {
  it("bounds a kinds-only filter by its limit, where it once scanned the table", async () => {
    // The shape that broke the relay. `kind` was the leftmost column of
    // no index, so buildFilterQuery's ORDER BY created_at DESC had to
    // sort every matching row before LIMIT could discard any -- limit 20
    // and limit 500 cost the identical 2E. idx_events_kind_created
    // (schema.ts) now serves the sort directly.
    //
    // The "before" figure is measured live rather than quoted from a
    // comment: SQLite's unary + operator suppresses index use on a term
    // (sqlite.org/optoverview.html), so `+kind IN (...)` reproduces
    // exactly the plan this filter used to get, against the same rows.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);

      const small = buildFilterQuery({ kinds: [1], limit: 20 }, now);
      const large = buildFilterQuery({ kinds: [1], limit: 500 }, now);
      expect(small).not.toBeNull();
      expect(large).not.toBeNull();

      const smallCost = rowsRead(sql, small!.sql, ...small!.params);
      const largeCost = rowsRead(sql, large!.sql, ...large!.params);

      // 2 rows per returned event (index entry + table row) + 1. This is
      // the measurement limits.ts ROWS_READ_PER_MATCH is set from.
      expect(smallCost).toBe(41);
      expect(largeCost).toBe(1001);
      // The property that was missing before: asking for less costs less.
      expect(smallCost).toBeLessThan(largeCost);

      const unindexed = rowsRead(sql, small!.sql.replace("kind IN", "+kind IN"), ...small!.params);
      expect(unindexed).toBeGreaterThan(EVENTS);
      // ~48x cheaper at E=1,000, and the ratio grows with the table: the
      // new cost is a function of `limit`, the old one of E.
      expect(smallCost * 10).toBeLessThan(unindexed);
    });
  });

  it("bounds an authors-only filter by its limit, where it once scanned the table", async () => {
    // Not a surprise once stated: the only index was (pubkey, kind,
    // created_at), so with `kind` unconstrained the rows for one pubkey
    // arrived grouped by kind rather than in created_at order and ORDER
    // BY had to sort all of them. On a single-owner relay "all rows for
    // one pubkey" is the entire table. idx_events_pubkey_created is the
    // index that makes this the same shape of cheap as any other.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const query = buildFilterQuery({ authors: [OWNER_PUBKEY_HEX], limit: 20 }, Math.floor(Date.now() / 1000));
      expect(query).not.toBeNull();

      expect(rowsRead(sql, query!.sql, ...query!.params)).toBe(41);
      const unindexed = rowsRead(sql, query!.sql.replace("pubkey IN", "+pubkey IN"), ...query!.params);
      expect(unindexed).toBeGreaterThan(EVENTS);
    });
  });

  it("stays bounded by the limit when the same filter also names authors and one kind", async () => {
    // (pubkey, kind, created_at DESC) covers this exactly, and always
    // did -- the one filter shape that was never the problem. Kept as the
    // control: if this regresses, the index set has been broken rather
    // than extended.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const query = buildFilterQuery(
        { authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 },
        Math.floor(Date.now() / 1000),
      );
      expect(query).not.toBeNull();
      expect(rowsRead(sql, query!.sql, ...query!.params)).toBeLessThan(100);
    });
  });

  it("splits a multi-kind filter instead of sorting the table for it", async () => {
    // An index can only serve the sort when every key column ahead of
    // created_at is pinned to ONE value, and `kind IN (1, 7)` pins
    // nothing -- so a multi-kind filter defeated the new index just as
    // thoroughly as no index at all. filters.ts expandFilter is what
    // closes that hole: one limited query per (author, kind)
    // combination, re-merged and re-sliced by storage.ts queryFilter.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const filter = { kinds: [1, 7], limit: 20 };

      const single = buildFilterQuery(filter, now);
      expect(single).not.toBeNull();
      const singleCost = rowsRead(sql, single!.sql, ...single!.params);

      let splitCost = 0;
      const parts = expandFilter(filter);
      expect(parts).toHaveLength(2);
      for (const part of parts) {
        const query = buildFilterQuery(part, now);
        splitCost += rowsRead(sql, query!.sql, ...query!.params);
      }

      expect(singleCost).toBeGreaterThan(EVENTS);
      expect(splitCost).toBe(82);
      expect(splitCost * 10).toBeLessThan(singleCost);
    });
  });

  it("returns the same events split as it would have unsplit", async () => {
    // The split has to be invisible from the outside, or it is a protocol
    // change rather than an optimisation. Each sub-filter carries the
    // original limit, so the union can overshoot; queryFilter re-sorts by
    // buildFilterQuery's own ordering rule and slices back.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const filter = { kinds: [1, 7], limit: 20 };

      const split = queryFilter(sql, filter, now);
      const single = buildFilterQuery(filter, now)!;
      const unsplit = sql
        .exec<{ id: string }>(single.sql, ...single.params)
        .toArray()
        .map((r) => r.id);

      expect(split).toHaveLength(20);
      expect(split.map((e) => e.id)).toEqual(unsplit);
    });
  });

  it("costs estimateRowsWritten24h the size of the 24h window, not the size of the table", async () => {
    // The last line of the fixed daily floor, removed in two steps, and
    // both steps are measured here against the same rows in the same
    // Durable Object so the before/after in CLAUDE.md "The budget" is a
    // measurement rather than two runs compared from memory.
    //
    // Step one (v0.7.2) removed a LEFT JOIN. The query derived each
    // event's tag count live, and idx_event_tags_lookup is
    // (tag_name, tag_value, created_at) with `event_id` nowhere in it --
    // so SQLite built an automatic index over all of `event_tags` on
    // every call, reading E + T to answer a question about the ten rows
    // in the window. Stamping `row_cost` at insert time cut that to E.
    //
    // Step two (v0.7.6) removed the scan. E is not a constant, and a
    // cost proportional to everything ever stored -- paid twice per cron
    // tick by backfill.ts hasBackfillHeadroom, so 48E rows/day with no
    // client connected -- gets worse as the relay fills whether or not
    // anything else changes. idx_events_ingested is
    // (ingested_at, row_cost): covering, so the SUM is a range seek
    // answered from the index without visiting the table at all.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const since = Math.floor(Date.now() / 1000) - 86_400;

      // `+t.event_id` suppresses idx_event_tags_event (added v0.7.3),
      // reproducing the plan this join got when no index covered
      // event_id: SQLite builds an automatic index over the whole table.
      const joinCost = rowsRead(
        sql,
        `SELECT COUNT(t.event_id) AS tag_count
           FROM events e
           LEFT JOIN event_tags t ON +t.event_id = e.id
          WHERE e.ingested_at > ?
          GROUP BY e.id`,
        since,
      );
      // `+ingested_at` suppresses idx_events_ingested the same way,
      // reproducing the unindexed scan this query paid between v0.7.2 and
      // v0.7.6.
      const scanCost = rowsRead(
        sql,
        `SELECT SUM(row_cost) AS total FROM events WHERE +ingested_at > ?`,
        since,
      );
      const indexedCost = rowsRead(
        sql,
        `SELECT SUM(row_cost) AS total FROM events WHERE ingested_at > ?`,
        since,
      );

      // Measured at E = 1,000, T = 5,000, window = 10:
      //   join (pre-v0.7.2)   51,000
      //   scan (v0.7.2)        1,000   exactly E
      //   indexed (v0.7.6)        10   exactly the window
      // The last of those is one row read per row in the window and no
      // table lookup behind any of them, which is the covering index
      // doing what it was added for.

      // E + T: the whole of both tables.
      expect(joinCost).toBeGreaterThanOrEqual(EVENTS + TAG_ROWS);
      // E: the whole of `events`, however few rows are in the window.
      expect(scanCost).toBeGreaterThanOrEqual(EVENTS);
      expect(scanCost).toBeLessThanOrEqual(EVENTS + 1);
      // The window. A handful of rows off the covering index, with no
      // table lookup behind them -- which is what makes this the size of
      // the day's ingest rather than the size of the history. The slack
      // is for SQLite's seek and terminating probe, not for a per-row
      // cost: what must not appear here is anything proportional to
      // EVENTS.
      console.log(`MEASURED join=${joinCost} scan=${scanCost} indexed=${indexedCost} E=${EVENTS} T=${TAG_ROWS} window=${RECENTLY_INGESTED}`);
      expect(indexedCost).toBeLessThanOrEqual(RECENTLY_INGESTED + 2);
      expect(indexedCost * 20).toBeLessThan(scanCost);
    });
  });

  it("costs countIngested24h the window too, off the same index", async () => {
    // The other query keyed on `ingested_at`, and it rides
    // idx_events_ingested for free -- worth an assertion because it is
    // the one that would silently keep scanning if the index were ever
    // narrowed to something `COUNT(*)` could not be answered from.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const since = Math.floor(Date.now() / 1000) - 86_400;
      const cost = rowsRead(sql, `SELECT COUNT(*) AS n FROM events WHERE ingested_at > ?`, since);
      expect(cost).toBeLessThanOrEqual(RECENTLY_INGESTED + 2);
    });
  });

  it("counts gift wraps through an index instead of scanning the table", async () => {
    // storage.ts giftWrapCount, run on every accepted gift wrap. It cost
    // E because `kind` led no index; idx_events_kind_created fixed it as
    // a side effect of fixing kinds-only REQ filters.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const cost = rowsRead(sql, `SELECT COUNT(*) AS n FROM events WHERE kind = ?`, 1059);
      const unindexed = rowsRead(sql, `SELECT COUNT(*) AS n FROM events WHERE +kind = ?`, 1059);
      expect(cost).toBeLessThan(10);
      expect(unindexed).toBeGreaterThanOrEqual(EVENTS);
    });
  });

  it("seeks an index to delete one event's tags, where it once scanned the table", async () => {
    // `DELETE FROM event_tags WHERE event_id = ?` (storage.ts
    // deleteEventRow), served by idx_event_tags_event since v0.7.3. Paid
    // on every replaceable/addressable replacement and on every
    // NIP-09/NIP-62 deletion and NIP-86 banevent.
    //
    // This one is not a budget regression test. NIP-62 forbids gating,
    // throttling or revoking the vanish path that reaches this DELETE, so
    // cost is the only control the relay has over it -- an unindexed
    // scan here is an unrefusable read amplifier, not a slow query. If
    // this assertion ever fails because the index went away, that is the
    // finding.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      // An id that matches nothing, so the seek is all cost and no work
      // and the seeded rows survive for the tests after this one.
      const seek = rowsRead(sql, `DELETE FROM event_tags WHERE event_id = ?`, "no-such-id");
      const scan = rowsRead(sql, `DELETE FROM event_tags WHERE +event_id = ?`, "no-such-id");
      expect(seek).toBeLessThan(10);
      expect(scan).toBe(TAG_ROWS);
    });
  });
});

describe("the read-cost guard", () => {
  // limits.ts boundFilter, asserted as a cost model rather than as a list
  // of accepted shapes -- the distinction the old isUnconstrainedFilter
  // got wrong.
  it("refuses a filter no index can serve", () => {
    const bound = boundFilter({ since: 0 });
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.reason.startsWith("invalid:")).toBe(true);
  });

  it("admits the shapes an index now covers, and says which index", () => {
    const cases: [Filter, string][] = [
      [{ kinds: [1], limit: 20 }, "idx_events_kind_created"],
      [{ authors: [OWNER_PUBKEY_HEX], limit: 20 }, "idx_events_pubkey_created"],
      [{ authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 }, "idx_events_pubkey_kind_created"],
      [{ ids: ["0".repeat(64)] }, "events primary key"],
    ];
    for (const [filter, via] of cases) {
      const bound = boundFilter(filter);
      expect(bound.ok).toBe(true);
      if (bound.ok) expect(bound.cost.via).toBe(via);
    }
  });

  it("prices a filter by combinations x limit, matching what expandFilter runs", () => {
    const bound = boundFilter({ authors: [OWNER_PUBKEY_HEX], kinds: [1, 7], limit: 20 });
    expect(bound.ok).toBe(true);
    // Two (author, kind) combinations at 2*20+1 each -- and the measured
    // split cost above was 82. The model is not decorative.
    if (bound.ok) expect(bound.cost.rowsRead).toBe(82);
  });

  it("counts combinations without materialising them, and gets the same answer", () => {
    // filterReadCost runs on every REQ filter before anything has decided
    // the filter is affordable, and `authors` is uncapped off the wire --
    // so it counts arithmetically rather than building the cross-product.
    // These two must not drift, since the cost model is only honest if
    // the count matches what expandFilter actually runs.
    const cases: Filter[] = [
      { kinds: [1], limit: 20 },
      { kinds: [1, 7, 0], limit: 20 },
      { authors: [OWNER_PUBKEY_HEX], limit: 20 },
      { authors: [OWNER_PUBKEY_HEX, "a".repeat(64)], kinds: [1, 7], limit: 20 },
      { ids: ["b".repeat(64)], limit: 20 },
      { "#e": ["c".repeat(64)], limit: 20 },
    ];
    for (const filter of cases) {
      expect(expandFilterCount(filter)).toBe(expandFilter(filter).length);
    }
  });

  it("clamps the limit rather than refusing a client with many follows", () => {
    const authors = Array.from({ length: 200 }, (_, i) => i.toString(16).padStart(64, "0"));
    const bound = boundFilter({ authors, kinds: [1], limit: 500 });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.filter.limit).toBeLessThan(500);
      expect(bound.cost.rowsRead).toBeLessThanOrEqual(MAX_FILTER_ROWS_READ);
    }
  });

  it("refuses when no limit is small enough to make the cost affordable", () => {
    // Two shapes reach this, and both are refused rather than clamped
    // because their cost does not fall with the limit.
    const authors = Array.from({ length: 5000 }, (_, i) => i.toString(16).padStart(64, "0"));
    expect(boundFilter({ authors, kinds: [1, 7], limit: 1 }).ok).toBe(false);

    // An `ids` seek costs one row per id however few the client wants
    // back, so halving the limit never helps. filters.ts parseFilter does
    // not cap the array, so this is reachable straight off the wire.
    const ids = Array.from({ length: 50_000 }, (_, i) => i.toString(16).padStart(64, "0"));
    const bound = boundFilter({ ids, limit: 1 });
    expect(bound.ok).toBe(false);
    // The message must not blame authors x kinds for an ids-only filter.
    if (!bound.ok) expect(bound.reason).toContain("fewer ids");
  });

  it("closes a REQ the guard refuses, with a NIP-01 machine-readable prefix", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "unbounded", { since: 0 }]);
    const frame = await conn.nextMessage();
    expect(frame[0]).toBe("CLOSED");
    expect((frame[2] as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });
});

describe("read attribution", () => {
  it("bills a REQ, the stats endpoint and the rows-written estimate to separate paths", async () => {
    await runInDurableObject(stub(), async () => resetReadMetrics());

    const conn = await connectRelay();
    conn.send(["REQ", "sub", { kinds: [1], limit: 20 }]);
    let frame = await conn.nextMessage();
    while (frame[0] !== "EOSE") frame = await conn.nextMessage();
    conn.close();

    await SELF.fetch("https://example.com/api/stats");

    const snapshot = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    const byPath = new Map(snapshot.paths.map((p) => [p.path, p]));

    // The same REQ that used to carry a table-sized cost. It is now
    // bounded by its limit, and the bucket still has to exist and be
    // billed separately -- a path that reports nothing is
    // indistinguishable from a path that was never instrumented.
    expect(byPath.get("req")?.calls).toBe(1);
    expect(byPath.get("req")?.rowsRead ?? 0).toBeGreaterThan(0);
    expect(byPath.get("req")?.rowsRead ?? 0).toBeLessThan(EVENTS);

    // estimateRowsWritten24h reports separately from the getStats call
    // that invoked it -- the whole reason it declares its own scope. It
    // no longer touches `event_tags` at all, so its bucket must now sit
    // at or below E rather than above E + T.
    expect(byPath.get("estimateRowsWritten24h")?.rowsRead ?? 0).toBeLessThanOrEqual(EVENTS + 1);
    expect(byPath.get("getStats")?.rowsRead ?? 0).toBeGreaterThan(0);

    expect(snapshot.totalRowsRead).toBeGreaterThan(0);
    // The gap detector. Anything reaching SQLite outside a withReadPath
    // scope lands in `unattributed`, and a non-empty bucket here means
    // the breakdown /api/stats reports cannot be reasoned from.
    expect(byPath.has("unattributed")).toBe(false);
  });

  it("surfaces the breakdown on /api/stats", async () => {
    const response = await SELF.fetch("https://example.com/api/stats");
    const stats = (await response.json()) as {
      reads: { totalRowsRead: number; sinceMs: number; paths: { path: string }[] };
    };
    expect(stats.reads.totalRowsRead).toBeGreaterThan(0);
    expect(stats.reads.sinceMs).toBeGreaterThanOrEqual(0);
    expect(stats.reads.paths.map((p) => p.path)).toContain("getStats");
  });

  it("serves a second /api/stats load without rescanning `events`", async () => {
    // The counts behind /api/stats were memoized in memory for 15
    // seconds (relay.ts statsCache), and measured on the live relay that
    // cache essentially never hit: the Durable Object hibernates between
    // admin page visits, in-memory state does not survive eviction, and
    // two page loads therefore paid two full scans apiece -- 17,601 rows
    // each at E = 4,232, with zero cache hits recorded. A cache whose
    // lifetime is shorter than the gap between the requests it exists to
    // serve is not a cache.
    //
    // It is now the `stats_snapshot` row (schema.ts), which is storage
    // and so outlives eviction by construction. This test can only
    // observe the in-process half of that, so it asserts the part it can
    // see -- the second load does not rescan -- and the assertion below
    // it covers the part that made the old arrangement fail.
    // Tests in this file share one Durable Object and earlier ones have
    // already loaded /api/stats, so the snapshot has to be cleared for
    // "first load" to mean anything. Dropped through storage rather than
    // through any relay API: nothing in production deletes this row, and
    // adding a method so a test could would be inventing a code path.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      state.storage.sql.exec(`DELETE FROM stats_snapshot`);
      resetReadMetrics();
    });

    await SELF.fetch("https://example.com/api/stats");
    const first = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    const firstCost = first.paths.find((p) => p.path === "getStats")?.rowsRead ?? 0;

    await SELF.fetch("https://example.com/api/stats");
    const second = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    const secondCost = (second.paths.find((p) => p.path === "getStats")?.rowsRead ?? 0) - firstCost;

    // Measured at E = 1,000: 3,019 to compute a snapshot, 17 to read one
    // back. The second figure is the one that matters, and what matters
    // about it is that it contains no term in E.

    // The first load has no snapshot to read and computes one: ~3E.
    expect(firstCost).toBeGreaterThan(EVENTS);
    // The second reads it back. What it still pays is the live half --
    // the snapshot row, the owner and settings rows, the backfill tables,
    // pendingVanishes, recordHost -- all of which are bounded by their
    // own table sizes and none of which is proportional to E. The whole
    // point is that this number does not grow with the relay.
    console.log(`MEASURED stats first=${firstCost} secondDelta=${secondCost}`);
    expect(secondCost).toBeLessThan(100);
  });

  it("keeps the stats snapshot in storage, where it survives eviction", async () => {
    // The property the in-memory cache could not have, stated directly
    // rather than inferred from a cost. A Durable Object that hibernates
    // loses every field on the instance and keeps every row in SQLite,
    // so "the cache is a row" IS the fix -- the read costs above are the
    // consequence, not the claim.
    await SELF.fetch("https://example.com/api/stats");
    const row = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readStatsSnapshot(state.storage.sql),
    );
    expect(row).not.toBeNull();
    expect(row?.totalEvents).toBe(EVENTS);
    // Recomputation is bounded by limits.ts STATS_SNAPSHOT_MAX_AGE_MS and
    // by nothing else -- in particular not by how often anyone loads the
    // page, which is exactly what set the rate before.
    expect(row?.computedAt).toBeGreaterThan(0);
  });

  it("counts replacements as R, and projects the table size at which that path alone hits the ceiling", async () => {
    // R is the number the event_tags-delete decision turns on (see the
    // comment on storage.ts deleteEventRow). The per-call cost is known
    // and measured; how OFTEN it is paid is not, and estimating it lands
    // on a range spanning the point where this path overtakes the cron
    // floor -- so it is counted rather than guessed.
    await runInDurableObject(stub(), async () => resetReadMetrics());
    const now = Math.floor(Date.now() / 1000);

    // kind 10003 (NIP-51 bookmarks): replaceable, special-cased nowhere in
    // relay.ts, and touched by no other test in this file -- which matters
    // because this file deliberately shares one Durable Object across its
    // tests, so two of them contending for the same replaceable address
    // would make whichever ran second depend on the first one's
    // timestamps.
    const conn = await connectRelay();
    conn.send(["EVENT", signEvent(OWNER_SECRET_KEY_HEX, { kind: 10003, content: "", created_at: now })]);
    await conn.nextMessage();
    // Only this second one supersedes an existing version, so only this
    // one is a replacement.
    conn.send([
      "EVENT",
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 10003, content: "again", created_at: now + 10 }),
    ]);
    await conn.nextMessage();
    conn.close();

    const snapshot = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    expect(snapshot.replacements.count).toBe(1);
    // Under MIN_SAMPLE_MS of uptime the rate is deliberately null rather
    // than one replacement multiplied by 1,440.
    if (snapshot.replacements.projected24h !== null) {
      expect(snapshot.replacements.ceilingAtEvents).not.toBeNull();
    }
  });

  it("does not count an operator deletion as R", async () => {
    // NIP-09/NIP-62/NIP-86 deletions reach the same unindexed DELETE and
    // pay the same per-call cost, but they happen at operator pace rather
    // than on the per-event drumbeat R measures. Folding them in would
    // inflate exactly the number the fix decision turns on.
    await runInDurableObject(stub(), async () => resetReadMetrics());
    const now = Math.floor(Date.now() / 1000);

    const conn = await connectRelay();
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "to delete", created_at: now });
    conn.send(["EVENT", note]);
    await conn.nextMessage();
    conn.send([
      "EVENT",
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 5, tags: [["e", note.id]], created_at: now + 1 }),
    ]);
    await conn.nextMessage();
    conn.close();

    const snapshot = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    expect(snapshot.replacements.count).toBe(0);
  });

  it("bills a replaceable replacement to the write path, now at index-seek cost", async () => {
    await runInDurableObject(stub(), async () => resetReadMetrics());
    const now = Math.floor(Date.now() / 1000);

    const conn = await connectRelay();
    conn.send(["EVENT", signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: "{}", created_at: now })]);
    await conn.nextMessage();
    // The second one replaces the first, which is what reaches
    // deleteEventRow's unindexed DELETE.
    conn.send([
      "EVENT",
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: `{"name":"a"}`, created_at: now + 10 }),
    ]);
    await conn.nextMessage();
    conn.close();

    const snapshot = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    const write = snapshot.paths.find((p) => p.path === "write");
    expect(write?.calls).toBe(2);
    // Was >= TAG_ROWS before idx_event_tags_event: replacing one kind-0
    // read every tag row in the table. Now it reads the handful the
    // replaced event actually carried.
    expect(write?.rowsRead ?? 0).toBeLessThan(TAG_ROWS / 10);
  });
});
