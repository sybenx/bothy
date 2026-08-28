// /api/stats and the static admin page (CLAUDE.md "What it is").
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { refreshFollows } from "../src/ownership";
import { profileCacheSize, resetProfileCache } from "../src/profile-lookup";
import type { Relay } from "../src/relay";
import {
  auditMaintainedCounts,
  countEvents24h,
  readLiveStats,
  readMaintainedCounts,
} from "../src/storage";
import { forgetSchemaHash, initSchema } from "../src/schema";
import { connectRelay, publish } from "./helpers/socket";
import { version } from "../package.json";
import {
  DAILY_ROWS_READ_LIMIT,
  DAILY_ROWS_WRITTEN_LIMIT,
  STORAGE_BYTES_LIMIT,
  utcDayStartSeconds,
} from "../src/limits";

isolateStorage();

describe("GET /api/stats", () => {
  it("reports claimed status and event counts", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "counted" });
    await publish(conn, event);
    conn.close();

    const response = await exports.default.fetch("https://example.com/api/stats");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      claimed: boolean;
      totalEvents: number;
      events24h: number;
    };

    expect(body).toMatchObject({
      version,
      claimed: true,
      totalEvents: expect.any(Number),
      events24h: expect.any(Number),
      storageBytes: expect.any(Number),
      rowsWrittenToday: expect.any(Number),
      ingested24h: expect.any(Number),
      // The three ceilings public/index.html used to hardcode a second
      // copy of -- transported so the admin page's progress bars can
      // never drift from what limits.ts actually declares.
      storageBytesLimit: STORAGE_BYTES_LIMIT,
      dailyRowsWrittenLimit: DAILY_ROWS_WRITTEN_LIMIT,
      dailyRowsReadLimit: DAILY_ROWS_READ_LIMIT,
      backfill: { status: "pending", totalStored: 0, relayCount: 0, exhaustedCount: 0 },
    });
    expect(body.totalEvents).toBeGreaterThanOrEqual(1);
    expect(body.events24h).toBeGreaterThanOrEqual(1);
  });

  it("reports follows write policy and a zeroed follow count before any list is stored", async () => {
    const response = await exports.default.fetch("https://example.com/api/stats");
    const body = (await response.json()) as {
      writePolicy: string;
      followCount: number;
      followsListAt: number | null;
    };

    // The global test env leaves ALLOW_FOLLOWS unset (vitest.config.ts),
    // and it's an opt-out (ownership.ts allowFollowsEnabled), so this is
    // "follows" here even with an empty follow list -- see
    // follows.test.ts for the ALLOW_FOLLOWS=false owner-only case.
    expect(body.writePolicy).toBe("follows");
    expect(body.followCount).toBe(0);
    expect(body.followsListAt).toBeNull();
  });

  it("reflects real follow table contents once the owner publishes kind-3", async () => {
    const friendA = randomKeypair();
    const friendB = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: [
        ["p", friendA.pubkeyHex],
        ["p", friendB.pubkeyHex],
      ],
    });

    const conn = await connectRelay();
    // ALLOW_FOLLOWS is an opt-out (ownership.ts allowFollowsEnabled) and
    // the global test env leaves it unset, so relay.ts's immediate
    // refresh on this owner kind-3 already populates `follows` for real.
    await publish(conn, contacts);
    conn.close();

    // Driven again directly with an explicit follows-enabled env (the
    // same technique test/follows.test.ts uses for the write-gate itself)
    // so this test doesn't depend on ALLOW_FOLLOWS's default staying what
    // it is today -- what's under test here is that getStats'
    // followCount/followsListAt reflect whatever is actually in the
    // table, not relay.ts's refresh trigger (covered by
    // test/write-gate-refresh.test.ts instead).
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      refreshFollows(state.storage.sql, { ...env, ALLOW_FOLLOWS: "true" } as unknown as Env);
    });

    const response = await exports.default.fetch("https://example.com/api/stats");
    const body = (await response.json()) as {
      followCount: number;
      followsListAt: number | null;
    };

    expect(body.followCount).toBe(2);
    expect(body.followsListAt).toEqual(expect.any(Number));
  });
});

// The claim form's courtesy profile preview (src/index.ts handleProfile),
// which is a setup endpoint and is now scoped to setup.
//
// The whole suite runs with OWNER_PUBKEY bound (see vitest.config.ts), so
// every relay these tests see is claimed -- which is exactly the state
// this endpoint must refuse in, and the one a real deployment spends all
// but the first few minutes of its life in. The unclaimed half is
// unreachable over HTTP under this config for the reason
// test/claim.test.ts documents at length.
describe("GET /api/profile", () => {
  it("rejects a request with no pubkey", async () => {
    const response = await exports.default.fetch("https://example.com/api/profile");
    expect(response.status).toBe(400);
  });

  it("rejects a pubkey that is not 64 hex characters", async () => {
    const response = await exports.default.fetch("https://example.com/api/profile?pubkey=npub1nope");
    expect(response.status).toBe(400);
  });

  it("is gone once the relay is claimed", async () => {
    // 404, matching /api/claim's disabled branch rather than inventing a
    // second vocabulary for an endpoint that is no longer part of this
    // relay.
    const response = await exports.default.fetch(
      "https://example.com/api/profile?pubkey=" + OWNER_PUBKEY_HEX,
    );
    expect(response.status).toBe(404);
  });

  it("refuses a claimed relay's request without reaching the network", async () => {
    // The status code alone would not prove this: a 404 returned after
    // opening two outbound WebSockets to relay.damus.io and nos.lol would
    // look identical from the outside, and the outbound connection is the
    // entire cost being removed. A lookup leaves exactly one visible
    // trace -- a cache entry (src/profile-lookup.ts) -- so an untouched
    // cache is the proof that the ownership check ran first.
    resetProfileCache();
    const response = await exports.default.fetch(
      "https://example.com/api/profile?pubkey=" + "b".repeat(64),
    );
    expect(response.status).toBe(404);
    expect(profileCacheSize()).toBe(0);
  });
});

describe("admin page fallback", () => {
  it("serves something other than the old placeholder for an unmatched path", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("bothy");
  });
});

// The maintained event counters (schema.ts `event_counts` and
// `event_hour_counts`). `totalEvents` and `events24h` are no longer counted
// per request; they are moved by storage.ts insertEventRow and
// deleteEventRow, the only two functions in the codebase that write to
// `events`.
//
// That single-choke-point property is the entire safety argument for a
// maintained count, so it is asserted here rather than described: every
// removal path in the relay -- replaceable replacement, NIP-09, NIP-62
// vanish, NIP-86 banevent -- has to bring the counters back down, and a
// path that grew its own DELETE would fail these.
describe("maintained event counters", () => {
  const fetchCounts = async () =>
    (await (await exports.default.fetch("https://example.com/api/stats")).json()) as {
      totalEvents: number;
      events24h: number;
    };

  it("counts a stored event, and counts it in the 24h window by created_at", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "one" }));
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "two" }));
    conn.close();

    const body = await fetchCounts();
    expect(body.totalEvents).toBe(2);
    expect(body.events24h).toBe(2);
  });

  it("keeps a backfill-aged event out of the 24h window while still counting it", async () => {
    // The wrinkle the bucket table exists for. `events24h` counts by
    // `created_at`, so an event signed years ago and stored this morning
    // belongs to a years-old bucket -- incrementing "the current hour" on
    // arrival would have made a backfill look like a posting spree. This
    // is the mirror image of the bug `ingested_at` exists to fix, and the
    // reason the two windows need two different mechanisms.
    const conn = await connectRelay();
    const old = Math.floor(Date.now() / 1000) - 400 * 86400;
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "old", created_at: old }));
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "new" }));
    conn.close();

    const body = await fetchCounts();
    expect(body.totalEvents).toBe(2);
    expect(body.events24h).toBe(1);
  });

  it("decrements when a replaceable event is replaced", async () => {
    const now = Math.floor(Date.now() / 1000);
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: "{}", created_at: now }));
    await publish(
      conn,
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: '{"name":"a"}', created_at: now + 10 }),
    );
    conn.close();

    // Two events published, one row standing: the replacement removed the
    // first through deleteEventRow, so both counters must show one.
    const body = await fetchCounts();
    expect(body.totalEvents).toBe(1);
    expect(body.events24h).toBe(1);
  });

  it("decrements on a NIP-09 deletion", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 5, tags: [["e", target.id]] }));
    conn.close();

    // The kind-5 deletion request is itself stored, so one row goes and
    // one arrives: the total stays at 1 rather than dropping to 0, and
    // that is the correct answer rather than a wash that hides a bug --
    // the next test removes the deletion request too.
    const body = await fetchCounts();
    expect(body.totalEvents).toBe(1);
  });

  it("decrements on a NIP-86 banevent, and not for an id that was never stored", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "ban me" });
    await publish(conn, target);
    conn.close();

    expect((await fetchCounts()).totalEvents).toBe(1);

    await runInDurableObject(stub, (instance: Relay) =>
      instance.manage("banevent", [target.id, "spam"], "1.2.3.4"),
    );
    expect((await fetchCounts()).totalEvents).toBe(0);

    // banevent tombstones an id whether or not it is stored, which is the
    // one caller of deleteEventRow that can be handed an id with no row
    // behind it. It must not decrement for one -- which is why the
    // created_at lookup lives inside deleteEventRow rather than being
    // passed in by callers that happen to know it.
    await runInDurableObject(stub, (instance: Relay) =>
      instance.manage("banevent", ["a".repeat(64), "never stored"], "1.2.3.4"),
    );
    expect((await fetchCounts()).totalEvents).toBe(0);
  });

  it("seeds once from a real count, and never recounts after that", async () => {
    // The migration in schema.ts seedMaintainedCounts. A relay that has been
    // running for months must not start from zero -- and, just as
    // importantly, must not re-seed on the next schema change, because a
    // recount would silently repair drift that auditEventCounters is
    // supposed to report.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const now = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Pre-counter rows, inserted the way an older deployment left them.
      sql.exec(`DELETE FROM maintained_counts`);
      sql.exec(`DELETE FROM event_hour_counts`);
      for (let i = 0; i < 4; i++) {
        sql.exec(
          `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost)
           VALUES (?, 'p', ?, 1, '[]', 'x', 's', NULL, ?, 6)`,
          `s${i}`.padStart(64, "0"),
          now,
          now,
        );
      }
      forgetSchemaHash(sql);
      initSchema(sql);
      expect(readMaintainedCounts(sql).events).toBe(4);
      expect(countEvents24h(sql, now)).toBe(4);

      // A second reconcile pass -- what a later schema change causes --
      // must leave the counters exactly where they are, even after they
      // have been made wrong on purpose.
      sql.exec(`UPDATE maintained_counts SET events = 99`);
      forgetSchemaHash(sql);
      initSchema(sql);
      expect(readMaintainedCounts(sql).events).toBe(99);
    });
  });

  it("logs a drift it cannot have caused, and does not repair it", async () => {
    // Detect only. A counter that repairs itself erases the evidence of
    // whatever broke it: the drift returns on the next occurrence of the
    // same bug and is swallowed again, and the only symptom is a number
    // that is quietly wrong between repairs.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "drift" }));
    conn.close();

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await runInDurableObject(stub, async (_instance, state) => {
        const sql = state.storage.sql;
        sql.exec(`UPDATE maintained_counts SET events = 41, audited_at = NULL`);
        auditMaintainedCounts(sql, Math.floor(Date.now() / 1000));
        // Logged, and left wrong.
        expect(readMaintainedCounts(sql).events).toBe(41);
      });
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).toContain("MAINTAINED COUNT DRIFT");
  });

  it("audits at most once a day", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const now = Math.floor(Date.now() / 1000);
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "paced" }));
    conn.close();

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      auditMaintainedCounts(sql, now);
      const first = sql
        .exec<{ audited_at: number | null }>(`SELECT audited_at FROM maintained_counts`)
        .toArray()[0]?.audited_at;
      expect(first).toBe(now);

      // An hour later is not a day later: the recount is an E-row scan and
      // the cron fires hourly, so pacing it by the data rather than by the
      // tick is what keeps it at E/day instead of 24E/day.
      auditMaintainedCounts(sql, now + 3600);
      expect(
        sql.exec<{ audited_at: number | null }>(`SELECT audited_at FROM maintained_counts`).toArray()[0]
          ?.audited_at,
      ).toBe(now);

      auditMaintainedCounts(sql, now + 86400);
      expect(
        sql.exec<{ audited_at: number | null }>(`SELECT audited_at FROM maintained_counts`).toArray()[0]
          ?.audited_at,
      ).toBe(now + 86400);
    });
  });
});

// The one cache left on /api/stats (schema.ts `live_stats`), and the tests
// in this block are about that arrangement rather than about any
// individual number.
//
// It had a companion, `stats_snapshot`, on a six-hour clock over the
// counts that walked a table -- itself a replacement for a 15-second
// in-memory cache that measurement showed essentially never hit, since
// the Durable Object hibernates between admin page visits. Both are gone:
// every field that cache held is a maintained counter now or deleted, so
// there was a TTL, a table, a refresh function and a cron call rationing
// a cost that no longer existed. What is asserted below is that the
// SURVIVING cache still behaves, and that nothing else on the document
// answers to a clock any more.
describe("/api/stats live cache", () => {
  const stub = () => env.RELAY.get(env.RELAY.idFromName("relay"));

  const fetchStats = async () =>
    (await (await exports.default.fetch("https://example.com/api/stats")).json()) as {
      liveAt: number;
      totalEvents: number;
      followCount: number;
      ingested24h: number;
      rowsWrittenToday: number;
    };

  // Nothing in production clears this row -- it expires on its own after
  // limits.ts LIVE_STATS_MAX_AGE_MS, and adding a method so a test could
  // clear it would be inventing a code path. Dropped through storage
  // directly instead, the same exception test/read-cost.test.ts documents
  // for its own fixtures.
  const expireLiveStats = async () =>
    runInDurableObject(stub(), async (_instance: Relay, state) => {
      state.storage.sql.exec(`DELETE FROM live_stats`);
    });

  it("dates the cached figures so their age is stated, not assumed", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "dated" }));
    conn.close();

    const body = await fetchStats();
    // Two fields on this document are up to LIVE_STATS_MAX_AGE_MS old and
    // every other one is current. A consumer that cannot tell which is
    // which has to assume the whole document describes one instant, and
    // it does not. There used to be a second age here, `snapshotAt`;
    // it went with the cache it dated.
    expect(body.liveAt).toBeGreaterThan(0);
    expect(body.liveAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it("holds the cached figures steady between requests while the counters move", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "first" }));
    conn.close();

    const before = await fetchStats();

    const conn2 = await connectRelay();
    await publish(conn2, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "second" }));
    conn2.close();

    const after = await fetchStats();

    // `totalEvents` used to be THE example of a snapshotted figure here:
    // a count over `events` costing O(E), cached for six hours, so a page
    // load could legitimately show a stale number. It is a maintained
    // counter now, so it tracks the second event immediately and the
    // staleness that had to be traded for is simply gone.
    expect(after.totalEvents).toBe(before.totalEvents + 1);

    // The write-budget meter holds still too, and used to be the
    // counter-example here: it was read live precisely because an owner
    // watching their daily ceiling needs it current. It is cached now
    // because live meant ~1,200 rows read on an unauthenticated GET with
    // nothing in front of it -- ~4,100 requests to spend the entire
    // 5,000,000/day rows-read allowance. The concession to what it is
    // for is the CLOCK, not an exemption: five minutes
    // (LIVE_STATS_MAX_AGE_MS), and it is the only clock left on this
    // document.
    expect(after.ingested24h).toBe(before.ingested24h);
    expect(after.rowsWrittenToday).toBe(before.rowsWrittenToday);
    expect(after.liveAt).toBe(before.liveAt);

    // And it is a cache, not a freeze: once the row is gone the next
    // request recomputes and both figures pick up the second event.
    await expireLiveStats();
    const refreshed = await fetchStats();
    expect(refreshed.ingested24h).toBe(before.ingested24h + 1);
    expect(refreshed.rowsWrittenToday).toBeGreaterThan(before.rowsWrittenToday);
  });

  it("discards a cached write-budget figure measured from a previous UTC day", async () => {
    // The one invalidation age cannot do. The rows-written allowance
    // empties at 00:00 UTC, so a figure computed at 23:59 is two minutes
    // old at 00:01 -- comfortably inside the five-minute TTL -- and is
    // reporting yesterday's consumption as today's, at exactly the hour
    // someone reads this page during a recovery. relay.ts
    // refreshLiveStats keys on the boundary as well as the age.
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "yesterday" }));
    conn.close();

    await fetchStats();

    // Backdate the stored boundary by a day, leaving `computed_at`
    // current: a row that looks fresh by every test except the one that
    // matters.
    const stale = await runInDurableObject(stub(), async (_instance: Relay, state) => {
      state.storage.sql.exec(
        `UPDATE live_stats SET budget_since = budget_since - 86400, rows_written_today = 999999`,
      );
      return readLiveStats(state.storage.sql);
    });
    expect(stale?.rowsWrittenToday).toBe(999999);

    const body = await fetchStats();
    expect(body.rowsWrittenToday).not.toBe(999999);
    const rewritten = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readLiveStats(state.storage.sql),
    );
    expect(rewritten?.budgetSince).toBe(utcDayStartSeconds(Date.now()));
  });

  it("keeps the live figures in storage, where they survive eviction", async () => {
    // The property that decides row-versus-memory, stated directly. An
    // in-memory cache would hit under a flood, since a flood keeps the
    // object awake -- but a flood is not the cheap attack. One request
    // every ten seconds misses an in-memory cache every time and still
    // reaches twice the daily rows-read ceiling; see limits.ts
    // LIVE_STATS_MAX_AGE_MS. Only storage outlives eviction.
    await fetchStats();
    const row = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readLiveStats(state.storage.sql),
    );
    expect(row).not.toBeNull();
    expect(row?.computedAt).toBeGreaterThan(0);
    expect(row?.budgetSince).toBe(utcDayStartSeconds(Date.now()));
  });

  it("leaves no snapshot table behind for a cron tick to fill", async () => {
    // The cron tick used to refresh `stats_snapshot` so an admin page load
    // would find one already computed and pay nothing for it. There is
    // nothing to precompute now: a stats request reads one
    // `maintained_counts` row and at most 26 buckets, which is cheaper
    // than the cache read the snapshot itself cost. The table is dropped
    // by initSchema (schema.ts), so this asserts its absence rather than
    // its contents.
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "cron" }));
    conn.close();

    await runInDurableObject(stub(), (instance: Relay) => instance.runCron());

    await runInDurableObject(stub(), async (_instance, state) => {
      const present = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stats_snapshot'`,
        )
        .toArray();
      expect(present).toEqual([]);
    });
  });

  it("does not cache the maintained counts behind any clock", async () => {
    // What replaced the two cron tests that used to sit here: they
    // asserted that a fresh snapshot was NOT recomputed, which was the
    // whole value of the six-hour gate. The property now is the opposite
    // and stronger -- every count is current on every request, with no
    // gate to outrun.
    const before = await fetchStats();

    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "immediate" }));
    conn.close();

    const after = await fetchStats();
    expect(after.totalEvents).toBe(before.totalEvents + 1);

    await runInDurableObject(stub(), async (_instance, state) => {
      expect(readMaintainedCounts(state.storage.sql).events).toBe(after.totalEvents);
    });
  });
});
