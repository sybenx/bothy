// /api/stats and the static admin page (CLAUDE.md "What it is").
import { env, exports } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
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
  readIngestCounts,
  readMaintainedCounts,
} from "../src/storage";
import { eventRemovalBudget, eventRowCost, forgetSchemaHash, initSchema } from "../src/schema";
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

// The write-budget meter: `rowsWrittenToday`, which used to be a SUM over
// `events.row_cost` -- the cost of STORING events and nothing else -- and
// is now every row this relay writes, measured by the SqlStorage wrapper
// in src/read-metrics.ts and landed in an ingest-hour bucket.
//
// What these assert is the property the arrangement stands on: the count
// reaches STORAGE inside the execution context that produced it. The
// accumulator is instance memory and this object hibernates ~70 times per
// cron interval, so a flush on a timer or deferred to the next tick would
// lose almost all of it -- and lose more of it the quieter the relay is,
// which is the failure nobody would notice.
describe("rows written today", () => {
  const stub = () => env.RELAY.get(env.RELAY.idFromName("relay"));
  const nowSec = () => Math.floor(Date.now() / 1000);

  const rowsWrittenToday = async () =>
    runInDurableObject(
      stub(),
      async (_instance: Relay, state) =>
        readIngestCounts(state.storage.sql, nowSec(), utcDayStartSeconds(Date.now())).rowsWrittenToday,
    );

  it("counts a write that stores no event at all", async () => {
    // The whole point of measuring at the wrapper. A NIP-86 ban writes
    // two rows and no event, so the old SUM over `events.row_cost` could
    // not see it however large it got -- and the follow rebuild, which is
    // 900 rows at 300 follows, was invisible the same way.
    const before = await rowsWrittenToday();
    await runInDurableObject(stub(), (instance: Relay) =>
      instance.manage("banpubkey", ["b".repeat(64), "spam"], "1.2.3.4"),
    );
    const after = await rowsWrittenToday();
    expect(after).toBeGreaterThan(before);
  });

  it("lands the total in storage before the entry point returns", async () => {
    // The correctness property, asserted against eviction rather than
    // against a number: the count has to be a row by the time the call
    // that produced it is finished, because the memory it accumulated in
    // does not survive the next hibernation.
    const before = await rowsWrittenToday();
    await runInDurableObject(stub(), (instance: Relay) =>
      instance.manage("blockip", ["10.0.0.9", "noisy"], "1.2.3.4"),
    );
    const landed = await rowsWrittenToday();
    expect(landed).toBeGreaterThan(before);

    await evictDurableObject(stub());
    expect(await rowsWrittenToday()).toBe(landed);
  });

  it("counts an event write without a bucket write of its own", async () => {
    // Storing an event already writes an ingest-hour bucket row for
    // `ingested24h`, and the meter's total goes into the same statement
    // -- so the measurement is free on the path that dominates the
    // budget. What lands has to be at least what the event cost.
    const before = await rowsWrittenToday();
    const conn = await connectRelay();
    await publish(
      conn,
      signEvent(OWNER_SECRET_KEY_HEX, {
        kind: 1,
        content: "metered",
        tags: [
          ["e", "a".repeat(64)],
          ["p", "b".repeat(64)],
        ],
      }),
    );
    conn.close();
    expect(await rowsWrittenToday()).toBeGreaterThanOrEqual(before + eventRowCost(2));
  });

  it("counts a removal at the pessimistic figure, not at what the cursor reports", async () => {
    // SqlStorageCursor counts index maintenance on INSERT and not on
    // DELETE (schema.ts eventRemovalRowsWritten), so a wrapper-only
    // figure would understate every removal -- the wrong direction for a
    // budget meter, on the one operation this relay cannot refuse.
    // storage.ts deleteEventRow adds eventRemovalBudget on top of what
    // the cursor saw, which is the same number the vanish drain is paced
    // against and deliberately leans high.
    const target = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "removed",
      tags: [
        ["e", "c".repeat(64)],
        ["p", "d".repeat(64)],
      ],
    });
    const conn = await connectRelay();
    await publish(conn, target);
    conn.close();

    const before = await rowsWrittenToday();
    await runInDurableObject(stub(), (instance: Relay) =>
      instance.manage("banevent", [target.id, "gone"], "1.2.3.4"),
    );
    expect(await rowsWrittenToday()).toBeGreaterThanOrEqual(before + eventRemovalBudget(2));
  });

  it("never decrements the rows-written bucket when an event is removed", async () => {
    // `n` beside it comes back out on removal, because `ingested24h`
    // counts events this relay took in and still holds. `rows_written`
    // must not: a row that was written and then deleted was still
    // written, and the allowance does not come back.
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "transient" });
    await publish(conn, target);
    conn.close();

    const stored = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readIngestCounts(state.storage.sql, nowSec(), utcDayStartSeconds(Date.now())),
    );

    await runInDurableObject(stub(), (instance: Relay) =>
      instance.manage("banevent", [target.id, "gone"], "1.2.3.4"),
    );

    const removed = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readIngestCounts(state.storage.sql, nowSec(), utcDayStartSeconds(Date.now())),
    );
    expect(removed.ingested24h).toBe(stored.ingested24h - 1);
    expect(removed.rowsWrittenToday).toBeGreaterThan(stored.rowsWrittenToday);
  });

  it("seeds the ingest buckets once from real rows, and never recounts", async () => {
    // schema.ts seedIngestCounts, guarded on the TABLE being empty rather
    // than on the schema hash -- the same rule and the same reason as
    // seedMaintainedCounts. A seed keyed to the reconcile pass would
    // re-run on every future schema change and silently repair whatever
    // drift the buckets had accumulated, which is the evidence
    // auditMaintainedCounts exists to report.
    const now = nowSec();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM ingest_hour_counts`);
      sql.exec(`DELETE FROM events`);
      for (let i = 0; i < 3; i++) {
        sql.exec(
          `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost)
           VALUES (?, 'p', ?, 1, '[]', 'x', 's', NULL, ?, 6)`,
          `i${i}`.padStart(64, "0"),
          now,
          now,
        );
      }
      forgetSchemaHash(sql);
      initSchema(sql);
      const seeded = readIngestCounts(sql, now, now - 3600);
      expect(seeded.ingested24h).toBe(3);
      // Seeded from `events.row_cost`: what storing those rows cost, and
      // deliberately not an invented figure for the deletions and
      // bookkeeping of hours already past. A floor, exactly as
      // `row_cost`'s own arrival was.
      expect(seeded.rowsWrittenToday).toBe(18);

      // A later schema change reconciles again and must leave the buckets
      // alone, even after they have been made wrong on purpose.
      sql.exec(`UPDATE ingest_hour_counts SET rows_written = 4242`);
      forgetSchemaHash(sql);
      initSchema(sql);
      expect(readIngestCounts(sql, now, now - 3600).rowsWrittenToday).toBe(4242);
    });
  });

  it("logs ingest-bucket drift, including a rows-written figure below its floor", async () => {
    // The daily audit covers the new counters too, and detects only. The
    // rows-written check is a FLOOR rather than an equality: the bucket
    // legitimately exceeds the cost of the events in it (deletions,
    // follow rebuilds, NIP-86 calls), but it can never fall below it --
    // below means the meter lost writes, which is the failure that
    // matters.
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "audited" }));
    conn.close();

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await runInDurableObject(stub(), async (_instance, state) => {
        const sql = state.storage.sql;
        sql.exec(`UPDATE ingest_hour_counts SET n = n + 7, rows_written = 0`);
        sql.exec(`UPDATE maintained_counts SET audited_at = NULL`);
        auditMaintainedCounts(sql, nowSec());
        // Logged, and left wrong.
        expect(
          readIngestCounts(sql, nowSec(), utcDayStartSeconds(Date.now())).rowsWrittenToday,
        ).toBe(0);
      });
    } finally {
      console.error = original;
    }
    const logged = errors.join("\n");
    expect(logged).toContain("ingest_hour_counts, summed over the last 24h");
    expect(logged).toContain("rows_written");
  });
});

// /api/stats no longer caches anything, and the tests in this block are
// about that arrangement rather than about any individual number.
//
// There were two caches in two releases. `stats_snapshot`, on a six-hour
// clock over the counts that walked a table, went when those became
// maintained counters. `live_stats`, on a five-minute clock over
// `ingested24h` and `rowsWrittenToday`, went when those became hourly
// buckets keyed by ingest time (schema.ts `ingest_hour_counts`). Each
// time the TTL was rationing a cost that stopped existing, which is the
// lesson limits.ts records where costs get priced. What is asserted below
// is that nothing on this document answers to a clock any more.
describe("/api/stats has no cache left", () => {
  const stub = () => env.RELAY.get(env.RELAY.idFromName("relay"));

  const fetchStats = async () =>
    (await (await exports.default.fetch("https://example.com/api/stats")).json()) as {
      totalEvents: number;
      followCount: number;
      ingested24h: number;
      rowsWrittenToday: number;
    };

  it("carries no age field, because nothing on it is stale", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "dated" }));
    conn.close();

    const body = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as Record<string, unknown>;
    // `liveAt` dated the five-minute cache and `snapshotAt` the six-hour
    // one before it. A consumer that finds neither can read the whole
    // document as describing one instant, which it now does.
    expect(body).not.toHaveProperty("liveAt");
    expect(body).not.toHaveProperty("snapshotAt");
  });

  it("moves every figure immediately, including the two that used to be cached", async () => {
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "first" }));
    conn.close();

    const before = await fetchStats();

    const conn2 = await connectRelay();
    await publish(conn2, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "second" }));
    conn2.close();

    const after = await fetchStats();

    // `totalEvents` was THE example of a snapshotted figure here: a count
    // over `events` costing O(E), cached for six hours.
    expect(after.totalEvents).toBe(before.totalEvents + 1);
    // These two were the counter-example one release ago -- held steady
    // between requests on purpose, because computing them cost ~1,200
    // rows on an unauthenticated GET. Bucketed by ingest hour, they track
    // the second event immediately and the staleness that had to be
    // traded for is simply gone.
    expect(after.ingested24h).toBe(before.ingested24h + 1);
    expect(after.rowsWrittenToday).toBeGreaterThan(before.rowsWrittenToday);
  });

  it("keeps the write budget measured from the last 00:00 UTC, not a rolling day", async () => {
    // The invalidation the five-minute cache had to key on separately: a
    // figure computed at 23:59 was two minutes old at 00:01, comfortably
    // inside its TTL, and was reporting yesterday's consumption as
    // today's. A bucket table has no such failure -- a UTC day starts on
    // a whole hour, so "today" is a range of bucket keys and the
    // boundary is not a thing that can go stale.
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "budgeted" }));
    conn.close();

    const body = await fetchStats();
    const dayStart = utcDayStartSeconds(Date.now());
    const direct = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readIngestCounts(state.storage.sql, Math.floor(Date.now() / 1000), dayStart),
    );
    expect(body.rowsWrittenToday).toBe(direct.rowsWrittenToday);
    expect(direct.rowsWrittenToday).toBeGreaterThan(0);

    // Asking from tomorrow's boundary reports nothing: the buckets stop
    // at today's, so the allowance resetting is a cutoff moving rather
    // than a cached figure expiring.
    const tomorrow = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      readIngestCounts(state.storage.sql, Math.floor(Date.now() / 1000), dayStart + 86400),
    );
    expect(tomorrow.rowsWrittenToday).toBe(0);
  });

  it("keeps the ingest buckets in storage, where they survive eviction", async () => {
    // The property that decided row-versus-memory for the cache these
    // replaced, and it decides the same way for the counters: a Durable
    // Object that hibernates loses every field on the instance and keeps
    // every row in SQLite. It matters more here than it did there --
    // the write meter accumulates in memory between landings, so the
    // landing has to reach storage or the figure is lost on the next
    // eviction (read-metrics.ts).
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "durable" }));
    conn.close();

    const rows = await runInDurableObject(stub(), async (_instance: Relay, state) =>
      state.storage.sql
        .exec<{ hour: number; n: number; rows_written: number }>(
          `SELECT hour, n, rows_written FROM ingest_hour_counts ORDER BY hour DESC LIMIT 1`,
        )
        .toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.rows_written).toBeGreaterThanOrEqual(1);
  });

  it("leaves no cache table behind for a cron tick to fill", async () => {
    // The cron tick used to refresh `stats_snapshot` so an admin page load
    // would find one already computed and pay nothing for it. There is
    // nothing to precompute now: a stats request reads one
    // `maintained_counts` row and at most 26 + 25 bucket rows, which is
    // cheaper than the cache read either snapshot itself cost. Both
    // tables are dropped by initSchema (schema.ts), so this asserts their
    // absence rather than their contents.
    const conn = await connectRelay();
    await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "cron" }));
    conn.close();

    await runInDurableObject(stub(), (instance: Relay) => instance.runCron());

    await runInDurableObject(stub(), async (_instance, state) => {
      const present = state.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('stats_snapshot', 'live_stats')`,
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
