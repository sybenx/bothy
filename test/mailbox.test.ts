// The mailbox in bytes (limits.ts mailStorageBytes, mailBytesPerMember;
// storage.ts mail_usage, mailRoom): what a stored wrap is charged, the
// home's cap and each recipient's share, the per-key bound on reads, and
// mymailbox.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAIL_BYTES_PER_MEMBER_DEFAULT,
  MAIL_STORAGE_BYTES_DEFAULT,
  MAX_WRAPS_PER_AUTHOR,
  MEMBER_REMOVAL_GRACE_SECONDS,
} from "../src/limits";
import type { Relay } from "../src/relay";
import {
  HOME_MAILBOX_FULL_MESSAGE,
  RECIPIENT_MAILBOX_FULL_MESSAGE,
  WRAPS_PER_KEY_MESSAGE,
} from "../src/relay";
import { initSchema } from "../src/schema";
import { storeEvent, sweepExpiredGiftWraps, sweepFormerMembers, wrapBytes } from "../src/storage";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.MAIL_STORAGE_BYTES;
  delete mutableEnv.MAIL_BYTES_PER_MEMBER;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.22.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

function wrapFor(
  pubkey: string,
  size = 3000,
  signer = randomKeypair(),
  extraTags: string[][] = [],
): NostrEvent {
  return signEvent(signer.secretKeyHex, {
    kind: 1059,
    tags: [["p", pubkey], ...extraTags],
    content: "x".repeat(size),
  });
}

async function send(wrap: NostrEvent): Promise<[boolean, string]> {
  const conn = await connectRelay(freshIp());
  const [, , ok, message] = await publish(conn, wrap);
  conn.close();
  return [ok, message];
}

async function mailbox(who: Keypair) {
  const reply = await callManagement("mymailbox", [], { secretKeyHex: who.secretKeyHex, ip: freshIp() });
  return reply.result as {
    messages: number;
    usedBytes: number;
    limitBytes: number | null;
    homeUsedBytes: number;
    homeLimitBytes: number | null;
  };
}

describe("what a wrap is charged", () => {
  it("is its stored bytes, to its recipient and to the home, and is refunded when it goes", async () => {
    const alice = await member();
    const now = Math.floor(Date.now() / 1000);
    const wrap = wrapFor(alice.pubkeyHex, 2500, randomKeypair(), [["expiration", String(now + 2)]]);
    expect((await send(wrap))[0]).toBe(true);
    const charge = wrapBytes(wrap.content, JSON.stringify(wrap.tags));

    expect(await mailbox(alice)).toEqual({
      messages: 1,
      usedBytes: charge,
      limitBytes: MAIL_BYTES_PER_MEMBER_DEFAULT,
      homeUsedBytes: charge,
      homeLimitBytes: MAIL_STORAGE_BYTES_DEFAULT,
    });

    await runInDurableObject(stub(), (_i: Relay, state) => {
      sweepExpiredGiftWraps(state.storage.sql, now + 10, 100);
    });
    const after = await mailbox(alice);
    expect([after.messages, after.usedBytes, after.homeUsedBytes]).toEqual([0, 0, 0]);
  });

  it("is seeded from the wraps already stored on an upgrade", async () => {
    const alice = await member();
    await send(wrapFor(alice.pubkeyHex, 1000));
    await send(wrapFor(alice.pubkeyHex, 2000));
    const before = await mailbox(alice);
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      sql.exec(`DELETE FROM mail_usage`);
      sql.exec(`DELETE FROM schema_meta`);
      initSchema(sql);
    });
    expect(await mailbox(alice)).toEqual(before);
  });
});

describe("the caps", () => {
  it("refuses mail past a recipient's share, with a reason the sender's app can show", async () => {
    mutableEnv.MAIL_BYTES_PER_MEMBER = "7000";
    const alice = await member();
    const bob = await member();
    expect((await send(wrapFor(alice.pubkeyHex)))[0]).toBe(true);
    expect((await send(wrapFor(alice.pubkeyHex)))[0]).toBe(true);
    expect(await send(wrapFor(alice.pubkeyHex))).toEqual([false, RECIPIENT_MAILBOX_FULL_MESSAGE]);
    expect(RECIPIENT_MAILBOX_FULL_MESSAGE).toBe("blocked: the recipient's mailbox on this home is full");
    // Somebody else's mailbox is unaffected.
    expect((await send(wrapFor(bob.pubkeyHex)))[0]).toBe(true);
  });

  it("applies the share to the owner's mail too", async () => {
    mutableEnv.MAIL_BYTES_PER_MEMBER = "4000";
    expect((await send(wrapFor(OWNER_PUBKEY_HEX)))[0]).toBe(true);
    expect((await send(wrapFor(OWNER_PUBKEY_HEX)))[1]).toBe(RECIPIENT_MAILBOX_FULL_MESSAGE);
  });

  it("refuses mail past the home's total", async () => {
    mutableEnv.MAIL_STORAGE_BYTES = "7000";
    const alice = await member();
    const bob = await member();
    expect((await send(wrapFor(alice.pubkeyHex)))[0]).toBe(true);
    expect((await send(wrapFor(bob.pubkeyHex)))[0]).toBe(true);
    expect(await send(wrapFor(bob.pubkeyHex))).toEqual([false, HOME_MAILBOX_FULL_MESSAGE]);
    expect(HOME_MAILBOX_FULL_MESSAGE).toBe("blocked: this home's mailbox is full");
  });

  it("can be turned off", async () => {
    mutableEnv.MAIL_BYTES_PER_MEMBER = "off";
    mutableEnv.MAIL_STORAGE_BYTES = "off";
    const alice = await member();
    expect((await send(wrapFor(alice.pubkeyHex)))[0]).toBe(true);
    const box = await mailbox(alice);
    expect([box.limitBytes, box.homeLimitBytes]).toEqual([null, null]);
  });
});

describe(`at most ${MAX_WRAPS_PER_AUTHOR} wraps from one key`, () => {
  it("refuses one more from a key that has signed that many", async () => {
    const alice = await member();
    const reused = randomKeypair();
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < MAX_WRAPS_PER_AUTHOR; i++) {
        storeEvent(state.storage.sql, wrapFor(alice.pubkeyHex, 100 + i, reused), now);
      }
    });
    expect(await send(wrapFor(alice.pubkeyHex, 100, reused))).toEqual([false, WRAPS_PER_KEY_MESSAGE]);
    // A fresh key, as NIP-59 uses, is fine.
    expect((await send(wrapFor(alice.pubkeyHex, 100)))[0]).toBe(true);
  });
});

describe("mymailbox", () => {
  it("is refused to somebody who is not a member", async () => {
    const reply = await callManagement("mymailbox", [], { secretKeyHex: randomKeypair().secretKeyHex });
    expect(reply.status).toBe(401);
  });
});

describe("an erased account's leftover mail", () => {
  it("is swept at once, not after the grace period", async () => {
    const alice = await member();
    await callManagement("eraseme", [], { secretKeyHex: alice.secretKeyHex, ip: freshIp() });
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      // What the first batch would have left behind.
      storeEvent(sql, wrapFor(alice.pubkeyHex, 100), now);
      const result = sweepFormerMembers(sql, now, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100);
      expect(result.removed).toBe(1);
    });
  });
});

describe("the storage budget", () => {
  it("is 1GB by default, and every share follows it when the owner raises it", async () => {
    const { mailBytesPerMember, mailStorageBytes, nonOwnerStorageLimit, photoStorageBytes, storageBudget } =
      await import("../src/limits");
    const gib = 1024 * 1024 * 1024;
    const base = {} as Env;
    expect(storageBudget(base)).toBe(gib);
    expect(nonOwnerStorageLimit(base)).toBe(gib / 2);
    expect(mailStorageBytes(base)).toBe(Math.floor(gib * 0.3));
    expect(mailBytesPerMember(base)).toBe(Math.floor(Math.floor(gib * 0.3) / 10));
    expect(photoStorageBytes(base)).toBe(Math.floor(gib * 0.05));

    const paid = { STORAGE_BUDGET_BYTES: String(10 * gib) } as unknown as Env;
    expect(nonOwnerStorageLimit(paid)).toBe(5 * gib);
    expect(mailStorageBytes(paid)).toBe(Math.floor(10 * gib * 0.3));
    expect(photoStorageBytes(paid)).toBe(Math.floor(10 * gib * 0.05));
    // An explicit setting still wins over the share.
    expect(mailStorageBytes({ ...paid, MAIL_STORAGE_BYTES: "1000" } as unknown as Env)).toBe(1000);

    mutableEnv.STORAGE_BUDGET_BYTES = String(2 * gib);
    try {
      const { exports } = await import("cloudflare:workers");
      const stats = (await (
        await exports.default.fetch(new Request("https://example.com/api/stats"))
      ).json()) as {
        storageBytesLimit: number;
      };
      expect(stats.storageBytesLimit).toBe(2 * gib);
    } finally {
      delete mutableEnv.STORAGE_BUDGET_BYTES;
    }
  });
});
