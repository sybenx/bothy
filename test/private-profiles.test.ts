// Private profiles (src/profiles.ts): a member's kind 0 is served only to
// this home's authenticated owner, admins and members, in stored reads and
// live fan-out; removed-in-grace profiles only to the owner and admins;
// members may store a sealed photo; leaving for good deletes the profile.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { MEMBER_REMOVAL_GRACE_SECONDS } from "../src/limits";
import { sha256Hex } from "../src/photos";
import type { Relay } from "../src/relay";
import { storeEvent, sweepFormerMembers } from "../src/storage";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { collectStored, connectLiveFeed, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;

afterEach(() => {
  delete mutableEnv.MEMBER_LIST;
});

const OWNER: Keypair = { secretKeyHex: OWNER_SECRET_KEY_HEX, pubkeyHex: OWNER_PUBKEY_HEX } as Keypair;

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.27.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function as(who: Keypair, method: string, params: unknown[] = []) {
  return callManagement(method, params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function newMember(): Promise<Keypair> {
  const who = randomKeypair();
  expect((await callManagement("allowpubkey", [who.pubkeyHex])).result).toBe(true);
  return who;
}

async function newAdmin(): Promise<Keypair> {
  const who = randomKeypair();
  expect((await callManagement("addadmin", [who.pubkeyHex])).result).toBe(true);
  return who;
}

async function authenticate(conn: RelayConn, who: Keypair): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage();
  conn.send([
    "AUTH",
    signEvent(who.secretKeyHex, {
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

async function connectAs(who: Keypair | null): Promise<RelayConn> {
  const conn = await connectRelay(freshIp());
  if (who !== null) await authenticate(conn, who);
  return conn;
}

function profile(who: Keypair, name: string, createdAt?: number): NostrEvent {
  return signEvent(who.secretKeyHex, {
    kind: 0,
    content: JSON.stringify({ name }),
    ...(createdAt === undefined ? {} : { created_at: createdAt }),
  });
}

async function publishProfile(who: Keypair, name: string): Promise<NostrEvent> {
  const conn = await connectAs(who);
  const event = profile(who, name);
  const [, , ok, message] = await publish(conn, event);
  expect([ok, message]).toEqual([true, ""]);
  conn.close();
  return event;
}

// The names `reader` gets back for these filters.
async function namesSeenBy(reader: Keypair | null, filters: Record<string, unknown>[]): Promise<string[]> {
  const conn = await connectAs(reader);
  const events = await collectStored(conn, "p", filters);
  conn.close();
  return events.map((e) => (JSON.parse(e.content) as { name: string }).name).sort();
}

async function nothingArrives(conn: RelayConn): Promise<void> {
  await expect(conn.nextMessage(300)).rejects.toThrow(/no message/);
}

async function rows(query: string, ...bindings: unknown[]): Promise<Record<string, unknown>[]> {
  return runInDurableObject(stub(), (_i: Relay, state) => state.storage.sql.exec(query, ...bindings).toArray());
}

describe("private profiles: NIP-11", () => {
  it('says "profiles": "members"', async () => {
    const info = await (
      await exports.default.fetch(new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }))
    ).json<Record<string, unknown>>();
    expect(info.profiles).toBe("members");
  });
});

describe("private profiles: stored reads", () => {
  it("hide a member's kind 0 from an unauthenticated reader and from an authenticated stranger", async () => {
    const alice = await newMember();
    await publishProfile(alice, "Alice");
    const filters = [{ kinds: [0], authors: [alice.pubkeyHex] }];
    expect(await namesSeenBy(null, filters)).toEqual([]);
    expect(await namesSeenBy(randomKeypair(), filters)).toEqual([]);
    // No kinds named at all: still omitted.
    expect(await namesSeenBy(null, [{ authors: [alice.pubkeyHex] }])).toEqual([]);
    expect(await namesSeenBy(null, [{ ids: [(await publishProfile(alice, "Alice 2")).id] }])).toEqual([]);
  });

  it("answer a stranger the same way whether or not the member has a profile stored", async () => {
    const alice = await newMember();
    const bob = await newMember();
    await publishProfile(alice, "Alice");
    const conn = await connectAs(null);
    const withProfile = await collectStored(conn, "a", [{ kinds: [0], authors: [alice.pubkeyHex] }]);
    const without = await collectStored(conn, "b", [{ kinds: [0], authors: [bob.pubkeyHex] }]);
    conn.close();
    expect(withProfile).toEqual(without);
  });

  it("show every member's kind 0 to members, admins and the owner", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const admin = await newAdmin();
    await publishProfile(alice, "Alice");
    await publishProfile(bob, "Bob");
    const filters = [{ kinds: [0], authors: [alice.pubkeyHex, bob.pubkeyHex] }];
    for (const reader of [alice, bob, admin, OWNER]) {
      expect(await namesSeenBy(reader, filters)).toEqual(["Alice", "Bob"]);
    }
    // A wildcard read by a member, with the list not hidden.
    expect(await namesSeenBy(alice, [{ kinds: [0] }])).toEqual(["Alice", "Bob"]);
  });

  it("leave the owner's own kind 0 public", async () => {
    await publishProfile(OWNER, "Aaron");
    expect(await namesSeenBy(null, [{ kinds: [0], authors: [OWNER_PUBKEY_HEX] }])).toEqual(["Aaron"]);
  });

  it("show a removed-in-grace member's kind 0 to the owner and admins only", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const admin = await newAdmin();
    await publishProfile(alice, "Alice");
    expect((await callManagement("unallowpubkey", [alice.pubkeyHex])).result).toBeTruthy();
    const filters = [{ kinds: [0], authors: [alice.pubkeyHex] }];
    expect(await namesSeenBy(OWNER, filters)).toEqual(["Alice"]);
    expect(await namesSeenBy(admin, filters)).toEqual(["Alice"]);
    expect(await namesSeenBy(bob, filters)).toEqual([]);
    expect(await namesSeenBy(null, filters)).toEqual([]);
    // The removed person may still read their own.
    expect(await namesSeenBy(alice, filters)).toEqual(["Alice"]);
  });

  it("with MEMBER_LIST=hidden, give a plain member profiles only on a filter naming authors", async () => {
    mutableEnv.MEMBER_LIST = "hidden";
    const alice = await newMember();
    const bob = await newMember();
    const admin = await newAdmin();
    await publishProfile(alice, "Alice");
    await publishProfile(bob, "Bob");
    expect(await namesSeenBy(bob, [{ kinds: [0] }])).toEqual(["Bob"]);
    expect(await namesSeenBy(bob, [{ kinds: [0], authors: [alice.pubkeyHex] }])).toEqual(["Alice"]);
    expect(await namesSeenBy(admin, [{ kinds: [0] }])).toEqual(["Alice", "Bob"]);
  });

  it("stop serving a stranger a profile the moment its author joins (no stale cached answer)", async () => {
    const carol = randomKeypair();
    await runInDurableObject(stub(), (_i: Relay, state) => {
      storeEvent(state.storage.sql, profile(carol, "Carol"), Math.floor(Date.now() / 1000));
    });
    const filters = [{ kinds: [0], authors: [carol.pubkeyHex] }];
    expect(await namesSeenBy(null, filters)).toEqual(["Carol"]);
    expect((await callManagement("allowpubkey", [carol.pubkeyHex])).result).toBe(true);
    expect(await namesSeenBy(null, filters)).toEqual([]);
  });
});

describe("private profiles: how an app signs in to read them", () => {
  it("a profile REQ carrying an own-mail filter is asked to AUTH, then answers with members' profiles", async () => {
    const alice = await newMember();
    const bob = await newMember();
    await publishProfile(alice, "Alice");
    const conn = await connectRelay(freshIp());
    const now = Math.floor(Date.now() / 1000);
    const filters = [
      { kinds: [0], authors: [alice.pubkeyHex] },
      { kinds: [1059], "#p": [bob.pubkeyHex], since: now + 60, limit: 1 },
    ];
    conn.send(["REQ", "p", ...filters]);
    const [auth, challenge] = await conn.nextMessage();
    expect(auth).toBe("AUTH");
    const [closed, , reason] = await conn.nextMessage();
    expect([closed, String(reason).startsWith("auth-required")]).toEqual(["CLOSED", true]);
    conn.send([
      "AUTH",
      signEvent(bob.secretKeyHex, {
        kind: 22242,
        tags: [
          ["relay", "wss://example.com"],
          ["challenge", challenge as string],
        ],
      }),
    ]);
    expect((await conn.nextMessage())[2]).toBe(true);
    const events = await collectStored(conn, "p", filters);
    expect(events.map((e) => e.pubkey)).toEqual([alice.pubkeyHex]);
    conn.close();
  });
});

describe("private profiles: live fan-out", () => {
  it("sends a member's new kind 0 to other members' open subscriptions, never a stranger's or the live feed", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const bobConn = await connectAs(bob);
    const strangerConn = await connectAs(randomKeypair());
    const anonConn = await connectAs(null);
    for (const conn of [bobConn, strangerConn, anonConn]) {
      expect(await collectStored(conn, "live", [{ kinds: [0] }])).toEqual([]);
    }
    const feed = await connectLiveFeed();

    const event = await publishProfile(alice, "Alice");
    const [type, subId, got] = await bobConn.nextMessage();
    expect([type, subId, (got as NostrEvent).id]).toEqual(["EVENT", "live", event.id]);
    await nothingArrives(strangerConn);
    await nothingArrives(anonConn);
    await expect(feed.nextMessage(300)).rejects.toThrow(/no message/);
    for (const conn of [bobConn, strangerConn, anonConn]) conn.close();
    feed.close();
  });

  it("with MEMBER_LIST=hidden, sends it to a plain member only on a subscription naming the author", async () => {
    mutableEnv.MEMBER_LIST = "hidden";
    const alice = await newMember();
    const bob = await newMember();
    const wildcard = await connectAs(bob);
    const named = await connectAs(bob);
    expect(await collectStored(wildcard, "w", [{ kinds: [0] }])).toEqual([]);
    expect(await collectStored(named, "n", [{ kinds: [0], authors: [alice.pubkeyHex] }])).toEqual([]);
    const event = await publishProfile(alice, "Alice");
    expect((await named.nextMessage())[2]).toMatchObject({ id: event.id });
    await nothingArrives(wildcard);
    wildcard.close();
    named.close();
  });

  it("still fans the owner's kind 0 out to anyone", async () => {
    const anonConn = await connectAs(null);
    expect(await collectStored(anonConn, "o", [{ kinds: [0], authors: [OWNER_PUBKEY_HEX] }])).toEqual([]);
    const event = await publishProfile(OWNER, "Aaron");
    expect((await anonConn.nextMessage())[2]).toMatchObject({ id: event.id });
    anonConn.close();
  });
});

describe("private profiles: leaving deletes the profile", () => {
  it("eraseme deletes the member's kind 0 and their own keys' kind 0", async () => {
    const alice = await newMember();
    const child = randomKeypair();
    const proof = signEvent(child.secretKeyHex, {
      kind: 21236,
      tags: [
        ["p", alice.pubkeyHex],
        ["relay", "https://example.com/"],
      ],
      content: "",
    });
    expect((await as(alice, "addmykey", [child.pubkeyHex, proof])).result).toBe(true);
    await publishProfile(alice, "Alice");
    await publishProfile(child, "Alice too");
    expect(await rows(`SELECT 1 FROM events WHERE kind = 0 AND pubkey IN (?, ?)`, alice.pubkeyHex, child.pubkeyHex)).toHaveLength(2);
    expect((await as(alice, "eraseme")).result).toMatchObject({ erased: true });
    expect(await rows(`SELECT 1 FROM events WHERE kind = 0 AND pubkey IN (?, ?)`, alice.pubkeyHex, child.pubkeyHex)).toEqual([]);
  });

  it("the end of the removal grace deletes the kind 0, not before", async () => {
    const alice = await newMember();
    await publishProfile(alice, "Alice");
    expect((await callManagement("unallowpubkey", [alice.pubkeyHex])).result).toBeTruthy();
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      const removedAt = sql
        .exec<{ removed_at: number }>(`SELECT removed_at FROM former_members WHERE pubkey = ?`, alice.pubkeyHex)
        .toArray()[0]!.removed_at;
      const kind0 = () => sql.exec(`SELECT 1 FROM events WHERE kind = 0 AND pubkey = ?`, alice.pubkeyHex).toArray();
      sweepFormerMembers(sql, removedAt + MEMBER_REMOVAL_GRACE_SECONDS - 1, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100);
      expect(kind0()).toHaveLength(1);
      sweepFormerMembers(sql, removedAt + MEMBER_REMOVAL_GRACE_SECONDS, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100);
      expect(kind0()).toEqual([]);
    });
  });
});

describe("private profiles: sealed photos", () => {
  function sealed(size = 1500): Uint8Array {
    const bytes = crypto.getRandomValues(new Uint8Array(size));
    // Not an image signature, whatever the random bytes were.
    bytes[0] = 0x00;
    return bytes;
  }

  async function upload(who: Keypair, bytes: Uint8Array, contentType: string): Promise<Response> {
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
    return exports.default.fetch(
      new Request("https://example.com/upload", {
        method: "PUT",
        body: bytes,
        headers: {
          Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
          "Content-Type": contentType,
          "CF-Connecting-IP": freshIp(),
        },
      }),
    );
  }

  it("takes a member's sealed photo as octet-stream and serves the bytes by hash", async () => {
    const alice = await newMember();
    const bytes = sealed();
    const response = await upload(alice, bytes, "application/octet-stream");
    expect(response.status).toBe(200);
    const sha256 = await sha256Hex(bytes);
    expect(await response.json()).toMatchObject({
      url: `https://example.com/${sha256}`,
      sha256,
      type: "application/octet-stream",
    });
    const got = await exports.default.fetch(
      new Request(`https://example.com/${sha256}`, { headers: { "CF-Connecting-IP": freshIp() } }),
    );
    expect(got.status).toBe(200);
    expect(got.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
  });

  it("refuses a sealed photo from the owner, from a stranger, and sealed bytes claimed as an image", async () => {
    const owner = await upload(OWNER, sealed(), "application/octet-stream");
    expect([owner.status, owner.headers.get("X-Reason")]).toEqual([
      415,
      "the owner's photo is public, so it must be JPEG, PNG or WebP",
    ]);
    expect((await upload(randomKeypair(), sealed(), "application/octet-stream")).status).toBe(403);
    const alice = await newMember();
    expect((await upload(alice, sealed(), "image/jpeg")).status).toBe(415);
  });
});
