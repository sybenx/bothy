// A browser's half of web push, for the tests that check what the relay
// sends (test/push.test.ts, test/members.test.ts): a subscription made the
// way a browser makes one, and the RFC 8291 + RFC 8188 decryption a browser
// does before handing the plaintext to a service worker.
import { expect } from "vitest";

export function b64uEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function b64uDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
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
export interface FakeDevice {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  privateKey: CryptoKey;
  auth: Uint8Array;
  p256dh: Uint8Array;
}

export async function makeDevice(endpoint: string): Promise<FakeDevice> {
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
export async function decryptPush(device: FakeDevice, body: Uint8Array): Promise<string> {
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
