// /api/stats and the static admin page (CLAUDE.md "Admin page").
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { refreshFollows } from "../src/ownership";
import { connectRelay, publish } from "./helpers/socket";
import { version } from "../package.json";

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
      rowsWrittenEstimate24h: expect.any(Number),
      ingested24h: expect.any(Number),
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
      followsRefreshedAt: number | null;
    };

    // The global test env leaves ALLOW_FOLLOWS unset (vitest.config.ts),
    // and it's an opt-out (ownership.ts allowFollowsEnabled), so this is
    // "follows" here even with an empty follow list -- see
    // follows.test.ts for the ALLOW_FOLLOWS=false owner-only case.
    expect(body.writePolicy).toBe("follows");
    expect(body.followCount).toBe(0);
    expect(body.followsRefreshedAt).toBeNull();
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
    // followCount/followsRefreshedAt reflect whatever is actually in the
    // table, not relay.ts's refresh trigger (covered by
    // test/write-gate-refresh.test.ts instead).
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      refreshFollows(
        state.storage.sql,
        { ...env, ALLOW_FOLLOWS: "true" } as unknown as Env,
        Math.floor(Date.now() / 1000),
      );
    });

    const response = await exports.default.fetch("https://example.com/api/stats");
    const body = (await response.json()) as {
      followCount: number;
      followsRefreshedAt: number | null;
    };

    expect(body.followCount).toBe(2);
    expect(body.followsRefreshedAt).toEqual(expect.any(Number));
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
