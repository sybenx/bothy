// listmembers activity fields (storage.ts listMembers, memberActivity):
// lastSeen, push and waiting, read from what bothy already keeps, on
// members and removed members alike; and inviterUnknown, which marks an
// invitedBy that names the owner only by default.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Relay } from "../src/relay";
import { utcDay } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

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
  return `172.29.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

type Activity = { lastSeen: number | null; push: boolean; waiting: number };
type Row = Activity & { pubkey: string; invitedBy: string; inviterUnknown: boolean };
type Removed = Activity & { pubkey: string; removedAt: number; deletesAt: number };

async function listmembers(secretKeyHex?: string): Promise<{ members: Row[]; removed: Removed[] }> {
  const reply = await callManagement("listmembers", [], secretKeyHex ? { secretKeyHex } : {});
  expect(reply.error).toBeUndefined();
  return reply.result as { members: Row[]; removed: Removed[] };
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

async function signIn(secretKeyHex: string): Promise<void> {
  const conn = await connectRelay(freshIp());
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
  conn.close();
}

async function mailTo(pubkey: string): Promise<void> {
  const conn = await connectRelay(freshIp());
  const [, , ok] = await publish(
    conn,
    signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", pubkey]], content: "sealed" }),
  );
  conn.close();
  expect(ok).toBe(true);
}

function webPush(who: Keypair) {
  return callManagement(
    "subscribepush",
    [
      {
        endpoint: `https://push.example/${who.pubkeyHex.slice(0, 8)}`,
        keys: {
          p256dh: "BHVDLZvC37wnCeGsi517W_MyZ8JQnblkMlhwCwz7zKC13RCbyFPClkJ-WtOpqIcyXlim0K92C8IuUnOT75hUnS8",
          auth: "AAAAAAAAAAAAAAAAAAAAAA",
        },
      },
    ],
    { secretKeyHex: who.secretKeyHex, ip: freshIp() },
  );
}

function sql<T>(fn: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(stub(), (_i: Relay, state) => fn(state.storage.sql));
}

function rowOf<T extends { pubkey: string }>(rows: T[], who: Keypair): T {
  return rows.find((r) => r.pubkey === who.pubkeyHex)!;
}

describe("activity fields", () => {
  it("starts empty: never seen, no push, nothing waiting", async () => {
    const quiet = await member();
    expect(rowOf((await listmembers()).members, quiet)).toMatchObject({ lastSeen: null, push: false, waiting: 0 });
  });

  it("lastSeen is the stored UTC day number of the last sign-in", async () => {
    const alice = await member();
    await signIn(alice.secretKeyHex);
    const today = utcDay(Math.floor(Date.now() / 1000));
    expect(rowOf((await listmembers()).members, alice).lastSeen).toBe(today);
    await sql((s) => s.exec(`UPDATE member_seen SET day = ? WHERE pubkey = ?`, today - 40, alice.pubkeyHex));
    expect(rowOf((await listmembers()).members, alice).lastSeen).toBe(today - 40);
  });

  it("push is true for web push or an Android FCM token", async () => {
    const web = await member();
    const android = await member();
    const neither = await member();
    expect((await webPush(web)).result).toBe(true);
    await sql((s) =>
      s.exec(
        `INSERT INTO fcm_tokens (token, pubkey, label, created_at) VALUES ('tok', ?, NULL, 0)`,
        android.pubkeyHex,
      ),
    );
    const { members } = await listmembers();
    expect([rowOf(members, web).push, rowOf(members, android).push, rowOf(members, neither).push]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("waiting counts stored gift wraps addressed to each member", async () => {
    const alice = await member();
    const bob = await member();
    await mailTo(alice.pubkeyHex);
    await mailTo(alice.pubkeyHex);
    await mailTo(bob.pubkeyHex);
    await mailTo(OWNER_PUBKEY_HEX);
    const { members } = await listmembers();
    expect([rowOf(members, alice).waiting, rowOf(members, bob).waiting]).toEqual([2, 1]);
  });

  it("removed members in their grace carry the same fields", async () => {
    const gone = await member();
    await signIn(gone.secretKeyHex);
    await webPush(gone);
    await mailTo(gone.pubkeyHex);
    await callManagement("unallowpubkey", [gone.pubkeyHex]);
    const { members, removed } = await listmembers();
    expect(members.some((r) => r.pubkey === gone.pubkeyHex)).toBe(false);
    // Removal deletes the sign-in day and the push registrations; the
    // mail stays for the grace period.
    expect(rowOf(removed, gone)).toMatchObject({ lastSeen: null, push: false, waiting: 1 });
  });

  it("an admin sees them too, a member does not", async () => {
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    await signIn(admin.secretKeyHex);
    expect(rowOf((await listmembers(admin.secretKeyHex)).members, admin).lastSeen).not.toBeNull();
    const plain = await member();
    expect((await callManagement("listmembers", [], { secretKeyHex: plain.secretKeyHex })).status).toBe(401);
  });
});

describe("inviterUnknown", () => {
  it("is false for an inviter on record, the owner included", async () => {
    const byOwner = await member();
    const code = ((await callManagement("createinvite", [1], { secretKeyHex: byOwner.secretKeyHex })).result as {
      code: string;
    }).code;
    const invitee = randomKeypair();
    await callManagement("redeeminvite", [code], { secretKeyHex: invitee.secretKeyHex });
    const { members } = await listmembers();
    expect(rowOf(members, byOwner)).toMatchObject({ invitedBy: OWNER_PUBKEY_HEX, inviterUnknown: false });
    expect(rowOf(members, invitee)).toMatchObject({ invitedBy: byOwner.pubkeyHex, inviterUnknown: false });
  });

  it("is true for a NULL (pre-v0.19) inviter or one no longer listed, with invitedBy still the owner", async () => {
    const old = randomKeypair();
    const orphan = randomKeypair();
    const self = randomKeypair();
    const removedInviter = randomKeypair();
    await sql((s) => {
      for (const [who, by] of [
        [old, null],
        [orphan, removedInviter.pubkeyHex],
        [self, self.pubkeyHex],
      ] as const) {
        s.exec(
          `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source, invited_by) VALUES (?, NULL, 1756500000, 'invite', ?)`,
          who.pubkeyHex,
          by,
        );
      }
    });
    const { members } = await listmembers();
    for (const who of [old, orphan, self]) {
      expect(rowOf(members, who)).toMatchObject({ invitedBy: OWNER_PUBKEY_HEX, inviterUnknown: true });
    }
  });
});
