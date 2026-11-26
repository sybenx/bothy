// Layer 1b (src/vault.ts 'box' rows, src/vouch.ts handOverToPhone): a
// passkey whose app gives no PRF is kept as a sign-in. After the same
// assertion checks as any vaultopen, the new phone gets the member's vouch
// copy sealed to a one-time key it made, and that key is bound into the
// assertion. Above all, every failure, in either form, must look the same
// to a stranger, and the 'passkey' rows must behave as they did.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_VAULT_OPENS_PER_HASH_PER_WINDOW,
  MEMBER_REMOVAL_GRACE_SECONDS,
  VAULT_OPEN_FLOOR_MS,
  VAULT_ROWS_PER_MEMBER,
  VOUCH_HISTORY_PER_MEMBER,
  VOUCH_RELEASE_DELAY_SECONDS,
} from "../src/limits";
import { conversationKey, nip44Decrypt, nip44Encrypt } from "../src/nip44";
import { MANAGEMENT_CONTENT_TYPE, NOT_A_MEMBER_REASON } from "../src/nip86";
import { readMetricsSnapshot, resetReadMetrics, writeMetricsSnapshot } from "../src/read-metrics";
import type { Relay } from "../src/relay";
import { forgetSchemaHash, initSchema } from "../src/schema";
import { sweepFormerMembers } from "../src/storage";
import {
  boundChallenge,
  COSE_ES256,
  fromBase64url,
  toBase64url,
  VAULT_FULL_MESSAGE,
  VAULT_NOT_FOUND,
  VAULT_RATE_LIMITED,
  VAULT_RP_ID,
} from "../src/vault";
import {
  NOPRF_NEEDS_COPY_MESSAGE,
  NOPRF_NOTICE,
  NOPRF_OFF_MESSAGE,
  NOPRF_RELEASED_TEXT,
  NOPRF_WHY,
} from "../src/vouch";
import { isolateStorage } from "./helpers/isolate";
import { callManagement, MANAGEMENT_URL } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.VOUCH;
  delete mutableEnv.VAULT_STORAGE_BYTES;
  delete mutableEnv.MAIL_BYTES_PER_MEMBER;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.29.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
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

async function info(): Promise<Record<string, unknown>> {
  return (
    await exports.default.fetch(new Request(MANAGEMENT_URL, { headers: { Accept: "application/nostr+json" } }))
  ).json<Record<string, unknown>>();
}

async function copyFor(who: Keypair) {
  const box = (await info()).self as string;
  return { v: 3, seal: "box", pubkey: who.pubkeyHex, ct: nip44Encrypt(who.secretKeyHex, conversationKey(who.secretKeyHex, box)) };
}

async function sql<T>(query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(stub(), (_i: Relay, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
}

// ---------------------------------------------------------------------
// A software passkey, as test/vault.test.ts makes one (ES256 here: the
// other algorithms share every line this file is about).
// ---------------------------------------------------------------------

interface Passkey {
  credentialId: Uint8Array;
  hash: string;
  publicKey: string;
  privateKey: CryptoKey;
  counter: number;
}

async function makePasskey(): Promise<Passkey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const credentialId = randomBytes(32);
  return { credentialId, hash: bytesToHex(sha256(credentialId)), publicKey: toBase64url(spki), privateKey: pair.privateKey, counter: 0 };
}

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

// A WebAuthn assertion over `clientChallenge`, the string the browser
// writes into clientDataJSON.
async function assert(passkey: Passkey, clientChallenge: string, signWith = passkey) {
  const clientDataJSON = new TextEncoder().encode(
    JSON.stringify({ type: "webauthn.get", challenge: clientChallenge, origin: "https://dms.aaro.cc", crossOrigin: false }),
  );
  const authData = new Uint8Array(37);
  authData.set(sha256(new TextEncoder().encode(VAULT_RP_ID)), 0);
  authData[32] = 0x05;
  new DataView(authData.buffer).setUint32(33, passkey.counter);
  const signed = new Uint8Array([...authData, ...sha256(clientDataJSON)]);
  const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signWith.privateKey, signed));
  return {
    id: toBase64url(passkey.credentialId),
    rawId: toBase64url(passkey.credentialId),
    type: "public-key",
    response: {
      clientDataJSON: toBase64url(clientDataJSON),
      authenticatorData: toBase64url(authData),
      signature: toBase64url(rawToDer(raw)),
    },
  };
}

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
    text,
    body: JSON.parse(text) as { result?: unknown; error?: string },
    elapsed: Date.now() - started,
  };
}

async function challenge(): Promise<string> {
  const reply = await unsigned("vaultchallenge");
  expect(reply.body.error).toBeUndefined();
  return (reply.body.result as { challenge: string }).challenge;
}

// What the new phone signs: the challenge bound to its one-time key.
function bound(c: string, oneTimeKey: string): string {
  return toBase64url(boundChallenge(fromBase64url(c)!, oneTimeKey));
}

interface BoundOpts {
  challenge?: string;
  phone?: Keypair;
  // The one-time key sent in the call, when it is not the one signed for.
  sendKey?: string;
  signWith?: Passkey;
  hash?: string;
}

// vaultopen's bound form, as a new phone calls it.
async function openBound(passkey: Passkey, opts: BoundOpts = {}) {
  const c = opts.challenge ?? (await challenge());
  const phone = opts.phone ?? randomKeypair();
  const assertion = await assert(passkey, bound(c, phone.pubkeyHex), opts.signWith);
  const reply = await unsigned("vaultopen", [opts.hash ?? passkey.hash, assertion, opts.sendKey ?? phone.pubkeyHex, c]);
  return { reply, phone };
}

// vaultopen's first form, as DMs 0.5.8 calls it.
async function openPlain(passkey: Passkey, c?: string) {
  const ch = c ?? (await challenge());
  return unsigned("vaultopen", [passkey.hash, await assert(passkey, ch)]);
}

function boxFields(passkey: Passkey, extra: Record<string, unknown> = {}) {
  return {
    credentialId: toBase64url(passkey.credentialId),
    publicKey: passkey.publicKey,
    alg: COSE_ES256,
    label: "Bitwarden",
    seal: "box",
    ...extra,
  };
}

function passkeyFields(owner: Keypair, passkey: Passkey) {
  return {
    credentialId: toBase64url(passkey.credentialId),
    publicKey: passkey.publicKey,
    alg: COSE_ES256,
    label: "Google Password Manager",
    blob: { v: 2, pubkey: owner.pubkeyHex, cred: toBase64url(passkey.credentialId), iv: toBase64url(randomBytes(12)), ct: "AAAA" },
  };
}

// A member who keeps a vouch copy (as DMs writes for everyone) and a
// 'box' row for a new passkey.
async function boxMember(): Promise<{ member: Keypair; passkey: Passkey }> {
  const member = await newMember();
  expect((await as(member, "vouchput", [await copyFor(member)])).result).toBe(true);
  const passkey = await makePasskey();
  const put = await as(member, "vaultput", [passkey.hash, boxFields(passkey)]);
  expect(put.error).toBeUndefined();
  expect(put.result).toBe(true);
  return { member, passkey };
}

function keyIn(copy: unknown, phone: Keypair): string {
  const c = copy as { v: number; pubkey: string; box: string; ct: string };
  return nip44Decrypt(c.ct, conversationKey(phone.secretKeyHex, c.box));
}

// The relay's messages to `who`, opened as their app would: "tag:account"
// and the text.
async function noticesTo(who: Keypair): Promise<{ tag: string; content: string }[]> {
  const wraps = await sql<{ pubkey: string; tags: string; content: string }>(`SELECT pubkey, tags, content FROM events WHERE kind = 1059`);
  const out: { tag: string; content: string }[] = [];
  for (const wrap of wraps) {
    const p = (JSON.parse(wrap.tags) as string[][]).find((t) => t[0] === "p")?.[1];
    if (p !== who.pubkeyHex) continue;
    const seal = JSON.parse(nip44Decrypt(wrap.content, conversationKey(who.secretKeyHex, wrap.pubkey))) as { pubkey: string; content: string };
    const rumor = JSON.parse(nip44Decrypt(seal.content, conversationKey(who.secretKeyHex, seal.pubkey))) as {
      tags: string[][];
      content: string;
    };
    const tag = rumor.tags.find((t) => t[0] === "bothy");
    if (tag) out.push({ tag: `${tag[1]}:${tag[2]}`, content: rumor.content });
  }
  return out;
}

type Listing = { members: { pubkey: string; restore?: number; restoreBoxReadable?: number }[] };

// ---------------------------------------------------------------------

describe("discovery", () => {
  it("advertises noprf inside restore, beside vouch, and lists no new method", async () => {
    const doc = await info();
    expect(doc.restore).toEqual({ v: 1, vouch: { v: 1, box: doc.self, wait: VOUCH_RELEASE_DELAY_SECONDS }, noprf: { v: 1 } });
    const methods = (await callManagement("supportedmethods")).result as string[];
    for (const m of ["vaultput", "vaultlist", "vaultdelete", "vaultchallenge", "vaultopen"]) expect(methods).toContain(m);
  });

  it("VOUCH=off takes it out of NIP-11 and refuses a 'box' row, but not a 'passkey' one", async () => {
    const member = await newMember();
    mutableEnv.VOUCH = "off";
    expect((await info()).restore).toEqual({ v: 1 });
    const passkey = await makePasskey();
    const refused = await as(member, "vaultput", [passkey.hash, boxFields(passkey, { copy: await copyFor(member) })]);
    expect(refused.error).toBe(`vaultput: ${NOPRF_OFF_MESSAGE}`);
    expect(await sql(`SELECT 1 FROM vault`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM vouch_copies`)).toEqual([]);
    expect((await as(member, "vaultput", [passkey.hash, passkeyFields(member, passkey)])).result).toBe(true);
  });
});

describe("registering", () => {
  it("keeps a 'box' row with no blob, listed box-readable beside the vouch copy", async () => {
    const { member, passkey } = await boxMember();
    const list = (await as(member, "vaultlist")).result as Record<string, unknown>[];
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({
      hash: passkey.hash,
      credentialId: toBase64url(passkey.credentialId),
      publicKey: passkey.publicKey,
      alg: COSE_ES256,
      label: "Bitwarden",
      addedAt: expect.any(Number),
      updatedAt: expect.any(Number),
      lastUsedAt: null,
      seal: "box",
      boxReadable: true,
    });
    expect(list[1]).toMatchObject({ seal: "box", boxReadable: true, vouch: true });
    // Nothing a box row stores is a copy of its own.
    expect(await sql(`SELECT blob, seal FROM vault`)).toEqual([{ blob: "", seal: "box" }]);
  });

  it("lists a 'passkey' row exactly as before", async () => {
    const member = await newMember();
    const passkey = await makePasskey();
    expect((await as(member, "vaultput", [passkey.hash, passkeyFields(member, passkey)])).result).toBe(true);
    const list = (await as(member, "vaultlist")).result as Record<string, unknown>[];
    expect(Object.keys(list[0]!)).toEqual([
      "hash",
      "credentialId",
      "publicKey",
      "alg",
      "label",
      "addedAt",
      "updatedAt",
      "lastUsedAt",
      "seal",
      "boxReadable",
    ]);
    expect(list[0]).toMatchObject({ seal: "passkey", boxReadable: false });
  });

  it("needs the vouch copy: refused without one, kept as the vouch copy when sent", async () => {
    const member = await newMember();
    const passkey = await makePasskey();
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey)])).error).toBe(NOPRF_NEEDS_COPY_MESSAGE);
    expect(await sql(`SELECT 1 FROM vault`)).toEqual([]);

    const copy = await copyFor(member);
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { copy })])).result).toBe(true);
    const stored = await sql<{ blob: string }>(`SELECT blob FROM vouch_copies WHERE pubkey = ?`, member.pubkeyHex);
    expect(JSON.parse(stored[0]!.blob)).toEqual(copy);
    // One home-openable copy per member, however many rows hand it over.
    const second = await makePasskey();
    expect((await as(member, "vaultput", [second.hash, boxFields(second)])).result).toBe(true);
    expect((await sql(`SELECT 1 FROM vouch_copies`)).length).toBe(1);
  });

  it("checks a sent copy like vouchput, and stores neither row nor copy when it is wrong", async () => {
    const member = await newMember();
    const passkey = await makePasskey();
    const other = randomKeypair();
    const wrong = { ...(await copyFor(member)), ct: nip44Encrypt(other.secretKeyHex, conversationKey(member.secretKeyHex, (await info()).self as string)) };
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { copy: wrong })])).error).toMatch(/^vaultput: the copy must be/);
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { copy: { ...(await copyFor(member)), pubkey: other.pubkeyHex } })])).error).toBe(
      "vaultput: the copy must name your own pubkey",
    );
    expect(await sql(`SELECT 1 FROM vault`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM vouch_copies`)).toEqual([]);
  });

  it("refuses a blob on a 'box' row, a copy on a 'passkey' row, and an unknown seal", async () => {
    const member = await newMember();
    const passkey = await makePasskey();
    const withBlob = { ...boxFields(passkey), blob: passkeyFields(member, passkey).blob };
    expect((await as(member, "vaultput", [passkey.hash, withBlob])).error).toBe(
      'vaultput: a "box" row carries no blob; its copy is your vouch copy',
    );
    expect((await as(member, "vaultput", [passkey.hash, { ...passkeyFields(member, passkey), copy: await copyFor(member) }])).error).toBe(
      'vaultput: copy goes only with seal "box"',
    );
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { seal: "prf" })])).error).toBe(
      'vaultput: seal must be "passkey" (with a blob) or "box" (without one)',
    );
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { publicKey: toBase64url(randomBytes(91)) })])).error).toBe(
      "vaultput: publicKey is not a public key of that alg",
    );
  });

  it("refuses a stranger", async () => {
    const stranger = randomKeypair();
    const passkey = await makePasskey();
    const reply = await as(stranger, "vaultput", [passkey.hash, boxFields(passkey, { copy: await copyFor(stranger) })]);
    expect([reply.status, reply.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });
});

describe("opening", () => {
  it("hands the new phone the key sealed to its one-time key, and records the use", async () => {
    const { member, passkey } = await boxMember();
    const { reply, phone } = await openBound(passkey);
    expect(Object.keys(reply.body)).toEqual(["result"]);
    const copy = (reply.body.result as { copy: Record<string, unknown> }).copy;
    expect(Object.keys(reply.body.result as object)).toEqual(["copy"]);
    expect(copy).toMatchObject({ v: 1, pubkey: member.pubkeyHex, box: (await info()).self });
    const secret = keyIn(copy, phone);
    expect(secret).toBe(member.secretKeyHex);
    expect(bytesToHex(schnorr.getPublicKey(hexToBytes(secret)))).toBe(member.pubkeyHex);
    // Never the bare key, and no other key opens it.
    expect(reply.text).not.toContain(member.secretKeyHex);
    expect(() => keyIn(copy, randomKeypair())).toThrow();
    expect(reply.elapsed).toBeGreaterThanOrEqual(VAULT_OPEN_FLOOR_MS - 5);

    const row = ((await as(member, "vaultlist")).result as { lastUsedAt: number | null }[])[0]!;
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("tells the account, even with a full mailbox, and shows it in myvouch", async () => {
    const { member, passkey } = await boxMember();
    mutableEnv.MAIL_BYTES_PER_MEMBER = "1";
    const { reply, phone } = await openBound(passkey);
    expect(reply.body.result).toBeDefined();
    expect(await noticesTo(member)).toEqual([{ tag: `${NOPRF_NOTICE}:${member.pubkeyHex}`, content: NOPRF_RELEASED_TEXT }]);
    expect(NOPRF_RELEASED_TEXT).not.toMatch(/passkey|PRF|—/i);
    const mine = (await as(member, "myvouch")).result as { open: unknown; past: Record<string, unknown>[] };
    expect(mine.open).toBeNull();
    expect(mine.past).toEqual([
      {
        key: phone.pubkeyHex,
        askedAt: expect.any(Number),
        approvedBy: null,
        approvedAt: null,
        releasedAt: expect.any(Number),
        closedAt: expect.any(Number),
        closedBy: null,
        why: NOPRF_WHY,
      },
    ]);
    // Nothing for a voucher to see.
    expect((await callManagement("vouchrequests")).result).toEqual([]);
  });

  it("does not hide or close a vouch request already open", async () => {
    const { member, passkey } = await boxMember();
    const asker = randomKeypair();
    expect((await unsigned("vouchask", [member.pubkeyHex, asker.pubkeyHex])).body.result).toBeDefined();
    expect((await openBound(passkey)).reply.body.result).toBeDefined();
    const mine = (await as(member, "myvouch")).result as { open: { key: string } | null; past: unknown[] };
    expect(mine.open?.key).toBe(asker.pubkeyHex);
    expect((await callManagement("vouchrequests")).result).toEqual([expect.objectContaining({ key: asker.pubkeyHex })]);
    // A second ask is still refused its place, and the open one can be cancelled.
    await unsigned("vouchask", [member.pubkeyHex, randomKeypair().pubkeyHex]);
    expect((await sql(`SELECT 1 FROM vouch_requests WHERE closed_at IS NULL`)).length).toBe(1);
    expect((await as(member, "vouchcancel")).result).toBe(true);
    expect(await sql(`SELECT 1 FROM vouch_requests WHERE closed_at IS NULL`)).toEqual([]);
  });

  it(`keeps at most ${VOUCH_HISTORY_PER_MEMBER} past entries, and never drops an open vouch request`, async () => {
    const { member, passkey } = await boxMember();
    const asker = randomKeypair();
    expect((await unsigned("vouchask", [member.pubkeyHex, asker.pubkeyHex])).body.result).toBeDefined();
    for (let i = 0; i < VOUCH_HISTORY_PER_MEMBER + 2; i++) {
      passkey.counter++;
      expect((await openBound(passkey)).reply.body.result).toBeDefined();
    }
    const rows = await sql<{ why: string | null }>(`SELECT closed_why AS why FROM vouch_requests WHERE pubkey = ?`, member.pubkeyHex);
    expect(rows.length).toBe(VOUCH_HISTORY_PER_MEMBER + 1);
    expect(rows.filter((r) => r.why === NOPRF_WHY).length).toBe(VOUCH_HISTORY_PER_MEMBER);
    expect(((await as(member, "myvouch")).result as { open: { key: string } | null }).open?.key).toBe(asker.pubkeyHex);
  }, 30_000);

  it("binds the one-time key: a good assertion sent with another key opens nothing, and spends its challenge", async () => {
    const { passkey } = await boxMember();
    const c = await challenge();
    const phone = randomKeypair();
    const thief = randomKeypair();
    const swapped = await openBound(passkey, { challenge: c, phone, sendKey: thief.pubkeyHex });
    expect(swapped.reply.text).toBe(JSON.stringify({ error: VAULT_NOT_FOUND }));
    // The same assertion with its own key is now too late: the challenge went.
    const late = await openBound(passkey, { challenge: c, phone });
    expect(late.reply.body).toEqual({ error: VAULT_NOT_FOUND });
    // And a successful one cannot be replayed with a key of the replayer's.
    const good = await challenge();
    const assertion = await assert(passkey, bound(good, phone.pubkeyHex));
    expect((await unsigned("vaultopen", [passkey.hash, assertion, phone.pubkeyHex, good])).body.result).toBeDefined();
    expect((await unsigned("vaultopen", [passkey.hash, assertion, thief.pubkeyHex, good])).body).toEqual({ error: VAULT_NOT_FOUND });
  });

  it("refuses an assertion over the bare challenge, and a key that is not a usable one", async () => {
    const { passkey } = await boxMember();
    const c = await challenge();
    const unboundAssertion = await assert(passkey, c);
    const phone = randomKeypair();
    expect((await unsigned("vaultopen", [passkey.hash, unboundAssertion, phone.pubkeyHex, c])).body).toEqual({ error: VAULT_NOT_FOUND });
    const c2 = await challenge();
    const notAPoint = "f".repeat(64);
    const a2 = await assert(passkey, toBase64url(boundChallenge(fromBase64url(c2)!, notAPoint)));
    expect((await unsigned("vaultopen", [passkey.hash, a2, notAPoint, c2])).body).toEqual({ error: VAULT_NOT_FOUND });
    expect((await openBound(passkey)).reply.body.result).toBeDefined();
  });

  it("refuses a stale counter, like a 'passkey' row", async () => {
    const { passkey } = await boxMember();
    passkey.counter = 5;
    expect((await openBound(passkey)).reply.body.result).toBeDefined();
    expect((await openBound(passkey)).reply.body).toEqual({ error: VAULT_NOT_FOUND });
    passkey.counter = 6;
    expect((await openBound(passkey)).reply.body.result).toBeDefined();
  });
});

describe("what a stranger sees", () => {
  // Every way an unsigned open can fail, in both forms, against a member
  // who keeps both kinds of row. Each case fetches its challenge and signs
  // first, and returns the call to make, so the call alone can be measured.
  type Prepared = { c: string; params: unknown[] };

  async function boundParams(key: Passkey, c: string, opts: { signWith?: Passkey; sendKey?: string } = {}): Promise<unknown[]> {
    const phone = randomKeypair();
    return [key.hash, await assert(key, bound(c, phone.pubkeyHex), opts.signWith), opts.sendKey ?? phone.pubkeyHex, c];
  }

  async function failures() {
    const { member, passkey: box } = await boxMember();
    const prf = await makePasskey();
    expect((await as(member, "vaultput", [prf.hash, passkeyFields(member, prf)])).result).toBe(true);
    const unknown = await makePasskey();
    const replayed = await challenge();
    expect((await openBound(box, { challenge: replayed })).reply.body.result).toBeDefined();
    box.counter++;

    const cases: Record<string, () => Promise<Prepared>> = {
      "unknown credential, bound form": async () => {
        const c = await challenge();
        return { c, params: await boundParams(unknown, c) };
      },
      "unknown credential, plain form": async () => {
        const c = await challenge();
        return { c, params: [unknown.hash, await assert(unknown, c)] };
      },
      "'passkey' row asked the bound way": async () => {
        const c = await challenge();
        return { c, params: await boundParams(prf, c) };
      },
      "'box' row asked the plain way": async () => {
        const c = await challenge();
        return { c, params: [box.hash, await assert(box, c)] };
      },
      "'box' row, wrong signature": async () => {
        const c = await challenge();
        return { c, params: await boundParams(box, c, { signWith: unknown }) };
      },
      "'box' row, replayed challenge": async () => ({ c: replayed, params: await boundParams(box, replayed) }),
      "'box' row, another one-time key": async () => {
        const c = await challenge();
        return { c, params: await boundParams(box, c, { sendKey: randomKeypair().pubkeyHex }) };
      },
    };
    return { member, box, prf, unknown, cases };
  }

  it("answers every failure with the same status, headers and bytes, after the floor, and spends every challenge", async () => {
    const { box, prf, cases } = await failures();
    const replies: Awaited<ReturnType<typeof unsigned>>[] = [];
    for (const [name, prepare] of Object.entries(cases)) {
      const { c, params } = await prepare();
      const reply = await unsigned("vaultopen", params);
      expect(reply.text, name).toBe(JSON.stringify({ error: VAULT_NOT_FOUND }));
      expect(reply.elapsed, name).toBeGreaterThanOrEqual(VAULT_OPEN_FLOOR_MS - 5);
      replies.push(reply);
      // The challenge is gone whatever failed: a right answer over it fails too.
      expect((await openBound(box, { challenge: c })).reply.body, name).toEqual({ error: VAULT_NOT_FOUND });
      expect((await openPlain(prf, c)).body, name).toEqual({ error: VAULT_NOT_FOUND });
    }
    for (const reply of replies) {
      expect(reply.status).toBe(replies[0]!.status);
      expect(reply.headers).toEqual(replies[0]!.headers);
    }
    // The rows themselves still open, each its own way.
    expect((await openBound(box)).reply.body.result).toBeDefined();
    expect((await openPlain(prf)).body.result).toBeDefined();
  }, 60_000);

  it("does the same writes for every failure, and reads one row more when the row exists (measured)", async () => {
    // Measured inside the object with the instrument behind /api/stats
    // `reads` and `rowsWrittenToday` (src/read-metrics.ts), on the path the
    // open itself runs in (`unattributed`; the meter's own landing is
    // left out, since when it lands depends on what came before).
    //
    // What this records, and what it means for a stranger:
    // - Every failure writes the spent challenge (one row and its two
    //   indexes, 3 rows written), row or no row, either form.
    // - The row lookup by primary key reads 1 row when the row exists and
    //   0 when it does not. /api/stats `reads` is public, so someone who
    //   reads it just before and after an open on a quiet home can tell
    //   whether a credential id has a row here. That was already true of
    //   v0.33's vaultopen; the bound form adds nothing to it. It needs the
    //   credential id, which only the passkey app and the homes it was
    //   used with ever see. The README says so.
    // - A replayed challenge writes nothing (it is already spent). The
    //   replayer knows they replayed, and it is the same with or without
    //   a row, so it says nothing about one.
    const { cases } = await failures();
    const costs: Record<string, { read: number; written: number }> = {};
    for (const [name, prepare] of Object.entries(cases)) {
      const { params } = await prepare();
      await runInDurableObject(stub(), async () => resetReadMetrics());
      await unsigned("vaultopen", params);
      const [reads, writes] = await runInDurableObject(stub(), async () => [readMetricsSnapshot(), writeMetricsSnapshot()] as const);
      costs[name] = {
        read: reads.paths.find((p) => p.path === "unattributed")?.rowsRead ?? 0,
        written: writes.paths.find((p) => p.path === "unattributed")?.rowsWritten ?? 0,
      };
    }
    expect(costs).toEqual({
      "unknown credential, bound form": { read: 0, written: 3 },
      "unknown credential, plain form": { read: 0, written: 3 },
      "'passkey' row asked the bound way": { read: 1, written: 3 },
      "'box' row asked the plain way": { read: 1, written: 3 },
      "'box' row, wrong signature": { read: 1, written: 3 },
      "'box' row, replayed challenge": { read: 1, written: 0 },
      "'box' row, another one-time key": { read: 1, written: 3 },
    });
  }, 30_000);

  it("rate-limits by hash across both forms, the same for a row and for none", async () => {
    const { passkey } = await boxMember();
    const unknown = await makePasskey();
    const burst = async (key: Passkey) => {
      const replies = [];
      // Half asked one way, half the other: one shared count per hash.
      for (let i = 0; i <= MAX_VAULT_OPENS_PER_HASH_PER_WINDOW; i++) {
        const assertion = await assert(key, "x".repeat(43));
        const params = i % 2 === 0 ? [key.hash, assertion] : [key.hash, assertion, randomKeypair().pubkeyHex, "x".repeat(48)];
        replies.push(unsigned("vaultopen", params));
      }
      return Promise.all(replies);
    };
    for (const replies of [await burst(passkey), await burst(unknown)]) {
      expect(replies.filter((r) => r.body.error === VAULT_RATE_LIMITED).length).toBe(1);
      expect(replies.filter((r) => r.body.error === VAULT_NOT_FOUND).length).toBe(MAX_VAULT_OPENS_PER_HASH_PER_WINDOW);
    }
  });

  it("writes the hand-over's rows only on success (measured)", async () => {
    // A successful open writes: the spent challenge, the row's counter and
    // last use, the history row, and the account's message (its event row
    // and what storeEvent keeps beside it), 21 rows with their indexes; it
    // reads 22 (one is the re-check that the row is still a box row). Recorded so a change shows. The message moves the public
    // counts on /api/stats (totalEvents, ingested24h, rowsWrittenToday),
    // so a watcher can tell that some phone got in this way just then,
    // not whose account it was; it needs the person's passkey.
    const { passkey } = await boxMember();
    const c = await challenge();
    const phone = randomKeypair();
    const assertion = await assert(passkey, bound(c, phone.pubkeyHex));
    await runInDurableObject(stub(), async () => resetReadMetrics());
    expect((await unsigned("vaultopen", [passkey.hash, assertion, phone.pubkeyHex, c])).body.result).toBeDefined();
    const [reads, writes] = await runInDurableObject(stub(), async () => [readMetricsSnapshot(), writeMetricsSnapshot()] as const);
    expect({ read: reads.totalRowsRead, written: writes.totalRowsWritten }).toEqual(SUCCESS_COST);
  });
});

// A successful bound open, measured (Workers Free plan: 100,000 rows
// written and 5,000,000 rows read a day; the per-hash limit allows 20
// opens an hour per row).
const SUCCESS_COST = { read: 22, written: 21 };

describe("'passkey' rows are unchanged", () => {
  it("a member with both kinds opens each only its own way", async () => {
    const { member, passkey: box } = await boxMember();
    const prf = await makePasskey();
    const fields = passkeyFields(member, prf);
    expect((await as(member, "vaultput", [prf.hash, fields])).result).toBe(true);
    expect((await openPlain(prf)).text).toBe(JSON.stringify({ result: { blob: fields.blob } }));
    expect((await openPlain(box)).body).toEqual({ error: VAULT_NOT_FOUND });
    expect((await openBound(prf)).reply.body).toEqual({ error: VAULT_NOT_FOUND });
    expect((await openBound(box)).reply.body.result).toBeDefined();
  });

  it("a 'passkey' row's open sends no message and leaves no history", async () => {
    const member = await newMember();
    const prf = await makePasskey();
    expect((await as(member, "vaultput", [prf.hash, passkeyFields(member, prf)])).result).toBe(true);
    expect((await openPlain(prf)).body.result).toBeDefined();
    expect(await noticesTo(member)).toEqual([]);
    expect(await sql(`SELECT 1 FROM vouch_requests`)).toEqual([]);
  });

  it("an old database's rows become 'passkey' rows and still open", async () => {
    const member = await newMember();
    const prf = await makePasskey();
    const fields = passkeyFields(member, prf);
    expect((await as(member, "vaultput", [prf.hash, fields])).result).toBe(true);
    // Rebuild the v0.33 table around the stored row, then migrate.
    await runInDurableObject(stub(), async (_i: Relay, state) => {
      const s = state.storage.sql;
      s.exec(`ALTER TABLE vault RENAME TO vault_v33`);
      s.exec(
        `CREATE TABLE vault (hash TEXT PRIMARY KEY, pubkey TEXT NOT NULL, credential_id TEXT NOT NULL, public_key TEXT NOT NULL,
           alg INTEGER NOT NULL, blob TEXT NOT NULL, label TEXT, size INTEGER NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
           added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER)`,
      );
      s.exec(
        `INSERT INTO vault SELECT hash, pubkey, credential_id, public_key, alg, blob, label, size, counter, added_at, updated_at, last_used_at FROM vault_v33`,
      );
      s.exec(`DROP TABLE vault_v33`);
      forgetSchemaHash(s);
      initSchema(s);
      // Idempotent: a second pass changes nothing.
      forgetSchemaHash(s);
      initSchema(s);
    });
    expect(await sql(`SELECT seal FROM vault`)).toEqual([{ seal: "passkey" }]);
    expect((await openPlain(prf)).text).toBe(JSON.stringify({ result: { blob: fields.blob } }));
  });
});

describe("upgrading", () => {
  it("a 'passkey' put of the same credential replaces the 'box' row, and keeps its counter", async () => {
    const { member, passkey } = await boxMember();
    passkey.counter = 3;
    expect((await openBound(passkey)).reply.body.result).toBeDefined();
    const fields = passkeyFields(member, passkey);
    expect((await as(member, "vaultput", [passkey.hash, fields])).result).toBe(true);
    const list = (await as(member, "vaultlist")).result as Record<string, unknown>[];
    expect(list.filter((r) => r.hash !== undefined)).toEqual([expect.objectContaining({ hash: passkey.hash, seal: "passkey", boxReadable: false })]);
    expect(await sql(`SELECT counter, seal FROM vault`)).toEqual([{ counter: 3, seal: "passkey" }]);
    expect((await openBound(passkey)).reply.body).toEqual({ error: VAULT_NOT_FOUND });
    passkey.counter = 4;
    expect((await openPlain(passkey)).text).toBe(JSON.stringify({ result: { blob: fields.blob } }));
    // The vouch copy is the member's, and stays.
    expect((await sql(`SELECT 1 FROM vouch_copies`)).length).toBe(1);
  });
});

describe("cleaning up", () => {
  it("vaultdelete removes a 'box' row like any other", async () => {
    const { member, passkey } = await boxMember();
    expect((await as(member, "vaultdelete", [passkey.hash])).result).toBe(true);
    expect(await sql(`SELECT 1 FROM vault`)).toEqual([]);
    expect((await openBound(passkey)).reply.body).toEqual({ error: VAULT_NOT_FOUND });
  });

  it("vouchdelete takes the 'box' rows with the copy, and leaves 'passkey' rows", async () => {
    const { member, passkey } = await boxMember();
    const prf = await makePasskey();
    expect((await as(member, "vaultput", [prf.hash, passkeyFields(member, prf)])).result).toBe(true);
    expect((await as(member, "vouchdelete")).result).toBe(true);
    expect(await sql(`SELECT hash, seal FROM vault`)).toEqual([{ hash: prf.hash, seal: "passkey" }]);
    expect((await openBound(passkey)).reply.body).toEqual({ error: VAULT_NOT_FOUND });
  });

  it("removal drops 'box' rows at once with the copy; 'passkey' rows wait out the grace; the sweep takes the rest", async () => {
    const { member, passkey } = await boxMember();
    const prf = await makePasskey();
    expect((await as(member, "vaultput", [prf.hash, passkeyFields(member, prf)])).result).toBe(true);
    expect((await callManagement("unallowpubkey", [member.pubkeyHex])).result).toBe(true);
    expect(await sql(`SELECT seal FROM vault`)).toEqual([{ seal: "passkey" }]);
    expect((await openBound(passkey)).reply.body).toEqual({ error: VAULT_NOT_FOUND });

    const removedAt = (await sql<{ removed_at: number }>(`SELECT removed_at FROM former_members WHERE pubkey = ?`, member.pubkeyHex))[0]!
      .removed_at;
    await runInDurableObject(stub(), (_i: Relay, state) =>
      sweepFormerMembers(state.storage.sql, removedAt + MEMBER_REMOVAL_GRACE_SECONDS, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100),
    );
    expect(await sql(`SELECT 1 FROM vault`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM vouch_requests`)).toEqual([]);
  });

  it("a member let back in during the grace has no 'box' row until they register again", async () => {
    const { member, passkey } = await boxMember();
    expect((await callManagement("unallowpubkey", [member.pubkeyHex])).result).toBe(true);
    expect((await callManagement("allowpubkey", [member.pubkeyHex])).result).toBe(true);
    expect((await openBound(passkey)).reply.body).toEqual({ error: VAULT_NOT_FOUND });
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { copy: await copyFor(member) })])).result).toBe(true);
    passkey.counter++;
    expect((await openBound(passkey)).reply.body.result).toBeDefined();
  });

  it("eraseme deletes the rows, the copy and the history", async () => {
    const { member, passkey } = await boxMember();
    expect((await openBound(passkey)).reply.body.result).toBeDefined();
    expect((await as(member, "eraseme")).error).toBeUndefined();
    expect(await sql(`SELECT 1 FROM vault`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM vouch_copies`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM vouch_requests`)).toEqual([]);
  });

  it("VOUCH=off hands nothing over from a row kept before, which stays listed for the member to remove", async () => {
    const { member, passkey } = await boxMember();
    mutableEnv.VOUCH = "off";
    const { reply } = await openBound(passkey);
    expect(reply.text).toBe(JSON.stringify({ error: VAULT_NOT_FOUND }));
    expect(await noticesTo(member)).toEqual([]);
    const list = (await as(member, "vaultlist")).result as Record<string, unknown>[];
    expect(list[0]).toMatchObject({ hash: passkey.hash, seal: "box", boxReadable: true });
    expect((await as(member, "vaultdelete", [passkey.hash])).result).toBe(true);
  });
});

describe("limits", () => {
  it(`counts toward the ${VAULT_ROWS_PER_MEMBER} rows each`, async () => {
    const { member } = await boxMember();
    for (let i = 1; i < VAULT_ROWS_PER_MEMBER; i++) {
      const p = await makePasskey();
      const fields = i % 2 === 0 ? boxFields(p) : passkeyFields(member, p);
      expect((await as(member, "vaultput", [p.hash, fields])).result).toBe(true);
    }
    const extra = await makePasskey();
    expect((await as(member, "vaultput", [extra.hash, boxFields(extra)])).error).toBe(
      `vaultput: at most ${VAULT_ROWS_PER_MEMBER} passkeys each. Remove one first.`,
    );
  });

  it("counts the row and the copy it brings against the vault's share, and stores neither when full", async () => {
    const member = await newMember();
    const passkey = await makePasskey();
    const copy = await copyFor(member);
    const copySize = new TextEncoder().encode(JSON.stringify(copy)).length;
    const rowSize = toBase64url(passkey.credentialId).length + passkey.publicKey.length + "Bitwarden".length;
    mutableEnv.VAULT_STORAGE_BYTES = String(copySize + rowSize - 1);
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { copy })])).error).toBe(VAULT_FULL_MESSAGE);
    expect(await sql(`SELECT 1 FROM vault`)).toEqual([]);
    expect(await sql(`SELECT 1 FROM vouch_copies`)).toEqual([]);
    mutableEnv.VAULT_STORAGE_BYTES = String(copySize + rowSize);
    expect((await as(member, "vaultput", [passkey.hash, boxFields(passkey, { copy })])).result).toBe(true);
    expect(await sql<{ size: number }>(`SELECT size FROM vault`)).toEqual([{ size: rowSize }]);
  });
});

describe("listmembers", () => {
  it("counts 'box' rows in restore and again in restoreBoxReadable", async () => {
    const { member } = await boxMember();
    const prf = await makePasskey();
    expect((await as(member, "vaultput", [prf.hash, passkeyFields(member, prf)])).result).toBe(true);
    const plain = await newMember();
    const listing = (await callManagement("listmembers")).result as Listing;
    expect(listing.members.find((m) => m.pubkey === member.pubkeyHex)).toMatchObject({ restore: 2, restoreBoxReadable: 1 });
    expect(listing.members.find((m) => m.pubkey === plain.pubkeyHex)).toMatchObject({ restore: 0, restoreBoxReadable: 0 });
  });

  it("is left off a plain member's myinvitees with restore", async () => {
    const inviter = await newMember();
    const code = ((await as(inviter, "createinvite")).result as { code: string }).code;
    const invitee = randomKeypair();
    expect((await as(invitee, "redeeminvite", [code])).result).toBe(true);
    const plain = (await as(inviter, "myinvitees")).result as Listing;
    expect(plain.members[0]).not.toHaveProperty("restore");
    expect(plain.members[0]).not.toHaveProperty("restoreBoxReadable");
    const owners = (await callManagement("myinvitees")).result as Listing;
    expect(owners.members.find((m) => m.pubkey === invitee.pubkeyHex)).toMatchObject({ restore: 0, restoreBoxReadable: 0 });
  });
});
