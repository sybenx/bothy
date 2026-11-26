// Vouching (src/vouch.ts): a member keeps a copy of their key this relay
// can open; a new phone asks, unsigned, with a one-time key; someone who
// may vouch checks the code and approves; a day later the copy is handed
// to that one-time key. Above all, the unsigned calls must not tell a
// stranger who has an account here, and nothing is handed over to anyone
// but the phone whose code was approved.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_VOUCH_ASKS_PER_PUBKEY_PER_WINDOW,
  VAULT_OPEN_FLOOR_MS,
  VOUCH_COPY_MAX_BYTES,
  VOUCH_PICKUP_SECONDS,
  VOUCH_RELEASE_DELAY_SECONDS,
  VOUCH_REQUEST_TTL_SECONDS,
  VOUCHERS_PER_MEMBER,
} from "../src/limits";
import { conversationKey, nip44Decrypt, nip44Encrypt } from "../src/nip44";
import { MANAGEMENT_CONTENT_TYPE, NOT_A_MEMBER_REASON } from "../src/nip86";
import type { Relay } from "../src/relay";
import { VAULT_NOT_FOUND, VAULT_RATE_LIMITED } from "../src/vault";
import { VOUCH_ASK_USAGE, vouchCode, VOUCH_OFF_MESSAGE } from "../src/vouch";
import { isolateStorage } from "./helpers/isolate";
import { callManagement, MANAGEMENT_URL } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.VOUCH;
  delete mutableEnv.VAULT_STORAGE_BYTES;
});

const OWNER: Keypair = { pubkeyHex: OWNER_PUBKEY_HEX, secretKeyHex: OWNER_SECRET_KEY_HEX };

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.30.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
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

async function boxKey(): Promise<string> {
  return (await info()).self as string;
}

// The copy a member's app writes: their key, NIP-44 sealed to the box.
async function copyFor(who: Keypair, extra: Record<string, unknown> = {}, sealWith = who.secretKeyHex) {
  return {
    v: 3,
    seal: "box",
    pubkey: who.pubkeyHex,
    ct: nip44Encrypt(sealWith, conversationKey(who.secretKeyHex, await boxKey())),
    ...extra,
  };
}

async function withCopy(): Promise<Keypair> {
  const who = await newMember();
  expect((await as(who, "vouchput", [await copyFor(who)])).result).toBe(true);
  return who;
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

interface Ask {
  phone: Keypair;
  token: string;
  code: string;
  expiresAt: number;
}

async function ask(account: string, phone = randomKeypair()): Promise<Ask> {
  const reply = await unsigned("vouchask", [account, phone.pubkeyHex]);
  expect(reply.body.error).toBeUndefined();
  return { phone, ...(reply.body.result as { token: string; code: string; expiresAt: number }) };
}

async function status(account: string, a: Ask) {
  return (await unsigned("vouchstatus", [account, a.phone.pubkeyHex, a.token])).body;
}

async function sql<T>(query: string, ...bindings: unknown[]): Promise<T[]> {
  return runInDurableObject(stub(), (_i: Relay, state) => state.storage.sql.exec(query, ...bindings).toArray() as T[]);
}

// Moves an approved request's release time into the past.
async function windClock(account: string, seconds = VOUCH_RELEASE_DELAY_SECONDS) {
  await sql(`UPDATE vouch_requests SET release_at = release_at - ? WHERE pubkey = ?`, seconds, account);
}

// The `bothy` tags of the relay's messages to `who`, opened as their app
// would.
async function noticesTo(who: Keypair): Promise<string[]> {
  const wraps = await sql<{ pubkey: string; tags: string; content: string }>(
    `SELECT pubkey, tags, content FROM events WHERE kind = 1059`,
  );
  const out: string[] = [];
  for (const wrap of wraps) {
    const p = (JSON.parse(wrap.tags) as string[][]).find((t) => t[0] === "p")?.[1];
    if (p !== who.pubkeyHex) continue;
    const seal = JSON.parse(nip44Decrypt(wrap.content, conversationKey(who.secretKeyHex, wrap.pubkey))) as {
      pubkey: string;
      content: string;
    };
    const rumor = JSON.parse(nip44Decrypt(seal.content, conversationKey(who.secretKeyHex, seal.pubkey))) as {
      tags: string[][];
    };
    const tag = rumor.tags.find((t) => t[0] === "bothy");
    if (tag) out.push(`${tag[1]}:${tag[2]}`);
  }
  return out.sort();
}

// ---------------------------------------------------------------------

describe("discovery", () => {
  it("lists the methods and advertises vouch in NIP-11's restore, with the box key and the wait", async () => {
    const methods = (await callManagement("supportedmethods")).result as string[];
    for (const m of ["vouchput", "vouchers", "vouchapprove", "myvouch", "vouchask", "vouchstatus"]) {
      expect(methods).toContain(m);
    }
    const doc = await info();
    // v0.34 adds `noprf` beside `vouch` (test/vault-noprf.test.ts).
    expect(doc.restore).toEqual({ v: 1, vouch: { v: 1, box: doc.self, wait: VOUCH_RELEASE_DELAY_SECONDS }, noprf: { v: 1 } });
  });

  it("VOUCH=off takes it out of both, and refuses new copies", async () => {
    mutableEnv.VOUCH = "off";
    expect((await info()).restore).toEqual({ v: 1 });
    expect((await callManagement("supportedmethods")).result as string[]).not.toContain("vouchask");
    const alice = await newMember();
    expect((await as(alice, "vouchput", [await copyFor(alice)])).error).toBe(`vouchput: ${VOUCH_OFF_MESSAGE}`);
    expect((await as(alice, "vouchdelete")).result).toBe(true);
  });
});

describe("the vouch copy", () => {
  it("is kept, shown box-readable in vaultlist beside nothing else, and dropped", async () => {
    const alice = await withCopy();
    const list = (await as(alice, "vaultlist")).result as Record<string, unknown>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ seal: "box", boxReadable: true, vouch: true });
    expect(list[0]).not.toHaveProperty("hash");
    expect(list[0]).not.toHaveProperty("credentialId");
    expect((await as(alice, "vouchdelete")).result).toBe(true);
    expect((await as(alice, "vaultlist")).result).toEqual([]);
  });

  it("refuses a copy the box can't open, or one that isn't the signer's key", async () => {
    const alice = await newMember();
    const bob = randomKeypair();
    // Someone else's key, sealed correctly.
    const wrongKey = await as(alice, "vouchput", [await copyFor(alice, {}, bob.secretKeyHex)]);
    expect(wrongKey.error).toMatch(/^vouchput: the copy must be/);
    // Sealed to a key that isn't the box's.
    const elsewhere = {
      v: 3,
      seal: "box",
      pubkey: alice.pubkeyHex,
      ct: nip44Encrypt(alice.secretKeyHex, conversationKey(alice.secretKeyHex, randomKeypair().pubkeyHex)),
    };
    expect((await as(alice, "vouchput", [elsewhere])).error).toMatch(/^vouchput: the copy must be/);
    expect((await as(alice, "vouchput", [await copyFor(alice, { pubkey: OWNER_PUBKEY_HEX })])).error).toBe(
      "vouchput: the copy must name your own pubkey",
    );
    expect((await as(alice, "vouchput", [await copyFor(alice, { v: 2 })])).error).toMatch(/^vouchput: the copy must be/);
    const big = await as(alice, "vouchput", [await copyFor(alice, { pad: "x".repeat(VOUCH_COPY_MAX_BYTES) })]);
    expect(big.error).toBe(`vouchput: the copy can be at most ${VOUCH_COPY_MAX_BYTES} bytes`);
    expect(await sql(`SELECT pubkey FROM vouch_copies`)).toEqual([]);
  });

  it("counts against the vault's share", async () => {
    const alice = await newMember();
    mutableEnv.VAULT_STORAGE_BYTES = "100";
    expect((await as(alice, "vouchput", [await copyFor(alice)])).error).toBe(
      "blocked: this home's restore storage is full",
    );
  });

  it("refuses a stranger", async () => {
    const stranger = randomKeypair();
    const reply = await as(stranger, "vouchput", [await copyFor(stranger)]);
    expect([reply.status, reply.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });
});

describe("who may vouch", () => {
  it("is the owner and admins by default, plus members a member names", async () => {
    const alice = await newMember();
    const admin = await newMember();
    const mum = await newMember();
    expect((await callManagement("addadmin", [admin.pubkeyHex])).result).toBe(true);
    expect((await as(alice, "addvoucher", [mum.pubkeyHex])).result).toBe(true);
    const list = (await as(alice, "vouchers")).result as { pubkey: string; why: string }[];
    expect(list.map((v) => [v.pubkey, v.why])).toEqual([
      [OWNER_PUBKEY_HEX, "owner"],
      [admin.pubkeyHex, "admin"],
      [mum.pubkeyHex, "named"],
    ]);
    // The owner's own list has only people the owner named: an admin is not let in above their standing.
    const owners = (await callManagement("vouchers")).result as { pubkey: string }[];
    expect(owners.map((v) => v.pubkey)).toEqual([]);
    await callManagement("addvoucher", [mum.pubkeyHex]);
    expect(((await callManagement("vouchers")).result as { pubkey: string }[]).map((v) => v.pubkey)).toEqual([mum.pubkeyHex]);
    // An admin's list: the owner and the people they named, not the other admins.
    const admin2 = await newMember();
    await callManagement("addadmin", [admin2.pubkeyHex]);
    const admins = (await as(admin, "vouchers")).result as { pubkey: string }[];
    expect(admins.map((v) => v.pubkey)).toEqual([OWNER_PUBKEY_HEX]);
  });

  it("an admin cannot let a phone into another admin's account", async () => {
    const target = await withCopy();
    const admin = await newMember();
    await callManagement("addadmin", [target.pubkeyHex]);
    await callManagement("addadmin", [admin.pubkeyHex]);
    const a = await ask(target.pubkeyHex);
    expect(await noticesTo(admin)).toEqual([]);
    expect((await as(admin, "vouchapprove", [target.pubkeyHex, a.phone.pubkeyHex])).error).toBeDefined();
    await windClock(target.pubkeyHex);
    expect(((await status(target.pubkeyHex, a)).result as { state: string }).state).not.toBe("ready");
  });

  it("refuses yourself, strangers, and more than the cap", async () => {
    const alice = await newMember();
    expect((await as(alice, "addvoucher", [alice.pubkeyHex])).error).toBe("addvoucher: you can't vouch for yourself");
    expect((await as(alice, "addvoucher", [randomKeypair().pubkeyHex])).error).toBe(
      "addvoucher: they need to be in this home",
    );
    for (let i = 0; i < VOUCHERS_PER_MEMBER; i++) {
      expect((await as(alice, "addvoucher", [(await newMember()).pubkeyHex])).result).toBe(true);
    }
    expect((await as(alice, "addvoucher", [(await newMember()).pubkeyHex])).error).toBe(
      `addvoucher: at most ${VOUCHERS_PER_MEMBER} people each. Remove one first.`,
    );
  });

  it("drops a named voucher who leaves the home, and one taken off the list", async () => {
    const alice = await newMember();
    const mum = await newMember();
    const dad = await newMember();
    await as(alice, "addvoucher", [mum.pubkeyHex]);
    await as(alice, "addvoucher", [dad.pubkeyHex]);
    expect((await callManagement("unallowpubkey", [mum.pubkeyHex])).result).toBe(true);
    expect((await as(alice, "removevoucher", [dad.pubkeyHex])).result).toBe(true);
    const list = (await as(alice, "vouchers")).result as { pubkey: string }[];
    expect(list.map((v) => v.pubkey)).toEqual([OWNER_PUBKEY_HEX]);
    expect(await sql(`SELECT member FROM vouchers`)).toEqual([]);
  });
});

describe("a new phone getting back in", () => {
  it("asks, is approved by someone who checked the code, and gets the key a day later", async () => {
    const alice = await withCopy();
    const a = await ask(alice.pubkeyHex);
    expect(a.code).toBe(vouchCode(alice.pubkeyHex, a.phone.pubkeyHex));
    expect(a.code).toMatch(/^\d{6}$/);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "waiting", expiresAt: a.expiresAt } });

    // The owner sees it with the same code; so does alice's own device.
    const seen = (await callManagement("vouchrequests")).result as { pubkey: string; key: string; code: string; state: string }[];
    expect(seen).toEqual([
      expect.objectContaining({ pubkey: alice.pubkeyHex, key: a.phone.pubkeyHex, code: a.code, state: "waiting" }),
    ]);
    const mine = (await as(alice, "myvouch")).result as { open: { code: string } | null };
    expect(mine.open?.code).toBe(a.code);
    expect(await noticesTo(OWNER)).toEqual([`vouchrequest:${alice.pubkeyHex}`]);
    expect(await noticesTo(alice)).toEqual([`vouchasked:${alice.pubkeyHex}`]);

    // Another plain member can't approve it, and an approval naming a
    // different phone's key doesn't match it.
    const bob = await newMember();
    expect((await as(bob, "vouchrequests")).result).toEqual([]);
    expect((await as(bob, "vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex])).error).toBe(
      "vouchapprove: you can't vouch for this account",
    );
    expect((await callManagement("vouchapprove", [alice.pubkeyHex, randomKeypair().pubkeyHex])).error).toBe(
      "vouchapprove: that request is no longer open",
    );

    const approved = await callManagement("vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex]);
    const releaseAt = (approved.result as { releaseAt: number }).releaseAt;
    expect(releaseAt).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + VOUCH_RELEASE_DELAY_SECONDS - 5);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "approved", releaseAt } });
    expect(await noticesTo(alice)).toEqual([`vouchapproved:${alice.pubkeyHex}`, `vouchasked:${alice.pubkeyHex}`]);

    await windClock(alice.pubkeyHex);
    const ready = (await status(alice.pubkeyHex, a)).result as {
      state: string;
      copy: { v: number; pubkey: string; box: string; ct: string };
    };
    expect(ready.state).toBe("ready");
    expect(ready.copy).toMatchObject({ v: 1, pubkey: alice.pubkeyHex, box: await boxKey() });
    // Only the one-time key opens it, and it is alice's key.
    const secret = nip44Decrypt(ready.copy.ct, conversationKey(a.phone.secretKeyHex, ready.copy.box));
    expect(secret).toBe(alice.secretKeyHex);
    expect(bytesToHex(schnorr.getPublicKey(hexToBytes(secret)))).toBe(alice.pubkeyHex);
    expect(() => nip44Decrypt(ready.copy.ct, conversationKey(randomKeypair().secretKeyHex, ready.copy.box))).toThrow();

    // Alice sees the release afterwards, as a message and in myvouch.
    expect(await noticesTo(alice)).toContain(`vouchreleased:${alice.pubkeyHex}`);
    const after = (await as(alice, "myvouch")).result as { open: unknown; past: { releasedAt: number | null; approvedBy: string }[] };
    expect(after.open).toMatchObject({ state: "ready", releasedAt: expect.any(Number) });
    // Past the pickup window it closes, and the release stays on record.
    await windClock(alice.pubkeyHex, VOUCH_PICKUP_SECONDS);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "closed" } });
    const later = (await as(alice, "myvouch")).result as { open: unknown; past: { releasedAt: number | null; approvedBy: string; why: string }[] };
    expect(later.open).toBeNull();
    expect(later.past).toEqual([expect.objectContaining({ approvedBy: OWNER_PUBKEY_HEX, why: "released" })]);
    expect(later.past[0]!.releasedAt).not.toBeNull();
  });

  it("lets a named member and an admin approve", async () => {
    for (const kind of ["named", "admin"]) {
      const alice = await withCopy();
      const voucher = await newMember();
      if (kind === "named") await as(alice, "addvoucher", [voucher.pubkeyHex]);
      else await callManagement("addadmin", [voucher.pubkeyHex]);
      const a = await ask(alice.pubkeyHex);
      expect(await noticesTo(voucher)).toEqual([`vouchrequest:${alice.pubkeyHex}`]);
      expect((await as(voucher, "vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex])).error).toBeUndefined();
      await windClock(alice.pubkeyHex);
      expect(((await status(alice.pubkeyHex, a)).result as { state: string }).state).toBe("ready");
    }
  });

  it("releases nothing if the voucher was removed during the wait", async () => {
    const alice = await withCopy();
    const mum = await newMember();
    await as(alice, "addvoucher", [mum.pubkeyHex]);
    const a = await ask(alice.pubkeyHex);
    await as(mum, "vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex]);
    await callManagement("unallowpubkey", [mum.pubkeyHex]);
    await windClock(alice.pubkeyHex);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "closed" } });
  });

  it("releases nothing if an admin approver stops being one", async () => {
    const alice = await withCopy();
    const admin = await newMember();
    await callManagement("addadmin", [admin.pubkeyHex]);
    const a = await ask(alice.pubkeyHex);
    await as(admin, "vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex]);
    await callManagement("removeadmin", [admin.pubkeyHex]);
    await windClock(alice.pubkeyHex);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "closed" } });
  });

  it("is cancelled by the account's own device during the wait", async () => {
    const alice = await withCopy();
    const a = await ask(alice.pubkeyHex);
    await callManagement("vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex]);
    expect((await as(alice, "vouchcancel")).result).toBe(true);
    await windClock(alice.pubkeyHex);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "closed" } });
    const mine = (await as(alice, "myvouch")).result as { open: unknown; past: { why: string; closedBy: string }[] };
    expect(mine.open).toBeNull();
    expect(mine.past[0]).toMatchObject({ why: "cancelled", closedBy: alice.pubkeyHex });
    // Idempotent.
    expect((await as(alice, "vouchcancel")).result).toBe(true);
  });

  it("keeps one open request per account; a decline frees the place", async () => {
    const alice = await withCopy();
    const first = await ask(alice.pubkeyHex);
    const second = await ask(alice.pubkeyHex);
    // The second looks the same from outside but was not stored.
    expect(await status(alice.pubkeyHex, second)).toEqual({ result: { state: "waiting", expiresAt: second.expiresAt } });
    const seen = (await callManagement("vouchrequests")).result as { key: string }[];
    expect(seen.map((r) => r.key)).toEqual([first.phone.pubkeyHex]);
    expect((await callManagement("vouchapprove", [alice.pubkeyHex, second.phone.pubkeyHex])).error).toBe(
      "vouchapprove: that request is no longer open",
    );

    expect((await callManagement("vouchdecline", [alice.pubkeyHex, first.phone.pubkeyHex])).result).toBe(true);
    expect(await status(alice.pubkeyHex, first)).toEqual({ result: { state: "closed" } });
    const third = await ask(alice.pubkeyHex);
    const now = (await callManagement("vouchrequests")).result as { key: string }[];
    expect(now.map((r) => r.key)).toEqual([third.phone.pubkeyHex]);
  });

  it("lapses unapproved after its time", async () => {
    const alice = await withCopy();
    const a = await ask(alice.pubkeyHex);
    await sql(`UPDATE vouch_requests SET asked_at = asked_at - ? WHERE pubkey = ?`, VOUCH_REQUEST_TTL_SECONDS, alice.pubkeyHex);
    expect((await callManagement("vouchrequests")).result).toEqual([]);
    expect((await callManagement("vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex])).error).toBe(
      "vouchapprove: that request is no longer open",
    );
  });

  it("is closed when the account is removed, and the copy goes at once", async () => {
    const alice = await withCopy();
    const a = await ask(alice.pubkeyHex);
    await callManagement("vouchapprove", [alice.pubkeyHex, a.phone.pubkeyHex]);
    await callManagement("unallowpubkey", [alice.pubkeyHex]);
    expect(await sql(`SELECT pubkey FROM vouch_copies`)).toEqual([]);
    await windClock(alice.pubkeyHex);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "closed" } });
  });

  it("eraseme deletes the copy and every request", async () => {
    const alice = await withCopy();
    await ask(alice.pubkeyHex);
    expect((await as(alice, "eraseme")).error).toBeUndefined();
    expect(await sql(`SELECT pubkey FROM vouch_copies`)).toEqual([]);
    expect(await sql(`SELECT id FROM vouch_requests`)).toEqual([]);
  });
});

describe("no enumeration", () => {
  it("answers an account with a copy and a stranger the same way, and holds both to the floor", async () => {
    const alice = await withCopy();
    const stranger = randomKeypair().pubkeyHex;
    const phone = randomKeypair();
    const known = await unsigned("vouchask", [alice.pubkeyHex, phone.pubkeyHex]);
    const unknown = await unsigned("vouchask", [stranger, phone.pubkeyHex]);
    expect(known.status).toBe(unknown.status);
    expect(known.headers).toEqual(unknown.headers);
    const k = known.body.result as Record<string, unknown>;
    const u = unknown.body.result as Record<string, unknown>;
    expect(Object.keys(k)).toEqual(Object.keys(u));
    expect(known.text.length).toBe(unknown.text.length);
    for (const reply of [known, unknown]) expect(reply.elapsed).toBeGreaterThanOrEqual(VAULT_OPEN_FLOOR_MS - 5);

    const ks = await unsigned("vouchstatus", [alice.pubkeyHex, phone.pubkeyHex, k.token]);
    const us = await unsigned("vouchstatus", [stranger, phone.pubkeyHex, u.token]);
    expect(ks.body).toEqual({ result: { state: "waiting", expiresAt: k.expiresAt } });
    expect(us.body).toEqual({ result: { state: "waiting", expiresAt: u.expiresAt } });
    for (const reply of [ks, us]) expect(reply.elapsed).toBeGreaterThanOrEqual(VAULT_OPEN_FLOOR_MS - 5);
  });

  it("answers a member without a copy like a stranger, and stores nothing for either", async () => {
    const bob = await newMember();
    await ask(bob.pubkeyHex);
    await ask(randomKeypair().pubkeyHex);
    expect(await sql(`SELECT id FROM vouch_requests`)).toEqual([]);
  });

  it("refuses a token it did not issue, or one for another key, with the vault's not-found", async () => {
    const alice = await withCopy();
    const a = await ask(alice.pubkeyHex);
    const forged = await unsigned("vouchstatus", [alice.pubkeyHex, a.phone.pubkeyHex, bytesToHex(randomBytes(20))]);
    const otherKey = await unsigned("vouchstatus", [alice.pubkeyHex, randomKeypair().pubkeyHex, a.token]);
    for (const reply of [forged, otherKey]) expect(reply.text).toBe(JSON.stringify({ error: VAULT_NOT_FOUND }));
  });

  it("rate-limits asks per account the same whether it exists or not", async () => {
    const alice = await withCopy();
    const stranger = randomKeypair().pubkeyHex;
    for (const account of [alice.pubkeyHex, stranger]) {
      const replies = [];
      for (let i = 0; i <= MAX_VOUCH_ASKS_PER_PUBKEY_PER_WINDOW; i++) {
        replies.push(await unsigned("vouchask", [account, randomKeypair().pubkeyHex]));
      }
      expect(replies.slice(0, -1).every((r) => r.body.result !== undefined)).toBe(true);
      expect(replies.at(-1)!.body).toEqual({ error: VAULT_RATE_LIMITED });
    }
  });

  it("refuses a malformed ask, and a one-time key that is not a usable key", async () => {
    const alice = await withCopy();
    for (const params of [[], [alice.pubkeyHex], [alice.pubkeyHex, "zz"], [alice.pubkeyHex, alice.pubkeyHex]]) {
      expect((await unsigned("vouchask", params)).body).toEqual({ error: VOUCH_ASK_USAGE });
    }
    // Not an x coordinate on the curve.
    expect((await unsigned("vouchask", [alice.pubkeyHex, "0".repeat(63) + "5"])).body).toEqual({ error: VOUCH_ASK_USAGE });
  });

  it("stores nothing with VOUCH=off, and still answers the same way", async () => {
    const alice = await withCopy();
    mutableEnv.VOUCH = "off";
    const a = await ask(alice.pubkeyHex);
    expect(await status(alice.pubkeyHex, a)).toEqual({ result: { state: "waiting", expiresAt: a.expiresAt } });
    expect(await sql(`SELECT id FROM vouch_requests`)).toEqual([]);
  });
});
