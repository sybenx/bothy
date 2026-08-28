// ALLOW_FOLLOWS (CLAUDE.md "Configuration": "also accept writes from the
// owner's kind-3 follow list"). Follows are re-derived from the owner's
// own most recent kind-3 event already stored on this relay, not fetched
// from elsewhere -- see ownership.ts refreshFollows(). ALLOW_FOLLOWS is an
// opt-out (ownership.ts allowFollowsEnabled), so both states are exercised
// explicitly below with a hand-built env against real SqlStorage via
// runInDurableObject, rather than relying on whatever the global test env
// happens to default to.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isAllowedWriter, refreshFollows } from "../src/ownership";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { publish, connectRelay } from "./helpers/socket";
import { allowPubkey, banPubkey, readMaintainedCounts, storeEvent } from "../src/storage";

isolateStorage();

// Sums SqlStorageCursor.rowsWritten across every statement `fn` issues --
// the same instrument test/hibernation.test.ts uses for the per-event
// write cost, kept local rather than shared so neither file's fixture can
// reach into the other's.
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

const FOLLOWS_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, ALLOW_FOLLOWS: "true" } as unknown as Env;
const NO_FOLLOWS_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, ALLOW_FOLLOWS: "false" } as unknown as Env;

describe("ALLOW_FOLLOWS write gate", () => {
  it("a friend in the owner's stored kind-3 contact list may write once follows are refreshed", async () => {
    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: [["p", friend.pubkeyHex]],
    });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      // Stored directly via storeEvent rather than published over the
      // wire -- publishing would go through relay.ts's own handleEvent,
      // which (now that ALLOW_FOLLOWS is an opt-out, see
      // ownership.ts allowFollowsEnabled) immediately refreshes the
      // follow cache on an owner kind-3, defeating the point of this
      // test's explicit before/after refreshFollows assertions.
      storeEvent(state.storage.sql, contacts, Math.floor(Date.now() / 1000));

      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(false);

      refreshFollows(state.storage.sql, FOLLOWS_ENV);

      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(true);
    });
  });

  it("does not allow a follow's writes when ALLOW_FOLLOWS is off", async () => {
    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: [["p", friend.pubkeyHex]],
    });
    const conn = await connectRelay();
    await publish(conn, contacts);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      refreshFollows(state.storage.sql, NO_FOLLOWS_ENV);
      expect(isAllowedWriter(state.storage.sql, NO_FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(false);
    });
  });

  it("a stranger not in the follow list is still rejected", async () => {
    const stranger = randomKeypair().pubkeyHex;
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(isAllowedWriter(state.storage.sql, FOLLOWS_ENV, stranger).allowed).toBe(false);
    });
  });

  it("the owner can always write regardless of ALLOW_FOLLOWS", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(isAllowedWriter(state.storage.sql, NO_FOLLOWS_ENV, OWNER_PUBKEY_HEX).allowed).toBe(true);
    });
  });
});

describe("NIP-86 banpubkey/allowpubkey write gate (phase two)", () => {
  it("a banned pubkey is rejected even if it is also a follow, with reason 'banned'", async () => {
    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", friend.pubkeyHex]] });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      storeEvent(sql, contacts, now);
      refreshFollows(sql, FOLLOWS_ENV);
      expect(isAllowedWriter(sql, FOLLOWS_ENV, friend.pubkeyHex).allowed).toBe(true);

      // Also allowlisted -- the ban must still win, since banned_pubkeys
      // is checked before both the follows lookup and allowed_pubkeys.
      banPubkey(sql, friend.pubkeyHex, "no", now);
      allowPubkey(sql, friend.pubkeyHex, "yes", now);

      const auth = isAllowedWriter(sql, FOLLOWS_ENV, friend.pubkeyHex);
      expect(auth.allowed).toBe(false);
      expect(auth).toMatchObject({ reason: "banned" });
    });
  });

  it("writes nothing on a refresh that finds the same contact list", async () => {
    // The cron path is a FALLBACK -- relay.ts acceptEvent refreshes the
    // moment the owner publishes a kind-3 here -- so a tick that finds
    // nothing new is the normal case. It used to DELETE the table and
    // re-INSERT every row anyway: 900 rows written at 300 follows
    // (measured: 300 for the delete, 600 for the inserts), 21,600/day on
    // an hourly cron, against a 100,000/day ceiling.
    const follows = Array.from({ length: 50 }, () => randomKeypair().pubkeyHex);
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      tags: follows.map((pubkey) => ["p", pubkey]),
    });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, contacts, Math.floor(Date.now() / 1000));

      const build = measureRowsWritten(sql, (s) => refreshFollows(s, FOLLOWS_ENV));
      // 2 per follow to insert (the row and its primary key index),
      // nothing to delete on a cache that was empty, and 1 for the
      // maintained follow count (schema.ts `maintained_counts`) -- one row
      // against the hundred this rebuild already costs, and the reason
      // /api/stats no longer counts `follows` per request.
      expect(build).toBe(2 * follows.length + 1);

      const unchanged = measureRowsWritten(sql, (s) => refreshFollows(s, FOLLOWS_ENV));
      // Zero, counter included. This is the assertion that says the
      // counter write lives INSIDE the rebuild branch rather than at the
      // function's exit: parked at the exit it would fire on every cron
      // tick, turning a free no-op into 24 rows/day to restate a number
      // that had not changed.
      expect(unchanged).toBe(0);
      // And the cache it declined to rebuild is still the right one.
      expect(isAllowedWriter(sql, FOLLOWS_ENV, follows[0]!).allowed).toBe(true);
      expect(readMaintainedCounts(sql).follows).toBe(follows.length);
    });
  });

  it("maintains the follow count through every branch that writes the table", async () => {
    // `followCount` on /api/stats was a COUNT over `follows` behind a
    // six-hour cache; it is maintained here now, and removing that last
    // walked table is what let `stats_snapshot` be deleted outright.
    //
    // refreshFollows has exactly two branches that write, and both are
    // exercised: the rebuild, and the clear when the contact list is gone.
    // A counter that only tracked the first would drift the moment an
    // owner deleted their kind-3 -- and would report follows the write
    // gate no longer admits.
    const follows = Array.from({ length: 3 }, () => randomKeypair().pubkeyHex);
    const now = Math.floor(Date.now() / 1000);
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;

      // Nothing stored: the counter starts where the table does.
      refreshFollows(sql, FOLLOWS_ENV);
      expect(readMaintainedCounts(sql).follows).toBe(0);

      storeEvent(
        sql,
        signEvent(OWNER_SECRET_KEY_HEX, {
          kind: 3,
          tags: follows.map((pubkey) => ["p", pubkey]),
          created_at: now,
        }),
        now,
      );
      refreshFollows(sql, FOLLOWS_ENV);
      expect(readMaintainedCounts(sql).follows).toBe(3);

      // A newer, shorter list: the count follows it down as well as up.
      storeEvent(
        sql,
        signEvent(OWNER_SECRET_KEY_HEX, {
          kind: 3,
          tags: [["p", follows[0]!]],
          created_at: now + 10,
        }),
        now + 10,
      );
      refreshFollows(sql, FOLLOWS_ENV);
      expect(readMaintainedCounts(sql).follows).toBe(1);

      // The contact list is gone -- deleted, vanished, or never stored.
      // The clear branch is a write too, and the counter moves with it.
      sql.exec(`DELETE FROM events WHERE kind = 3`);
      refreshFollows(sql, FOLLOWS_ENV);
      expect(readMaintainedCounts(sql).follows).toBe(0);
      expect(
        sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM follows`).toArray()[0]?.n,
      ).toBe(0);
    });
  });

  it("rebuilds when the owner's contact list is replaced by a newer one", async () => {
    const first = randomKeypair().pubkeyHex;
    const second = randomKeypair().pubkeyHex;
    const now = Math.floor(Date.now() / 1000);

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", first]], created_at: now }), now);
      refreshFollows(sql, FOLLOWS_ENV);
      expect(isAllowedWriter(sql, FOLLOWS_ENV, first).allowed).toBe(true);

      storeEvent(
        sql,
        signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", second]], created_at: now + 1 }),
        now + 1,
      );
      const rebuild = measureRowsWritten(sql, (s) => refreshFollows(s, FOLLOWS_ENV));
      expect(rebuild).toBeGreaterThan(0);

      expect(isAllowedWriter(sql, FOLLOWS_ENV, second).allowed).toBe(true);
      expect(isAllowedWriter(sql, FOLLOWS_ENV, first).allowed).toBe(false);
    });
  });

  it("clears the cache once, not every tick, when the contact list is gone", async () => {
    // A kind-3 removed by NIP-09 or NIP-62 must empty the allowlist --
    // and then stop costing anything. The DELETE only runs while there is
    // something to delete.
    const friend = randomKeypair().pubkeyHex;
    const now = Math.floor(Date.now() / 1000);

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", friend]], created_at: now }), now);
      refreshFollows(sql, FOLLOWS_ENV);
      expect(isAllowedWriter(sql, FOLLOWS_ENV, friend).allowed).toBe(true);

      sql.exec(`DELETE FROM events WHERE kind = 3`);

      expect(measureRowsWritten(sql, (s) => refreshFollows(s, FOLLOWS_ENV))).toBeGreaterThan(0);
      expect(isAllowedWriter(sql, FOLLOWS_ENV, friend).allowed).toBe(false);
      expect(measureRowsWritten(sql, (s) => refreshFollows(s, FOLLOWS_ENV))).toBe(0);
    });
  });

  it("an explicitly allowlisted pubkey can write even with ALLOW_FOLLOWS off", async () => {
    const friend = randomKeypair().pubkeyHex;
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      expect(isAllowedWriter(sql, NO_FOLLOWS_ENV, friend).allowed).toBe(false);

      allowPubkey(sql, friend, "manual grant", Math.floor(Date.now() / 1000));
      expect(isAllowedWriter(sql, NO_FOLLOWS_ENV, friend).allowed).toBe(true);
    });
  });
});
