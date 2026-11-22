// A member deleting their own account (nip86.ts eraseme, storage.ts
// eraseMember): everything bothy holds for them goes at once, their place
// goes back to their inviter, and the people they invited stay.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INVITES_PER_MEMBER_DEFAULT } from "../src/limits";
import { NOT_A_MEMBER_REASON } from "../src/nip86";
import { sha256Hex } from "../src/photos";
import type { Relay } from "../src/relay";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { makeDevice } from "./helpers/push";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
beforeEach(() => {
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
});
afterEach(() => {
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.23.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function as(who: Keypair, method: string, params: unknown[] = []) {
  return callManagement(method, params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function codeFrom(who: Keypair | null, params: unknown[] = []): Promise<string> {
  const reply =
    who === null ? await callManagement("createinvite", params) : await as(who, "createinvite", params);
  expect(reply.error).toBeUndefined();
  return (reply.result as { code: string }).code;
}

async function joinWith(code: string): Promise<Keypair> {
  const who = randomKeypair();
  expect((await as(who, "redeeminvite", [code])).result).toBe(true);
  return who;
}

async function wrapTo(...pubkeys: string[]): Promise<NostrEvent> {
  const wrap = signEvent(randomKeypair().secretKeyHex, {
    kind: 1059,
    tags: pubkeys.map((p) => ["p", p]),
    content: "sealed",
  });
  const conn = await connectRelay(freshIp());
  const [, , ok] = await publish(conn, wrap);
  conn.close();
  expect(ok).toBe(true);
  return wrap;
}

async function rows(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]> {
  return runInDurableObject(stub(), (_i: Relay, state) =>
    state.storage.sql.exec(query, ...bindings).toArray(),
  );
}

async function uploadPhoto(who: Keypair): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(500));
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  const sha256 = await sha256Hex(bytes);
  const auth = signEvent(who.secretKeyHex, {
    kind: 24242,
    content: "upload",
    tags: [
      ["t", "upload"],
      ["expiration", String(Math.floor(Date.now() / 1000) + 300)],
      ["x", sha256],
    ],
  });
  const { exports } = await import("cloudflare:workers");
  const response = await exports.default.fetch(
    new Request("https://example.com/upload", {
      method: "PUT",
      body: bytes,
      headers: { Authorization: `Nostr ${btoa(JSON.stringify(auth))}`, "CF-Connecting-IP": freshIp() },
    }),
  );
  expect(response.status).toBe(200);
  return sha256;
}

describe("eraseme", () => {
  it("deletes what bothy holds for the member at once, and ends the membership", async () => {
    const alice = await joinWith(await codeFrom(null));
    const own = await wrapTo(alice.pubkeyHex);
    const shared = await wrapTo(alice.pubkeyHex, OWNER_PUBKEY_HEX);
    const photo = await uploadPhoto(alice);
    const device = await makeDevice("https://push.example/alice");
    await as(alice, "subscribepush", [{ endpoint: device.endpoint, keys: device.keys }]);

    const reply = await as(alice, "eraseme");
    expect(reply.result).toEqual({ erased: true, messagesDeleted: 1, messagesLeft: 0 });

    expect(await rows(`SELECT id FROM events WHERE id = ?`, own.id)).toEqual([]);
    // Mail that is also the owner's stays.
    expect(await rows(`SELECT id FROM events WHERE id = ?`, shared.id)).toEqual([{ id: shared.id }]);
    expect(await rows(`SELECT 1 FROM photos WHERE sha256 = ?`, photo)).toEqual([]);
    expect(await rows(`SELECT 1 FROM push_subscriptions WHERE pubkey = ?`, alice.pubkeyHex)).toEqual([]);
    expect(await rows(`SELECT 1 FROM allowed_pubkeys WHERE pubkey = ?`, alice.pubkeyHex)).toEqual([]);

    // Gone as a member: the next call is refused, and new mail too.
    const after = await as(alice, "myinvites");
    expect([after.status, after.error]).toEqual([401, NOT_A_MEMBER_REASON]);
    const conn = await connectRelay(freshIp());
    const [, , ok] = await publish(
      conn,
      signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", alice.pubkeyHex]], content: "x" }),
    );
    conn.close();
    expect(ok).toBe(false);
  });

  it("gives their place back to the member who invited them", async () => {
    const parent = await joinWith(await codeFrom(null));
    const child = await joinWith(await codeFrom(parent));
    const left = async () => ((await as(parent, "myinvites")).result as { left: number }).left;
    expect(await left()).toBe(INVITES_PER_MEMBER_DEFAULT - 1);
    await as(child, "eraseme");
    expect(await left()).toBe(INVITES_PER_MEMBER_DEFAULT);
    // The code they used is not open again.
    expect((await as(parent, "listunusedinvites")).result).toEqual([]);
  });

  it("keeps the people they invited, under whoever invited them", async () => {
    const a = await joinWith(await codeFrom(null));
    const b = await joinWith(await codeFrom(a));
    const c = await joinWith(await codeFrom(b));
    await as(b, "eraseme");
    const { members } = (await callManagement("listmembers")).result as {
      members: { pubkey: string; invitedBy: string }[];
    };
    expect(members.find((m) => m.pubkey === c.pubkeyHex)?.invitedBy).toBe(a.pubkeyHex);
    expect(members.some((m) => m.pubkey === b.pubkeyHex)).toBe(false);
  });

  it("revokes their own codes still waiting", async () => {
    const a = await joinWith(await codeFrom(null));
    const code = await codeFrom(a);
    await as(a, "eraseme");
    expect((await as(randomKeypair(), "redeeminvite", [code])).error).toBeDefined();
  });

  it("takes an admin's role with the account", async () => {
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    expect((await as(admin, "eraseme")).result).toEqual({ erased: true, messagesDeleted: 0, messagesLeft: 0 });
    expect((await callManagement("listadmins")).result).toEqual([]);
  });

  it("is told to the storage service as erased, with nothing left to delete", async () => {
    const service = randomKeypair();
    await callManagement("setstorage", ["https://storage.example/", service.pubkeyHex]);
    const alice = await joinWith(await codeFrom(null));
    const bob = await joinWith(await codeFrom(null));
    await as(alice, "eraseme");
    await callManagement("unallowpubkey", [bob.pubkeyHex]);
    const { removed } = (await as(service, "memberkeys")).result as {
      removed: { pubkey: string; removedAt: number; deletesAt: number; reason: string }[];
    };
    const erased = removed.find((r) => r.pubkey === alice.pubkeyHex)!;
    const removedByOwner = removed.find((r) => r.pubkey === bob.pubkeyHex)!;
    expect([erased.reason, erased.deletesAt]).toEqual(["erased", erased.removedAt]);
    expect(removedByOwner.reason).toBe("removed");
    expect(removedByOwner.deletesAt).toBeGreaterThan(removedByOwner.removedAt);
  });

  it("is not for the owner, nor for someone who is not a member", async () => {
    expect((await callManagement("eraseme")).error).toBe(
      "eraseme: the relay owner cannot erase themselves; the relay itself is your account here",
    );
    const stranger = await as(randomKeypair(), "eraseme");
    expect([stranger.status, stranger.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });
});
