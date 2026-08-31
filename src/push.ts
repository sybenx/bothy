// Web push: RFC 8291 message encryption and RFC 8292 VAPID
// authorization, written against the platform's own WebCrypto rather than
// against a library.
//
// WHY NO LIBRARY. The npm packages that do this -- `web-push` and the
// wrappers around it -- are written for Node: they `require("crypto")`
// for ECDH and AES-GCM, `require("https")` to make the request, and
// `crypto.createECDH()` in particular has no Workers equivalent at all.
// None of it runs here, and the parts that do would drag a second crypto
// stack in beside @noble, which CLAUDE.md "Conventions" rules out. The
// alternative was checked rather than assumed: everything RFC 8291 needs
// -- P-256 ECDH, HKDF-SHA256, AES-128-GCM -- and everything RFC 8292
// needs -- ECDSA P-256 over SHA-256, emitting the raw r||s form JWS calls
// ES256 -- is native `crypto.subtle` on workerd, and native is also
// faster than any JS implementation on a 10ms CPU budget.
//
// The ONE thing WebCrypto cannot do is derive a public key from a bare
// private scalar: `importKey` wants a JWK carrying x and y, which is the
// thing being derived. That is one point multiplication, and @noble is
// already a dependency, so `p256.getPublicKey` does it -- once per key,
// memoised below -- and everything else is `crypto.subtle`.
//
// The client half of this contract is hearth's reference/push.md: it
// reads `push_key` off the NIP-11 document (nip11.ts), subscribes with
// it, and hands the subscription over as the NIP-86 call in nip86.ts.
import { p256 } from "@noble/curves/nist.js";
import {
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_RECORD_SIZE,
  PUSH_TTL_SECONDS,
  VAPID_JWT_LIFETIME_SECONDS,
} from "./limits";

// NIP-29's own chat kind ("kind 9 is a chat message"), and the kind a
// message notification is raised for.
export const GROUP_CHAT_KIND = 9;

// hearth's call presence beat -- its own kind, in the ephemeral range, no
// NIP behind it (reference/push.md, hearth's kinds.js). Nothing is stored
// for one; what the relay keeps is the last-seen watermark in
// storage.ts, and only the absent-to-present transition raises a
// notification. See limits.ts PRESENCE_WRITE_INTERVAL_SECONDS.
export const CALL_PRESENCE_KIND = 25051;

// The two things worth waking a phone for, and the exact strings hearth's
// service worker switches on: "voice" renders as "somebody is at the
// fire", anything else as "there's a message".
export type PushReason = "message" | "voice";

// What a push carries, and deliberately all it carries. reference/push.md
// "What it must not do": no message content and no name -- the payload
// travels through Apple's or Google's push service to reach the phone,
// and neither the contents of the room nor who is in it are theirs to
// hold. The room name is already public: it is the NIP-11 `name` any
// client can fetch unauthenticated.
export interface PushPayload {
  room: string;
  kind: PushReason;
}

// One stored subscription, as the fan-out needs it.
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// What a send resolved to, and what the caller does about it.
// reference/push.md "Cleanup": 404 or 410 means the endpoint is gone for
// good and the row should go; anything else is worth a retry and is not
// worth a deletion.
export type PushOutcome = "sent" | "gone" | "failed";

// ---------------------------------------------------------------------
// base64url, unpadded, in both directions. The whole of web push speaks
// it: the VAPID key on the NIP-11 document, both subscription keys, and
// every segment of the JWT.
// ---------------------------------------------------------------------

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Returns null rather than throwing on anything that is not base64url, so
// a malformed subscription from a client and a malformed key from the
// environment both fail as "absent" rather than as an exception on a path
// that has no business throwing.
function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const utf8 = new TextEncoder();

// ---------------------------------------------------------------------
// The VAPID keypair (RFC 8292).
//
// ONE SECRET, NOT TWO. `VAPID_PRIVATE_KEY` is the 32-byte P-256 scalar in
// base64url -- the same form every web push tool calls "the private key"
// -- and the public half is DERIVED from it here rather than configured
// beside it. Two configured halves can disagree; a derived one cannot,
// and a relay advertising a `push_key` that does not match the key it
// signs with would produce subscriptions that can never be pushed to and
// no error anywhere saying why.
//
// It is a SECRET, never a var: wrangler.jsonc declares no `vars` block at
// all (see the comment there), and a git-connected Worker may sync vars
// from that config on deploy and overwrite what was set in the dashboard
// -- which for a private key would mean the repository silently deciding
// what it is. `wrangler secret put VAPID_PRIVATE_KEY` is the only way in,
// secrets are never read back out of the config, and env.d.ts declares it
// optional like every other variable in this project.
//
// Unset is a first-class state and not an error. No key means no
// `push_key` on the NIP-11 document, which means hearth never subscribes,
// which means no subscription rows, no outbox rows and no alarm -- see
// reference/push.md: "A relay that never advertises a `push_key` never
// learns any of it, and hearth works."
// ---------------------------------------------------------------------

export interface VapidKeys {
  secret: Uint8Array;
  // Uncompressed SEC1 (65 bytes, 0x04 || x || y), base64url -- the exact
  // string a browser wants as `applicationServerKey` and the exact string
  // that goes on the NIP-11 document as `push_key`.
  publicKey: string;
  // JWK form of the private half, ready for crypto.subtle.importKey. Held
  // rather than rebuilt because it is derived from the point multiply
  // above and neither half ever changes for a given secret.
  jwk: JsonWebKey;
}

// Memoised on the raw environment string, the same shape and for the same
// reason as ownership.ts getOwnerPubkey: this is read on the NIP-11 path
// and once per push fan-out, and the derivation is an elliptic curve
// point multiplication. A Map rather than a single slot so a test that
// swaps the variable is not answered from the previous value.
const vapidCache = new Map<string, VapidKeys | null>();

export function vapidKeys(env: Env): VapidKeys | null {
  const raw = env.VAPID_PRIVATE_KEY;
  if (!raw) return null;
  const cached = vapidCache.get(raw);
  if (cached !== undefined) return cached;
  const resolved = deriveVapidKeys(raw);
  if (resolved === null) {
    // Logged, not thrown. A malformed key is an operator mistake on an
    // optional feature, and the honest failure is the one push.md already
    // describes for an absent key -- no push_key, no subscriptions, no
    // errors anywhere a client can see. Silence would leave an operator
    // who set the variable wondering why nothing happened.
    console.warn(
      "push: VAPID_PRIVATE_KEY is not a base64url-encoded 32-byte P-256 secret key, so push is disabled. " +
        "Generate one with any web-push tool and set it with `wrangler secret put VAPID_PRIVATE_KEY`.",
    );
  }
  vapidCache.set(raw, resolved);
  return resolved;
}

function deriveVapidKeys(raw: string): VapidKeys | null {
  const secret = base64UrlDecode(raw.trim());
  if (secret === null || secret.length !== 32) return null;
  try {
    if (!p256.utils.isValidSecretKey(secret)) return null;
    // The one line WebCrypto cannot replace -- see the header comment.
    const uncompressed = p256.getPublicKey(secret, false);
    return {
      secret,
      publicKey: base64UrlEncode(uncompressed),
      jwk: {
        kty: "EC",
        crv: "P-256",
        d: base64UrlEncode(secret),
        x: base64UrlEncode(uncompressed.subarray(1, 33)),
        y: base64UrlEncode(uncompressed.subarray(33, 65)),
        ext: true,
      },
    };
  } catch {
    return null;
  }
}

// Whether this deployment can push at all. Read by nip86.ts, which
// refuses a subscription rather than storing one it can never use, and by
// relay.ts, which queues nothing when this is false -- so an unconfigured
// relay writes no rows and schedules no alarms for a feature it does not
// have.
export function pushConfigured(env: Env): boolean {
  return vapidKeys(env) !== null;
}

// The public half, for the NIP-11 document. Null while unconfigured, and
// the field is omitted rather than emitted empty -- the same rule
// nip11.ts already applies to `icon`, `pubkey` and `contact`.
export function pushPublicKey(env: Env): string | null {
  return vapidKeys(env)?.publicKey ?? null;
}

// ---------------------------------------------------------------------
// RFC 8292: the Authorization header.
//
// One JWT per push service ORIGIN, not per endpoint -- the `aud` claim is
// the origin and nothing else in the token varies, so twenty phones
// behind one FCM origin share one signature. That matters: signing is the
// only per-send cost here that is not native, and a fan-out that signed
// once per endpoint would pay it forty times for one answer.
// ---------------------------------------------------------------------

async function signVapid(keys: VapidKeys, origin: string, subject: string, nowSec: number): Promise<string> {
  const header = base64UrlEncode(utf8.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64UrlEncode(
    utf8.encode(
      JSON.stringify({
        aud: origin,
        exp: nowSec + VAPID_JWT_LIFETIME_SECONDS,
        sub: subject,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    keys.jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto emits the raw r||s pair (IEEE P1363), which is exactly what
  // JWS ES256 wants. Node's crypto emits DER instead, which is the one
  // place a port of a Node implementation would silently produce a token
  // every push service rejects.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(signingInput)),
  );
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

// ---------------------------------------------------------------------
// RFC 8291 + RFC 8188: the body.
//
// Every step below is the spec's own, in the spec's own order:
//
//   ecdh_secret = ECDH(ephemeral private, subscription p256dh)
//   IKM         = HKDF(salt = auth secret, ikm = ecdh_secret,
//                      info = "WebPush: info" || 0x00 || ua || as, 32)
//   PRK/CEK     = HKDF(salt = record salt, ikm = IKM,
//                      info = "Content-Encoding: aes128gcm" || 0x00, 16)
//   NONCE       = HKDF(same salt and IKM,
//                      info = "Content-Encoding: nonce" || 0x00, 12)
//   body        = salt || rs || idlen || as || AES128GCM(plaintext || 0x02)
//
// WebCrypto's HKDF does extract and expand in one call, which is what
// each of those three lines is; the trailing 0x02 is RFC 8188's
// last-record padding delimiter, not padding we chose.
// ---------------------------------------------------------------------

async function encryptPayload(target: PushTarget, payload: PushPayload): Promise<Uint8Array | null> {
  const uaPublic = base64UrlDecode(target.p256dh);
  const authSecret = base64UrlDecode(target.auth);
  // Validated again here even though nip86.ts validates on the way in: a
  // row stored by an older, laxer version of that check would otherwise
  // reach `importKey` and throw inside the fan-out, where one bad row
  // would take out the whole batch.
  if (uaPublic === null || uaPublic.length !== 65 || uaPublic[0] !== 0x04) return null;
  if (authSecret === null || authSecret.length !== 16) return null;

  const plaintext = utf8.encode(JSON.stringify(payload));
  // The record has to hold the plaintext, the 0x02 delimiter and the
  // 16-byte GCM tag. Refused rather than truncated: a truncated payload
  // decrypts to broken JSON, and hearth's service worker would raise a
  // notification with the wrong room name on it.
  if (plaintext.length > PUSH_PAYLOAD_MAX_BYTES) return null;

  // Casts, twice, and both are workerd's generated types rather than
  // anything unusual at runtime. `generateKey` is typed as returning
  // `CryptoKey | CryptoKeyPair` because one signature covers symmetric
  // and asymmetric algorithms; ECDH always yields a pair. `exportKey` is
  // typed as returning `ArrayBuffer | JsonWebKey` for the same reason;
  // "raw" always yields the buffer.
  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );
  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // `public` is EcdhKeyDeriveParams' own member name (W3C WebCrypto).
      // worker-configuration.d.ts spells it `$public` -- that is the
      // type generator escaping a C++ keyword, not the property workerd
      // reads at runtime, so the cast is what keeps the spec-correct name
      // on the object. test/push.test.ts decrypts a real body, which is
      // what would catch this being wrong.
      { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    ),
  );

  const ecdhKey = await crypto.subtle.importKey("raw", ecdhSecret, "HKDF", false, ["deriveBits"]);
  const keyInfo = concat(utf8.encode("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: authSecret, info: keyInfo },
      ecdhKey,
      256,
    ),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const ikmKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const cekBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: concat(utf8.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
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
        info: concat(utf8.encode("Content-Encoding: nonce"), new Uint8Array([0])),
      },
      ikmKey,
      96,
    ),
  );

  const cek = await crypto.subtle.importKey("raw", cekBits, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      cek,
      concat(plaintext, new Uint8Array([0x02])),
    ),
  );

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, PUSH_RECORD_SIZE, false);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

// RFC 8292: "the `sub` claim... SHOULD include a contact URI for the
// application server as either a `mailto:` (email) or an `https:` URI".
// It is what a push service operator reads when this deployment's traffic
// causes them a problem, so it wants to identify the deployment and not
// the project.
//
// The relay's own https origin, learned from traffic (host.ts) rather
// than configured -- there is no way to know it at deploy time, since the
// Worker's name is whatever the deployer typed and a custom domain can be
// attached later. The upstream project URL is the fallback for the window
// before any request has reached this object, which in practice does not
// happen: a subscription only exists because a management POST arrived,
// and every request that reaches the Durable Object records the host.
export function pushSubject(host: string | null): string {
  return host === null ? "https://github.com/sybenx/bothy" : `https://${host}`;
}

// ---------------------------------------------------------------------
// One send.
//
// Runs in the Durable Object's alarm handler (relay.ts), which is the one
// place in this object that reaches the network. That is not the
// exception to "the DO opens no outbound connection" it looks like: the
// rule exists because an outbound WEBSOCKET pins the object in memory for
// as long as it stays open -- up to fifteen minutes, which is why
// profile-lookup.ts and backfill-worker.ts both live in the Worker. An
// HTTPS request that completes does not; an alarm is a brief billed wake
// that the platform schedules against a hibernated object and lets
// hibernate again afterwards, exactly as the live feed's lifetime alarm
// already does. And there is no Worker-side alternative: nothing in the
// Worker runs when a WebSocket message arrives, and the hourly cron is
// three orders of magnitude too slow for a notification.
// ---------------------------------------------------------------------

export async function sendPush(
  keys: VapidKeys,
  subject: string,
  target: PushTarget,
  payload: PushPayload,
  nowSec: number,
): Promise<PushOutcome> {
  let body: Uint8Array | null;
  let origin: string;
  try {
    origin = new URL(target.endpoint).origin;
    body = await encryptPayload(target, payload);
  } catch {
    // An endpoint that no longer parses as a URL, or a key pair that no
    // longer imports. Neither will ever work again, so the row goes --
    // the same disposal a 410 gets, for the same reason.
    return "gone";
  }
  if (body === null) return "gone";

  let response: Response;
  try {
    response = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${await signVapid(keys, origin, subject, nowSec)}, k=${keys.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // RFC 8030: how long the push service may hold this if the device
        // is offline. See limits.ts PUSH_TTL_SECONDS.
        TTL: String(PUSH_TTL_SECONDS[payload.kind]),
      },
      body,
    });
  } catch (err) {
    // A network failure is not evidence the subscription is dead.
    console.warn(`push: send to ${origin} failed`, err);
    return "failed";
  }

  if (response.status === 404 || response.status === 410) return "gone";
  if (response.ok) return "sent";
  // Named rather than counted: 429 and 5xx are the ones worth knowing
  // about, and a 401/403 means the VAPID key the subscription was made
  // with is not the key being signed with -- which is what a rotation
  // looks like from here, and is not something a retry fixes.
  console.warn(`push: ${origin} answered ${response.status}`);
  return "failed";
}
