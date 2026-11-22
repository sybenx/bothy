// The restore vault (src/vault.ts): members store a passkey-locked copy of
// their key, and a new phone gets it back with a passkey assertion and no
// signature. Above all, the unsigned calls must not tell a stranger who
// has a row here.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_VAULT_CALLS_PER_IP_PER_WINDOW,
  MAX_VAULT_OPENS_PER_HASH_PER_WINDOW,
  MEMBER_REMOVAL_GRACE_SECONDS,
  VAULT_OPEN_FLOOR_MS,
  VAULT_ROWS_PER_MEMBER,
} from "../src/limits";
import { MANAGEMENT_CONTENT_TYPE, NOT_A_MEMBER_REASON } from "../src/nip86";
import type { Relay } from "../src/relay";
import { sweepFormerMembers } from "../src/storage";
import {
  COSE_EDDSA,
  COSE_ES256,
  COSE_RS256,
  derToRawEcdsa,
  toBase64url,
  VAULT_FULL_MESSAGE,
  VAULT_NOT_FOUND,
  VAULT_RATE_LIMITED,
  VAULT_RP_ID,
} from "../src/vault";
import { isolateStorage } from "./helpers/isolate";
import { callManagement, MANAGEMENT_URL } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.VAULT_STORAGE_BYTES;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.31.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function as(who: Keypair, method: string, params: unknown[] = []) {
  return callManagement(method, params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function newMember(): Promise<Keypair> {
  const code = ((await callManagement("createinvite")).result as { code: string }).code;
  const who = randomKeypair();
  expect((await as(who, "redeeminvite", [code])).result).toBe(true);
  return who;
}

// ---------------------------------------------------------------------
// A software passkey: a key pair, a credential id, and a WebAuthn
// assertion over whatever challenge it is handed.
// ---------------------------------------------------------------------

interface Passkey {
  alg: number;
  credentialId: Uint8Array;
  hash: string;
  publicKey: string;
  privateKey: CryptoKey;
  counter: number;
}

async function makePasskey(alg = COSE_ES256): Promise<Passkey> {
  const params =
    alg === COSE_ES256
      ? { name: "ECDSA", namedCurve: "P-256" }
      : alg === COSE_EDDSA
        ? { name: "Ed25519" }
        : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const credentialId = randomBytes(32);
  return {
    alg,
    credentialId,
    hash: bytesToHex(sha256(credentialId)),
    publicKey: toBase64url(spki),
    privateKey: pair.privateKey,
    counter: 0,
  };
}

// P1363 r||s to the DER WebAuthn sends.
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let out = bytes.subarray(i);
    if (out[0]! & 0x80) out = Uint8Array.from([0, ...out]);
    return [0x02, out.length, ...out];
  };
  const body = [...int(raw.subarray(0, 32)), ...int(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

interface AssertionOptions {
  origin?: string;
  rpId?: string;
  flags?: number;
  type?: string;
  counter?: number;
  userHandle?: string | null;
  signWith?: Passkey;
}

async function assert(passkey: Passkey, challenge: string, opts: AssertionOptions = {}) {
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({
      type: opts.type ?? "webauthn.get",
      challenge,
      origin: opts.origin ?? "https://dms.aaro.cc",
      crossOrigin: false,
    }),
  );
  const authData = new Uint8Array(37);
  authData.set(sha256(new TextEncoder().encode(opts.rpId ?? VAULT_RP_ID)), 0);
  authData[32] = opts.flags ?? 0x05;
  new DataView(authData.buffer).setUint32(33, opts.counter ?? passkey.counter);
  const signed = new Uint8Array([...authData, ...sha256(clientDataJSON)]);
  const signer = opts.signWith ?? passkey;
  const algorithm =
    signer.alg === COSE_ES256
      ? { name: "ECDSA", hash: "SHA-256" }
      : signer.alg === COSE_EDDSA
        ? { name: "Ed25519" }
        : { name: "RSASSA-PKCS1-v1_5" };
  let signature: Uint8Array = new Uint8Array(await crypto.subtle.sign(algorithm, signer.privateKey, signed));
  if (signer.alg === COSE_ES256) signature = rawToDer(signature);
  return {
    id: toBase64url(passkey.credentialId),
    rawId: toBase64url(passkey.credentialId),
    type: "public-key",
    response: {
      clientDataJSON: toBase64url(clientDataJSON),
      authenticatorData: toBase64url(authData),
      signature: toBase64url(signature),
      ...(opts.userHandle === null ? {} : { userHandle: opts.userHandle }),
    },
  };
}

function blobFor(
  owner: Keypair | string,
  passkey: Passkey,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    v: 2,
    pubkey: typeof owner === "string" ? owner : owner.pubkeyHex,
    cred: toBase64url(passkey.credentialId),
    iv: toBase64url(randomBytes(12)),
    ct: toBase64url(randomBytes(48)),
    ...extra,
  };
}

function putParams(owner: Keypair, passkey: Passkey, fields: Record<string, unknown> = {}) {
  return [
    passkey.hash,
    {
      credentialId: toBase64url(passkey.credentialId),
      publicKey: passkey.publicKey,
      alg: passkey.alg,
      blob: blobFor(owner, passkey),
      label: "Google Password Manager",
      ...fields,
    },
  ];
}

// An unsigned call, answered as raw bytes and headers so two answers can
// be compared exactly.
async function unsigned(method: string, params: unknown[] = [], ip = freshIp()) {
  const started = Date.now();
  const response = await exports.default.fetch(
    new Request(MANAGEMENT_URL, {
      method: "POST",
      headers: { "Content-Type": MANAGEMENT_CONTENT_TYPE, "CF-Connecting-IP": ip },
      body: JSON.stringify({ method, params }),
    }),
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    bytes,
    text,
    body: JSON.parse(text) as { result?: unknown; error?: string },
    elapsed: Date.now() - started,
  };
}

async function challenge(ip = freshIp()): Promise<string> {
  const reply = await unsigned("vaultchallenge", [], ip);
  expect(reply.body.error).toBeUndefined();
  return (reply.body.result as { challenge: string }).challenge;
}

async function open(passkey: Passkey, opts: AssertionOptions & { challenge?: string; hash?: string } = {}) {
  const c = opts.challenge ?? (await challenge());
  return unsigned("vaultopen", [opts.hash ?? passkey.hash, await assert(passkey, c, opts)]);
}

async function stored(
  member: Keypair,
  passkey = makePasskey(),
): Promise<{ passkey: Passkey; blob: Record<string, unknown> }> {
  const key = await passkey;
  const params = putParams(member, key);
  const reply = await as(member, "vaultput", params);
  expect(reply.error).toBeUndefined();
  expect(reply.result).toBe(true);
  return { passkey: key, blob: (params[1] as { blob: Record<string, unknown> }).blob };
}

async function sqlRows<T>(query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(stub(), (_i: Relay, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
}

// ---------------------------------------------------------------------

describe("discovery", () => {
  it("lists the five methods and advertises restore on NIP-11", async () => {
    const methods = (await callManagement("supportedmethods")).result as string[];
    for (const m of ["vaultput", "vaultlist", "vaultdelete", "vaultchallenge", "vaultopen"]) {
      expect(methods).toContain(m);
    }
    const info = await (
      await exports.default.fetch(new Request(MANAGEMENT_URL, { headers: { Accept: "application/nostr+json" } }))
    ).json<Record<string, unknown>>();
    expect(info.restore).toEqual({ v: 1 });
  });
});

describe("a member's own rows", () => {
  it("puts, lists without blobs, and deletes", async () => {
    const alice = await newMember();
    const { passkey } = await stored(alice);
    const list = (await as(alice, "vaultlist")).result as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      hash: passkey.hash,
      credentialId: toBase64url(passkey.credentialId),
      publicKey: passkey.publicKey,
      alg: COSE_ES256,
      label: "Google Password Manager",
      lastUsedAt: null,
    });
    expect(list[0]).not.toHaveProperty("blob");
    // Someone else's list does not show it, and their delete does nothing.
    const bob = await newMember();
    expect((await as(bob, "vaultlist")).result).toEqual([]);
    expect((await as(bob, "vaultdelete", [passkey.hash])).result).toBe(true);
    expect(((await as(alice, "vaultlist")).result as unknown[]).length).toBe(1);
    // Idempotent for the owner of the row.
    expect((await as(alice, "vaultdelete", [passkey.hash])).result).toBe(true);
    expect((await as(alice, "vaultdelete", [passkey.hash])).result).toBe(true);
    expect((await as(alice, "vaultlist")).result).toEqual([]);
  });

  it("lets the owner keep a row too", async () => {
    const passkey = await makePasskey();
    const params = putParams({ pubkeyHex: OWNER_PUBKEY_HEX, secretKeyHex: "" }, passkey);
    expect((await callManagement("vaultput", params)).result).toBe(true);
    expect(((await callManagement("vaultlist")).result as unknown[]).length).toBe(1);
  });

  it("refuses a stranger", async () => {
    const stranger = randomKeypair();
    const passkey = await makePasskey();
    const reply = await as(stranger, "vaultput", putParams(stranger, passkey));
    expect([reply.status, reply.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });

  it("refuses a blob that names someone else or another credential", async () => {
    const alice = await newMember();
    const passkey = await makePasskey();
    const other = await makePasskey();
    const wrongPubkey = await as(alice, "vaultput", putParams(alice, passkey, { blob: blobFor(OWNER_PUBKEY_HEX, passkey) }));
    expect(wrongPubkey.error).toBe("vaultput: the blob must name your own pubkey");
    const wrongCred = await as(alice, "vaultput", putParams(alice, passkey, { blob: blobFor(alice, other) }));
    expect(wrongCred.error).toBe("vaultput: the blob must name this credential");
    const wrongHash = await as(alice, "vaultput", [other.hash, putParams(alice, passkey)[1]]);
    expect(wrongHash.error).toBe("vaultput: the hash must be the sha256 of the credential id");
    expect((await as(alice, "vaultlist")).result).toEqual([]);
  });

  it("takes the blob as a JSON string too, and gives back the object", async () => {
    const alice = await newMember();
    const passkey = await makePasskey();
    const blob = blobFor(alice, passkey);
    expect((await as(alice, "vaultput", putParams(alice, passkey, { blob: JSON.stringify(blob) }))).result).toBe(true);
    expect((await open(passkey)).body).toEqual({ result: { blob } });
    const notObject = await as(alice, "vaultput", putParams(alice, passkey, { blob: [1] }));
    expect(notObject.error).toBe("vaultput: blob must be the locked copy, a JSON object");
  });

  it("refuses a blob over 1 KB, a bad key and an unknown alg", async () => {
    const alice = await newMember();
    const passkey = await makePasskey();
    const big = await as(alice, "vaultput", putParams(alice, passkey, { blob: blobFor(alice, passkey, { pad: "x".repeat(1000) }) }));
    expect(big.error).toBe("vaultput: blob can be at most 1024 bytes");
    const badKey = await as(alice, "vaultput", putParams(alice, passkey, { publicKey: toBase64url(randomBytes(91)) }));
    expect(badKey.error).toBe("vaultput: publicKey is not a public key of that alg");
    const mismatched = await as(alice, "vaultput", putParams(alice, passkey, { alg: COSE_EDDSA }));
    expect(mismatched.error).toBe("vaultput: publicKey is not a public key of that alg");
    const alg = await as(alice, "vaultput", putParams(alice, passkey, { alg: -35 }));
    expect(alg.error).toBe("vaultput: alg must be -7 (ES256), -8 (EdDSA) or -257 (RS256)");
  });

  it("refuses a row another account owns", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const { passkey } = await stored(alice);
    const reply = await as(bob, "vaultput", putParams(bob, passkey));
    expect(reply.error).toBe("vaultput: this passkey belongs to another account");
  });

  it(`keeps at most ${VAULT_ROWS_PER_MEMBER} rows each, and an update is not a new row`, async () => {
    const alice = await newMember();
    const keys: Passkey[] = [];
    for (let i = 0; i < VAULT_ROWS_PER_MEMBER; i++) keys.push((await stored(alice)).passkey);
    const extra = await makePasskey();
    expect((await as(alice, "vaultput", putParams(alice, extra))).error).toBe(
      `vaultput: at most ${VAULT_ROWS_PER_MEMBER} passkeys each. Remove one first.`,
    );
    expect((await as(alice, "vaultput", putParams(alice, keys[0]!, { label: "renamed" }))).result).toBe(true);
    await as(alice, "vaultdelete", [keys[1]!.hash]);
    expect((await as(alice, "vaultput", putParams(alice, extra))).result).toBe(true);
  });

  it("refuses when the vault's share of the budget is full", async () => {
    const alice = await newMember();
    await stored(alice);
    mutableEnv.VAULT_STORAGE_BYTES = "600";
    expect((await as(alice, "vaultput", putParams(alice, await makePasskey()))).error).toBe(VAULT_FULL_MESSAGE);
  });
});

describe("vaultopen", () => {
  it("gives the blob back for a good ES256 assertion, with no signature, and records the use", async () => {
    const alice = await newMember();
    const { passkey, blob } = await stored(alice);
    const reply = await open(passkey, { userHandle: toBase64url(hexToBytes(alice.pubkeyHex)) });
    expect(reply.body).toEqual({ result: { blob } });
    const row = ((await as(alice, "vaultlist")).result as { lastUsedAt: number | null; addedAt: number }[])[0]!;
    expect(row.lastUsedAt).not.toBeNull();
    expect(row.addedAt).toBeGreaterThan(1_700_000_000);
  });

  it("verifies EdDSA and RS256 passkeys too", async () => {
    const alice = await newMember();
    for (const alg of [COSE_EDDSA, COSE_RS256]) {
      const { passkey, blob } = await stored(alice, makePasskey(alg));
      expect((await open(passkey)).body).toEqual({ result: { blob } });
    }
  });

  it("accepts the Android apps' origins", async () => {
    const alice = await newMember();
    const { passkey, blob } = await stored(alice);
    for (const origin of [
      "android:apk-key-hash:efbXU0b5eHPEQgq1uPc1oMys86-mHv1gGEaRCMQdbu8",
      "android:apk-key-hash:RYdjcYY-ch01dNLVkJK4CP-oA1WD2z1kIyXoXlF8zO4",
    ]) {
      expect((await open(passkey, { origin })).body).toEqual({ result: { blob } });
    }
  });

  it("spends a challenge once", async () => {
    const alice = await newMember();
    const { passkey, blob } = await stored(alice);
    const c = await challenge();
    expect((await open(passkey, { challenge: c })).body).toEqual({ result: { blob } });
    expect((await open(passkey, { challenge: c })).body).toEqual({ error: VAULT_NOT_FOUND });
  });

  it("refuses a forged challenge, a wrong origin, a wrong RP ID, no user verification and a stale counter", async () => {
    const alice = await newMember();
    const { passkey } = await stored(alice);
    const forged = toBase64url(randomBytes(36));
    const cases: (AssertionOptions & { challenge?: string })[] = [
      { challenge: forged },
      { origin: "https://evil.example" },
      { rpId: "evil.example" },
      { flags: 0x01 },
      { type: "webauthn.create" },
      { userHandle: toBase64url(hexToBytes(OWNER_PUBKEY_HEX)) },
      { signWith: await makePasskey() },
    ];
    for (const c of cases) expect((await open(passkey, c)).body).toEqual({ error: VAULT_NOT_FOUND });
    passkey.counter = 5;
    expect((await open(passkey)).body.result).toBeDefined();
    expect((await open(passkey)).body).toEqual({ error: VAULT_NOT_FOUND });
    passkey.counter = 6;
    expect((await open(passkey)).body.result).toBeDefined();
  });

  it("answers a known-but-wrong call and an unknown one with identical bytes, and spends both challenges", async () => {
    const alice = await newMember();
    const { passkey, blob } = await stored(alice);
    const unknown = await makePasskey();

    const knownChallenge = await challenge();
    const unknownChallenge = await challenge();
    // Known row, signed by the wrong key.
    const known = await open(passkey, { challenge: knownChallenge, signWith: unknown });
    // No row at all, otherwise a perfectly good assertion.
    const missing = await open(unknown, { challenge: unknownChallenge });

    expect(known.status).toBe(missing.status);
    expect(known.headers).toEqual(missing.headers);
    expect(bytesToHex(known.bytes)).toBe(bytesToHex(missing.bytes));
    expect(known.text).toBe(JSON.stringify({ error: VAULT_NOT_FOUND }));
    for (const reply of [known, missing]) expect(reply.elapsed).toBeGreaterThanOrEqual(VAULT_OPEN_FLOOR_MS - 5);

    // Both challenges are gone: the right assertion over either fails.
    expect((await open(passkey, { challenge: knownChallenge })).body).toEqual({ error: VAULT_NOT_FOUND });
    expect((await open(passkey, { challenge: unknownChallenge })).body).toEqual({ error: VAULT_NOT_FOUND });
    expect((await open(passkey)).body).toEqual({ result: { blob } });
  });

  it("answers garbage with the same not-found body", async () => {
    const replies = await Promise.all([
      unsigned("vaultopen", []),
      unsigned("vaultopen", ["zz", {}]),
      unsigned("vaultopen", [bytesToHex(randomBytes(32)), { response: {} }]),
    ]);
    for (const reply of replies) expect(reply.text).toBe(JSON.stringify({ error: VAULT_NOT_FOUND }));
  });

  it("rate-limits by hash whether or not the row exists, identically", async () => {
    const alice = await newMember();
    const { passkey } = await stored(alice);
    const unknown = await makePasskey();
    const burst = (key: Passkey) =>
      Promise.all(
        Array.from({ length: MAX_VAULT_OPENS_PER_HASH_PER_WINDOW + 1 }, async () =>
          unsigned("vaultopen", [key.hash, await assert(key, "x".repeat(48))]),
        ),
      );
    const knownReplies = await burst(passkey);
    const unknownReplies = await burst(unknown);
    const count = (replies: { body: { error?: string } }[], error: string) =>
      replies.filter((r) => r.body.error === error).length;
    expect(count(knownReplies, VAULT_RATE_LIMITED)).toBe(1);
    expect(count(unknownReplies, VAULT_RATE_LIMITED)).toBe(1);
    expect(count(knownReplies, VAULT_NOT_FOUND)).toBe(MAX_VAULT_OPENS_PER_HASH_PER_WINDOW);
    expect(count(unknownReplies, VAULT_NOT_FOUND)).toBe(MAX_VAULT_OPENS_PER_HASH_PER_WINDOW);
  });

  it("rate-limits challenges per address", async () => {
    const ip = freshIp();
    const replies = [];
    for (let i = 0; i <= MAX_VAULT_CALLS_PER_IP_PER_WINDOW; i++) replies.push(await unsigned("vaultchallenge", [], ip));
    expect(replies.slice(0, -1).every((r) => r.body.result !== undefined)).toBe(true);
    expect(replies.at(-1)!.body).toEqual({ error: VAULT_RATE_LIMITED });
  });
});

describe("leaving", () => {
  it("eraseme deletes the rows at once", async () => {
    const alice = await newMember();
    const { passkey } = await stored(alice);
    expect((await as(alice, "eraseme")).error).toBeUndefined();
    expect((await open(passkey)).body).toEqual({ error: VAULT_NOT_FOUND });
    expect(await sqlRows(`SELECT hash FROM vault`)).toEqual([]);
  });

  it("keeps a removed member's rows read-only for the grace period, then drops them", async () => {
    const alice = await newMember();
    const { passkey, blob } = await stored(alice);
    expect((await callManagement("unallowpubkey", [alice.pubkeyHex])).result).toBe(true);

    // Open still works; put does not.
    expect((await open(passkey)).body).toEqual({ result: { blob } });
    const put = await as(alice, "vaultput", putParams(alice, await makePasskey()));
    expect([put.status, put.error]).toEqual([401, NOT_A_MEMBER_REASON]);

    const removedAt = (
      await sqlRows<{ removed_at: number }>(`SELECT removed_at FROM former_members WHERE pubkey = ?`, alice.pubkeyHex)
    )[0]!.removed_at;
    const sweep = (nowSec: number) =>
      runInDurableObject(stub(), (_i: Relay, state) =>
        sweepFormerMembers(state.storage.sql, nowSec, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100),
      );
    await sweep(removedAt + MEMBER_REMOVAL_GRACE_SECONDS - 1);
    expect((await sqlRows(`SELECT hash FROM vault`)).length).toBe(1);
    await sweep(removedAt + MEMBER_REMOVAL_GRACE_SECONDS);
    expect(await sqlRows(`SELECT hash FROM vault`)).toEqual([]);
    expect((await open(passkey)).body).toEqual({ error: VAULT_NOT_FOUND });
  });
});

describe("derToRawEcdsa", () => {
  it("round-trips short integers and refuses garbage", () => {
    const raw = new Uint8Array(64);
    raw[31] = 7;
    raw[32] = 0x80;
    raw[63] = 1;
    expect(bytesToHex(derToRawEcdsa(rawToDer(raw)))).toBe(bytesToHex(raw));
    expect(bytesToHex(derToRawEcdsa(randomBytes(10)))).toBe("00".repeat(64));
  });
});
