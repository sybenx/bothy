// The `network` write policy (write-policy.ts, ownership.ts, src/network.ts):
// besides everything `mentions` admits, the people the owner's follows
// follow. The list is built from the follows' own contact lists, verified,
// capped and paced; it is never shown, only counted.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { NETWORK_AUTHORS_PER_TICK } from "../src/limits";
import { ingestNetwork, networkSummary, networkWork } from "../src/network";
import { isAllowedWriter } from "../src/ownership";
import type { Relay } from "../src/relay";
import { WRITE_POLICIES } from "../src/write-policy";
import { signEvent, withCorruptSignature, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.NETWORK_MAX_KEYS;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

function sqlOf<T>(run: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(stub(), (_i: Relay, state) => run(state.storage.sql));
}

// Follows straight into the cache (ownership.ts refreshFollows is tested
// elsewhere); what matters here is what is built on top of them.
async function follow(...who: Keypair[]): Promise<void> {
  await sqlOf((sql) => {
    for (const k of who)
      sql.exec(`INSERT OR IGNORE INTO follows (pubkey, fetched_at) VALUES (?, 1)`, k.pubkeyHex);
  });
}

function contactList(of: Keypair, follows: string[], createdAt = Math.floor(Date.now() / 1000)): NostrEvent {
  return signEvent(of.secretKeyHex, { kind: 3, created_at: createdAt, tags: follows.map((p) => ["p", p]) });
}

async function setPolicy(name: string): Promise<void> {
  expect((await callManagement("changewritepolicy", [name])).result).toBe(true);
}

let nextIp = 0;
async function publishAs(who: Keypair, tags: string[][] = []): Promise<[boolean, string]> {
  nextIp++;
  const conn = await connectRelay(`172.17.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`);
  const [, , ok, message] = await publish(
    conn,
    signEvent(who.secretKeyHex, { kind: 1, content: "hello", tags }),
  );
  conn.close();
  return [ok, message];
}

// One full rebuild through the two halves the Worker tick drives.
async function rebuild(lists: NostrEvent[], now = Math.floor(Date.now() / 1000)): Promise<void> {
  await sqlOf((sql) => {
    for (let guard = 0; guard < 100; guard++) {
      const work = networkWork(sql, now);
      if (work === null) return;
      ingestNetwork(sql, env, work.authors, lists, 1_000_000);
    }
    throw new Error("rebuild did not finish");
  });
}

describe("the policy", () => {
  it("sits after mentions, so relays on mentions are not widened", async () => {
    expect(WRITE_POLICIES).toEqual(["owner", "inbox", "follows", "mentions", "network", "all"]);
    const reply = await callManagement("changewritepolicy", ["network"]);
    expect(reply.result).toBe(true);
    expect(reply.error).toContain("the people they follow");
  });

  it("admits someone a follow follows, and still refuses a stranger", async () => {
    const friend = randomKeypair();
    const friendOfFriend = randomKeypair();
    const stranger = randomKeypair();
    await follow(friend);
    await rebuild([contactList(friend, [friendOfFriend.pubkeyHex])]);
    await setPolicy("network");

    expect((await publishAs(friendOfFriend))[0]).toBe(true);
    expect(await publishAs(stranger)).toEqual([
      false,
      "restricted: only the owner, people they follow, people those follow, and events that mention the owner can publish here",
    ]);
    // Everything mentions admits is still admitted.
    expect((await publishAs(stranger, [["p", OWNER_PUBKEY_HEX]]))[0]).toBe(true);
  });

  it("does not admit the second ring under follows or mentions", async () => {
    const friend = randomKeypair();
    const friendOfFriend = randomKeypair();
    await follow(friend);
    await sqlOf((sql) =>
      sql.exec(`INSERT INTO network_keys (pubkey, gen) VALUES (?, 1)`, friendOfFriend.pubkeyHex),
    );
    for (const policy of ["follows", "mentions"] as const) {
      const auth = await sqlOf((sql) =>
        isAllowedWriter(sql, env, friendOfFriend.pubkeyHex, { policy, tags: [] }),
      );
      expect(auth.allowed).toBe(false);
    }
  });

  it("keeps bans and allowpubkey on top of it", async () => {
    const friend = randomKeypair();
    const friendOfFriend = randomKeypair();
    const allowed = randomKeypair();
    await follow(friend);
    await rebuild([contactList(friend, [friendOfFriend.pubkeyHex])]);
    await setPolicy("network");
    await callManagement("banpubkey", [friendOfFriend.pubkeyHex]);
    expect((await publishAs(friendOfFriend))[1]).toBe("blocked: this pubkey is banned from writing here");
    await callManagement("allowpubkey", [allowed.pubkeyHex]);
    expect((await publishAs(allowed))[0]).toBe(true);
  });
});

describe("building the list", () => {
  it("takes only lists that verify, from follows that were asked about", async () => {
    const friend = randomKeypair();
    const notAFollow = randomKeypair();
    const viaForgery = randomKeypair().pubkeyHex;
    const viaStranger = randomKeypair().pubkeyHex;
    const real = randomKeypair().pubkeyHex;
    await follow(friend);
    await rebuild([
      withCorruptSignature(contactList(friend, [viaForgery], Math.floor(Date.now() / 1000) + 5)),
      contactList(notAFollow, [viaStranger]),
      contactList(friend, [real]),
    ]);
    const keys = await sqlOf((sql) =>
      sql
        .exec<{ pubkey: string }>(`SELECT pubkey FROM network_keys`)
        .toArray()
        .map((r) => r.pubkey),
    );
    expect(keys).toEqual([real]);
  });

  it("uses each follow's newest list", async () => {
    const friend = randomKeypair();
    const old = randomKeypair().pubkeyHex;
    const current = randomKeypair().pubkeyHex;
    await follow(friend);
    await rebuild([contactList(friend, [old], 1000), contactList(friend, [current], 2000)]);
    const keys = await sqlOf((sql) =>
      sql
        .exec<{ pubkey: string }>(`SELECT pubkey FROM network_keys`)
        .toArray()
        .map((r) => r.pubkey),
    );
    expect(keys).toEqual([current]);
  });

  it("stops at the cap, and says so", async () => {
    mutableEnv.NETWORK_MAX_KEYS = "3";
    const friend = randomKeypair();
    await follow(friend);
    await rebuild([
      contactList(
        friend,
        Array.from({ length: 5 }, () => randomKeypair().pubkeyHex),
      ),
    ]);
    const summary = await sqlOf((sql) => networkSummary(sql));
    expect([summary.count, summary.capped]).toEqual([3, true]);
  });

  it("stays inside a tick's row budget, and finishes the same list on the next tick", async () => {
    const friend = randomKeypair();
    await follow(friend);
    const many = Array.from({ length: 10 }, () => randomKeypair().pubkeyHex);
    const list = contactList(friend, many);
    await sqlOf((sql) => {
      const now = Math.floor(Date.now() / 1000);
      const work = networkWork(sql, now)!;
      // 2 rows per new key: a budget of 8 takes 4 keys and does not move on.
      expect(ingestNetwork(sql, env, work.authors, [list], 8)).toEqual({ taken: 0, rowsWritten: 8 });
      expect(networkWork(sql, now)!.authors).toEqual(work.authors);
      expect(ingestNetwork(sql, env, work.authors, [list], 100)).toEqual({ taken: 1, rowsWritten: 12 });
      expect(sql.exec(`SELECT COUNT(*) AS n FROM network_keys`).toArray()[0]).toEqual({ n: 10 });
    });
  });

  it("asks for a few follows at a time, in order", async () => {
    const follows = Array.from({ length: NETWORK_AUTHORS_PER_TICK + 3 }, () => randomKeypair());
    await follow(...follows);
    const first = await sqlOf((sql) => networkWork(sql, Math.floor(Date.now() / 1000)));
    expect(first!.authors.length).toBe(NETWORK_AUTHORS_PER_TICK);
    expect(first!.authors).toEqual([...first!.authors].sort());
  });
});

describe("rebuilding", () => {
  it("drops someone no follow lists any more, once enough lists were found", async () => {
    const friend = randomKeypair();
    const dropped = randomKeypair().pubkeyHex;
    const kept = randomKeypair().pubkeyHex;
    await follow(friend);
    const t0 = Math.floor(Date.now() / 1000);
    await rebuild([contactList(friend, [dropped, kept], t0 - 10)], t0);
    await rebuild([contactList(friend, [kept], t0)], t0 + 8 * 24 * 3600);
    const keys = await sqlOf((sql) =>
      sql
        .exec<{ pubkey: string }>(`SELECT pubkey FROM network_keys`)
        .toArray()
        .map((r) => r.pubkey),
    );
    expect(keys).toEqual([kept]);
    expect((await sqlOf((sql) => networkSummary(sql))).count).toBe(1);
  });

  it("still drops stale keys when public relays hold only some lists, as they usually do", async () => {
    // Measured on a real owner: about 60% of follows' lists were findable.
    const friends = Array.from({ length: 5 }, () => randomKeypair());
    await follow(...friends);
    const dropped = randomKeypair().pubkeyHex;
    const kept = randomKeypair().pubkeyHex;
    const t0 = Math.floor(Date.now() / 1000);
    await rebuild([contactList(friends[0]!, [dropped, kept], t0 - 10)], t0);
    await rebuild([contactList(friends[0]!, [kept], t0)], t0 + 8 * 24 * 3600);
    const keys = await sqlOf((sql) =>
      sql.exec<{ pubkey: string }>(`SELECT pubkey FROM network_keys`).toArray().map((r) => r.pubkey),
    );
    expect(keys).toEqual([kept]);
  });

  it("keeps the list when too few lists were found to trust a rebuild", async () => {
    const friends = Array.from({ length: 5 }, () => randomKeypair());
    await follow(...friends);
    const someone = randomKeypair().pubkeyHex;
    const t0 = Math.floor(Date.now() / 1000);
    await rebuild([contactList(friends[0]!, [someone])], t0);
    // A week later the relays answer for nobody.
    await rebuild([], t0 + 8 * 24 * 3600);
    const keys = await sqlOf((sql) =>
      sql
        .exec<{ pubkey: string }>(`SELECT pubkey FROM network_keys`)
        .toArray()
        .map((r) => r.pubkey),
    );
    expect(keys).toEqual([someone]);
  });

  it("waits a week between rebuilds, and does nothing unless the policy is network", async () => {
    const friend = randomKeypair();
    await follow(friend);
    const t0 = Math.floor(Date.now() / 1000);
    await rebuild([contactList(friend, [randomKeypair().pubkeyHex])], t0);
    expect(await sqlOf((sql) => networkWork(sql, t0 + 3600))).toBeNull();
    // The relay's own entry point checks the policy first.
    await setPolicy("follows");
    expect(await runInDurableObject(stub(), (instance: Relay) => instance.getNetworkWork())).toBeNull();
  });
});

describe("what is shown", () => {
  it("a count on /api/stats, never the list", async () => {
    const friend = randomKeypair();
    const friendOfFriend = randomKeypair();
    await follow(friend);
    await rebuild([contactList(friend, [friendOfFriend.pubkeyHex])]);
    const { exports } = await import("cloudflare:workers");
    const text = await (await exports.default.fetch(new Request("https://example.com/api/stats"))).text();
    const stats = JSON.parse(text) as Record<string, unknown>;
    expect([stats.networkCount, stats.networkCapped]).toEqual([1, false]);
    expect(typeof stats.networkUpdatedAt).toBe("number");
    expect(text).not.toContain(friendOfFriend.pubkeyHex);
  });
});
