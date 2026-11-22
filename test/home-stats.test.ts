// Home activity (nip86.ts homestats): counts for the owner and admins of how
// the home is used, and nothing per person. Never on /api/stats, which is
// public.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HOME_STATS_DAYS, HOME_STATS_WEEKS } from "../src/limits";
import type { Relay } from "../src/relay";
import { pruneHomeStats, utcDay } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
const mutableEnv = env as unknown as Record<string, unknown>;
beforeEach(() => {
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
});
afterEach(() => {
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.27.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

type Stats = {
  members: number;
  activeMembers: { last1Day: number; last7Days: number; last30Days: number };
  messagesPerDay: { day: string; count: number }[];
  weeks: { from: string; newMembers: number; invitesUsed: number }[];
  pushSubscribers: number;
  photoBytes: number;
  photoStorageLimit: number | null;
};

async function homestats(): Promise<Stats> {
  const reply = await callManagement("homestats");
  expect(reply.error).toBeUndefined();
  return reply.result as Stats;
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

async function authenticate(conn: RelayConn, secretKeyHex: string): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage();
  conn.send([
    "AUTH",
    signEvent(secretKeyHex, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", challenge as string],
      ],
    }),
  ]);
  const [, , ok] = await conn.nextMessage();
  expect(ok).toBe(true);
}

async function signIn(secretKeyHex: string): Promise<void> {
  const conn = await connectRelay(freshIp());
  await authenticate(conn, secretKeyHex);
  conn.close();
}

async function mailTo(pubkey: string): Promise<boolean> {
  const conn = await connectRelay(freshIp());
  const [, , ok] = await publish(
    conn,
    signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", pubkey]], content: "sealed" }),
  );
  conn.close();
  return ok;
}

function setSeen(pubkey: string, daysAgo: number) {
  return runInDurableObject(stub(), (_i: Relay, state) => {
    state.storage.sql.exec(
      `UPDATE member_seen SET day = ? WHERE pubkey = ?`,
      utcDay(Math.floor(Date.now() / 1000)) - daysAgo,
      pubkey,
    );
  });
}

describe("who may see it", () => {
  it("is the owner and admins, and nobody else", async () => {
    await homestats();
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    expect(
      (await callManagement("homestats", [], { secretKeyHex: admin.secretKeyHex })).result,
    ).toBeDefined();
    for (const who of [await member(), randomKeypair()]) {
      expect((await callManagement("homestats", [], { secretKeyHex: who.secretKeyHex })).status).toBe(401);
    }
  });

  it("is not on the public /api/stats", async () => {
    const stats = (await (
      await exports.default.fetch(new Request("https://example.com/api/stats"))
    ).json()) as Record<string, unknown>;
    for (const field of ["activeMembers", "messagesPerDay", "weeks", "pushSubscribers"]) {
      expect(stats).not.toHaveProperty(field);
    }
  });

  it("names nobody", async () => {
    const alice = await member();
    await signIn(alice.secretKeyHex);
    await mailTo(alice.pubkeyHex);
    const text = JSON.stringify(await homestats());
    expect(text).not.toContain(alice.pubkeyHex);
    expect(text).not.toContain(OWNER_PUBKEY_HEX);
  });
});

describe("active members", () => {
  it("counts members who signed in, by the last day each was seen", async () => {
    const alice = await member();
    const bob = await member();
    const carol = await member();
    await signIn(alice.secretKeyHex);
    await signIn(alice.secretKeyHex);
    await signIn(bob.secretKeyHex);
    await signIn(carol.secretKeyHex);
    // Neither the owner nor a stranger is a member.
    await signIn(OWNER_SECRET_KEY_HEX);
    await signIn(randomKeypair().secretKeyHex);
    expect((await homestats()).activeMembers).toEqual({ last1Day: 3, last7Days: 3, last30Days: 3 });

    await setSeen(bob.pubkeyHex, 6);
    await setSeen(carol.pubkeyHex, 29);
    expect((await homestats()).activeMembers).toEqual({ last1Day: 1, last7Days: 2, last30Days: 3 });
    await setSeen(carol.pubkeyHex, 30);
    expect((await homestats()).activeMembers.last30Days).toBe(2);
  });

  it("forgets a removed member's day", async () => {
    const alice = await member();
    await signIn(alice.secretKeyHex);
    await callManagement("unallowpubkey", [alice.pubkeyHex]);
    const rows = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql.exec(`SELECT 1 FROM member_seen`).toArray(),
    );
    expect(rows).toEqual([]);
    expect((await homestats()).activeMembers.last30Days).toBe(0);
  });
});

describe("messages per day", () => {
  it(`counts accepted mail for the last ${HOME_STATS_DAYS} days, today last`, async () => {
    const alice = await member();
    expect(await mailTo(alice.pubkeyHex)).toBe(true);
    expect(await mailTo(OWNER_PUBKEY_HEX)).toBe(true);
    expect(await mailTo(randomKeypair().pubkeyHex)).toBe(false);
    const { messagesPerDay } = await homestats();
    expect(messagesPerDay.length).toBe(HOME_STATS_DAYS);
    expect(messagesPerDay[HOME_STATS_DAYS - 1]).toEqual({
      day: new Date().toISOString().slice(0, 10),
      count: 2,
    });
    expect(messagesPerDay.slice(0, -1).every((d) => d.count === 0)).toBe(true);
  });

  it("keeps a day's count for 30 days", async () => {
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO mail_days (day, n) VALUES (100, 4), (130, 5)`);
      pruneHomeStats(sql, 130, 30);
      expect(sql.exec(`SELECT day FROM mail_days ORDER BY day`).toArray()).toEqual([{ day: 130 }]);
    });
  });
});

describe("joins per week", () => {
  it(`shows ${HOME_STATS_WEEKS} weeks, with how many came by invite`, async () => {
    await member();
    const code = ((await callManagement("createinvite", [2])).result as { code: string }).code;
    for (let i = 0; i < 2; i++) {
      await callManagement("redeeminvite", [code], { secretKeyHex: randomKeypair().secretKeyHex });
    }
    const old = randomKeypair();
    await runInDurableObject(stub(), (_i: Relay, state) => {
      state.storage.sql.exec(
        `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source) VALUES (?, NULL, ?, 'member')`,
        old.pubkeyHex,
        Math.floor(Date.now() / 1000) - 10 * 86400,
      );
    });
    const { weeks, members } = await homestats();
    expect(members).toBe(4);
    expect(weeks.length).toBe(HOME_STATS_WEEKS);
    expect(weeks[HOME_STATS_WEEKS - 1]).toEqual({ from: expect.any(String), newMembers: 3, invitesUsed: 2 });
    expect(weeks[HOME_STATS_WEEKS - 2]).toEqual({ from: expect.any(String), newMembers: 1, invitesUsed: 1 });
  });
});

describe("push subscribers", () => {
  it("counts members with a device, once each, and not the owner", async () => {
    const alice = await member();
    const subscribe = (secretKeyHex: string, endpoint: string) =>
      callManagement(
        "subscribepush",
        [
          {
            endpoint,
            keys: {
              p256dh:
                "BHVDLZvC37wnCeGsi517W_MyZ8JQnblkMlhwCwz7zKC13RCbyFPClkJ-WtOpqIcyXlim0K92C8IuUnOT75hUnS8",
              auth: "AAAAAAAAAAAAAAAAAAAAAA",
            },
          },
        ],
        { secretKeyHex, ip: freshIp() },
      );
    expect((await subscribe(alice.secretKeyHex, "https://push.example/a1")).result).toBe(true);
    expect((await subscribe(alice.secretKeyHex, "https://push.example/a2")).result).toBe(true);
    expect((await subscribe(OWNER_SECRET_KEY_HEX, "https://push.example/owner")).result).toBe(true);
    expect((await homestats()).pushSubscribers).toBe(1);
  });
});
