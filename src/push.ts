// Web push: RFC 8291 message encryption and RFC 8292 VAPID
// authorization, written against the platform's own WebCrypto rather than
// against a library.
//
// WHY NO LIBRARY. `web-push` and its wrappers are written for Node
// (`require("crypto")`, `require("https")`, `crypto.createECDH()`, which
// has no Workers equivalent), so they do not run on workerd, and would add
// a second crypto stack beside @noble, which this project avoids.
// Everything RFC 8291 needs (P-256 ECDH, HKDF-SHA256, AES-128-GCM) and RFC
// 8292 needs (ECDSA P-256/SHA-256 in the raw r||s form JWS calls ES256) is
// native `crypto.subtle` on workerd, which is also faster than JS on a
// 10ms CPU budget.
//
// The ONE exception: WebCrypto cannot derive a public key from a bare
// private scalar (`importKey` wants a JWK carrying the x and y being
// derived), so @noble's `p256.getPublicKey` does that, once per key,
// memoised below.
//
// The client half of this contract is hearth's reference/push.md: it reads
// `push_key` off the NIP-11 document (nip11.ts), subscribes with it, and
// hands the subscription over through nip86.ts subscribepush.
import { p256 } from "@noble/curves/nist.js";
import {
  PUSH_PAYLOAD_MAX_BYTES,
  PUSH_RECORD_SIZE,
  PUSH_TTL_SECONDS,
  VAPID_JWT_LIFETIME_SECONDS,
} from "./limits";

// NIP-29's chat kind, the kind a message notification is raised for.
// Declared in groups.ts to avoid an import cycle (see the comment there).
export { GROUP_CHAT_KIND } from "./groups";

// hearth's call presence beat -- its own kind, in the ephemeral range, no
// NIP behind it (reference/push.md, hearth's kinds.js). Nothing is stored
// for one; what the relay keeps is the last-seen watermark in
// storage.ts, and only the absent-to-present transition raises a
// notification. See limits.ts PRESENCE_WRITE_INTERVAL_SECONDS.
export const CALL_PRESENCE_KIND = 25051;

// The things worth waking a phone for, and the exact strings the apps
// switch on: hearth's service worker renders "voice" as "somebody is at
// the fire" and anything else as "there's a message"; "call" is a ring
// (relay.ts handleGiftWrap), which the DMs apps answer by fetching the
// ring wrap and ringing.
export type PushReason = "message" | "voice" | "call";

// What a push carries, and deliberately all it carries: no message content
// and no sender. The payload travels through Apple's or Google's push
// service, and neither the room's contents nor who is in it are theirs to
// hold. The room name is admissible because it is already public (the
// NIP-11 `name`). That rule is about what is put in, independent of the
// RFC 8291 encryption.
//
// What encryption cannot hide: the push service still learns which devices
// this deployment pushes to, and when. That is why push is something a
// person turns on, and a relay with no VAPID key (no `push_key`) never
// learns any of it.
//
// `label` is the one addition: the opaque tag the app gave the account
// when it subscribed (nip86.ts subscribepush), so an app holding several
// accounts on one endpoint knows which one a push is for. The app chose
// it and maps it back itself; it is never a pubkey. Absent when the app
// gave none.
export interface PushPayload {
  room: string;
  kind: PushReason;
  label?: string;
}

// The payload for one device: the shared one, plus that device's label.
export function payloadFor(payload: PushPayload, target: { label: string | null }): PushPayload {
  return target.label === null ? payload : { ...payload, label: target.label };
}

// One stored subscription, as the fan-out needs it.
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

// What a send resolved to. 404 or 410 means the endpoint is gone for good
// and the row should be deleted (reference/push.md "Cleanup"); any other
// failure is not evidence of that. There is no retry queue: a retried
// notification is stale by the time it lands.
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
// base64url, and the public half is DERIVED from it rather than configured
// beside it. Two configured halves could disagree, and a `push_key` that
// does not match the signing key yields subscriptions that can never be
// pushed to, with no error anywhere.
//
// A SECRET, never a var (`wrangler secret put VAPID_PRIVATE_KEY`): a
// git-connected Worker may sync vars from wrangler.jsonc on deploy and
// overwrite the dashboard value (see the comment there), and secrets are
// never synced from config.
//
// Unset is a supported state, not an error: no `push_key` on NIP-11, so no
// client subscribes, so no subscription rows, outbox rows or alarms.
// ---------------------------------------------------------------------

export interface VapidKeys {
  secret: Uint8Array;
  // Uncompressed SEC1 (65 bytes, 0x04 || x || y), base64url -- the exact
  // string a browser wants as `applicationServerKey` and the exact string
  // that goes on the NIP-11 document as `push_key`.
  publicKey: string;
  // JWK form of the private half, for crypto.subtle.importKey. Held because
  // building it needs the point multiplication.
  jwk: JsonWebKey;
}

// Memoised on the raw environment string: read on the NIP-11 path and per
// fan-out, and the derivation is a point multiplication. A Map rather than
// a single slot so a test that swaps the variable gets a fresh answer.
const vapidCache = new Map<string, VapidKeys | null>();

export function vapidKeys(env: Env): VapidKeys | null {
  const raw = env.VAPID_PRIVATE_KEY;
  if (!raw) return null;
  const cached = vapidCache.get(raw);
  if (cached !== undefined) return cached;
  const resolved = deriveVapidKeys(raw);
  if (resolved === null) {
    // Logged, not thrown: a malformed key behaves exactly like an absent
    // one, and the log line is the only way the operator learns why push
    // never came on.
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

// Whether this deployment can push at all. nip86.ts refuses subscriptions
// and relay.ts queues nothing when false, so an unconfigured relay writes
// no rows and schedules no alarms for push.
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
// The token depends only on the push service ORIGIN (`aud`), the subject
// and the expiry, so one signature could serve every endpoint behind one
// origin. sendPush currently signs once per send, not per origin.
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
  // WebCrypto emits the raw r||s pair (IEEE P1363), which is what JWS ES256
  // wants. Node's crypto emits DER, so code ported from Node would produce
  // a token every push service rejects.
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
  // Re-validated although nip86.ts validates on the way in: a row that
  // slipped past that check would otherwise throw in `importKey` and take
  // out the whole fan-out batch.
  if (uaPublic === null || uaPublic.length !== 65 || uaPublic[0] !== 0x04) return null;
  if (authSecret === null || authSecret.length !== 16) return null;

  const plaintext = utf8.encode(JSON.stringify(payload));
  // The record must hold the plaintext, the 0x02 delimiter and the 16-byte
  // GCM tag. Refused rather than truncated: truncation yields broken JSON
  // on the device.
  if (plaintext.length > PUSH_PAYLOAD_MAX_BYTES) return null;

  // Two casts, both for workerd's generated types: `generateKey` returns
  // `CryptoKey | CryptoKeyPair` (ECDH always yields a pair) and `exportKey`
  // returns `ArrayBuffer | JsonWebKey` ("raw" always yields the buffer).
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

// RFC 8292: the `sub` claim "SHOULD include a contact URI for the
// application server". A push service operator reads it when this
// deployment causes them trouble, so it identifies the deployment, not the
// project.
//
// The relay's own https origin, learned from traffic (host.ts) because it
// is unknowable at deploy time. The upstream URL is a fallback that should
// not occur in practice: a subscription exists only because a management
// request reached this object, and every such request records the host.
export function pushSubject(host: string | null): string {
  return host === null ? "https://github.com/sybenx/bothy" : `https://${host}`;
}

// ---------------------------------------------------------------------
// One send.
//
// Runs in the Durable Object's alarm handler (relay.ts), the one place the
// object reaches the network. This does not break the rule that the DO
// opens no outbound connection: that rule is about outbound WEBSOCKETS,
// which pin the object in memory while open (why profile-lookup.ts and
// backfill-worker.ts run in the Worker). An HTTPS request completes, and an
// alarm is a brief wake after which the object can hibernate again, like
// the live feed's lifetime alarm. The Worker cannot do this instead:
// nothing in it runs when a WebSocket message arrives, and the hourly cron
// is far too slow for a notification.
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
        // RFC 8030 Urgency: a ring must wake a device in power saving at
        // once. Everything else keeps the default (normal).
        ...(payload.kind === "call" ? { Urgency: "high" } : {}),
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
