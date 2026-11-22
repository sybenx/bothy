// Android push through FCM (src/fcm.ts, nip86.ts subscribefcm): the
// service-account JWT, registration, what a message carries, and cleanup.
// Google is never reached: fetch is replaced for its two hosts.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAssertion, forgetAccessToken, serviceAccount } from "../src/fcm";
import { MAX_FCM_TOKENS_PER_PUBKEY } from "../src/limits";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { randomKeypair, type Keypair } from "./helpers/keys";
import { makeDevice } from "./helpers/push";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

// A real RSA key, made once, in a real service-account JSON shape.
let publicKey: CryptoKey;
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
  publicKey = pair.publicKey;
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
  authorization: string | null;
  body: string;
}

let sent: Sent[] = [];
let fcmStatus: (token: string) => { status: number; body?: unknown } = () => ({ status: 200 });
let realFetch: typeof fetch;

beforeEach(async () => {
  if (!serviceAccountJson) await makeServiceAccount();
  mutableEnv.FCM_SERVICE_ACCOUNT = serviceAccountJson;
  forgetAccessToken(serviceAccount(env)!);
  sent = [];
  fcmStatus = () => ({ status: 200 });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url === "https://oauth2.googleapis.com/token") {
      sent.push({ url, authorization: null, body });
      return Response.json({ access_token: "ya29.test-token", expires_in: 3600 });
    }
    if (url.startsWith("https://fcm.googleapis.com/")) {
      sent.push({ url, authorization: new Headers(init?.headers).get("Authorization"), body });
      const token = (JSON.parse(body) as { message: { token: string } }).message.token;
      const reply = fcmStatus(token);
      return Response.json(reply.body ?? {}, { status: reply.status });
    }
    if (url.startsWith("https://push.example")) {
      sent.push({ url, authorization: null, body: "" });
      return new Response(null, { status: 201 });
    }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete mutableEnv.FCM_SERVICE_ACCOUNT;
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.26.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function token(n: number | string): string {
  return `fcm-token-${n}:APA91b${"x".repeat(140)}`;
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

function subscribe(who: Keypair, fcmToken: string, option?: unknown) {
  const params: unknown[] = [fcmToken];
  if (option !== undefined) params.push(option);
  return callManagement("subscribefcm", params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function tokens(): Promise<{ token: string; pubkey: string; label: string | null }[]> {
  return runInDurableObject(stub(), (_i: Relay, state) =>
    state.storage.sql
      .exec<{ token: string; pubkey: string; label: string | null }>(
        `SELECT token, pubkey, label FROM fcm_tokens ORDER BY created_at, rowid`,
      )
      .toArray(),
  );
}

async function mailTo(who: Keypair): Promise<void> {
  const conn = await connectRelay(freshIp());
  const [, , ok] = await publish(
    conn,
    signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", who.pubkeyHex]],
      content: "sealed secret text",
    }),
  );
  conn.close();
  expect(ok).toBe(true);
  await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
}

function fcmSends(): { authorization: string | null; message: Record<string, unknown> }[] {
  return sent
    .filter((s) => s.url.startsWith("https://fcm.googleapis.com/"))
    .map((s) => ({
      authorization: s.authorization,
      message: (JSON.parse(s.body) as { message: Record<string, unknown> }).message,
    }));
}

describe("the service-account JWT", () => {
  it("is RS256, names the account, the FCM scope and Google's token endpoint, and verifies", async () => {
    const account = serviceAccount(env)!;
    const jwt = await buildAssertion(account, 1_000);
    const [header, claims, signature] = jwt.split(".");
    const decode = (part: string) =>
      JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT", kid: "key-1" });
    expect(decode(claims!)).toEqual({
      iss: "push@bothy-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1_000,
      exp: 4_600,
    });
    const sig = Uint8Array.from(atob(signature!.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
      c.charCodeAt(0),
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      sig,
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });
});

describe("registering a token", () => {
  it("is for members, keyed by token and pubkey, with an optional label", async () => {
    const a = await member();
    const b = await member();
    expect((await subscribe(a, token(1), { label: "a1" })).result).toBe(true);
    expect((await subscribe(b, token(1), { label: "b2" })).result).toBe(true);
    expect((await tokens()).map((t) => [t.pubkey, t.label]).sort()).toEqual(
      [
        [a.pubkeyHex, "a1"],
        [b.pubkeyHex, "b2"],
      ].sort(),
    );
    expect((await subscribe(randomKeypair(), token(2))).status).toBe(401);
  });

  it(`keeps ${MAX_FCM_TOKENS_PER_PUBKEY} per member, evicting the oldest`, async () => {
    const a = await member();
    for (let i = 0; i <= MAX_FCM_TOKENS_PER_PUBKEY; i++) await subscribe(a, token(i));
    expect((await tokens()).map((t) => t.token)).toEqual(
      Array.from({ length: MAX_FCM_TOKENS_PER_PUBKEY }, (_, i) => token(i + 1)),
    );
  });

  it("does not share the cap with web push devices", async () => {
    mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
    const a = await member();
    for (let i = 0; i < 4; i++) {
      const device = await makeDevice(`https://push.example/web-${i}`);
      await callManagement("subscribepush", [{ endpoint: device.endpoint, keys: device.keys }], {
        secretKeyHex: a.secretKeyHex,
        ip: freshIp(),
      });
    }
    for (let i = 0; i < 4; i++) await subscribe(a, token(i));
    expect((await tokens()).length).toBe(4);
  });

  it("refuses a malformed token or label", async () => {
    const a = await member();
    expect((await subscribe(a, "short")).error).toBe(
      "subscribefcm takes the app's FCM registration token as a string",
    );
    expect((await subscribe(a, token(1), { label: "has space" })).error).toContain('{"label": "..."}');
  });

  it("unsubscribes only the signer's account from a shared token", async () => {
    const a = await member();
    const b = await member();
    await subscribe(a, token(1));
    await subscribe(b, token(1));
    await callManagement("unsubscribefcm", [token(1)], { secretKeyHex: a.secretKeyHex, ip: freshIp() });
    expect((await tokens()).map((t) => t.pubkey)).toEqual([b.pubkeyHex]);
  });

  it("drops a removed member's tokens", async () => {
    const a = await member();
    await subscribe(a, token(1));
    await callManagement("unallowpubkey", [a.pubkeyHex]);
    expect(await tokens()).toEqual([]);
  });
});

describe("what is sent", () => {
  it("a high-priority data message with the kind, the room and the label, and nothing else", async () => {
    const a = await member();
    await subscribe(a, token(1), { label: "a1" });
    await mailTo(a);

    const oauth = sent.filter((s) => s.url === "https://oauth2.googleapis.com/token");
    expect(oauth.length).toBe(1);
    expect(new URLSearchParams(oauth[0]!.body).get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );

    const sends = sent.filter((s) => s.url.startsWith("https://fcm.googleapis.com/"));
    expect(sends.map((s) => s.url)).toEqual([
      "https://fcm.googleapis.com/v1/projects/bothy-test/messages:send",
    ]);
    expect(sends[0]!.authorization).toBe("Bearer ya29.test-token");
    const { message } = fcmSends()[0]!;
    expect(message).toEqual({
      token: token(1),
      data: { kind: "message", room: expect.any(String), label: "a1" },
      android: { priority: "HIGH", ttl: "3600s" },
    });
    expect(message).not.toHaveProperty("notification");
    expect(sends[0]!.body).not.toContain("sealed secret text");
    expect(sends[0]!.body).not.toContain(a.pubkeyHex);
  });

  it("reuses the access token across sends", async () => {
    const a = await member();
    await subscribe(a, token(1));
    await mailTo(a);
    await mailTo(a);
    expect(sent.filter((s) => s.url === "https://oauth2.googleapis.com/token").length).toBe(1);
    expect(fcmSends().length).toBe(2);
  });

  it("goes to Android and web devices alike, each its own kind", async () => {
    mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
    const a = await member();
    const device = await makeDevice("https://push.example/a-browser");
    await callManagement("subscribepush", [{ endpoint: device.endpoint, keys: device.keys }], {
      secretKeyHex: a.secretKeyHex,
      ip: freshIp(),
    });
    await subscribe(a, token(1));
    await mailTo(a);
    expect(sent.some((s) => s.url === device.endpoint)).toBe(true);
    expect(fcmSends().length).toBe(1);
  });

  it("sends no label when none was given", async () => {
    const a = await member();
    await subscribe(a, token(1));
    await mailTo(a);
    expect(fcmSends()[0]!.message.data).toEqual({ kind: "message", room: expect.any(String) });
  });
});

describe("cleanup", () => {
  it("forgets a token Google says is gone, by 404 or UNREGISTERED, and keeps one that merely failed", async () => {
    const a = await member();
    await subscribe(a, token("404"));
    await subscribe(a, token("unregistered"));
    await subscribe(a, token("flaky"));
    fcmStatus = (t) =>
      t === token("404")
        ? { status: 404 }
        : t === token("unregistered")
          ? { status: 400, body: { error: { details: [{ errorCode: "UNREGISTERED" }] } } }
          : { status: 503 };
    await mailTo(a);
    expect((await tokens()).map((t) => t.token)).toEqual([token("flaky")]);
  });
});

describe("without FCM_SERVICE_ACCOUNT", () => {
  it("is off: registration refused, nothing advertised, nothing sent", async () => {
    const a = await member();
    delete mutableEnv.FCM_SERVICE_ACCOUNT;
    expect((await subscribe(a, token(1))).error).toContain("no FCM service account");
    const doc = (await (
      await exports.default.fetch(
        new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
      )
    ).json()) as Record<string, unknown>;
    expect(doc.fcm).toBeUndefined();
    mutableEnv.FCM_SERVICE_ACCOUNT = serviceAccountJson;
    const on = (await (
      await exports.default.fetch(
        new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
      )
    ).json()) as Record<string, unknown>;
    expect(on.fcm).toEqual({ project_id: "bothy-test" });
  });

  it("treats a malformed secret as off", async () => {
    mutableEnv.FCM_SERVICE_ACCOUNT = "{not json";
    const a = await member();
    expect((await subscribe(a, token(1))).error).toContain("no FCM service account");
  });
});
