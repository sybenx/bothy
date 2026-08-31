// Web push (src/push.ts, src/nip86.ts subscribepush, relay.ts's presence
// and fan-out), against hearth's contract in that repo's
// reference/push.md.
//
// Three things here are worth more than the rest and are asserted
// end-to-end rather than by shape:
//
//   1. THE CRYPTO ACTUALLY ROUND TRIPS. The encryption test builds a
//      subscription keypair the way a browser does, hands it to the same
//      code a real send uses, and DECRYPTS the body back to the payload.
//      RFC 8291 has half a dozen places where a wrong constant or a wrong
//      key order produces a body that is perfectly well-formed and
//      undecryptable, and every one of them would look like success from
//      inside the relay.
//   2. PRESENCE DOES NOT PAY A WRITE PER BEAT. reference/push.md names
//      this as the one that will go wrong if it is written quickly, so it
//      is measured against a real SqlStorageCursor.rowsWritten rather
//      than reasoned about.
//   3. THE FAN-OUT IS BOUNDED. Workers Free allows fifty subrequests per
//      invocation; the test counts them.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { TOP_LEVEL_GROUP_ID } from "../src/groups";
import {
  MAX_PUSHES_PER_TICK,
  MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY,
  PRESENCE_WRITE_INTERVAL_SECONDS,
  PRESENCE_STALE_SECONDS,
} from "../src/limits";
import { buildRelayInfo } from "../src/nip11";
import { MEMBER_CALLABLE_METHODS, SUPPORTED_METHODS } from "../src/nip86";
import { PUT_USER_KIND } from "../src/nip29";
import { CALL_PRESENCE_KIND, GROUP_CHAT_KIND, vapidKeys } from "../src/push";
import { writeMetricsSnapshot } from "../src/read-metrics";
import type { Relay } from "../src/relay";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement, MANAGEMENT_URL } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

// A fixed P-256 secret, so the derived public half below is a constant a
// test can assert against rather than a value the test recomputes with
// the code it is checking.
const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
const VAPID_PUBLIC = "BHVDLZvC37wnCeGsi517W_MyZ8JQnblkMlhwCwz7zKC13RCbyFPClkJ-WtOpqIcyXlim0K92C8IuUnOT75hUnS8";

const mutableEnv = env as unknown as Record<string, unknown>;

function withKey(): Env {
  return { ...env, VAPID_PRIVATE_KEY: VAPID_SECRET } as unknown as Env;
}

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

// A fresh address per connection, for the reason helpers/management.ts
// gives for doing the same to its HTTP calls: relay.ts's per-IP message
// throttle is 50 messages per 10 seconds, a connection with no
// CF-Connecting-IP is seen as the literal string "unknown", and every
// such connection in the whole suite therefore shares one window. This
// file opens more of them than any other, so without this it throttles
// unrelated test files rather than itself. Private-range and sequential,
// so a failure is reproducible, and in a different block from the 10/8
// that helper uses and the 203.0.113.0/24 the rate-limit tests use
// deliberately.
let nextIp = 0;
function syntheticIp(): string {
  nextIp++;
  return `172.16.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function connect(): Promise<RelayConn> {
  return connectRelay(syntheticIp());
}

function b64uEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function b64uDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0),
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A subscription exactly as a browser produces one: a P-256 keypair whose
// public half is `p256dh`, and sixteen random bytes as `auth`.
interface FakeDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  privateKey: CryptoKey;
  auth: Uint8Array;
  p256dh: Uint8Array;
}

async function makeDevice(endpoint: string): Promise<FakeDevice> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const p256dh = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint,
    keys: { p256dh: b64uEncode(p256dh), auth: b64uEncode(auth) },
    privateKey: pair.privateKey,
    auth,
    p256dh,
  };
}

// The client half of RFC 8291 + RFC 8188, which is what a browser does
// before handing the plaintext to a service worker. Written out here
// rather than reusing anything from src/push.ts on purpose: a decryptor
// sharing code with the encryptor proves the two agree, not that either
// is right.
async function decryptPush(device: FakeDevice, body: Uint8Array): Promise<string> {
  const salt = body.subarray(0, 16);
  const idLen = body[20]!;
  const asPublic = body.subarray(21, 21 + idLen);
  const ciphertext = body.subarray(21 + idLen);

  const senderKey = await crypto.subtle.importKey(
    "raw",
    asPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: senderKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      device.privateKey,
      256,
    ),
  );
  const enc = new TextEncoder();
  const sharedKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: device.auth,
        info: concat(enc.encode("WebPush: info"), new Uint8Array([0]), device.p256dh, asPublic),
      },
      sharedKey,
      256,
    ),
  );
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cekBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    },
    ikmKey,
    128,
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])),
      },
      ikmKey,
      96,
    ),
  );
  const cek = await crypto.subtle.importKey("raw", cekBits, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cek, ciphertext),
  );
  // RFC 8188's last-record padding delimiter.
  expect(plaintext[plaintext.length - 1]).toBe(0x02);
  return new TextDecoder().decode(plaintext.subarray(0, plaintext.length - 1));
}

// Every outbound push this test run made, with the real fetch put back
// afterwards. `reply` decides what the push service answers, which is how
// the 404/410 disposal path is exercised.
interface CapturedPush {
  url: string;
  headers: Headers;
  body: Uint8Array;
}

let captured: CapturedPush[] = [];
let replyStatus: (url: string) => number = () => 201;
let realFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  replyStatus = () => 201;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://push.example")) return realFetch(input as RequestInfo, init);
    captured.push({
      url,
      headers: new Headers(init?.headers),
      body: new Uint8Array(init?.body as ArrayBuffer),
    });
    return new Response(null, { status: replyStatus(url) });
  }) as typeof fetch;
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

// ---------------------------------------------------------------------

describe("the VAPID keypair", () => {
  it("derives the public half from the one configured secret", () => {
    const keys = vapidKeys(withKey());
    expect(keys?.publicKey).toBe(VAPID_PUBLIC);
  });

  it("treats a malformed key as no key rather than as an error", () => {
    // The whole degradation path depends on this: an operator who pastes
    // the wrong string gets a relay with no push, not a relay that throws
    // on the NIP-11 document.
    for (const bad of ["not base64url!!", b64uEncode(new Uint8Array(16)), ""]) {
      expect(vapidKeys({ ...env, VAPID_PRIVATE_KEY: bad } as unknown as Env)).toBeNull();
    }
  });
});

describe("the NIP-11 document", () => {
  const settings = { name: null, description: null, icon: null };

  it("omits push_key entirely when no key is configured", () => {
    const info = buildRelayInfo(
      { ...env, VAPID_PRIVATE_KEY: undefined } as unknown as Env,
      settings,
      null,
      OWNER_PUBKEY_HEX,
      "f".repeat(64),
    );
    expect("push_key" in info).toBe(false);
  });

  it("publishes the public half when one is", () => {
    const info = buildRelayInfo(withKey(), settings, null, OWNER_PUBKEY_HEX, "f".repeat(64));
    expect(info.push_key).toBe(VAPID_PUBLIC);
  });
});

describe("CORS on the management endpoint", () => {
  it("answers a preflight without touching the Durable Object", async () => {
    const response = await exports.default.fetch(
      new Request(MANAGEMENT_URL, {
        method: "OPTIONS",
        headers: {
          Origin: "https://sybenx.github.io",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain(
      "authorization",
    );
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("puts the header on the management response itself, success or failure", async () => {
    // Without this a browser refuses to hand the body to the page even
    // though the request succeeded -- which is how "the invite list
    // never loads from GitHub Pages" looked from hearth's side.
    const ok = await exports.default.fetch(
      new Request(MANAGEMENT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/nostr+json+rpc",
          "CF-Connecting-IP": "203.0.113.90",
          Authorization: "Nostr not-a-real-event",
        },
        body: JSON.stringify({ method: "supportedmethods", params: [] }),
      }),
    );
    expect(ok.status).toBe(401);
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const reply = await callManagement("supportedmethods");
    expect(reply.status).toBe(200);
  });
});

describe("subscribepush / unsubscribepush", () => {
  it("is advertised by supportedmethods and listed as member-callable", async () => {
    const listed = (await callManagement("supportedmethods")).result as string[];
    expect(listed).toContain("subscribepush");
    expect(listed).toContain("unsubscribepush");
    for (const method of MEMBER_CALLABLE_METHODS) expect(SUPPORTED_METHODS).toContain(method);
  });

  it("stores the pubkey the signature proved, never one the body offers", async () => {
    const impostor = randomKeypair();
    const device = await makeDevice("https://push.example/owner-device");
    const reply = await callManagement("subscribepush", [
      // A body that tries to name somebody else. It is not a field this
      // relay reads at all, which is the point.
      { ...device, pubkey: impostor.pubkeyHex },
    ]);
    expect(reply.result).toBe(true);

    const rows = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql
        .exec<{ endpoint: string; pubkey: string }>(`SELECT endpoint, pubkey FROM push_subscriptions`)
        .toArray(),
    );
    expect(rows).toEqual([{ endpoint: device.endpoint, pubkey: OWNER_PUBKEY_HEX }]);
  });

  it("lets a group member subscribe, and refuses a stranger", async () => {
    const member = randomKeypair();
    const stranger = randomKeypair();
    const conn = await connect();
    await publish(
      conn,
      signEvent(OWNER_SECRET_KEY_HEX, {
        kind: PUT_USER_KIND,
        tags: [["h", TOP_LEVEL_GROUP_ID], ["p", member.pubkeyHex]],
      }),
    );
    conn.close();

    const memberDevice = await makeDevice("https://push.example/member-phone");
    const accepted = await callManagement("subscribepush", [memberDevice], {
      secretKeyHex: member.secretKeyHex,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.result).toBe(true);

    const strangerDevice = await makeDevice("https://push.example/stranger-phone");
    const refused = await callManagement("subscribepush", [strangerDevice], {
      secretKeyHex: stranger.secretKeyHex,
    });
    expect(refused.status).toBe(401);
  });

  it("does not widen any other method to a member", async () => {
    const member = randomKeypair();
    const conn = await connect();
    await publish(
      conn,
      signEvent(OWNER_SECRET_KEY_HEX, {
        kind: PUT_USER_KIND,
        tags: [["h", TOP_LEVEL_GROUP_ID], ["p", member.pubkeyHex]],
      }),
    );
    conn.close();

    const reply = await callManagement("banpubkey", ["a".repeat(64)], {
      secretKeyHex: member.secretKeyHex,
    });
    expect(reply.status).toBe(401);
  });

  it("refuses a subscription whose keys are not the shape RFC 8291 needs", async () => {
    const good = await makeDevice("https://push.example/bad-keys");
    for (const params of [
      [{ endpoint: good.endpoint }],
      [{ endpoint: "http://push.example/insecure", keys: good.keys }],
      [{ endpoint: good.endpoint, keys: { p256dh: good.keys.p256dh, auth: b64uEncode(new Uint8Array(8)) } }],
      [{ endpoint: good.endpoint, keys: { p256dh: b64uEncode(new Uint8Array(65)), auth: good.keys.auth } }],
    ]) {
      const reply = await callManagement("subscribepush", params);
      expect(reply.result).toBeUndefined();
      expect(reply.error).toContain("subscribepush");
    }
  });

  it("refuses to keep a subscription it could never push to", async () => {
    delete mutableEnv.VAPID_PRIVATE_KEY;
    const device = await makeDevice("https://push.example/no-key");
    const reply = await callManagement("subscribepush", [device]);
    expect(reply.error).toContain("push_key");
  });

  it("evicts the oldest endpoint rather than refusing the newest", async () => {
    for (let i = 0; i <= MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY; i++) {
      const device = await makeDevice(`https://push.example/device-${i}`);
      const reply = await callManagement("subscribepush", [device]);
      expect(reply.result).toBe(true);
    }
    const rows = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql
        .exec<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions ORDER BY endpoint`)
        .toArray()
        .map((r) => r.endpoint),
    );
    expect(rows.length).toBe(MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY);
    // A browser that rotated its endpoint must not be locked out by the
    // dead rows it left behind, so the newest registration always
    // survives and the oldest is what goes.
    expect(rows).toContain(`https://push.example/device-${MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY}`);
    expect(rows).not.toContain("https://push.example/device-0");
  });

  it("unsubscribes only the caller's own endpoint", async () => {
    const member = randomKeypair();
    const conn = await connect();
    await publish(
      conn,
      signEvent(OWNER_SECRET_KEY_HEX, {
        kind: PUT_USER_KIND,
        tags: [["h", TOP_LEVEL_GROUP_ID], ["p", member.pubkeyHex]],
      }),
    );
    conn.close();

    const ownerDevice = await makeDevice("https://push.example/owners");
    await callManagement("subscribepush", [ownerDevice]);

    // The member names the owner's endpoint. Endpoints are not secrets,
    // and quietly turning somebody else's notifications off is a quieter
    // kind of damage than turning them on.
    const reply = await callManagement("unsubscribepush", [ownerDevice.endpoint], {
      secretKeyHex: member.secretKeyHex,
    });
    expect(reply.result).toBe(true);

    const remaining = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql.exec(`SELECT endpoint FROM push_subscriptions`).toArray().length,
    );
    expect(remaining).toBe(1);
  });
});

describe("the encrypted body", () => {
  it("round trips through RFC 8291, headers and all", async () => {
    const device = await makeDevice("https://push.example/round-trip");
    await callManagement("subscribepush", [device]);
    await sendChat(await joinGroup());

    expect(captured.length).toBe(1);
    const push = captured[0]!;
    expect(push.headers.get("Content-Encoding")).toBe("aes128gcm");
    expect(push.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(Number(push.headers.get("TTL"))).toBeGreaterThan(0);

    const payload = JSON.parse(await decryptPush(device, push.body)) as Record<string, unknown>;
    // reference/push.md "What it must not do": the room and the kind, and
    // nothing else. Not the message, not who sent it.
    expect(Object.keys(payload).sort()).toEqual(["kind", "room"]);
    expect(payload.kind).toBe("message");
    expect(typeof payload.room).toBe("string");
  });

  it("authorizes with a VAPID JWT this relay's own key actually signed", async () => {
    const device = await makeDevice("https://push.example/vapid");
    await callManagement("subscribepush", [device]);
    await sendChat(await joinGroup());

    const header = captured[0]!.headers.get("Authorization") ?? "";
    const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, jwt, key] = match!;
    expect(key).toBe(VAPID_PUBLIC);

    const [encodedHeader, encodedClaims, encodedSignature] = jwt!.split(".");
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(encodedHeader!)))).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    const claims = JSON.parse(new TextDecoder().decode(b64uDecode(encodedClaims!))) as {
      aud: string;
      exp: number;
      sub: string;
    };
    // RFC 8292: `aud` is the push service's origin, and `sub` identifies
    // this deployment to whoever operates it.
    expect(claims.aud).toBe("https://push.example");
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(claims.sub.startsWith("https://")).toBe(true);

    // Verified against the public half a browser was handed, which is the
    // only thing that proves the two halves are one keypair.
    const verified = p256.verify(
      b64uDecode(encodedSignature!),
      new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
      b64uDecode(VAPID_PUBLIC),
      // `lowS: false`, because WebCrypto emits whatever s the signature
      // came out with and every ES256 verifier accepts both halves of the
      // pair -- noble's low-S default is a Bitcoin/Ethereum convention,
      // not a JWS one, and leaving it on would fail this about half the
      // time for a signature every push service would accept.
      { prehash: true, lowS: false },
    );
    expect(verified).toBe(true);
  });
});

describe("who a message is pushed to", () => {
  it("pushes to members, and never to the pubkey that sent it", async () => {
    const member = await joinGroup();
    const authorDevice = await makeDevice("https://push.example/author");
    const memberDevice = await makeDevice("https://push.example/member");
    await callManagement("subscribepush", [authorDevice], { secretKeyHex: member.secretKeyHex });

    const other = await joinGroup();
    await callManagement("subscribepush", [memberDevice], { secretKeyHex: other.secretKeyHex });

    await sendChat(member);
    expect(captured.map((p) => p.url)).toEqual([memberDevice.endpoint]);
  });

  it("never pushes to somebody whose socket is open", async () => {
    const member = await joinGroup();
    const device = await makeDevice("https://push.example/already-looking");
    await callManagement("subscribepush", [device], { secretKeyHex: member.secretKeyHex });

    const conn = await connect();
    await authenticate(conn, member.secretKeyHex);
    await sendChat(await joinGroup());
    expect(captured).toEqual([]);
    conn.close();
  });

  it("never pushes to a pubkey that is no longer in the group", async () => {
    const exMember = randomKeypair();
    await addMember(exMember.pubkeyHex);
    const device = await makeDevice("https://push.example/ex-member");
    await callManagement("subscribepush", [device], { secretKeyHex: exMember.secretKeyHex });
    await runInDurableObject(stub(), (_i: Relay, state) => {
      state.storage.sql.exec(`DELETE FROM group_members WHERE pubkey = ?`, exMember.pubkeyHex);
    });

    await sendChat(await joinGroup());
    expect(captured).toEqual([]);
  });

  it("coalesces a burst of messages into one notification", async () => {
    const member = await joinGroup();
    const device = await makeDevice("https://push.example/burst");
    await callManagement("subscribepush", [device], { secretKeyHex: member.secretKeyHex });

    const author = await joinGroup();
    const conn = await connect();
    for (let i = 0; i < 5; i++) {
      await publish(conn, chat(author.secretKeyHex, `line ${i}`));
    }
    conn.close();
    await fireAlarm();
    // hearth's service worker collapses these into one line in the shade
    // anyway (`tag: "hearth:message"`), so five rows and five fan-outs
    // would be rows written for a notification the phone throws away.
    expect(captured.length).toBe(1);
  });

  it("deletes an endpoint the push service reports gone, and keeps one that merely failed", async () => {
    const member = await joinGroup();
    const dead = await makeDevice("https://push.example/dead");
    const flaky = await makeDevice("https://push.example/flaky");
    await callManagement("subscribepush", [dead], { secretKeyHex: member.secretKeyHex });
    await callManagement("subscribepush", [flaky], { secretKeyHex: member.secretKeyHex });

    replyStatus = (url) => (url === dead.endpoint ? 410 : 429);
    await sendChat(await joinGroup());

    const rows = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql
        .exec<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions`)
        .toArray()
        .map((r) => r.endpoint),
    );
    expect(rows).toEqual([flaky.endpoint]);
  });
});

describe("the subrequest bound", () => {
  it("spends no more than one invocation's allowance and resumes on the next alarm", async () => {
    // The failure this exists to prevent is silent: a fan-out written
    // inline would send fifty and then throw, at exactly the group size
    // this is built for.
    //
    // The members and their devices are seeded straight into storage
    // rather than through put-user and subscribepush, which is a
    // deliberate drop below the wire protocol (docs/test-notes.md): forty
    // five real memberships would regenerate the kind-39002 member list
    // forty five times to set up a test about subrequests, and the keys
    // never need to be real because nothing here decrypts anything.
    const devices = MAX_PUSHES_PER_TICK + 5;
    const member = await joinGroup();
    const device = await makeDevice("https://push.example/template");
    await runInDurableObject(stub(), (_i: Relay, state) => {
      for (let i = 0; i < devices; i++) {
        const pubkey = `${String(i).padStart(2, "0")}${"c".repeat(62)}`;
        state.storage.sql.exec(
          `INSERT INTO group_members (pubkey, added_at) VALUES (?, 0) ON CONFLICT DO NOTHING`,
          pubkey,
        );
        state.storage.sql.exec(
          `INSERT INTO push_subscriptions (endpoint, pubkey, p256dh, auth, created_at, last_ok_at)
             VALUES (?, ?, ?, ?, 0, NULL)`,
          `https://push.example/wide-${String(i).padStart(3, "0")}`,
          pubkey,
          device.keys.p256dh,
          device.keys.auth,
        );
      }
    });

    await sendChat(member);
    expect(captured.length).toBeLessThanOrEqual(MAX_PUSHES_PER_TICK);
    const firstBatch = captured.length;

    await fireAlarm();
    expect(captured.length).toBeGreaterThan(firstBatch);
    // Every endpoint reached exactly once across the two invocations --
    // the cursor is what makes resuming not mean starting again.
    expect(new Set(captured.map((p) => p.url)).size).toBe(captured.length);
  });
});

describe("two notifications pending at once", () => {
  it("sends both, and does not let one starve the other", async () => {
    const watcher = await joinGroup();
    const device = await makeDevice("https://push.example/both");
    await callManagement("subscribepush", [device], { secretKeyHex: watcher.secretKeyHex });

    const author = await joinGroup();
    const arriving = await joinGroup();
    const conn = await connect();
    await publish(conn, chat(author.secretKeyHex, "said something"));
    await publish(conn, presence(arriving.secretKeyHex, "here"));
    conn.close();
    await fireAlarm();

    const kinds = await Promise.all(
      captured.map(async (p) => (JSON.parse(await decryptPush(device, p.body)) as { kind: string }).kind),
    );
    // Two different things happened, and hearth's service worker tags
    // them separately, so they are two notifications rather than one.
    expect(kinds.sort()).toEqual(["message", "voice"]);
  });
});

describe("bookkeeping the fan-out does not pay for", () => {
  it("refreshes last_ok_at at most once a day rather than once per push", async () => {
    const watcher = await joinGroup();
    const device = await makeDevice("https://push.example/bookkeeping");
    await callManagement("subscribepush", [device], { secretKeyHex: watcher.secretKeyHex });

    await sendChat(await joinGroup());
    const first = await lastOkAt(device.endpoint);
    expect(first).not.toBeNull();

    // Three more notifications, and the column must not move for any of
    // them: one row per device per notification is the shape presence
    // already taught this codebase not to pay.
    for (let i = 0; i < 3; i++) await sendChat(await joinGroup());
    expect(await lastOkAt(device.endpoint)).toBe(first);
  });
});

describe("call presence", () => {
  it("writes no row for a heartbeat inside the write interval", async () => {
    const member = await joinGroup();
    const conn = await connect();

    // The first beat is an arrival: one read, one write, one queued
    // notification.
    await publish(conn, presence(member.secretKeyHex, "here"));
    const afterFirst = await presenceRow(member.pubkeyHex);
    expect(afterFirst).not.toBeNull();

    // Twelve more beats -- a minute of hearth's five-second heartbeat.
    // Every one of them must cost nothing at all, which is the whole
    // point of limits.ts PRESENCE_WRITE_INTERVAL_SECONDS.
    const written = await measurePresenceWrites(async () => {
      for (let i = 0; i < 12; i++) await publish(conn, presence(member.secretKeyHex, "here"));
    });
    expect(written).toBe(0);
    expect(await presenceRow(member.pubkeyHex)).toBe(afterFirst);
    conn.close();
  });

  it("pushes on the arrival and not on the beats after it", async () => {
    const watcher = await joinGroup();
    const device = await makeDevice("https://push.example/watcher");
    await callManagement("subscribepush", [device], { secretKeyHex: watcher.secretKeyHex });

    const arriving = await joinGroup();
    const conn = await connect();
    for (let i = 0; i < 6; i++) await publish(conn, presence(arriving.secretKeyHex, "here"));
    conn.close();
    await fireAlarm();

    expect(captured.length).toBe(1);
    const payload = JSON.parse(await decryptPush(device, captured[0]!.body)) as { kind: string };
    expect(payload.kind).toBe("voice");
  });

  it("treats a watermark older than the derived staleness window as an arrival", async () => {
    const arriving = await joinGroup();
    const conn = await connect();
    await publish(conn, presence(arriving.secretKeyHex, "here"));
    await fireAlarm();
    captured = [];

    // Age the stored watermark past PRESENCE_STALE_SECONDS and clear the
    // in-memory tier, which is exactly the state an evicted object wakes
    // into. Nothing else about the relay changes.
    await runInDurableObject(stub(), (_i: Relay, state) => {
      state.storage.sql.exec(
        `UPDATE presence SET last_seen = ?`,
        Math.floor(Date.now() / 1000) - PRESENCE_STALE_SECONDS - 1,
      );
    });
    await clearPresenceMemory();

    const watcher = await joinGroup();
    const device = await makeDevice("https://push.example/return");
    await callManagement("subscribepush", [device], { secretKeyHex: watcher.secretKeyHex });

    const again = await connect();
    await publish(again, presence(arriving.secretKeyHex, "here"));
    again.close();
    await fireAlarm();
    expect(captured.length).toBe(1);
  });

  it("a leave beat makes the next arrival announceable straight away", async () => {
    const arriving = await joinGroup();
    const conn = await connect();
    await publish(conn, presence(arriving.secretKeyHex, "here"));
    await fireAlarm();

    await publish(conn, presence(arriving.secretKeyHex, "leave"));
    expect(await presenceRow(arriving.pubkeyHex)).toBeNull();

    const watcher = await joinGroup();
    const device = await makeDevice("https://push.example/rejoin");
    await callManagement("subscribepush", [device], { secretKeyHex: watcher.secretKeyHex });
    captured = [];

    await publish(conn, presence(arriving.secretKeyHex, "here"));
    conn.close();
    await fireAlarm();
    // Well inside PRESENCE_STALE_SECONDS, and announced anyway: they said
    // they were going, so coming back is an arrival rather than a
    // reconnect.
    expect(captured.length).toBe(1);
  });
});

describe("a relay with no VAPID key", () => {
  it("writes nothing, schedules nothing and errors nowhere", async () => {
    const member = await joinGroup();
    delete mutableEnv.VAPID_PRIVATE_KEY;

    const conn = await connect();
    const [, , accepted] = await publish(conn, chat(member.secretKeyHex, "into the void"));
    expect(accepted).toBe(true);
    await publish(conn, presence(member.secretKeyHex, "here"));
    conn.close();

    const state = await runInDurableObject(stub(), (_i: Relay, s) => ({
      outbox: s.storage.sql.exec(`SELECT reason FROM push_outbox`).toArray().length,
      presence: s.storage.sql.exec(`SELECT pubkey FROM presence`).toArray().length,
    }));
    expect(state).toEqual({ outbox: 0, presence: 0 });
    expect(captured).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------

function chat(secretKeyHex: string, content: string): NostrEvent {
  return signEvent(secretKeyHex, {
    kind: GROUP_CHAT_KIND,
    tags: [["h", TOP_LEVEL_GROUP_ID]],
    content,
  });
}

function presence(secretKeyHex: string, status: "here" | "leave"): NostrEvent {
  return signEvent(secretKeyHex, {
    kind: CALL_PRESENCE_KIND,
    tags: [["h", TOP_LEVEL_GROUP_ID]],
    content: JSON.stringify({ status }),
  });
}

async function addMember(pubkey: string): Promise<void> {
  const conn = await connect();
  const [, , ok] = await publish(
    conn,
    signEvent(OWNER_SECRET_KEY_HEX, {
      kind: PUT_USER_KIND,
      tags: [["h", TOP_LEVEL_GROUP_ID], ["p", pubkey]],
    }),
  );
  expect(ok).toBe(true);
  conn.close();
}

async function joinGroup() {
  const keypair = randomKeypair();
  await addMember(keypair.pubkeyHex);
  return keypair;
}

// Publishes one chat message and drains whatever it queued, which is the
// two halves of a real push: the write path queues, the alarm sends.
async function sendChat(author: { secretKeyHex: string }): Promise<void> {
  const conn = await connect();
  const [, , ok] = await publish(conn, chat(author.secretKeyHex, "anybody there"));
  expect(ok).toBe(true);
  conn.close();
  await fireAlarm();
}

// The same entry point a real scheduled alarm reaches -- see
// test/live-feed.test.ts, which drives the lifetime sweep the same way.
async function fireAlarm(): Promise<void> {
  await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
}

async function lastOkAt(endpoint: string): Promise<number | null> {
  return runInDurableObject(stub(), (_i: Relay, state) => {
    const row = state.storage.sql
      .exec<{ last_ok_at: number | null }>(
        `SELECT last_ok_at FROM push_subscriptions WHERE endpoint = ?`,
        endpoint,
      )
      .toArray()[0];
    return row?.last_ok_at ?? null;
  });
}

async function presenceRow(pubkey: string): Promise<number | null> {
  return runInDurableObject(stub(), (_i: Relay, state) => {
    const row = state.storage.sql
      .exec<{ last_seen: number }>(`SELECT last_seen FROM presence WHERE pubkey = ?`, pubkey)
      .toArray()[0];
    return row?.last_seen ?? null;
  });
}

// Ages the in-memory tier out of the way without evicting the object,
// which is the one thing a test cannot do directly. Writing a watermark
// far enough in the past makes the next beat fall outside
// PRESENCE_WRITE_INTERVAL_SECONDS and consult storage again.
async function clearPresenceMemory(): Promise<void> {
  await runInDurableObject(stub(), (instance: Relay) => {
    const map = (instance as unknown as { presenceWrites: Map<string, number> }).presenceWrites;
    for (const key of map.keys()) map.set(key, -PRESENCE_WRITE_INTERVAL_SECONDS * 10);
  });
}

// Rows written by the presence path specifically, off the same
// SqlStorageCursor.rowsWritten the write meter reads (read-metrics.ts
// instruments every query this object issues). Attributed rather than
// summed over the whole database, because a claim about the presence path
// has to be measured on the presence path: the totals move for a
// connection opening, an alarm firing and the meter landing its own
// residue, none of which is a heartbeat.
function presenceRowsWritten(): number {
  return writeMetricsSnapshot().paths.find((p) => p.path === "presence")?.rowsWritten ?? 0;
}

async function measurePresenceWrites(run: () => Promise<void>): Promise<number> {
  const before = presenceRowsWritten();
  await run();
  return presenceRowsWritten() - before;
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
