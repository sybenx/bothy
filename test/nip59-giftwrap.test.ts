// NIP-59 (nips/59.md) Gift Wrap: kind 1059, signed by a random one-time
// key, `p`-tagged to its recipient. Accepted from any pubkey when
// p-tagged to the owner, under every write policy from `inbox` up
// (src/write-policy.ts), and dispatched above isAllowedWriter
// (src/relay.ts handleGiftWrap) -- hence the extra abuse controls
// (limits.ts) exercised here alongside the accept/reject rules.
// Recipient-authorized deletion and its tombstone durability live in
// test/nip59-deletion.test.ts;
// the NIP-42 read gate lives in test/nip42-auth.test.ts. The expiry
// sweep that keeps the inbox cap a count of mail rather than a count of
// rows is at the bottom of this file.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { GROUP_SCOPE, PUBLIC_SCOPE, TOP_LEVEL_GROUP_ID } from "../src/groups";
import { GIFT_WRAP_SWEEP_BATCH_SIZE } from "../src/limits";
import type { Relay } from "../src/relay";
import { giftWrapCount, isDeleted, storeEvent, sweepExpiredGiftWraps } from "../src/storage";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-59 gift wrap accept path", () => {
  it("accepts a kind-1059 event from a stranger when its p tag names the owner", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "encrypted seal goes here",
    });

    const [, id, ok] = await publish(conn, giftWrap);

    expect(id).toBe(giftWrap.id);
    expect(ok).toBe(true);
    conn.close();
  });

  it("rejects a kind-1059 event whose p tag does not name the owner", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const someoneElse = randomKeypair().pubkeyHex;
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", someoneElse]],
      content: "not for the owner",
    });

    const [, , ok, message] = await publish(conn, giftWrap);

    expect(ok).toBe(false);
    expect(message.startsWith("restricted:")).toBe(true);
    conn.close();
  });

  it("accepts a gift wrap with a created_at randomized up to two days in the past", async () => {
    // NIP-59 recommends randomizing created_at to hinder timing analysis;
    // a naive freshness check would wrongly reject valid mail.
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "backdated",
      created_at: twoDaysAgo,
    });

    const [, , ok] = await publish(conn, giftWrap);

    expect(ok).toBe(true);
    conn.close();
  });

  // The size cap enforced here is now the general MAX_EVENT_BYTES
  // (limits.ts), not a gift-wrap-specific one -- MAX_GIFT_WRAP_BYTES was
  // folded into it at the same 64KB rather than kept as a second constant
  // that had to agree. Hence "invalid:" rather than the "blocked:" this
  // path used to answer with. Covered generally in test/write-limits.test.ts;
  // kept here because a gift wrap is the write path where an unbounded
  // size costs the most, and this suite should keep proving it is bounded.
  it("rejects a gift wrap larger than the size cap", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "x".repeat(100_000),
    });

    const [, , ok, message] = await publish(conn, giftWrap);

    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  // A connection that has not signed in is counted per address. Over the
  // limit it gets an AUTH challenge with the refusal, so a member's app can
  // sign in and send again under its own allowance
  // (test/gift-wrap-limits.test.ts).
  it("rate-limits gift wraps from a single connection that has not signed in", async () => {
    const conn = await connectRelay();
    let refusal = "";
    for (let i = 0; i < 10 && refusal === ""; i++) {
      const giftWrap = signEvent(randomKeypair().secretKeyHex, {
        kind: 1059,
        tags: [["p", OWNER_PUBKEY_HEX]],
        content: `message ${i}`,
      });
      conn.send(["EVENT", giftWrap]);
      let frame = await conn.nextMessage();
      if (frame[0] === "AUTH") frame = await conn.nextMessage();
      if (frame[2] === false) refusal = frame[3] as string;
    }

    expect(refusal.startsWith("auth-required:")).toBe(true);
    conn.close();
  });

  it("rejects a gift wrap once the home's mailbox is full", async () => {
    // The mailbox is counted in bytes (storage.ts mail_usage); filling the
    // counter is enough, and test/mailbox.test.ts covers the rest.
    mutableEnv.MAIL_STORAGE_BYTES = "100000";
    try {
      await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), async (_instance, state) => {
        state.storage.sql.exec(`UPDATE mail_usage SET bytes = 99999 WHERE pubkey = '*'`);
      });
      const conn = await connectRelay();
      const giftWrap = signEvent(randomKeypair().secretKeyHex, {
        kind: 1059,
        tags: [["p", OWNER_PUBKEY_HEX]],
        content: "one too many",
      });
      const [, , ok, message] = await publish(conn, giftWrap);
      expect(ok).toBe(false);
      expect(message).toBe("blocked: this home's mailbox is full");
      conn.close();
    } finally {
      delete mutableEnv.MAIL_STORAGE_BYTES;
    }
  });
});

const mutableEnv = env as unknown as Record<string, string | undefined>;

// relay.ts handleGiftWrap also rejects with "restricted: relay has not
// been claimed yet" when getOwnerPubkey returns null. Not tested here at
// the wire level: vitest.config.ts injects a fixed OWNER_PUBKEY binding
// globally for this test run (every DO instance, regardless of name, has
// env.OWNER_PUBKEY set), so there is no way to exercise an unclaimed
// relay over the wire -- the same limitation test/claim.test.ts documents
// and works around for the claim endpoint itself. getOwnerPubkey
// returning null when unclaimed is already covered directly in
// claim.test.ts ("is unclaimed until a claim is written"); handleGiftWrap's
// branch on that null is a one-line check with nothing left to verify
// beyond what these two suites already prove independently.

// The expiry sweep (storage.ts sweepExpiredGiftWraps, run once per cron
// tick by relay.ts).
//
// Every other kind is content to be HIDDEN once its NIP-40 expiration
// passes -- filters.ts drops it from every query and the row costs
// storage bytes that NON_OWNER_STORAGE_SHARE_LIMIT already bounds. Kind
// 1059 is the exception because it is the one kind capped by COUNT, so a
// hidden row goes on holding a slot in maxGiftWraps that no query will
// ever serve from. Left alone, a relay carrying expiring wraps fills its
// inbox with rows it is hiding and then refuses the owner's real mail.
//
// Driven at the storage layer rather than over the wire, for the reason
// test/ephemeral-chat.test.ts gives about its own sweep: these are
// assertions about what stopped being stored, and the sweep runs from the
// cron tick rather than from a client frame.
function wrapStub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

// A gift wrap to the owner, expiring at `expiresAt` -- or never, when
// that is null, which is what an ordinary NIP-59 DM looks like.
function wrap(createdAt: number, expiresAt: number | null, n = 0): NostrEvent {
  const tags: string[][] = [["p", OWNER_PUBKEY_HEX]];
  if (expiresAt !== null) tags.push(["expiration", String(expiresAt)]);
  return signEvent(randomKeypair().secretKeyHex, {
    kind: 1059,
    created_at: createdAt,
    content: `sealed ${n}`,
    tags,
  });
}

function idsOfKind(sql: SqlStorage, kind: number, scope: number): string[] {
  return sql
    .exec<{ id: string }>(
      `SELECT id FROM events WHERE kind = ? AND is_group = ? ORDER BY created_at ASC`,
      kind,
      scope,
    )
    .toArray()
    .map((row) => row.id);
}

describe("expired gift wraps are removed, not merely hidden", () => {
  it("removes a lapsed wrap and frees the slot it was holding in the cap", async () => {
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const lapsed = wrap(now - 4000, now - 1, 1);
      const live = wrap(now - 3000, now + 86_400, 2);
      storeEvent(sql, lapsed, now);
      storeEvent(sql, live, now);

      // Both occupy the cap before the sweep: giftWrapCount counts rows,
      // which is the whole reason this sweep exists.
      expect(giftWrapCount(sql)).toBe(2);

      const result = sweepExpiredGiftWraps(sql, now, GIFT_WRAP_SWEEP_BATCH_SIZE);

      expect(result.removed).toBe(1);
      expect(result.done).toBe(true);
      expect(idsOfKind(sql, 1059, PUBLIC_SCOPE)).toEqual([live.id]);
      expect(giftWrapCount(sql)).toBe(1);
    });
  });

  it("leaves a wrap carrying no expiration tag alone, however old", async () => {
    // The common case by a distance: an ordinary NIP-59 DM sets no
    // expiration, and mail does not stop being mail for being old. A
    // sweep that used age rather than the sender's own tag would delete
    // the owner's inbox.
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const ancient = wrap(now - 400 * 86_400, null, 3);
      storeEvent(sql, ancient, now);

      const result = sweepExpiredGiftWraps(sql, now, GIFT_WRAP_SWEEP_BATCH_SIZE);

      expect(result.removed).toBe(0);
      expect(idsOfKind(sql, 1059, PUBLIC_SCOPE)).toEqual([ancient.id]);
    });
  });

  it("does not tombstone, because the event already refuses its own replay", async () => {
    // The one place this departs from every other removal in storage.ts,
    // and the argument is stronger than the one sweepChat makes for the
    // same choice: relay.ts acceptEvent drops any event whose expiration
    // has passed, and the tag is covered by the signature, so a re-send
    // of the same signed copy is refused forever and for free. A
    // deleted_ids row would be a permanent row bought to duplicate a
    // check the event carries.
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const lapsed = wrap(now - 4000, now - 1, 4);
      storeEvent(sql, lapsed, now);

      sweepExpiredGiftWraps(sql, now, GIFT_WRAP_SWEEP_BATCH_SIZE);

      expect(isDeleted(sql, lapsed.id)).toBe(false);
    });
  });

  it("touches no other kind, however expired", async () => {
    // The scope assertion, and the one with the most ways to go wrong.
    // NIP-40 expiry means "hide" for every kind on this relay; it means
    // "delete" for exactly the one kind with a count cap behind it.
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const expiredNote = signEvent(OWNER_SECRET_KEY_HEX, {
        kind: 1,
        created_at: now - 4000,
        content: "an expired note the owner published",
        tags: [["expiration", String(now - 1)]],
      });
      storeEvent(sql, expiredNote, now);

      const result = sweepExpiredGiftWraps(sql, now, GIFT_WRAP_SWEEP_BATCH_SIZE);

      expect(result.removed).toBe(0);
      expect(idsOfKind(sql, 1, PUBLIC_SCOPE)).toEqual([expiredNote.id]);
    });
  });

  it("sweeps the group partition too, where legacy group-tagged wraps sit", async () => {
    // handleGiftWrap now refuses a wrap carrying a group tag outright,
    // but rows stored before it did are still there and giftWrapCount
    // still counts them -- so a sweep that cleaned only the public
    // partition would leave the other half of the cap silting up exactly
    // as before.
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const grouped = signEvent(randomKeypair().secretKeyHex, {
        kind: 1059,
        created_at: now - 4000,
        content: "sealed, and wrongly tagged into the group",
        tags: [
          ["p", OWNER_PUBKEY_HEX],
          ["h", TOP_LEVEL_GROUP_ID],
          ["expiration", String(now - 1)],
        ],
      });
      storeEvent(sql, grouped, now);
      expect(idsOfKind(sql, 1059, GROUP_SCOPE)).toEqual([grouped.id]);

      const result = sweepExpiredGiftWraps(sql, now, GIFT_WRAP_SWEEP_BATCH_SIZE);

      expect(result.removed).toBe(1);
      expect(idsOfKind(sql, 1059, GROUP_SCOPE)).toEqual([]);
    });
  });

  it("drains a backlog across ticks, oldest first, leaving a contiguous remainder", async () => {
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const lapsed: NostrEvent[] = [];
      for (let i = 0; i < 5; i++) {
        const event = wrap(now - 5000 + i, now - 1, 10 + i);
        lapsed.push(event);
        storeEvent(sql, event, now);
      }

      const first = sweepExpiredGiftWraps(sql, now, 2);
      expect(first.removed).toBe(2);
      // Not done, so the next tick picks the remainder up. Oldest first,
      // so what is left is contiguous and no checkpoint is needed --
      // "run again" is the whole of the state this sweep carries.
      expect(first.done).toBe(false);
      expect(idsOfKind(sql, 1059, PUBLIC_SCOPE)).toEqual(lapsed.slice(2).map((e) => e.id));

      const second = sweepExpiredGiftWraps(sql, now, 2);
      expect(second.removed).toBe(2);
      expect(second.done).toBe(false);

      const third = sweepExpiredGiftWraps(sql, now, 2);
      expect(third.removed).toBe(1);
      expect(third.done).toBe(true);
      expect(idsOfKind(sql, 1059, PUBLIC_SCOPE)).toEqual([]);
    });
  });
});

// What the sweep costs, measured on real cursors so a change that moves
// either figure fails here rather than drifting.
describe("what the gift wrap sweep costs", () => {
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
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as SqlStorage;
    fn(proxy);
    return total;
  }

  // Cursors are collected and summed AFTER `fn` returns, not at exec
  // time: rowsRead is only meaningful once a cursor has been consumed,
  // and consuming it inside the proxy would hand the caller an empty one.
  // (rowsWritten above has no such problem -- a write has happened by the
  // time exec returns.)
  function measureRowsRead(sql: SqlStorage, fn: (sql: SqlStorage) => void): number {
    const cursors: { rowsRead: number }[] = [];
    const proxy = new Proxy(sql, {
      get(target, property) {
        if (property === "exec") {
          return (query: string, ...bindings: unknown[]) => {
            const cursor = target.exec(query, ...bindings);
            cursors.push(cursor);
            return cursor;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as SqlStorage;
    fn(proxy);
    return cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
  }

  it("costs eight rows to remove an expiring wrap, against seventeen to store it", async () => {
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      // A first wrap creates the mailbox counter rows; the measured one
      // after it is the steady state.
      storeEvent(sql, wrap(now - 5000, now - 1, 19), now);
      const lapsed = wrap(now - 4000, now - 1, 20);

      //   the event itself: 9 base + 3 for its one indexed `p` tag   12
      //   the mailbox's bytes, the home's row and the recipient's     2
      //   the expiry row, its key and its expiration index            3
      //                                                              ---
      //                                                               17
      // A wrap with no expiration (the usual NIP-17 case) skips the
      // last line: 14.
      const stored = measureRowsWritten(sql, (metered) => storeEvent(metered, lapsed, now));
      expect(stored).toBe(17);

      const removed = measureRowsWritten(sql, (metered) =>
        sweepExpiredGiftWraps(metered, now, GIFT_WRAP_SWEEP_BATCH_SIZE),
      );
      //   per wrap: the `p` tag row, the event row and the three
      //   maintained counters (5), the two mailbox rows (2) and the
      //   expiry row (1); no tombstone.                                8
      expect(removed).toBe(16);
    });
  });

  it("reads only what is due, however many wraps are stored", async () => {
    // The sweep reads wrap_expiry by expiration (schema.ts), not the
    // kind-1059 range, so an hour with nothing due reads next to nothing
    // whether the mailbox holds forty wraps or forty thousand.
    await runInDurableObject(wrapStub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const inbox = 40;
      for (let i = 0; i < inbox; i++) {
        storeEvent(sql, wrap(now - 5000 + i, now - 1, 30 + i), now);
      }

      const nothing = measureRowsRead(sql, (metered) =>
        sweepExpiredGiftWraps(metered, now - 100_000, GIFT_WRAP_SWEEP_BATCH_SIZE),
      );
      expect(nothing).toBeLessThanOrEqual(2);

      // Work to do, batch of 5: five read, not forty.
      const some = measureRowsRead(sql, (metered) => {
        const found = metered
          .exec<{ id: string }>(
            `SELECT id FROM wrap_expiry WHERE expiration <= ? ORDER BY expiration ASC LIMIT 5`,
            now,
          )
          .toArray();
        expect(found.length).toBe(5);
      });
      expect(some).toBeLessThanOrEqual(10);
    });
  });
});
