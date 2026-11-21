// Two accounts in one app on one phone: one browser push endpoint, two
// pubkeys (schema.ts `push_subscriptions`, keyed by both), and a label in
// each push saying which account it is for (nip86.ts subscribepush,
// push.ts PushPayload).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Relay } from "../src/relay";
import { initSchema } from "../src/schema";
import { pushCursor, pushSubscriptionsAfter } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { randomKeypair, type Keypair } from "./helpers/keys";
import { decryptPush, makeDevice, type FakeDevice } from "./helpers/push";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
const mutableEnv = env as unknown as Record<string, unknown>;

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let captured: { url: string; body: Uint8Array }[] = [];
let replyStatus = 201;
let realFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  replyStatus = 201;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://push.example")) return realFetch(input as RequestInfo, init);
    captured.push({ url, body: new Uint8Array(init?.body as ArrayBuffer) });
    return new Response(null, { status: replyStatus });
  }) as typeof fetch;
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.30.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

function subscribe(who: Keypair, device: FakeDevice, option?: unknown) {
  const params: unknown[] = [{ endpoint: device.endpoint, keys: device.keys }];
  if (option !== undefined) params.push(option);
  return callManagement("subscribepush", params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function mailTo(who: Keypair): Promise<void> {
  const conn = await connectRelay(freshIp());
  const [, , ok] = await publish(
    conn,
    signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", who.pubkeyHex]], content: "sealed" }),
  );
  conn.close();
  expect(ok).toBe(true);
  await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
}

async function rows(): Promise<{ endpoint: string; pubkey: string; label: string | null }[]> {
  return runInDurableObject(stub(), (_i: Relay, state) =>
    state.storage.sql
      .exec<{ endpoint: string; pubkey: string; label: string | null }>(
        `SELECT endpoint, pubkey, label FROM push_subscriptions ORDER BY pubkey`,
      )
      .toArray(),
  );
}

describe("two accounts on one endpoint", () => {
  it("keeps both subscriptions, and labels each push with the account it is for", async () => {
    const a = await member();
    const b = await member();
    const phone = await makeDevice("https://push.example/one-phone");
    expect((await subscribe(a, phone, { label: "a1" })).result).toBe(true);
    expect((await subscribe(b, phone, { label: "b2" })).result).toBe(true);
    expect((await rows()).map((r) => [r.pubkey, r.label]).sort()).toEqual(
      [
        [a.pubkeyHex, "a1"],
        [b.pubkeyHex, "b2"],
      ].sort(),
    );

    await mailTo(a);
    expect(captured.length).toBe(1);
    expect(JSON.parse(await decryptPush(phone, captured[0]!.body))).toEqual({
      room: expect.any(String),
      kind: "message",
      label: "a1",
    });

    captured = [];
    await mailTo(b);
    expect(JSON.parse(await decryptPush(phone, captured[0]!.body)).label).toBe("b2");
  });

  it("sends today's payload when no label was given, and clears a label on a subscribe without one", async () => {
    const a = await member();
    const phone = await makeDevice("https://push.example/no-label");
    await subscribe(a, phone, { label: "a1" });
    await subscribe(a, phone);
    expect((await rows())[0]!.label).toBeNull();
    await mailTo(a);
    expect(Object.keys(JSON.parse(await decryptPush(phone, captured[0]!.body))).sort()).toEqual([
      "kind",
      "room",
    ]);
  });

  it("refuses a label that is not short and plain", async () => {
    const a = await member();
    const phone = await makeDevice("https://push.example/bad-label");
    for (const option of [
      { label: "x".repeat(17) },
      { label: "has space" },
      { label: "" },
      { label: 7 },
      "a1",
      ["a1"],
    ]) {
      expect((await subscribe(a, phone, option)).error).toBe(
        'subscribepush: the second parameter is optional, {"label": "..."} with 1 to 16 letters, digits, "_" or "-"',
      );
    }
    expect(await rows()).toEqual([]);
  });

  it("unsubscribes only the signer's account from a shared endpoint", async () => {
    const a = await member();
    const b = await member();
    const phone = await makeDevice("https://push.example/shared-unsub");
    await subscribe(a, phone, { label: "a1" });
    await subscribe(b, phone, { label: "b2" });
    await callManagement("unsubscribepush", [phone.endpoint], {
      secretKeyHex: a.secretKeyHex,
      ip: freshIp(),
    });
    expect((await rows()).map((r) => r.pubkey)).toEqual([b.pubkeyHex]);
  });

  it("forgets every account on an endpoint the push service reports gone", async () => {
    const a = await member();
    const b = await member();
    const phone = await makeDevice("https://push.example/shared-gone");
    await subscribe(a, phone, { label: "a1" });
    await subscribe(b, phone, { label: "b2" });
    replyStatus = 410;
    await mailTo(a);
    expect(await rows()).toEqual([]);
  });
});

describe("the group fan-out cursor", () => {
  it("resumes between two accounts on the same endpoint without skipping either", async () => {
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      for (const pubkey of ["a".repeat(64), "b".repeat(64)]) {
        sql.exec(
          `INSERT INTO push_subscriptions (endpoint, pubkey, p256dh, auth, created_at) VALUES (?, ?, 'k', 'a', 1)`,
          "https://push.example/e1",
          pubkey,
        );
      }
      const first = pushSubscriptionsAfter(sql, null, 1);
      expect(first.map((r) => r.pubkey)).toEqual(["a".repeat(64)]);
      const second = pushSubscriptionsAfter(sql, pushCursor(first[0]!), 1);
      expect(second.map((r) => r.pubkey)).toEqual(["b".repeat(64)]);
      expect(pushSubscriptionsAfter(sql, pushCursor(second[0]!), 1)).toEqual([]);
      // A cursor from before the key had two parts: a bare endpoint.
      expect(pushSubscriptionsAfter(sql, "https://push.example/e1", 5).map((r) => r.pubkey)).toEqual([
        "a".repeat(64),
        "b".repeat(64),
      ]);
    });
  });
});

describe("upgrading a relay whose table was keyed by endpoint alone", () => {
  it("rebuilds it with the two-part key and keeps every subscription", async () => {
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      sql.exec(`DROP TABLE push_subscriptions`);
      sql.exec(
        `CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, pubkey TEXT NOT NULL, p256dh TEXT NOT NULL,
           auth TEXT NOT NULL, created_at INTEGER NOT NULL, last_ok_at INTEGER)`,
      );
      sql.exec(
        `INSERT INTO push_subscriptions VALUES ('https://push.example/old', ?, 'k', 'a', 5, 9)`,
        "c".repeat(64),
      );
      sql.exec(`DELETE FROM schema_meta`);
      initSchema(sql);

      const key = sql
        .exec<{ name: string; pk: number }>(`SELECT name, pk FROM pragma_table_info('push_subscriptions')`)
        .toArray()
        .filter((c) => c.pk > 0)
        .map((c) => c.name);
      expect(key).toEqual(["endpoint", "pubkey"]);
      expect(
        sql.exec(`SELECT endpoint, pubkey, created_at, last_ok_at, label FROM push_subscriptions`).toArray(),
      ).toEqual([
        {
          endpoint: "https://push.example/old",
          pubkey: "c".repeat(64),
          created_at: 5,
          last_ok_at: 9,
          label: null,
        },
      ]);
      const indexes = sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'push_subscriptions'`,
        )
        .toArray()
        .map((r) => r.name);
      expect(indexes).toContain("idx_push_subscriptions_pubkey");
      expect(
        sql.exec(`SELECT name FROM sqlite_master WHERE name = 'push_subscriptions_old'`).toArray(),
      ).toEqual([]);
    });
  });
});
