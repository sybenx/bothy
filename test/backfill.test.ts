// One-shot backfill. backfill.ts is pure over
// SqlStorage, like ownership.ts/storage.ts, so it's exercised directly
// via runInDurableObject against real storage rather than over the wire
// -- see test/follows.test.ts for the same pattern.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  applyBackfillPage,
  getBackfillStatus,
  hasBackfillHeadroom,
  resetWronglyExhaustedRelays,
  purgeSelfRelay,
  seedBackfillRelays,
} from "../src/backfill";
import { recordHost } from "../src/host";
import { BACKFILL_ROWS_SHARE_LIMIT, MAX_CREATED_AT_FUTURE_SECONDS } from "../src/limits";
import { eventRowCost } from "../src/schema";
import { countIngested24h, estimateRowsWritten24h } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

function eventRows(sql: SqlStorage, extra = ""): { id: string; kind: number; content: string }[] {
  return sql
    .exec<{ id: string; kind: number; content: string }>(`SELECT id, kind, content FROM events ${extra}`)
    .toArray();
}

// Cheap stand-in for real live traffic -- 3 rows/event (a bare kind-1
// note, schema.ts's write-cost formula), inserted directly rather than
// through storeEvent/signEvent so the test can push the rolling 24h
// rows-written estimate over BACKFILL_ROWS_SHARE_LIMIT without actually
// signing and storing tens of thousands of events.
// `ingestedAt` is what hasBackfillHeadroom actually measures (storage.ts
// estimateRowsWritten24h), so these rows have to carry it -- setting only
// created_at would make them invisible to the very guard this fixture
// exists to push over its limit. Both are set to the same second here
// because these stand in for the owner's own live writes, where the two
// genuinely coincide; a backfilled row is the case where they do not.
function insertSyntheticLiveRows(sql: SqlStorage, idPrefix: string, count: number, at: number): void {
  // Cloudflare's SqlStorage caps bound parameters per statement well
  // below stock SQLite's default -- keep each batch's param count (8
  // columns/row) comfortably under that.
  const BATCH = 10;
  let inserted = 0;
  while (inserted < count) {
    const batchCount = Math.min(BATCH, count - inserted);
    const values = Array(batchCount).fill("(?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)").join(", ");
    const params: (string | number)[] = [];
    for (let i = 0; i < batchCount; i++) {
      // row_cost stamped exactly as storage.ts insertEventRow would --
      // these stand in for real live writes, and a row with a NULL
      // row_cost is invisible to estimateRowsWritten24h by design (the
      // pre-migration case, covered separately below).
      params.push(
        `${idPrefix}-${inserted + i}`, "f".repeat(64), at, 1, "[]", "", "0".repeat(128), at,
        eventRowCost(0),
      );
    }
    sql.exec(
      `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost)
       VALUES ${values}`,
      ...params,
    );
    inserted += batchCount;
  }
}

// Regression coverage for the write-accounting bug this guard depends on.
// estimateRowsWritten24h used to filter on `created_at`, so a backfilled
// event -- which carries the timestamp its author signed it with, often
// years ago -- contributed nothing to the number that decides whether
// backfill may keep writing. The guard protecting the daily write budget
// from backfill could not see backfill's own writes. See schema.ts's
// `ingested_at` comment.
describe("backfill write accounting", () => {
  // Two years before `now` below: comfortably outside any 24h window, and
  // representative of what a real backfilled note carries.
  const ANCIENT = 1_700_000_000;
  const NOW = ANCIENT + 2 * 365 * 86400;

  it("counts a backfilled event's rows against the write budget despite its years-old timestamp", async () => {
    const oldNote = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "written years ago, ingested just now",
      created_at: ANCIENT,
    });

    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const since = NOW - 86400;
      expect(estimateRowsWritten24h(sql, since)).toBe(0);

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [oldNote], true, NOW);
      expect(result.stored).toBe(1);

      // The event's own rows (base + implicit PK index + one per index
      // on `events`) and none for tags, since this note carries none.
      // Derived from schema.ts rather than written as a literal: this
      // assertion said `3` until v0.7.2 added two indexes, and a literal
      // here would have to be found and changed by hand every time the
      // index set moves. test/hibernation.test.ts is what checks
      // eventRowCost against SQLite's real rowsWritten.
      expect(estimateRowsWritten24h(sql, since)).toBe(eventRowCost(0));

      // The old behaviour, shown to be the wrong question rather than
      // just a wrong number: by created_at this event is invisible in the
      // window, which is exactly why it used to cost nothing.
      const byTimestamp = sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE created_at > ?`, since)
        .toArray()[0]?.n;
      expect(byTimestamp).toBe(0);
      expect(countIngested24h(sql, since)).toBe(1);
    });
  });

  it("counts tag rows too, at the same per-event cost the schema documents", async () => {
    const reply = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "a reply, backfilled",
      created_at: ANCIENT,
      tags: [
        ["e", "a".repeat(64)],
        ["p", "b".repeat(64)],
      ],
    });

    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [reply], true, NOW);
      // Base cost plus TAG_ROW_COST per indexed tag, per schema.ts.
      expect(estimateRowsWritten24h(sql, NOW - 86400)).toBe(eventRowCost(2));
    });
  });

  it("stops counting an ingest once it falls out of the rolling window", async () => {
    const oldNote = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "aged out", created_at: ANCIENT });

    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [oldNote], true, NOW);
      expect(estimateRowsWritten24h(sql, NOW - 86400)).toBe(eventRowCost(0));
      // A day and a half later the same row no longer counts against the
      // budget -- the window rolls rather than accumulating forever.
      expect(estimateRowsWritten24h(sql, NOW + 86400 / 2)).toBe(0);
    });
  });
});

// A relay refusing a REQ (NIP-01 gives it CLOSED, NOTICE and AUTH to do
// that with) used to be indistinguishable from a relay saying nothing:
// backfill-worker.ts fetchPage discarded every non-EVENT/EOSE frame, so
// both arrived as zero events and no EOSE. These assert the information
// survives to somewhere a person can read it.
// A relay can end up listed as a source of its own history: the owner's
// kind-10002 legitimately names it, and seedBackfillRelays can only filter
// it out once getOwnHost() is non-null -- which it is not on a fresh
// deployment whose first cron tick beats its first inbound request. The
// row is harmless while flagged exhausted and becomes nextRelay the moment
// resetWronglyExhaustedRelays clears every flag.
// limits.ts MAX_CREATED_AT_FUTURE_SECONDS -- backfill must reject a
// far-future event too, not just the live path in relay.ts acceptEvent,
// or an old relay serving a mangled/malicious page could still brick a
// replaceable kind via backfill.
describe("backfill created_at future limit", () => {
  const NOW = 1_800_000_000;

  it("rejects a backfilled event dated beyond the future window", async () => {
    const fromTheFuture = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "backfilled from the future",
      created_at: NOW + MAX_CREATED_AT_FUTURE_SECONDS + 60,
    });

    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [fromTheFuture], true, NOW);
      expect(result.stored).toBe(0);
      expect(eventRows(sql).some((row) => row.id === fromTheFuture.id)).toBe(false);
    });
  });
});

describe("purgeSelfRelay", () => {
  const NOW = 1_800_000_000;
  const OWN_HOST = "my-relay.example.workers.dev";

  it("removes this relay's own row and leaves every other relay untouched", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, OWN_HOST);
      sql.exec(`DELETE FROM backfill_relays`);
      // Seeded before the host was known, which is the whole scenario.
      for (const [url, cursor] of [
        [`wss://${OWN_HOST}/`, 1000],
        ["wss://relay-a.example", 2000],
        ["wss://relay-b.example", 3000],
      ] as const) {
        sql.exec(
          `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES (?, ?, 0)`,
          url,
          cursor,
        );
      }

      expect(purgeSelfRelay(sql)).toBe(1);

      const left = sql
        .exec<{ relay_url: string; until_cursor: number }>(
          `SELECT relay_url, until_cursor FROM backfill_relays ORDER BY relay_url`,
        )
        .toArray();
      expect(left.map((r) => r.relay_url)).toEqual(["wss://relay-a.example", "wss://relay-b.example"]);
      // Cursors of the surviving relays are untouched -- purging one row
      // must not disturb anyone else's progress.
      expect(left.map((r) => r.until_cursor)).toEqual([2000, 3000]);
      // And the relay that should be worked on next is a real one.
      expect(getBackfillStatus(sql).nextRelay).toBe("wss://relay-a.example");
    });
  });

  it("matches on host, not on the exact URL string", async () => {
    // The kind-10002 tag and the recorded host will not be spelled the
    // same way -- scheme, trailing slash and case all differ.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, OWN_HOST);
      sql.exec(`DELETE FROM backfill_relays`);
      sql.exec(
        `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES (?, ?, 0)`,
        `wss://${OWN_HOST.toUpperCase()}`,
        1000,
      );
      expect(purgeSelfRelay(sql)).toBe(1);
      expect(sql.exec(`SELECT 1 FROM backfill_relays`).toArray().length).toBe(0);
    });
  });

  it("purges the row the exhaustion reset just un-retired", async () => {
    // The exact production sequence: a self row sitting flagged
    // exhausted, resetWronglyExhaustedRelays clearing every flag, and the
    // self row then sorting ahead of the relay with real history left.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, "aaa-relay.example.workers.dev");
      sql.exec(`DELETE FROM backfill_relays`);
      sql.exec(
        `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES ('wss://aaa-relay.example.workers.dev/', 1000, 1)`,
      );
      sql.exec(
        `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES ('wss://zzz-real.example', 2000, 1)`,
      );
      sql.exec(`UPDATE backfill_meta SET exhaust_reset_applied = 0`);

      resetWronglyExhaustedRelays(sql);
      // Without the purge this is the bug: the relay's own URL is now
      // what backfill would fetch from next.
      expect(getBackfillStatus(sql).nextRelay).toBe("wss://aaa-relay.example.workers.dev/");

      purgeSelfRelay(sql);
      expect(getBackfillStatus(sql).nextRelay).toBe("wss://zzz-real.example");
    });
  });

  it("does nothing while the host is still unknown", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`UPDATE relay_meta SET host = NULL`);
      sql.exec(`DELETE FROM backfill_relays`);
      sql.exec(`INSERT INTO backfill_relays (relay_url, until_cursor) VALUES ('wss://relay-a.example', 1000)`);
      expect(purgeSelfRelay(sql)).toBe(0);
      expect(sql.exec(`SELECT 1 FROM backfill_relays`).toArray().length).toBe(1);
    });
  });

  it("marks backfill done when this relay was the only source listed", async () => {
    // Nothing external to import. Leaving status at 'running' against an
    // empty table would read as "still working" forever.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, OWN_HOST);
      sql.exec(`DELETE FROM backfill_relays`);
      sql.exec(`UPDATE backfill_meta SET status = 'running'`);
      sql.exec(
        `INSERT INTO backfill_relays (relay_url, until_cursor) VALUES (?, ?)`,
        `wss://${OWN_HOST}/`,
        1000,
      );
      expect(purgeSelfRelay(sql)).toBe(1);
      expect(getBackfillStatus(sql).status).toBe("done");
    });
  });

  it("leaves an unseeded relay at 'pending' rather than calling it done", async () => {
    // An empty table because discovery has not run yet is a different
    // state from an empty table because everything in it was self.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, OWN_HOST);
      sql.exec(`DELETE FROM backfill_relays`);
      sql.exec(`UPDATE backfill_meta SET status = 'pending'`);
      expect(purgeSelfRelay(sql)).toBe(0);
      expect(getBackfillStatus(sql).status).toBe("pending");
    });
  });
});

describe("backfill refusals", () => {
  const NOW = 1_800_000_000;

  async function seeded(fn: (sql: SqlStorage) => void | Promise<void>) {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://refuses.example"], NOW);
      await fn(sql);
    });
  }

  it("records what the relay said when an empty page carried a refusal", async () => {
    await seeded(async (sql) => {
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://refuses.example", [], false, NOW, [
        '["CLOSED","backfill","auth-required: we only serve authenticated clients"]',
      ]);
      const status = getBackfillStatus(sql);
      expect(status.nextRefusal).toContain("auth-required");
      // A refusal is not exhaustion -- the relay still has history, it
      // just will not give it to us, so it must stay in the rotation.
      expect(status.exhaustedCount).toBe(0);
    });
  });

  it("leaves nextRefusal null when a relay is genuinely silent", async () => {
    await seeded(async (sql) => {
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://refuses.example", [], false, NOW, []);
      // The distinction the whole change exists for: silence and refusal
      // are different answers and must not read the same.
      expect(getBackfillStatus(sql).nextRefusal).toBeNull();
    });
  });

  it("clears a recorded refusal as soon as a page carries events", async () => {
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "history, finally" });
    await seeded(async (sql) => {
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://refuses.example", [], false, NOW, [
        '["NOTICE","rate-limited"]',
      ]);
      expect(getBackfillStatus(sql).nextRefusal).toContain("rate-limited");

      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://refuses.example", [note], true, NOW, [
        '["NOTICE","rate-limited"]',
      ]);
      // Stale refusals are worse than none -- they describe a problem the
      // relay has stopped having.
      expect(getBackfillStatus(sql).nextRefusal).toBeNull();
    });
  });

  it("does not treat a refusal as exhaustion even when EOSE follows it", async () => {
    await seeded(async (sql) => {
      // An empty page WITH a real EOSE is genuine exhaustion, and stays
      // so -- the refusal channel must not change that verdict, only
      // describe it.
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://refuses.example", [], true, NOW, [
        '["NOTICE","nothing to see here"]',
      ]);
      expect(getBackfillStatus(sql).exhaustedCount).toBe(1);
    });
  });
});

describe("backfill ingest", () => {
  it("dedupes an event returned by more than one relay -- checked before signature verification", async () => {
    const note = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "posted once, seen on two relays",
      created_at: 1000,
    });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;

      const first = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [note], true, 1000);
      expect(first.stored).toBe(1);

      const second = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-b", [note], true, 1000);
      expect(second.stored).toBe(0);

      expect(eventRows(sql, `WHERE id = '${note.id}'`)).toHaveLength(1);
    });
  });

  it("never resurrects a tombstoned id -- a deletion made here must survive backfill from a relay that still has it", async () => {
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });

    const conn = await connectRelay();
    await publish(conn, target);
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, { kind: 5, tags: [["e", target.id]] });
    await publish(conn, deletion);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(eventRows(sql, `WHERE id = '${target.id}'`)).toHaveLength(0);

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [target], true, 1000);
      expect(result.stored).toBe(0);
      expect(eventRows(sql, `WHERE id = '${target.id}'`)).toHaveLength(0);
    });
  });

  it("a page with several versions of the owner's kind 0 collapses to exactly one row", async () => {
    const v1 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: '{"name":"old"}', created_at: 1000 });
    const v2 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: '{"name":"newer"}', created_at: 2000 });
    const v3 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 0, content: '{"name":"newest"}', created_at: 1500 });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;

      // Deliberately out of chronological order -- a real relay page
      // isn't guaranteed to arrive sorted, and storeEvent's own
      // newest-wins comparison must not depend on arrival order.
      applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [v1, v3, v2], true, 1000);

      const rows = eventRows(sql, `WHERE pubkey = '${OWNER_PUBKEY_HEX}' AND kind = 0`);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.content).toBe(v2.content);
    });
  });

  it("drops ephemeral kinds instead of storing them", async () => {
    const ephemeral = signEvent(OWNER_SECRET_KEY_HEX, { kind: 25000, content: "should not persist" });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [ephemeral], true, 1000);
      expect(result.stored).toBe(0);
      expect(eventRows(sql, `WHERE id = '${ephemeral.id}'`)).toHaveLength(0);
    });
  });

  it("ignores events from a pubkey other than the owner, even inside an authors-filtered page", async () => {
    const stranger = randomKeypair();
    const spoofed = signEvent(stranger.secretKeyHex, { kind: 1, content: "not the owner" });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [spoofed], true, 1000);
      expect(result.stored).toBe(0);
      expect(eventRows(sql, `WHERE id = '${spoofed.id}'`)).toHaveLength(0);
    });
  });

  it("a short but non-empty page terminated by a real EOSE does not exhaust -- relays cap their own per-REQ limit", async () => {
    const older = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "older", created_at: 1000 });
    const newer = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "newer", created_at: 2000 });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], 5000);

      // Asked for PAGE_SIZE (200), got 2 back with a genuine EOSE -- a
      // relay-side per-REQ cap, not "nothing older."
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [newer, older], true, 5000);
      expect(result.exhausted).toBe(false);
      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.nextUntil).toBe(older.created_at - 1);
    });
  });

  it("an empty page terminated by a real EOSE does exhaust -- standard nostr pagination end", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], 5000);

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [], true, 5000);
      expect(result.exhausted).toBe(true);
      const status = getBackfillStatus(sql);
      expect(status.status).toBe("done");
      expect(status.nextRelay).toBeNull();
    });
  });

  it("a timed-out fetch (no EOSE) does not exhaust even with a partial page, and still advances the cursor", async () => {
    const older = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "older", created_at: 1000 });
    const newer = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "newer", created_at: 2000 });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], 5000);

      // BACKFILL_FETCH_TIMEOUT_MS fired before EOSE arrived --
      // fetchPage's `done()` still resolves with whatever partial page it
      // had collected, but eose stays false.
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [newer, older], false, 5000);
      expect(result.exhausted).toBe(false);
      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.nextRelay).toBe("wss://relay-a");
      // Refetching events already processed would be wasted work, so the
      // cursor still advances past them even though the fetch timed out.
      expect(status.nextUntil).toBe(older.created_at - 1);
    });
  });

  it("a failed fetch (no EOSE, zero events) does not exhaust", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], 5000);

      // A connection error, a close before EOSE, or the WebSocket
      // constructor throwing all resolve fetchPage with an empty array
      // and eose: false -- indistinguishable, at this layer, from a
      // relay saying "nothing more," except for the eose flag.
      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [], false, 5000);
      expect(result.exhausted).toBe(false);
      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.nextRelay).toBe("wss://relay-a");
    });
  });

  it("seedBackfillRelays only seeds once and flips status to running", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(getBackfillStatus(sql).status).toBe("pending");

      seedBackfillRelays(sql, ["wss://relay-a", "wss://relay-b"], 1000);
      let status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.relayCount).toBe(2);

      // A repeat call (e.g. a retried discovery) must not reset progress.
      seedBackfillRelays(sql, ["wss://relay-c"], 2000);
      status = getBackfillStatus(sql);
      expect(status.relayCount).toBe(2);
    });
  });

  it("skips its own host in the owner's write-relay list, however the deployment is named", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Whatever the deployer named their Worker -- the bug this guards
      // against was string-matching "bothy" in the URL, which a
      // differently-named deployment would never trip.
      recordHost(sql, "my-notes-thing.someusername.workers.dev");

      seedBackfillRelays(
        sql,
        ["wss://my-notes-thing.someusername.workers.dev/", "wss://relay-a", "wss://relay-b"],
        1000,
      );

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.relayCount).toBe(2);
      const relays = sql
        .exec<{ relay_url: string }>(`SELECT relay_url FROM backfill_relays ORDER BY relay_url`)
        .toArray()
        .map((r) => r.relay_url);
      expect(relays).toEqual(["wss://relay-a", "wss://relay-b"]);
    });
  });

  it("skips its own host when it's a custom domain, case- and slash-insensitively", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, "notes.example.com");

      seedBackfillRelays(sql, ["wss://NOTES.example.com", "wss://relay-a"], 1000);

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.relayCount).toBe(1);
      const relays = sql.exec<{ relay_url: string }>(`SELECT relay_url FROM backfill_relays`).toArray();
      expect(relays).toEqual([{ relay_url: "wss://relay-a" }]);
    });
  });

  it("marks backfill done, not stuck pending, when every listed write relay is itself", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      recordHost(sql, "notes.example.com");

      seedBackfillRelays(sql, ["wss://notes.example.com/"], 1000);

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("done");
      expect(status.relayCount).toBe(0);
    });
  });

  it("a budget failure mid-page stops without advancing past the failed event, and does not mark exhaustion", async () => {
    const a = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "a", created_at: 3000 });
    const b = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "b", created_at: 2000 });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], 5000);

      const real = sql.exec.bind(sql);
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (sql as any).exec = (...args: unknown[]) => {
        const sqlText = String(args[0]);
        if (sqlText.startsWith("INSERT INTO events") && ++calls === 1) {
          throw new Error("simulated rows-written quota exceeded");
        }
        return real(...(args as Parameters<typeof real>));
      };

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [a, b], true, 6000);
      expect(result.stored).toBe(0);
      expect(result.exhausted).toBe(false);

      const status = getBackfillStatus(sql);
      expect(status.status).toBe("paused-budget");
      // Cursor must not move past `a` (the event that failed to store) --
      // it needs to be retried once the daily quota resets, not skipped.
      expect(status.nextUntil).toBe(5000);
    });
  });

  it("yields to live traffic once it already holds more than its reserved share of the daily write budget", async () => {
    const now = Math.floor(Date.now() / 1000);
    const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "posted while backfill waits" });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], now);

      // Just under BACKFILL_ROWS_SHARE_LIMIT worth of bare-note-equivalent
      // rows -- still headroom. Sized from eventRowCost so the fixture
      // tracks the schema instead of assuming a bare note costs 3.
      insertSyntheticLiveRows(
        sql,
        "under",
        Math.floor(BACKFILL_ROWS_SHARE_LIMIT / eventRowCost(0)) - 100,
        now,
      );
      expect(hasBackfillHeadroom(sql, now)).toBe(true);

      // Cross the reserved share -- live traffic (real or, here,
      // synthetic) has used more than half the daily ceiling.
      insertSyntheticLiveRows(sql, "over", 200, now);
      expect(hasBackfillHeadroom(sql, now)).toBe(false);

      const result = applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [note], true, now);
      expect(result).toEqual({ stored: 0, exhausted: false });
      // Nothing this call would otherwise have done actually happened:
      // no row for the fetched event, and the relay's cursor/exhausted
      // state is untouched so the same page is retried once headroom
      // reopens.
      expect(eventRows(sql, `WHERE id = '${note.id}'`)).toHaveLength(0);
      const status = getBackfillStatus(sql);
      expect(status.status).toBe("running");
      expect(status.nextUntil).toBe(now);
    });
  });

  it("the one-time exhaustion reset clears wrongly-set flags, flips done back to running, leaves cursors untouched, and runs only once", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a", "wss://relay-b"], 1000);
      // Simulate the pre-fix bug's damage directly -- both relays wrongly
      // flagged exhausted by a short page that was really a timeout or a
      // per-REQ cap, with status consequently flipped to 'done'.
      sql.exec(`UPDATE backfill_relays SET exhausted = 1, until_cursor = 4242`);
      sql.exec(`UPDATE backfill_meta SET status = 'done'`);

      resetWronglyExhaustedRelays(sql);

      const relays = sql
        .exec<{ relay_url: string; exhausted: number; until_cursor: number }>(
          `SELECT relay_url, exhausted, until_cursor FROM backfill_relays ORDER BY relay_url`,
        )
        .toArray();
      expect(relays.every((r) => r.exhausted === 0)).toBe(true);
      // until_cursor is exactly where each relay stopped -- resetting it
      // would re-fetch history already stored, so it must be untouched.
      expect(relays.every((r) => r.until_cursor === 4242)).toBe(true);

      let status = getBackfillStatus(sql);
      expect(status.status).toBe("running");

      // Re-flag one relay exhausted (as the fixed applyBackfillPage rule
      // legitimately would) and re-run -- the marker must prevent a
      // second reset from wiping out real progress.
      sql.exec(`UPDATE backfill_relays SET exhausted = 1 WHERE relay_url = 'wss://relay-a'`);
      sql.exec(`UPDATE backfill_meta SET status = 'running'`);
      resetWronglyExhaustedRelays(sql);

      status = getBackfillStatus(sql);
      expect(status.exhaustedCount).toBe(1);
      expect(status.status).toBe("running");
    });
  });
});
