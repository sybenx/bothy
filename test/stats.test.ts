// /api/stats and the static admin page (CLAUDE.md "What it is").
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { refreshFollows } from "../src/ownership";
import type { Relay } from "../src/relay";
import { readLiveStats, readStatsSnapshot } from "../src/storage";
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

describe("GET /api/profile", () => {
  it("rejects a request with no pubkey", async () => {
    const response = await exports.default.fetch("https://example.com/api/profile");
    expect(response.status).toBe(400);
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

// The vanish exposure signal (v0.7.3). A NIP-62 vanish removes every
// event its sender authored, the relay cannot refuse one, and the cost
// scales with how many that is -- so the worst case a deployment is
// exposed to is the largest number of events any single non-owner pubkey
// holds. Reported rather than assumed.
describe("largestNonOwnerAuthor", () => {
  it("is null when nobody but the owner has written anything", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "owner only" }));
    conn.close();

    const response = await exports.default.fetch("https://example.com/api/stats");
    const body = (await response.json()) as { largestNonOwnerAuthor: unknown };
    expect(body.largestNonOwnerAuthor).toBeNull();
  });

  it("names the non-owner pubkey holding the most events, and how many", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const heavy = randomKeypair();
    const light = randomKeypair();
    const now = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const insert = (id: string, pubkey: string, kind: number) =>
        sql.exec(
          `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost)
           VALUES (?, ?, ?, ?, '[]', 'x', 's', NULL, ?, 5)`,
          id, pubkey, now, kind, now,
        );
      for (let i = 0; i < 7; i++) insert(`h${i}`.padStart(64, "0"), heavy.pubkeyHex, 1);
      for (let i = 0; i < 2; i++) insert(`l${i}`.padStart(64, "0"), light.pubkeyHex, 1);
      // Gift wraps are excluded: every one is signed by a fresh one-time
      // key (NIP-59), so counting them would report a crowd of pubkeys
      // holding one event each and bury the number being looked for.
      for (let i = 0; i < 50; i++) insert(`g${i}`.padStart(64, "0"), randomKeypair().pubkeyHex, 1059);
    });

    const response = await exports.default.fetch("https://example.com/api/stats");
    const body = (await response.json()) as {
      largestNonOwnerAuthor: { pubkey: string; events: number } | null;
    };
    expect(body.largestNonOwnerAuthor?.pubkey).toBe(heavy.pubkeyHex);
    expect(body.largestNonOwnerAuthor?.events).toBe(7);
  });
});

// The counts above are served from a row (schema.ts `stats_snapshot`)
// rather than recomputed per request, and the tests in this block are
// about that arrangement rather than about any individual number.
//
// It replaced a 15-second in-memory cache that measurement showed
// essentially never hit: the Durable Object hibernates between admin page
// visits, in-memory state does not survive eviction, and two page loads
// on the live relay produced two full 17,601-row scans and zero cache
// hits. Storage is the only state in this object that outlives
// hibernation, so a cache spanning page loads has to live there.
//
// Every test above this point passes precisely because isolateStorage()
// clears that row between tests, which is worth stating: the fresh
// numbers they assert on are the "no snapshot yet, compute one" path,
// and the ones below are the "snapshot exists" path.
describe("/api/stats snapshot", () => {
  const stub = () => env.RELAY.get(env.RELAY.idFromName("relay"));

  const fetchStats = async () =>
    (await (await exports.default.fetch("https://example.com/api/stats")).json()) as {
      snapshotAt: number;
      liveAt: number;
      totalEvents: number;
      ingested24h: number;
      rowsWrittenToday: number;
    };

  // Nothing in production clears this row -- it expires on its own after
  // limits.ts LIVE_STATS_MAX_AGE_MS, and adding a method so a test could
  // clear it would be inventing a code path. Dropped through storage
  // directly instead, the same exception test/read-cost.test.ts already
  // takes for `stats_snapshot`.
  const expireLiveStats = async () =>
    runInDurableObject(stub(), async (_instance: Relay, state) => {
      state.storage.sql.exec(`DELETE FROM live_stats`);
    });

  it("dates the snapshotted counts so their age is stated, not assumed", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "dated" }));
    conn.close();

    const body = await fetchStats();
    // Some fields on this document are up to
    // limits.ts STATS_SNAPSHOT_MAX_AGE_MS old and the rest are current.
    // A consumer that cannot tell which is which has to assume the whole
    // document describes one instant, and it does not.
    expect(body.snapshotAt).toBeGreaterThan(0);
    expect(body.snapshotAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it("holds both cached halves steady between requests, on their own two clocks", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "first" }));
    conn.close();

    const before = await fetchStats();

    const conn2 = await connectRelay();
    await publish(conn2, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "second" }));
    conn2.close();

    const after = await fetchStats();

    // The trade, asserted rather than described. `totalEvents` is a count
    // over `events` and costs O(E) to produce, so it is snapshotted and
    // does not move until the snapshot is older than
    // STATS_SNAPSHOT_MAX_AGE_MS. An hour-old event count on a dashboard
    // is fine; a full table scan per page load is not.
    expect(after.totalEvents).toBe(before.totalEvents);
    expect(after.snapshotAt).toBe(before.snapshotAt);

    // The write-budget meter holds still too, and used to be the
    // counter-example here: it was read live precisely because an owner
    // watching their daily ceiling needs it current. It is cached now
    // because live meant ~1,200 rows read on an unauthenticated GET with
    // nothing in front of it -- ~4,100 requests to spend the entire
    // 5,000,000/day rows-read allowance. The concession to what it is
    // for is the CLOCK, not an exemption: five minutes
    // (LIVE_STATS_MAX_AGE_MS) against the snapshot's six hours.
    expect(after.ingested24h).toBe(before.ingested24h);
    expect(after.rowsWrittenToday).toBe(before.rowsWrittenToday);
    expect(after.liveAt).toBe(before.liveAt);

    // And it is a cache, not a freeze: once the row is gone the next
    // request recomputes and both figures pick up the second event.
    await expireLiveStats();
    const refreshed = await fetchStats();
    expect(refreshed.ingested24h).toBe(before.ingested24h + 1);
    expect(refreshed.rowsWrittenToday).toBeGreaterThan(before.rowsWrittenToday);
    // The snapshotted half is untouched by any of that -- two caches,
    // two clocks, one document. `liveAt` and `snapshotAt` are both
    // reported so a consumer can tell which age applies to which field.
    expect(refreshed.snapshotAt).toBe(before.snapshotAt);
  });

  it("dates the live figures separately from the snapshotted ones", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "two ages" }));
    conn.close();

    const body = await fetchStats();
    expect(body.liveAt).toBeGreaterThan(0);
    expect(body.liveAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
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

  it("computes the snapshot on a cron tick, so a page load does not have to", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "cron" }));
    conn.close();

    // No snapshot yet: the relay has served no stats request. This is the
    // state of a freshly deployed relay, and the cron tick is what is
    // supposed to fill it so the first admin page load costs nothing.
    await runInDurableObject(stub(), async (_instance, state) => {
      expect(readStatsSnapshot(state.storage.sql)).toBeNull();
    });

    await runInDurableObject(stub(), (instance: Relay) => instance.runCron());

    await runInDurableObject(stub(), async (_instance, state) => {
      const row = readStatsSnapshot(state.storage.sql);
      expect(row?.totalEvents).toBe(1);
      expect(row?.events24h).toBe(1);
    });
  });

  it("does not recompute on a cron tick while the snapshot is still fresh", async () => {
    // The gate that makes the cadence a bound rather than a hope. An
    // hourly cron recomputing ~3E rows read every tick would be 72E rows
    // read per day with nobody watching -- larger than the 48E cron floor
    // v0.7.6 removed by indexing `ingested_at`, which would have been a
    // trade in the wrong direction. See limits.ts
    // STATS_SNAPSHOT_MAX_AGE_MS for the arithmetic.
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "fresh" }));
    conn.close();

    const first = await fetchStats();

    const conn2 = await connectRelay();
    await publish(conn2, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "later" }));
    conn2.close();

    await runInDurableObject(stub(), (instance: Relay) => instance.runCron());

    const second = await fetchStats();
    expect(second.snapshotAt).toBe(first.snapshotAt);
    expect(second.totalEvents).toBe(first.totalEvents);
  });
});
