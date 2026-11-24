// Calls (relay.ts handleGiftWrap ringRefusal, drainCallPushes): a ring is
// a gift wrap with an outer `["ring"]` tag and a short NIP-40 expiry. It
// is stored like mail, limited as a ring rather than as mail, and pushed
// at once as kind "call", even to someone with a socket open. Google and
// the push service are never reached: fetch is replaced for their hosts.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetAccessToken, serviceAccount } from "../src/fcm";
import {
  CALL_ICE_SERVERS,
  MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
  MAX_RINGS_PER_IP_PER_WINDOW,
  MAX_RINGS_PER_RECIPIENT_PER_WINDOW,
  PUSH_ALARM_DELAY_MS,
  RING_MAX_TTL_SECONDS,
} from "../src/limits";
import type { Relay } from "../src/relay";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { randomKeypair, type Keypair } from "./helpers/keys";
import { decryptPush, makeDevice } from "./helpers/push";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
const EXPIRY_REFUSAL = `invalid: a ring must expire within ${RING_MAX_TTL_SECONDS} seconds`;

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.27.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  expect((await callManagement("allowpubkey", [who.pubkeyHex])).result).toBe(true);
  return who;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// A ring to `to`, from a fresh throwaway key, expiring `ttl` seconds from
// now (null: no expiration tag at all).
function ring(to: string, ttl: number | null = 60): NostrEvent {
  const tags = [["p", to], ["ring"]];
  if (ttl !== null) tags.push(["expiration", String(nowSec() + ttl)]);
  return signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags, content: "sealed invite with an sdp offer" });
}

function mail(to: string): NostrEvent {
  return signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", to]], content: "sealed mail" });
}

async function authenticate(conn: RelayConn, who: Keypair): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage();
  conn.send([
    "AUTH",
    signEvent(who.secretKeyHex, {
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

async function sqlRows(query: string): Promise<unknown[]> {
  return runInDurableObject(stub(), (_i: Relay, state) => state.storage.sql.exec(query).toArray());
}

async function alarmAt(): Promise<number | null> {
  return runInDurableObject(stub(), (_i: Relay, state) => state.storage.getAlarm());
}

// ---------------------------------------------------------------------
// The outside world: Google's token endpoint, FCM, and a web push service.
// ---------------------------------------------------------------------

let serviceAccountJson: string;

async function makeServiceAccount(): Promise<void> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...pkcs8));
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  serviceAccountJson = JSON.stringify({
    type: "service_account",
    project_id: "bothy-test",
    private_key_id: "key-1",
    private_key: pem,
    client_email: "push@bothy-test.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

interface Sent {
  url: string;
  headers: Headers;
  body: string;
  bytes: Uint8Array;
}

let sent: Sent[] = [];
let realFetch: typeof fetch;

beforeEach(async () => {
  if (!serviceAccountJson) await makeServiceAccount();
  mutableEnv.FCM_SERVICE_ACCOUNT = serviceAccountJson;
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
  forgetAccessToken(serviceAccount(env)!);
  sent = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "ya29.test-token", expires_in: 3600 });
    }
    if (url.startsWith("https://fcm.googleapis.com/") || url.startsWith("https://push.example")) {
      const body = typeof init?.body === "string" ? init.body : "";
      const bytes = init?.body instanceof Uint8Array ? init.body : new Uint8Array();
      sent.push({ url, headers: new Headers(init?.headers), body, bytes });
      return url.startsWith("https://push.example") ? new Response(null, { status: 201 }) : Response.json({});
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete mutableEnv.FCM_SERVICE_ACCOUNT;
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

const FCM_TOKEN = `fcm-token-ring:APA91b${"x".repeat(140)}`;

async function subscribeBoth(who: Keypair) {
  const device = await makeDevice("https://push.example/phone-browser");
  expect(
    (
      await callManagement("subscribepush", [{ endpoint: device.endpoint, keys: device.keys }], {
        secretKeyHex: who.secretKeyHex,
        ip: freshIp(),
      })
    ).result,
  ).toBe(true);
  expect(
    (
      await callManagement("subscribefcm", [FCM_TOKEN, { label: "acct-1" }], {
        secretKeyHex: who.secretKeyHex,
        ip: freshIp(),
      })
    ).result,
  ).toBe(true);
  return device;
}

// Waits for the alarm to have sent `count` pushes. The alarm runs on its
// own; if it has not by the deadline it is run here, so a slow runner
// still gets an answer.
async function pushesSent(count: number, waitMs = 1500): Promise<Sent[]> {
  const deadline = Date.now() + waitMs;
  while (sent.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (sent.length < count) await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
  return sent;
}

describe("a ring", () => {
  it("is accepted with an expiry inside the window, and stored with it", async () => {
    const bob = await member();
    const conn = await connectRelay(freshIp());
    const event = ring(bob.pubkeyHex, RING_MAX_TTL_SECONDS);
    expect(await publish(conn, event)).toEqual(["OK", event.id, true, ""]);
    conn.close();
    const rows = (await sqlRows(`SELECT id, expiration FROM wrap_expiry`)) as { id: string; expiration: number }[];
    expect(rows.map((row) => row.id)).toEqual([event.id]);
  });

  it("is refused with no expiry, an expiry already past, or one too far ahead", async () => {
    const bob = await member();
    const conn = await connectRelay(freshIp());
    for (const ttl of [null, -5, 0, RING_MAX_TTL_SECONDS + 5, 3600]) {
      const event = ring(bob.pubkeyHex, ttl);
      expect(await publish(conn, event)).toEqual(["OK", event.id, false, EXPIRY_REFUSAL]);
    }
    conn.close();
  });

  it("is refused when addressed to nobody in the home, like any wrap", async () => {
    await member();
    const conn = await connectRelay(freshIp());
    const event = ring(randomKeypair().pubkeyHex);
    expect((await publish(conn, event))[2]).toBe(false);
    conn.close();
  });

  it("is up to the event size limit, far more than an SDP offer needs", async () => {
    const bob = await member();
    const conn = await connectRelay(freshIp());
    const event = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", bob.pubkeyHex], ["ring"], ["expiration", String(nowSec() + 60)]],
      content: "x".repeat(32 * 1024),
    });
    expect(await publish(conn, event)).toEqual(["OK", event.id, true, ""]);
    conn.close();
  });

  it("does not count against the gift wrap limit, nor mail against the ring limit", async () => {
    const bob = await member();
    const carol = await member();
    const conn = await connectRelay(freshIp());
    for (let i = 0; i < MAX_GIFT_WRAPS_PER_IP_PER_WINDOW; i++) {
      expect((await publish(conn, mail(bob.pubkeyHex)))[2]).toBe(true);
    }
    // Mail from this address is now at its limit (an AUTH challenge, then
    // the refusal, since this connection never signed in); rings still go.
    const over = mail(bob.pubkeyHex);
    expect((await publish(conn, over))[0]).toBe("AUTH");
    expect((await conn.nextMessage())[3]).toMatch(/^auth-required: too many gift wraps/);
    expect((await publish(conn, ring(bob.pubkeyHex)))[2]).toBe(true);
    expect((await publish(conn, ring(carol.pubkeyHex)))[2]).toBe(true);
    conn.close();
  });

  it(`is limited to ${MAX_RINGS_PER_IP_PER_WINDOW} a minute per address`, async () => {
    const people = await Promise.all([member(), member(), member(), member()]);
    const conn = await connectRelay(freshIp());
    // Spread over people so the per-recipient limit never trips first.
    for (let i = 0; i < MAX_RINGS_PER_IP_PER_WINDOW; i++) {
      const to = people[i % people.length]!;
      expect((await publish(conn, ring(to.pubkeyHex)))[2]).toBe(true);
    }
    const event = ring(people[0]!.pubkeyHex);
    expect(await publish(conn, event)).toEqual([
      "OK",
      event.id,
      false,
      "rate-limited: too many rings from this connection, slow down",
    ]);
    conn.close();
  });

  it(`is limited to ${MAX_RINGS_PER_RECIPIENT_PER_WINDOW} a minute per recipient, from any address`, async () => {
    const bob = await member();
    const carol = await member();
    for (let i = 0; i < MAX_RINGS_PER_RECIPIENT_PER_WINDOW; i++) {
      const conn = await connectRelay(freshIp());
      expect((await publish(conn, ring(bob.pubkeyHex)))[2]).toBe(true);
      conn.close();
    }
    const conn = await connectRelay(freshIp());
    const event = ring(bob.pubkeyHex);
    expect(await publish(conn, event)).toEqual([
      "OK",
      event.id,
      false,
      "rate-limited: too many rings to this person, try again in a minute",
    ]);
    // Somebody else can still be rung.
    expect((await publish(conn, ring(carol.pubkeyHex)))[2]).toBe(true);
    conn.close();
  });
});

describe("a ring's push", () => {
  it("goes at once as kind call, even with the recipient signed in, at high priority for 30 seconds", async () => {
    const bob = await member();
    const device = await subscribeBoth(bob);
    // Bob's app has a signed-in socket open (perhaps frozen by Android).
    const bobConn = await connectRelay(freshIp());
    await authenticate(bobConn, bob);

    const conn = await connectRelay(freshIp());
    const event = ring(bob.pubkeyHex);
    const before = Date.now();
    expect(await publish(conn, event)).toEqual(["OK", event.id, true, ""]);
    conn.close();
    // Set for now, not PUSH_ALARM_DELAY_MS ahead (or already run).
    const alarm = await alarmAt();
    if (alarm !== null) expect(alarm).toBeLessThan(before + PUSH_ALARM_DELAY_MS / 2);
    // Never queued as mail.
    expect(await sqlRows(`SELECT pubkey FROM inbox_push`)).toEqual([]);

    const pushes = await pushesSent(2);
    expect(pushes.length).toBe(2);

    const fcm = pushes.find((p) => p.url.startsWith("https://fcm.googleapis.com/"))!;
    const message = (JSON.parse(fcm.body) as { message: Record<string, unknown> }).message;
    expect(message).toEqual({
      token: FCM_TOKEN,
      data: { kind: "call", room: expect.any(String), label: "acct-1" },
      android: { priority: "HIGH", ttl: "30s" },
    });
    expect(fcm.body).not.toContain(bob.pubkeyHex);
    expect(fcm.body).not.toContain(event.pubkey);
    expect(fcm.body).not.toContain(event.id);
    expect(fcm.body).not.toContain("sdp");

    const web = pushes.find((p) => p.url === device.endpoint)!;
    expect(web.headers.get("Urgency")).toBe("high");
    expect(web.headers.get("TTL")).toBe("30");
    const payload = JSON.parse(await decryptPush(device, web.bytes)) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["kind", "room"]);
    expect(payload.kind).toBe("call");

    expect(await sqlRows(`SELECT pubkey FROM call_push`)).toEqual([]);
    bobConn.close();
  });

  it("does not also send a message push, and mail still waits for the delay and skips a signed-in recipient", async () => {
    const bob = await member();
    await subscribeBoth(bob);
    const conn = await connectRelay(freshIp());
    expect((await publish(conn, ring(bob.pubkeyHex)))[2]).toBe(true);
    const pushes = await pushesSent(2);
    expect(pushes.length).toBe(2);
    // Past the message coalescing delay: nothing more arrives.
    await new Promise((resolve) => setTimeout(resolve, PUSH_ALARM_DELAY_MS + 300));
    expect(sent.length).toBe(2);
    for (const push of sent.filter((p) => p.url.startsWith("https://fcm.googleapis.com/"))) {
      expect(push.body).toContain('"kind":"call"');
    }

    // Plain mail is unchanged: queued for the delay, a normal TTL, no
    // Urgency, and skipped while the recipient is signed in.
    sent = [];
    const before = Date.now();
    expect((await publish(conn, mail(bob.pubkeyHex)))[2]).toBe(true);
    const alarm = await alarmAt();
    expect(alarm).not.toBeNull();
    expect(alarm!).toBeGreaterThanOrEqual(before + PUSH_ALARM_DELAY_MS - 100);
    await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
    const web = sent.find((p) => p.url.startsWith("https://push.example"))!;
    expect(web.headers.get("Urgency")).toBeNull();
    expect(web.headers.get("TTL")).toBe("3600");
    const fcm = sent.find((p) => p.url.startsWith("https://fcm.googleapis.com/"))!;
    expect(fcm.body).toContain('"ttl":"3600s"');

    sent = [];
    const bobConn = await connectRelay(freshIp());
    await authenticate(bobConn, bob);
    expect((await publish(conn, mail(bob.pubkeyHex)))[2]).toBe(true);
    await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
    expect(sent).toEqual([]);
    bobConn.close();
    conn.close();
  });
});

describe("NIP-11", () => {
  it("offers calls and the STUN servers", async () => {
    const info = await (
      await exports.default.fetch(new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }))
    ).json<Record<string, unknown>>();
    expect(info.calls).toEqual({
      v: 1,
      ice: [{ urls: ["stun:stun.l.google.com:19302"] }, { urls: ["stun:stun.cloudflare.com:3478"] }],
    });
    expect(info.calls).toEqual({ v: 1, ice: CALL_ICE_SERVERS });
  });
});
