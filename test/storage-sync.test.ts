// The home's file server (nip86.ts setstorage, memberkeys, NIP-11
// `storage`) and when this relay stored a member's mail (mailtimes).
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MEMBER_REMOVAL_GRACE_SECONDS } from "../src/limits";
import { MAX_MAILTIMES_IDS, STORAGE_ONLY_REASON } from "../src/nip86";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const STORAGE_URL = "https://storage.example/";

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.25.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function as(who: Keypair | { secretKeyHex: string }, method: string, params: unknown[] = []) {
  return callManagement(method, params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

async function nip11(): Promise<Record<string, unknown>> {
  const response = await exports.default.fetch(
    new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
  );
  return (await response.json()) as Record<string, unknown>;
}

async function wrapTo(pubkey: string): Promise<NostrEvent> {
  const wrap = signEvent(randomKeypair().secretKeyHex, {
    kind: 1059,
    tags: [["p", pubkey]],
    content: "sealed",
  });
  const conn = await connectRelay(freshIp());
  const [, , ok] = await publish(conn, wrap);
  conn.close();
  expect(ok).toBe(true);
  return wrap;
}

describe("setstorage", () => {
  it("stores the server and its key, advertises the URL, and clears with an empty URL", async () => {
    const service = randomKeypair();
    expect((await callManagement("setstorage", [STORAGE_URL, service.pubkeyHex])).result).toBe(true);
    const doc = await nip11();
    expect(doc.storage).toEqual({ url: STORAGE_URL });
    expect(doc).toHaveProperty("blossom");

    expect((await callManagement("setstorage", [""])).result).toBe(true);
    expect((await nip11()).storage).toBeUndefined();
    expect((await as(service, "memberkeys")).status).toBe(401);
  });

  it("is the owner's alone", async () => {
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    for (const who of [admin, await member()]) {
      expect((await as(who, "setstorage", [STORAGE_URL, who.pubkeyHex])).status).toBe(401);
    }
  });

  it("refuses an address that is not https, or a key that is not one", async () => {
    expect(
      (await callManagement("setstorage", ["http://storage.example/", randomKeypair().pubkeyHex])).error,
    ).toBe('setstorage takes the storage server\'s https URL and its pubkey; "" as the URL clears both');
    expect((await callManagement("setstorage", [STORAGE_URL, "nope"])).error).toBe(
      "setstorage: the second parameter is the storage service's pubkey, as npub or hex",
    );
  });
});

describe("getstorage", () => {
  it("tells the owner what is set, or null, and nobody else", async () => {
    expect((await callManagement("getstorage")).result).toBeNull();
    const service = randomKeypair();
    await callManagement("setstorage", [STORAGE_URL, service.pubkeyHex]);
    expect((await callManagement("getstorage")).result).toEqual({ url: STORAGE_URL, pubkey: service.pubkeyHex });
    expect((await as(await member(), "getstorage")).status).toBe(401);
    await callManagement("setstorage", [""]);
    expect((await callManagement("getstorage")).result).toBeNull();
  });
});

describe("memberkeys", () => {
  it("tells the storage service who may upload and who has left, and nothing else", async () => {
    const service = randomKeypair();
    await callManagement("setstorage", [STORAGE_URL, service.pubkeyHex]);
    const alice = await member();
    const bob = await member();
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    await callManagement("unallowpubkey", [bob.pubkeyHex]);

    const reply = await as(service, "memberkeys");
    const result = reply.result as {
      owner: string;
      members: string[];
      removed: { pubkey: string; removedAt: number; deletesAt: number; reason: string }[];
    };
    expect(Object.keys(result).sort()).toEqual(["members", "owner", "removed"]);
    expect(result.owner).toBe(OWNER_PUBKEY_HEX);
    expect(result.members).toEqual([alice.pubkeyHex, admin.pubkeyHex].sort());
    expect(result.removed).toEqual([
      {
        pubkey: bob.pubkeyHex,
        removedAt: expect.any(Number),
        deletesAt: result.removed[0]!.removedAt + MEMBER_REMOVAL_GRACE_SECONDS,
        reason: "removed",
      },
    ]);
  });

  it("answers no other key, the owner's included", async () => {
    const service = randomKeypair();
    await callManagement("setstorage", [STORAGE_URL, service.pubkeyHex]);
    for (const who of [{ secretKeyHex: OWNER_SECRET_KEY_HEX }, await member(), randomKeypair()]) {
      const reply = await as(who, "memberkeys");
      expect([reply.status, reply.error]).toEqual([401, STORAGE_ONLY_REASON]);
    }
    // A replaced key stops working at once.
    const next = randomKeypair();
    await callManagement("setstorage", [STORAGE_URL, next.pubkeyHex]);
    expect((await as(service, "memberkeys")).status).toBe(401);
    expect((await as(next, "memberkeys")).status).toBe(200);
  });

  it("gives the storage key nothing but memberkeys", async () => {
    const service = randomKeypair();
    await callManagement("setstorage", [STORAGE_URL, service.pubkeyHex]);
    for (const method of ["listmembers", "listallowedpubkeys", "mailtimes", "homestats"]) {
      expect((await as(service, method, [["a".repeat(64)]])).status).toBe(401);
    }
  });

  it("refuses everyone while no storage is set", async () => {
    expect((await callManagement("memberkeys")).status).toBe(401);
  });
});

describe("mailtimes", () => {
  it("gives a member the time each of their own wraps was stored, and leaves out the rest", async () => {
    const alice = await member();
    const bob = await member();
    const before = Math.floor(Date.now() / 1000);
    const forAlice = await wrapTo(alice.pubkeyHex);
    const forBob = await wrapTo(bob.pubkeyHex);
    const reply = await as(alice, "mailtimes", [[forAlice.id, forBob.id, "f".repeat(64)]]);
    const times = reply.result as Record<string, number>;
    expect(Object.keys(times)).toEqual([forAlice.id]);
    expect(times[forAlice.id]).toBeGreaterThanOrEqual(before);
    expect(times[forAlice.id]).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("works for the owner's own mail", async () => {
    const forOwner = await wrapTo(OWNER_PUBKEY_HEX);
    const times = (await callManagement("mailtimes", [[forOwner.id]])).result as Record<string, number>;
    expect(Object.keys(times)).toEqual([forOwner.id]);
  });

  it(`takes 1 to ${MAX_MAILTIMES_IDS} hex ids and refuses anything else`, async () => {
    const alice = await member();
    const message = `mailtimes takes an array of 1 to ${MAX_MAILTIMES_IDS} event ids, as 64-character hex`;
    for (const params of [
      [[]],
      ["a".repeat(64)],
      [["nothex"]],
      [Array(MAX_MAILTIMES_IDS + 1).fill("a".repeat(64))],
    ]) {
      expect((await as(alice, "mailtimes", params)).error).toBe(message);
    }
    expect((await as(alice, "mailtimes", [Array(MAX_MAILTIMES_IDS).fill("a".repeat(64))])).result).toEqual(
      {},
    );
  });

  it("is refused to somebody who is not a member", async () => {
    expect((await as(randomKeypair(), "mailtimes", [["a".repeat(64)]])).status).toBe(401);
  });
});
