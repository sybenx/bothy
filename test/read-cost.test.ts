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
import { buildFilterQuery, expandFilter, expandFilterCount, tagScanLimit } from "../src/filters";
import {
  boundFilter,
  filterReadCost,
  MAX_FILTER_COMBINATIONS,
  MAX_FILTER_LIMIT,
  MAX_FILTER_ROWS_READ,
  maxGiftWraps,
  TAG_ROWS_READ_PER_MATCH,
} from "../src/limits";
import type { Filter } from "../src/nostr";
import { queryFilter, readMaintainedCounts } from "../src/storage";
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
// 24h window estimateRowsWrittenSince measures. Ten, not zero, and the
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
          // One of the five is the same value on every event: the owner's
          // own pubkey, p-tagged. That is not a contrived shape -- every
          // gift wrap this relay accepts must p-tag the owner
          // (relay.ts handleGiftWrap), so `#p:<owner>` is by construction
          // the highest-cardinality tag value in the table, and it is
          // exactly what a NIP-17 client asks for. The other four stay
          // unique, so both ends of the cardinality range are seeded.
          t === 1 ? OWNER_PUBKEY_HEX : `v${i}_${t}`,
          id,
          // The event's own created_at, as storage.ts insertEventRow
          // copies it -- the tag index's ordering column is only usable
          // as a bound on the outer query if the two agree.
          now - (EVENTS - i) * 60,
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

  it("bounds a high-cardinality tag filter by its limit, where it once read every matching row", async () => {
    // The shape that survived the first read-abuse guard untouched.
    // buildFilterQuery resolved a `#<letter>` condition as an unbounded
    // `id IN (SELECT event_id FROM event_tags WHERE ...)`, so the
    // subquery read every row carrying the named value whatever the
    // filter's `limit` -- and `#p:<owner>` names the one value every gift
    // wrap in the table carries. Flat in the limit meant limits.ts
    // boundFilter could neither clamp the filter nor refuse it: halving a
    // limit the cost does not depend on changes nothing.
    //
    // The "before" figure is measured live, against the same rows, by
    // stripping the ORDER BY/LIMIT back off the subquery.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);

      const small = buildFilterQuery({ "#p": [OWNER_PUBKEY_HEX], limit: 20 }, now);
      const tiny = buildFilterQuery({ "#p": [OWNER_PUBKEY_HEX], limit: 1 }, now);
      expect(small).not.toBeNull();
      expect(tiny).not.toBeNull();

      // 4 rows per tag row scanned -- the index entry and the
      // `event_tags` row it points at (idx_event_tags_lookup carries no
      // `event_id`), then the primary key entry and the `events` row.
      // This is the measurement limits.ts TAG_ROWS_READ_PER_MATCH is set
      // from, and TAG_SCAN_DEPTH x limit is how far the scan may go.
      expect(rowsRead(sql, small!.sql, ...small!.params)).toBe(
        TAG_ROWS_READ_PER_MATCH * tagScanLimit(20),
      );
      expect(rowsRead(sql, tiny!.sql, ...tiny!.params)).toBe(
        TAG_ROWS_READ_PER_MATCH * tagScanLimit(1),
      );

      // The property that was missing: asking for less costs less.
      const unbounded = small!.sql.replace(/ ORDER BY created_at DESC LIMIT \?\)/, ")");
      const unboundedParams = small!.params.filter((p) => p !== tagScanLimit(20));
      const before = rowsRead(sql, unbounded, ...unboundedParams);
      // Four per tag row in the table, plus the one row the outer scan
      // stops on: a function of E, with `limit` nowhere in it.
      expect(before).toBe(4 * EVENTS + 1);
      const beforeAtOne = rowsRead(
        sql,
        tiny!.sql.replace(/ ORDER BY created_at DESC LIMIT \?\)/, ")"),
        ...tiny!.params.filter((p) => p !== tagScanLimit(1)),
      );
      // Identical at limit 1 and limit 20: the old cost was a function of
      // the table, not of the request.
      expect(beforeAtOne).toBe(before);
    });
  });

  it("prices a tag condition as an addition to the driving path, not an alternative to it", async () => {
    // A `#<letter>` condition is a conjunct: its subquery runs whatever
    // else the filter names. filterReadCost used to offer it as one
    // candidate access path among several and take the cheapest, which
    // priced a query that pays for both as though it paid for one.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const filter = { "#p": [OWNER_PUBKEY_HEX], kinds: [7], limit: 20 };

      const query = buildFilterQuery(filter, now);
      expect(query).not.toBeNull();
      const measured = rowsRead(sql, query!.sql, ...query!.params);

      const cost = filterReadCost(filter);
      expect(cost).not.toBeNull();
      // Both terms, added -- and the estimate stays on the safe side of
      // what SQLite actually does.
      expect(cost!.rowsRead).toBe(
        2 * 20 + 1 + TAG_ROWS_READ_PER_MATCH * tagScanLimit(20),
      );
      expect(cost!.via).toContain("idx_event_tags_lookup");
      expect(measured).toBeLessThan(cost!.rowsRead);
      // The old model would have charged the `kinds` index alone.
      expect(measured).toBeGreaterThan(2 * 20 + 1);
    });
  });

  it("keeps the tag-scan depth derived from the ceiling it is meant to respect", () => {
    // filters.ts TAG_SCAN_DEPTH is not a tuning knob picked by hand: it
    // is the depth at which a single-value tag filter asking for
    // MAX_FILTER_LIMIT events costs exactly the per-filter ceiling. If
    // any of these three moves, the depth has to move with it, and this
    // is what says so.
    expect(TAG_ROWS_READ_PER_MATCH * tagScanLimit(MAX_FILTER_LIMIT)).toBe(MAX_FILTER_ROWS_READ);
  });

  it("clamps a tag filter's limit instead of admitting it at any cost", () => {
    // The whole point of bounding the subquery. Before it, this filter
    // was admitted at whatever limit it asked for, because the cost the
    // guard computed did not move when the limit did.
    const bound = boundFilter({ "#p": [OWNER_PUBKEY_HEX, "b".repeat(64), "c".repeat(64)], limit: 500 });
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(bound.filter.limit).toBeLessThan(500);
      expect(bound.cost.rowsRead).toBeLessThanOrEqual(MAX_FILTER_ROWS_READ);
    }
  });

  it("narrows a paginating tag filter to the window it asked for", async () => {
    // `since`/`until` are pushed into the tag subquery rather than
    // applied to its output. `event_tags.created_at` is the event's own,
    // so the bound is exact -- and without the pushdown a bounded
    // subquery would hand `until` the newest rows in the table and then
    // discard all of them, which is to say pagination would stop dead
    // after the first page.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const until = now - 500 * 60;
      const query = buildFilterQuery({ "#p": [OWNER_PUBKEY_HEX], until, limit: 20 }, now);
      expect(query).not.toBeNull();

      const cursor = sql.exec(query!.sql, ...query!.params);
      const rows = cursor.toArray() as { created_at: number }[];
      // A full page, from the right end of the table, at the same cost as
      // the first page.
      expect(rows).toHaveLength(20);
      expect(Math.max(...rows.map((r) => r.created_at))).toBeLessThanOrEqual(until);
      expect(cursor.rowsRead).toBe(TAG_ROWS_READ_PER_MATCH * tagScanLimit(20));
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

  it("costs estimateRowsWrittenSince the size of the 24h window, not the size of the table", async () => {
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
    // a side effect of fixing kinds-only REQ filters, and that index is
    // now the partial pair idx_events_kind_created_pub/_grp -- so the
    // query has to name a partition, and giftWrapCount runs once per
    // partition and sums.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const cost = rowsRead(sql, `SELECT COUNT(*) AS n FROM events WHERE kind = ? AND is_group = 0`, 1059);
      const unindexed = rowsRead(sql, `SELECT COUNT(*) AS n FROM events WHERE +kind = ? AND is_group = 0`, 1059);
      expect(cost).toBeLessThan(10);
      expect(unindexed).toBeGreaterThanOrEqual(EVENTS);
    });
  });

  it("scans the table for the same count with no partition named", async () => {
    // THE COST OF THE PARTIAL PAIRS, stated as a measurement rather than
    // left to be discovered. SQLite uses a partial index only for a query
    // whose WHERE clause implies the index's predicate, so a lookup that
    // names neither `is_group` value can use neither half and reads the
    // table -- which is why storage.ts runs every partition-agnostic
    // lookup once per partition (`acrossScopes`) rather than leaving the
    // pin off.
    //
    // This is the assertion that fails if somebody "simplifies" one of
    // those lookups by dropping the pin.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const pinned = rowsRead(sql, `SELECT COUNT(*) AS n FROM events WHERE kind = ? AND is_group = 0`, 1059);
      const unpinned = rowsRead(sql, `SELECT COUNT(*) AS n FROM events WHERE kind = ?`, 1059);
      expect(unpinned).toBeGreaterThanOrEqual(EVENTS);
      expect(pinned * 100).toBeLessThan(unpinned);
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
      // The public half of each partial pair: an unauthenticated read is
      // priced against the partition it is allowed to see.
      [{ kinds: [1], limit: 20 }, "idx_events_kind_created_pub"],
      [{ authors: [OWNER_PUBKEY_HEX], limit: 20 }, "idx_events_pubkey_created_pub"],
      [{ authors: [OWNER_PUBKEY_HEX], kinds: [1], limit: 20 }, "idx_events_pubkey_kind_created_pub"],
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

    // estimateRowsWrittenSince reports separately from the getStats call
    // that invoked it -- the whole reason it declares its own scope. It
    // no longer touches `event_tags` at all, so its bucket must now sit
    // at or below E rather than above E + T.
    expect(byPath.get("estimateRowsWrittenSince")?.rowsRead ?? 0).toBeLessThanOrEqual(EVENTS + 1);
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

  it("bounds the events24h window read at 26 rows however deep the history", async () => {
    // The claim the bucket table exists to make, and the one an absolute
    // "less than 36" bound elsewhere in this file cannot make on its own:
    // the cost of `events24h` is set by the WINDOW, not by how much
    // history the relay holds or how busy it has been.
    //
    // Seeded with a bucket per hour across five years -- 43,800 rows in
    // `event_hour_counts`, far more than any fixture here puts in
    // `events` -- so a read that scanned the table would be unmistakable.
    // Inserted straight into the counter table for the same reason the
    // rest of this file inserts straight into `events`: reaching this
    // shape through the protocol would take five years of signatures, and
    // nothing about the read cost depends on how the rows got there.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const nowSec = Math.floor(Date.now() / 1000);
      const nowBucket = Math.trunc(nowSec / 3600);
      const HOURS = 5 * 365 * 24;
      for (let i = 1; i <= HOURS; i++) {
        sql.exec(
          `INSERT INTO event_hour_counts (hour, n) VALUES (?, 1)
             ON CONFLICT(hour) DO UPDATE SET n = n + 1`,
          nowBucket - i,
        );
      }

      const cost = rowsRead(
        sql,
        `SELECT SUM(n) AS n FROM event_hour_counts WHERE hour >= ?`,
        Math.trunc((nowSec - 86400) / 3600),
      );
      const total = rowsRead(sql, `SELECT SUM(n) AS n FROM event_hour_counts`);

      console.log(`MEASURED events24h window=${cost} allBuckets=${total} buckets=${HOURS}`);
      // 26 keys at most: the bucket holding (now - 86400) up to the one
      // an hour ahead of now, which limits.ts MAX_CREATED_AT_FUTURE_SECONDS
      // makes the highest reachable. `hour INTEGER PRIMARY KEY` is a rowid
      // alias, so this is a range seek over consecutive integers.
      expect(cost).toBeLessThanOrEqual(26);
      // The same query without the range reads every bucket, which is
      // what "bounded by the window" is being asserted against.
      expect(total).toBeGreaterThanOrEqual(HOURS);

      // Left clean for whatever runs next -- this fixture's buckets would
      // otherwise show up in another test's counts.
      sql.exec(`DELETE FROM event_hour_counts WHERE hour < ?`, nowBucket);
    });
  });

  it("never scans `events` to serve /api/stats", async () => {
    // The counts behind /api/stats were memoized in memory for 15
    // seconds (relay.ts statsCache), and measured on the live relay that
    // cache essentially never hit: the Durable Object hibernates between
    // admin page visits, in-memory state does not survive eviction, and
    // two page loads therefore paid two full scans apiece -- 17,601 rows
    // each at E = 4,232, with zero cache hits recorded. A cache whose
    // lifetime is shorter than the gap between the requests it exists to
    // serve is not a cache.
    //
    // It became the `stats_snapshot` row, which outlives eviction and
    // bounded the scan to four times a day instead of once a load. This
    // test asserted that: a cold load cost ~3E, a warm one ~17.
    //
    // It does not assert it any more, because the scan is gone and so is
    // the cache. Every O(E) or O(F) field that row held is a maintained
    // counter now (`totalEvents`, `events24h`, `followCount`), answered
    // from one row (`followsListAt`), or deleted
    // (`largestNonOwnerAuthor`). There is no cold state left to
    // distinguish from a warm one: EVERY load costs what the warm one
    // used to, and the claim is therefore stronger than the one it
    // replaces and needs no cache to hold it up.
    await runInDurableObject(stub(), async () => {
      resetReadMetrics();
    });

    await SELF.fetch("https://example.com/api/stats");
    const first = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    const firstCost = first.paths.find((p) => p.path === "getStats")?.rowsRead ?? 0;

    await SELF.fetch("https://example.com/api/stats");
    const second = await runInDurableObject(stub(), async () => readMetricsSnapshot());
    const secondCost = (second.paths.find((p) => p.path === "getStats")?.rowsRead ?? 0) - firstCost;

    console.log(`MEASURED stats first=${firstCost} secondDelta=${secondCost} E=${EVENTS}`);

    // Both loads, and they should now be the same number: there is no
    // cache to warm. What each pays is the counter row, at most 26 bucket
    // rows, the follows row, the owner and settings rows, the backfill
    // tables, pendingVanishes and recordHost -- every one bounded by its
    // own table size and none of them proportional to E.
    expect(firstCost).toBeLessThan(100);
    expect(secondCost).toBeLessThan(100);
    // Stated against E as well, because a bound of 100 would pass on a
    // relay that happened to hold nothing. At E = 1,000 a cold load that
    // still scanned would be three orders of magnitude above this.
    expect(firstCost).toBeLessThan(EVENTS / 10);
  });

  it("does not bill the ingest window to every /api/stats request", async () => {
    // The other half of the same endpoint, and the last one that was
    // still billed per request. `ingested24h` and `rowsWrittenToday` both
    // seeked idx_events_ingested, so neither scaled with E -- but both
    // scaled with the WINDOW, and that is not small on a relay that is
    // actually doing anything: measured live at 853 + 344 rows, ~1,200
    // per request with the lookups beside them. GET /api/stats is
    // unauthenticated and nothing rate-limits it below the HTTP layer, so
    // ~4,100 requests from anywhere took the 5,000,000 rows-read/day
    // allowance for the rest of the UTC day, at no cost to the caller.
    //
    // A five-minute cache row bounded the RATE at which that was paid.
    // Bucketing by ingest hour removed the cost instead: at most 25 rows
    // in one statement, every request, with no cache to warm and no
    // clock to outrun. So this test no longer measures a first load
    // against the ones after it -- there is no difference to measure --
    // it measures every load against the window.
    //
    // The seeded window is deliberately widened to every row here. The
    // rest of this file keeps it at RECENTLY_INGESTED = 10, which is
    // enough to prove the index engages and far too small to show what
    // the window would cost if anything still read it -- the distinction
    // this test exists for.
    const recentIds = Array.from({ length: RECENTLY_INGESTED }, (_, k) =>
      (EVENTS - RECENTLY_INGESTED + k).toString(16).padStart(64, "0"),
    );
    const widen = async (ingestedAt: number | null) =>
      runInDurableObject(stub(), async (_instance: Relay, state) => {
        const sql = state.storage.sql;
        const now = Math.floor(Date.now() / 1000);
        if (ingestedAt !== null) {
          sql.exec(`UPDATE events SET ingested_at = ?`, ingestedAt);
        } else {
          // Restore the file's seeded shape by the rule beforeAll used,
          // so whatever runs next sees the window it was written
          // against.
          sql.exec(`UPDATE events SET ingested_at = ?`, now - 200_000);
          for (const id of recentIds) {
            sql.exec(`UPDATE events SET ingested_at = ? WHERE id = ?`, now - 100, id);
          }
        }
        resetReadMetrics();
      });

    try {
      await widen(Math.floor(Date.now() / 1000) - 100);

      // Both buckets, summed: estimateRowsWrittenSince keeps its own
      // read-metrics scope (storage.ts), so a request that still reached
      // it would be invisible in the getStats bucket alone. It should
      // stay at zero here -- backfill is its only caller now, and a stats
      // request is not one.
      const cost = async () => {
        const snapshot = await runInDurableObject(stub(), async () => readMetricsSnapshot());
        const of = (path: string) => snapshot.paths.find((p) => p.path === path)?.rowsRead ?? 0;
        return of("getStats") + of("estimateRowsWrittenSince");
      };

      await SELF.fetch("https://example.com/api/stats");
      const first = await cost();

      await SELF.fetch("https://example.com/api/stats");
      const second = (await cost()) - first;

      await SELF.fetch("https://example.com/api/stats");
      const third = (await cost()) - first - second;

      console.log(`MEASURED live-half first=${first} secondDelta=${second} thirdDelta=${third} window=${EVENTS}`);

      // Every load, including the first, and no term in the window at
      // all. This is the property the cache used to buy at the price of
      // staleness: a page load costs a bounded small number of rows no
      // matter how many arrive, and now it does so on the first one too.
      //
      // The bound is what it was for the warm case before, plus the
      // ingest buckets: `maintained_counts`, at most 26 `event_hour_counts`
      // rows, at most 25 `ingest_hour_counts` rows, the follows row, owner
      // and settings, the backfill tables, pendingVanishes and recordHost.
      // None of them proportional to E.
      for (const measured of [first, second, third]) {
        expect(measured).toBeLessThanOrEqual(61);
      }
      // Stated against the window as well, because the absolute bound
      // above would still pass on a relay whose window happened to be
      // tiny. Every one of the fixture's E events is inside the ingest
      // window here, and a load reads a bounded handful.
      expect(first * 10).toBeLessThan(EVENTS);
    } finally {
      await widen(null);
    }
  });

  it("keeps the ingest buckets in storage, where they survive eviction", async () => {
    // Row and not memory, and this is the assertion that decides it. The
    // cache these replaced faced the same question and answered it the
    // same way: a flood keeps the Durable Object awake, so an in-memory
    // figure would hit right through one -- but a flood is not the
    // cheapest way to spend this budget, and one request every ten
    // seconds misses in-memory state every single time because the object
    // is evicted between them.
    //
    // It binds harder for the write meter than it did for the cache. The
    // meter accumulates in instance memory between landings
    // (read-metrics.ts), so a landing that did not reach storage would
    // lose the count outright rather than merely recompute it.
    //
    // Published over the wire rather than seeded, because this file's
    // fixture inserts into `events` directly and so never passes through
    // insertEventRow -- the documented exception in docs/test-notes.md,
    // and the one thing that would leave these buckets empty.
    const conn = await connectRelay();
    conn.send(["EVENT", signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "bucketed" })]);
    await conn.nextMessage();
    conn.close();

    const rows = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ingest_hour_counts`)
        .toArray(),
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("keeps the maintained counts in storage, where they survive eviction", async () => {
    // The property the in-memory cache could not have, stated directly
    // rather than inferred from a cost. A Durable Object that hibernates
    // loses every field on the instance and keeps every row in SQLite.
    //
    // That reasoning produced the `stats_snapshot` cache, and this test
    // used to assert its row existed. It asserts the counters instead:
    // they answer the same question the cache did, out of storage for the
    // same reason, and they answer it exactly rather than within six
    // hours. The recomputation rate that constant used to bound is not a
    // quantity any more -- there is no recomputation.
    //
    // The absolute value is not asserted, and the reason is this file's
    // own fixture: it seeds `events` with direct INSERTs rather than
    // publishing over the wire (see the header), so those rows never pass
    // through insertEventRow and the counter does not see them. That is
    // the documented exception working as documented -- and it is exactly
    // the disagreement storage.ts auditMaintainedCounts exists to log. So
    // what is asserted is that the counter is storage-backed and moves
    // with a real write.
    await SELF.fetch("https://example.com/api/stats");
    const before = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readMaintainedCounts(state.storage.sql),
    );

    const conn = await connectRelay();
    conn.send(["EVENT", signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "counted" })]);
    await conn.nextMessage();
    conn.close();

    const after = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readMaintainedCounts(state.storage.sql),
    );
    expect(after.events).toBe(before.events + 1);
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

// The `ids` access path was priced as though the filter ran once. It runs
// filters.ts expandFilterCount times, and every one of those queries
// carries the same `id IN (...)` list.
describe("ids access path pricing", () => {
  it("prices an ids filter at what the expanded queries actually read", async () => {
    const AUTHORS = 50;
    const authors = Array.from({ length: AUTHORS }, (_, i) => i.toString(16).padStart(64, "9"));
    const filter: Filter = { ids: ["0".repeat(64)], authors, limit: 500 };

    // The mispricing: one row, whatever the author count.
    expect(filter.ids?.length).toBe(1);
    const cost = filterReadCost(filter);
    expect(cost?.via).toBe("events primary key");
    expect(cost?.rowsRead).toBe(AUTHORS);

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      let measured = 0;
      const cursors: { rowsRead: number }[] = [];
      for (const part of expandFilter(filter)) {
        const query = buildFilterQuery(part, now);
        const cursor = sql.exec(query!.sql, ...query!.params);
        cursor.toArray();
        cursors.push(cursor);
      }
      measured = cursors.reduce((n, c) => n + c.rowsRead, 0);
      // What the price now says, and what it used to say (1).
      expect(measured).toBe(AUTHORS);
    });
  });

  it("refuses a filter whose query count exceeds the cap, with or without an id to hide behind", async () => {
    // The whole attack in two lines: the same filter, priced 5,005,000
    // and refused without the id, priced 1 and admitted with it.
    const authors = Array.from({ length: MAX_FILTER_COMBINATIONS + 1 }, (_, i) =>
      i.toString(16).padStart(64, "8"),
    );
    expect(boundFilter({ authors, limit: 500 }).ok).toBe(false);
    expect(boundFilter({ ids: ["0".repeat(64)], authors, limit: 500 }).ok).toBe(false);
    // And the shape below the cap is still admitted, at a price that is
    // now the truth rather than a hundredth of it.
    const under = boundFilter({ ids: ["0".repeat(64)], authors: authors.slice(0, 100), limit: 500 });
    expect(under.ok).toBe(true);
    if (under.ok) expect(under.cost.rowsRead).toBe(100);
  });
});

// The NIP-42 gift wrap gate omits kind-1059 rows from an unauthenticated
// read instead of refusing it, which removed a storage probe from every
// kinds-less REQ and replaced it with a condition on the query that was
// already running. A skipped row is still a read row, so what the
// exclusion costs is measured here rather than assumed.
describe("gift wrap exclusion cost", () => {
  it("adds nothing to a tag-driven filter, whose candidate set is already bounded", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const filter: Filter = { "#p": [OWNER_PUBKEY_HEX], limit: 20 };
      const priced = filterReadCost(filter)!.rowsRead;

      const plain = buildFilterQuery(filter, now)!;
      const excluded = buildFilterQuery(filter, now, { excludeGiftWraps: true })!;

      // The tag subquery carries its own LIMIT (filters.ts tagScanLimit),
      // so the exclusion narrows what survives rather than widening what
      // is scanned.
      expect(rowsRead(sql, excluded.sql, ...excluded.params)).toBeLessThanOrEqual(
        rowsRead(sql, plain.sql, ...plain.params),
      );
      expect(rowsRead(sql, excluded.sql, ...excluded.params)).toBeLessThanOrEqual(priced);
    });
  });

  it("reads past the skipped wraps on an authors-pinned filter, bounded by the inbox", async () => {
    // The one shape that CAN read past its price: `authors` pinned with
    // no `kinds`, against a pubkey whose stored events are all gift
    // wraps. The scan reads every one of them to reach the first event it
    // may return.
    //
    // Seeded and removed inside this test rather than in the shared
    // fixture: several assertions in this file are written against the
    // exact size of that fixture.
    const WRAPS = 500;
    const AUTHOR = "c".repeat(64);
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < WRAPS; i++) {
        sql.exec(
          `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ("d" + i.toString(16)).padStart(64, "e"),
          AUTHOR,
          now - i,
          1059,
          "[]",
          "x",
          "sig",
          null,
          now - 200_000,
        );
      }

      const filter: Filter = { authors: [AUTHOR], limit: 20 };
      const priced = filterReadCost(filter)!.rowsRead;
      const plain = buildFilterQuery(filter, now)!;
      const excluded = buildFilterQuery(filter, now, { excludeGiftWraps: true })!;

      expect(rowsRead(sql, plain.sql, ...plain.params)).toBe(priced);
      // Every wrap is read and discarded, so this scales with the inbox
      // and not with the limit -- the price is a floor for this one shape.
      const overshoot = rowsRead(sql, excluded.sql, ...excluded.params);
      expect(overshoot).toBeGreaterThan(WRAPS);
      // And it is inside the per-filter cap, which is the property that
      // has to hold: the inbox count is the ceiling on the overshoot, so
      // the inbox cap is what bounds it.
      expect(overshoot).toBeLessThanOrEqual(MAX_FILTER_ROWS_READ);

      sql.exec(`DELETE FROM events WHERE pubkey = ?`, AUTHOR);
    });
  });

  it("bounds the gift wrap inbox so that overshoot cannot exceed the per-filter cap", async () => {
    // Two rows per skipped wrap: the index entry and the table row behind
    // it. limits.ts maxGiftWraps is bounded by MAX_FILTER_ROWS_READ for
    // this reason and not by the storage share alone -- the share is a
    // write-path cap, and this is the read cost it turned out to carry.
    expect(maxGiftWraps({} as Env) * 2).toBeLessThanOrEqual(MAX_FILTER_ROWS_READ);
    // The bound binds only under a configuration that would otherwise
    // lift the inbox far past it: a 1KB event cap prices ~131,000 wraps
    // into the same storage share.
    expect(maxGiftWraps({ MAX_EVENT_BYTES: "1024" } as unknown as Env) * 2).toBeLessThanOrEqual(
      MAX_FILTER_ROWS_READ,
    );
  });
});

// The group partition (src/groups.ts, schema.ts's partial index pairs),
// priced. The design claim is a pair of numbers: an unauthenticated read
// costs what it always cost, and an authorised one costs twice that
// because it runs once per partition. Both are asserted here rather than
// argued, since the whole reason for choosing partial pairs over a widened
// index was that a widened index moved a shape nobody had measured (an
// authenticated `#p` read went 601 -> 204,701; see src/groups.ts).
describe("rows read by partition", () => {
  it("costs an unauthenticated read exactly what the same filter cost before the partition existed", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const pub = buildFilterQuery({ kinds: [1], limit: 20 }, now)!;
      // 2 rows per returned event + 1, the same figure this file's first
      // assertion pins for the pre-partition index.
      expect(rowsRead(sql, pub.sql, ...pub.params)).toBe(41);
    });
  });

  it("costs an authorised read one query per partition, and prices it that way", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const filter: Filter = { kinds: [1], limit: 20 };
      const publicHalf = buildFilterQuery(filter, now, { scope: 0 })!;
      const groupHalf = buildFilterQuery(filter, now, { scope: 1 })!;
      const measured =
        rowsRead(sql, publicHalf.sql, ...publicHalf.params) +
        rowsRead(sql, groupHalf.sql, ...groupHalf.params);

      // The seeded fixture holds no group events, so the group half is a
      // seek that finds nothing -- the floor of the two-partition cost
      // rather than its ceiling.
      expect(measured).toBeGreaterThan(rowsRead(sql, publicHalf.sql, ...publicHalf.params));

      // And limits.ts knows: `scopes` multiplies the query count, so an
      // authorised reader is admitted at a limit it can actually afford
      // rather than at twice one.
      expect(filterReadCost(filter, 2)!.rowsRead).toBe(filterReadCost(filter, 1)!.rowsRead * 2);
    });
  });

  it("shares the tag scan budget between partitions instead of paying it twice", async () => {
    // Without the divisor a two-partition read would look at
    // tagScanLimit(limit) tag rows in EACH half and cost twice what
    // limits.ts prices a tag filter at. The divisor is also what stops one
    // busy partition starving the other: measured at 50,000 group events,
    // the owner's own `{"#p":[owner],"kinds":[1059]}` returned zero gift
    // wraps undivided (group tag rows filled the whole depth) and 16 with
    // the budget split.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const filter: Filter = { "#p": [OWNER_PUBKEY_HEX], limit: 20 };
      const whole = buildFilterQuery(filter, now, { scope: 0 })!;
      const half = buildFilterQuery(filter, now, { scope: 0, tagScanDivisor: 2 })!;
      const wholeCost = rowsRead(sql, whole.sql, ...whole.params);
      const halfCost = rowsRead(sql, half.sql, ...half.params);
      expect(halfCost).toBeLessThan(wholeCost);
      // Two halves add up to no more than one whole, which is the
      // property that keeps filterReadCost's tag term true for an
      // authorised reader without multiplying it.
      expect(halfCost * 2).toBeLessThanOrEqual(wholeCost + 2);
    });
  });

  // What widening the read gate to members added to the REQ path, priced.
  //
  // The gate resolves three permissions now (relay.ts handleReqInner) and
  // one of them is a storage read: `group_members` keyed by the
  // authenticated pubkey. It is a primary-key seek, so it is 1 row, and
  // it is paid only by a client that has completed AUTH and is not the
  // owner -- the owner short-circuits on the `||`, and an unauthenticated
  // REQ never reaches it. That last part is the property the gift wrap
  // gate was rewritten to have, and it is why this is asserted rather
  // than assumed: a lookup that crept onto the unauthenticated path would
  // be an unmetered read behind no gate at all, which is the shape this
  // whole file exists to catch.
  it("prices the member lookup the group read gate now runs at one indexed row", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const member = "b".repeat(64);
      sql.exec(`INSERT INTO group_members (pubkey, added_at) VALUES (?, ?)`, member, 0);
      expect(rowsRead(sql, `SELECT 1 FROM group_members WHERE pubkey = ?`, member)).toBe(1);
      // A pubkey that is not a member costs LESS than one that is -- the
      // seek lands between index entries and reads nothing. So the gate
      // is cheapest for exactly the callers there are most of, and a
      // stranger cannot make it expensive by failing it.
      expect(rowsRead(sql, `SELECT 1 FROM group_members WHERE pubkey = ?`, "c".repeat(64))).toBe(0);
      sql.exec(`DELETE FROM group_members WHERE pubkey = ?`, member);
    });
  });

  it("does not run it at all for an unauthenticated REQ", async () => {
    resetReadMetrics();
    const conn = await connectRelay("10.0.0.61");
    conn.send(["REQ", "anon", { kinds: [1], limit: 5 }]);
    for (;;) if ((await conn.nextMessage())[0] === "EOSE") break;
    conn.close();

    // The QUERY and nothing else -- 2 rows per returned event plus 1, the
    // same figure this file's first assertion pins for the same shape run
    // straight against storage. Both lookups the read gate can make sit
    // behind `authedPubkey !== undefined`, so an unauthenticated REQ
    // reaches neither: not the membership lookup this widening added, and
    // not the owner lookup that was already there.
    //
    // Pinned exactly rather than bounded, because this is the path with no
    // gate in front of it and the failure worth catching is a storage read
    // creeping onto it -- which a `toBeLessThan` would let through until
    // it got large.
    const req = readMetricsSnapshot().paths.find((p) => p.path === "req");
    expect(req?.rowsRead).toBe(2 * 5 + 1);
  });
});
