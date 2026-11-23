// History backup's server half: a member's `backedup` watermark
// (nip86.ts backedup, storage.ts recordBackedUp), the owner's mailbox
// retention switch (setretention, getretention), and the hourly sweep that
// deletes old, backed-up mail (storage.ts sweepRetention, relay.ts
// sweepRetainedMail). The design is dms docs/next-round/history-backup.md
// section 9; its test table rows 11 and 18 are the acceptance list here.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MAIL_RETENTION_SECONDS,
  MEMBER_REMOVAL_GRACE_SECONDS,
  RETENTION_PAUSE_AT_ROWS_WRITTEN,
  RETENTION_SWEEP_BATCH_SIZE,
} from "../src/limits";
import {
  BACKEDUP_PARAM_MESSAGE,
  NOT_A_MEMBER_REASON,
  RETENTION_NEEDS_STORAGE_MESSAGE,
  SETRETENTION_PARAM_MESSAGE,
} from "../src/nip86";
import type { Relay } from "../src/relay";
import { hourBucket, storeEvent, sweepFormerMembers, sweepRetention } from "../src/storage";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const DAY = 86400;
const STORAGE_URL = "https://storage.example/";

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.27.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function as(who: Keypair, method: string, params: unknown[] = []) {
  return callManagement(method, params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

async function connectStorage(): Promise<void> {
  expect((await callManagement("setstorage", [STORAGE_URL, randomKeypair().pubkeyHex])).result).toBe(true);
}

async function rows<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(stub(), (_i: Relay, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
}

// A gift wrap to `recipients`, stored as if it arrived at `storedAt`. Its
// own created_at is a little earlier, as NIP-59 randomizes it into the past.
async function storedWrap(storedAt: number, ...recipients: string[]): Promise<NostrEvent> {
  const wrap = signEvent(randomKeypair().secretKeyHex, {
    kind: 1059,
    created_at: storedAt - 3600,
    tags: recipients.map((p) => ["p", p]),
    content: "sealed",
  });
  await runInDurableObject(stub(), (_i: Relay, state) => {
    expect(storeEvent(state.storage.sql, wrap, storedAt).stored).not.toBeNull();
  });
  return wrap;
}

async function stillStored(wrap: NostrEvent): Promise<boolean> {
  return (await rows(`SELECT id FROM events WHERE id = ?`, wrap.id)).length === 1;
}

async function sweep(now = nowSec(), limit = RETENTION_SWEEP_BATCH_SIZE) {
  return runInDurableObject(stub(), (_i: Relay, state) => sweepRetention(state.storage.sql, now, OWNER_PUBKEY_HEX, limit));
}

async function watermark(pubkey: string): Promise<number | null> {
  const found = await rows<{ mail_through: number }>(
    `SELECT mail_through FROM backup_watermarks WHERE pubkey = ?`,
    pubkey,
  );
  return found[0]?.mail_through ?? null;
}

describe("backedup", () => {
  it("stores the member's watermark, moves it forward only, and answers what is stored", async () => {
    const alice = await member();
    const t = nowSec() - 40 * DAY;
    expect(await as(alice, "backedup", [t])).toMatchObject({ status: 200, result: { watermark: t } });
    // Lower: kept where it was.
    expect((await as(alice, "backedup", [t - DAY])).result).toEqual({ watermark: t });
    expect((await as(alice, "backedup", [t + DAY])).result).toEqual({ watermark: t + DAY });
    expect(await watermark(alice.pubkeyHex)).toBe(t + DAY);
  });

  it("never stores a time later than the call", async () => {
    const alice = await member();
    const before = nowSec();
    const reply = await as(alice, "backedup", [before + 365 * DAY]);
    const stored = (reply.result as { watermark: number }).watermark;
    expect(stored).toBeGreaterThanOrEqual(before);
    expect(stored).toBeLessThanOrEqual(nowSec());
  });

  it("is for members, admins and the owner, and refuses anyone else with the stable 401", async () => {
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    expect((await as(admin, "backedup", [1000])).result).toEqual({ watermark: 1000 });
    expect((await callManagement("backedup", [1000])).result).toEqual({ watermark: 1000 });

    const stranger = await as(randomKeypair(), "backedup", [1000]);
    expect(stranger.status).toBe(401);
    expect(stranger.error).toBe(NOT_A_MEMBER_REASON);

    const removed = await member();
    await callManagement("unallowpubkey", [removed.pubkeyHex]);
    expect((await as(removed, "backedup", [1000])).error).toBe(NOT_A_MEMBER_REASON);
  });

  it("refuses anything but whole, non-negative unix seconds", async () => {
    const alice = await member();
    for (const params of [[], ["1700000000"], [-1], [1.5], [null], [Number.MAX_SAFE_INTEGER + 2]]) {
      const reply = await as(alice, "backedup", params);
      expect(reply.error).toBe(BACKEDUP_PARAM_MESSAGE);
      expect(reply.error!.startsWith("backedup:")).toBe(true);
    }
    expect(await watermark(alice.pubkeyHex)).toBeNull();
  });

  it("is dropped by eraseme", async () => {
    const alice = await member();
    await as(alice, "backedup", [1000]);
    expect((await as(alice, "eraseme")).result).toMatchObject({ erased: true });
    expect(await watermark(alice.pubkeyHex)).toBeNull();
  });

  it("is kept through a removal's grace and a let back in, and dropped when the grace sweep finishes them", async () => {
    const alice = await member();
    await as(alice, "backedup", [1000]);
    await callManagement("unallowpubkey", [alice.pubkeyHex]);
    expect(await watermark(alice.pubkeyHex)).toBe(1000);
    await callManagement("allowpubkey", [alice.pubkeyHex]);
    expect(await watermark(alice.pubkeyHex)).toBe(1000);

    await callManagement("unallowpubkey", [alice.pubkeyHex]);
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const later = nowSec() + MEMBER_REMOVAL_GRACE_SECONDS + 1;
      expect(sweepFormerMembers(state.storage.sql, later, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100).finished).toBe(1);
    });
    expect(await watermark(alice.pubkeyHex)).toBeNull();
  });

  it("is listed in supportedmethods and announced in NIP-11", async () => {
    const methods = (await callManagement("supportedmethods")).result as string[];
    expect(methods).toEqual(expect.arrayContaining(["backedup", "setretention", "getretention"]));
    const response = await exports.default.fetch(
      new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
    );
    expect(((await response.json()) as Record<string, unknown>).backup).toEqual({ v: 1 });
  });
});

describe("setretention and getretention", () => {
  it("is off by default, and refuses to turn on without a file server, saying why", async () => {
    expect((await callManagement("getretention")).result).toEqual({
      on: false,
      storage: false,
      backedUp: 0,
      days: MAIL_RETENTION_SECONDS / DAY,
    });
    const refused = await callManagement("setretention", [true]);
    expect(refused.error).toBe(RETENTION_NEEDS_STORAGE_MESSAGE);
    expect(refused.result).toBeUndefined();
    expect(((await callManagement("getretention")).result as { on: boolean }).on).toBe(false);
    // Turning it off needs nothing.
    expect((await callManagement("setretention", [false])).result).toBe(true);
  });

  it("turns on with a file server, counts members with a backup, and turns off again", async () => {
    await connectStorage();
    const alice = await member();
    await member();
    await as(alice, "backedup", [1000]);
    // The owner's own watermark is stored but not counted.
    await callManagement("backedup", [1000]);
    expect((await callManagement("setretention", [true])).result).toBe(true);
    expect((await callManagement("getretention")).result).toEqual({ on: true, storage: true, backedUp: 1, days: 30 });
    expect((await callManagement("setretention", [false])).result).toBe(true);
    expect(((await callManagement("getretention")).result as { on: boolean }).on).toBe(false);
  });

  it("stays on but reports no file server once the server is cleared", async () => {
    await connectStorage();
    await callManagement("setretention", [true]);
    await callManagement("setstorage", [""]);
    expect((await callManagement("getretention")).result).toMatchObject({ on: true, storage: false });
  });

  it("refuses a parameter that is not true or false", async () => {
    for (const params of [[], ["on"], [1]]) {
      expect((await callManagement("setretention", params)).error).toBe(SETRETENTION_PARAM_MESSAGE);
    }
  });

  it("is the owner's alone", async () => {
    await connectStorage();
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    for (const who of [admin, await member()]) {
      expect((await as(who, "setretention", [true])).status).toBe(401);
      expect((await as(who, "getretention")).status).toBe(401);
    }
  });
});

describe("the retention sweep", () => {
  async function retentionOn(): Promise<void> {
    await connectStorage();
    expect((await callManagement("setretention", [true])).result).toBe(true);
  }

  it("deletes mail older than 30 days and under the watermark, and keeps the rest", async () => {
    await retentionOn();
    const now = nowSec();
    const alice = await member();
    const bob = await member();
    // Alice's backup holds everything stored up to 35 days ago.
    await as(alice, "backedup", [now - 35 * DAY]);
    await callManagement("backedup", [now]);

    const due = await storedWrap(now - 40 * DAY, alice.pubkeyHex);
    const atMark = await storedWrap(now - 35 * DAY, alice.pubkeyHex);
    const aboveMark = await storedWrap(now - 32 * DAY, alice.pubkeyHex);
    const noBackup = await storedWrap(now - 40 * DAY, bob.pubkeyHex);
    const owners = await storedWrap(now - 40 * DAY, OWNER_PUBKEY_HEX);

    expect(await sweep(now)).toEqual({ removed: 2, done: true });
    expect(await stillStored(due)).toBe(false);
    expect(await stillStored(atMark)).toBe(false);
    expect(await stillStored(aboveMark)).toBe(true);
    expect(await stillStored(noBackup)).toBe(true);
    expect(await stillStored(owners)).toBe(true);
  });

  it("keeps mail newer than 30 days, however far the watermark has gone", async () => {
    await retentionOn();
    const now = nowSec();
    const alice = await member();
    await as(alice, "backedup", [now]);
    const recent = await storedWrap(now - 29 * DAY, alice.pubkeyHex);
    const edge = await storedWrap(now - MAIL_RETENTION_SECONDS, alice.pubkeyHex);
    const old = await storedWrap(now - MAIL_RETENTION_SECONDS - 1, alice.pubkeyHex);
    expect((await sweep(now)).removed).toBe(1);
    expect(await stillStored(recent)).toBe(true);
    expect(await stillStored(edge)).toBe(true);
    expect(await stillStored(old)).toBe(false);
  });

  it("lowers the member's and the home's mailbox counts as it deletes", async () => {
    await retentionOn();
    const now = nowSec();
    const alice = await member();
    await as(alice, "backedup", [now]);
    await storedWrap(now - 40 * DAY, alice.pubkeyHex);
    await storedWrap(now - 40 * DAY, alice.pubkeyHex);
    await storedWrap(now - DAY, alice.pubkeyHex);
    const before = (await as(alice, "mymailbox")).result as { messages: number; usedBytes: number; homeUsedBytes: number };
    expect(before.messages).toBe(3);
    expect((await sweep(now)).removed).toBe(2);
    const after = (await as(alice, "mymailbox")).result as { messages: number; usedBytes: number; homeUsedBytes: number };
    expect(after.messages).toBe(1);
    expect(after.usedBytes).toBe(before.usedBytes / 3);
    expect(after.homeUsedBytes).toBe(before.homeUsedBytes - (before.usedBytes * 2) / 3);
  });

  it("does nothing while retention is off", async () => {
    await connectStorage();
    const now = nowSec();
    const alice = await member();
    await as(alice, "backedup", [now]);
    const old = await storedWrap(now - 40 * DAY, alice.pubkeyHex);
    expect(await sweep(now)).toEqual({ removed: 0, done: true });
    expect(await stillStored(old)).toBe(true);
  });

  it("does nothing once the file server is cleared, though the switch stays on", async () => {
    await retentionOn();
    await callManagement("setstorage", [""]);
    const now = nowSec();
    const alice = await member();
    await as(alice, "backedup", [now]);
    const old = await storedWrap(now - 40 * DAY, alice.pubkeyHex);
    expect(await sweep(now)).toEqual({ removed: 0, done: true });
    expect(await stillStored(old)).toBe(true);
    // Connecting one again lets it act.
    await connectStorage();
    expect((await sweep(now)).removed).toBe(1);
  });

  it("deletes a wrap to several people only when every one of them has backed it up", async () => {
    await retentionOn();
    const now = nowSec();
    const [alice, bob, carol, dave] = [await member(), await member(), await member(), await member()];
    await as(alice, "backedup", [now]);
    await as(bob, "backedup", [now]);
    await as(dave, "backedup", [now]);
    await callManagement("backedup", [now]);
    // Dave is removed: in his grace, retention leaves his mail alone.
    await callManagement("unallowpubkey", [dave.pubkeyHex]);

    const bothBackedUp = await storedWrap(now - 40 * DAY, alice.pubkeyHex, bob.pubkeyHex);
    const oneWithout = await storedWrap(now - 40 * DAY, alice.pubkeyHex, carol.pubkeyHex);
    const withOwner = await storedWrap(now - 40 * DAY, alice.pubkeyHex, OWNER_PUBKEY_HEX);
    const withRemoved = await storedWrap(now - 40 * DAY, alice.pubkeyHex, dave.pubkeyHex);
    const withStranger = await storedWrap(now - 40 * DAY, alice.pubkeyHex, randomKeypair().pubkeyHex);
    const onlyRemoved = await storedWrap(now - 40 * DAY, dave.pubkeyHex);

    expect((await sweep(now)).removed).toBe(1);
    expect(await stillStored(bothBackedUp)).toBe(false);
    for (const kept of [oneWithout, withOwner, withRemoved, withStranger, onlyRemoved]) {
      expect(await stillStored(kept)).toBe(true);
    }
  });

  it("stops at its cap and says more is due", async () => {
    await retentionOn();
    const now = nowSec();
    const alice = await member();
    await as(alice, "backedup", [now]);
    for (let i = 0; i < 3; i++) await storedWrap(now - 40 * DAY - i, alice.pubkeyHex);
    expect(await sweep(now, 2)).toEqual({ removed: 2, done: false });
    expect(await sweep(now, 2)).toEqual({ removed: 1, done: true });
  });

  it("reads only what is due, not the rest of a member's mailbox", async () => {
    await retentionOn();
    const now = nowSec();
    const alice = await member();
    await as(alice, "backedup", [now]);
    for (let i = 0; i < 40; i++) await storedWrap(now - i * 3600, alice.pubkeyHex);
    await storedWrap(now - 40 * DAY, alice.pubkeyHex);
    const read = await runInDurableObject(stub(), (_i: Relay, state) => {
      const cursors: { rowsRead: number }[] = [];
      const sql = new Proxy(state.storage.sql, {
        get(target, property) {
          if (property === "exec") {
            return (query: string, ...bindings: unknown[]) => {
              const cursor = target.exec(query, ...bindings);
              cursors.push(cursor);
              return cursor;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }) as SqlStorage;
      expect(sweepRetention(sql, now, OWNER_PUBKEY_HEX, RETENTION_SWEEP_BATCH_SIZE).removed).toBe(1);
      return cursors.reduce((total, cursor) => total + cursor.rowsRead, 0);
    });
    // The 40 recent wraps would cost at least 80 rows if the range read them.
    expect(read).toBeLessThan(40);
  });

  it("runs on the hourly tick, and waits while the day's writes are half spent", async () => {
    await retentionOn();
    const now = nowSec();
    const alice = await member();
    await as(alice, "backedup", [now]);
    const first = await storedWrap(now - 40 * DAY, alice.pubkeyHex);
    const second = await storedWrap(now - 41 * DAY, alice.pubkeyHex);

    // A busy day: half the allowance already written this hour.
    await runInDurableObject(stub(), (_i: Relay, state) => {
      state.storage.sql.exec(
        `INSERT INTO ingest_hour_counts (hour, n, group_n, rows_written) VALUES (?, 0, 0, ?)
           ON CONFLICT(hour) DO UPDATE SET rows_written = rows_written + excluded.rows_written`,
        hourBucket(nowSec()),
        RETENTION_PAUSE_AT_ROWS_WRITTEN,
      );
    });
    await runInDurableObject(stub(), (instance: Relay) => instance.runCron());
    expect(await stillStored(first)).toBe(true);
    expect(await stillStored(second)).toBe(true);

    await runInDurableObject(stub(), (_i: Relay, state) => {
      state.storage.sql.exec(`UPDATE ingest_hour_counts SET rows_written = 0 WHERE hour = ?`, hourBucket(nowSec()));
    });
    await runInDurableObject(stub(), (instance: Relay) => instance.runCron());
    expect(await stillStored(first)).toBe(false);
    expect(await stillStored(second)).toBe(false);
  });
});
