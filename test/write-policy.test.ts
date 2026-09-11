// The write policy (src/write-policy.ts): five cumulative named levels,
// resolved env-then-stored-then-default and enforced by
// ownership.ts isAllowedWriter and relay.ts handleGiftWrap.
//
// Three layers, in three describe blocks. The pure functions (parsePolicy,
// resolveWritePolicy) need no storage. The gate itself is driven directly
// against real SqlStorage with a hand-built env, the same exception
// test/follows.test.ts documents and for the same reason: the policy
// under test has to be chosen per assertion, and the global bindings are
// fixed for the run. The last block goes over the wire, because the
// global env sets no WRITE_POLICY -- so the STORED policy is what takes
// effect there, which is exactly the path an owner changing it from a
// client takes: a changewritepolicy call, then the very next event
// answered under the new policy.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_MENTION_EVENT_INDEXED_TAGS } from "../src/limits";
import { handleManagementCall, SUPPORTED_METHODS } from "../src/nip86";
import { isAllowedWriter, refreshFollows } from "../src/ownership";
import { allowPubkey, banPubkey, getStoredWritePolicy, storeEvent } from "../src/storage";
import {
  DEFAULT_WRITE_POLICY,
  envOverridesPolicy,
  OPEN_POLICY_CONFIRMATION,
  parsePolicy,
  resolveWritePolicy,
  WRITE_POLICIES,
  type WritePolicy,
} from "../src/write-policy";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { callManagement } from "./helpers/management";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const BASE_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX } as unknown as Env;
const CALLER_IP = "203.0.113.1";

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

function mentionOwner(secretKeyHex: string, extraTags: string[][] = []): NostrEvent {
  return signEvent(secretKeyHex, {
    kind: 1,
    tags: [["p", OWNER_PUBKEY_HEX], ...extraTags],
    content: "hey, owner",
  });
}

function giftWrap(): NostrEvent {
  return signEvent(randomKeypair().secretKeyHex, {
    kind: 1059,
    tags: [["p", OWNER_PUBKEY_HEX]],
    content: "encrypted seal goes here",
  });
}

async function relayInfo(): Promise<{ limitation: { restricted_writes: boolean } }> {
  const { exports } = await import("cloudflare:workers");
  const response = await exports.default.fetch(
    new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
  );
  return (await response.json()) as { limitation: { restricted_writes: boolean } };
}

describe("parsePolicy", () => {
  it("accepts each name, case-insensitively and trimmed", () => {
    for (const name of WRITE_POLICIES) {
      expect(parsePolicy(name)).toBe(name);
      expect(parsePolicy(` ${name.toUpperCase()} `)).toBe(name);
    }
  });

  it("refuses numbers and everything else", () => {
    // Numbers are internal ordering and never a way to name a policy.
    for (const bad of ["1", "3", "5", 3, "", "open", "everyone", "true", null, undefined, {}]) {
      expect(parsePolicy(bad)).toBeNull();
    }
  });
});

describe("resolveWritePolicy", () => {
  it("defaults to follows with nothing set anywhere", () => {
    expect(resolveWritePolicy(BASE_ENV, null)).toEqual({ policy: "follows", source: "default" });
    expect(DEFAULT_WRITE_POLICY).toBe("follows");
  });

  it("uses the stored value when WRITE_POLICY is unset", () => {
    expect(resolveWritePolicy(BASE_ENV, "mentions")).toEqual({ policy: "mentions", source: "stored" });
    expect(resolveWritePolicy(BASE_ENV, "all")).toEqual({ policy: "all", source: "stored" });
  });

  it("lets WRITE_POLICY outrank the stored value", () => {
    const pinned = { ...BASE_ENV, WRITE_POLICY: "owner" } as unknown as Env;
    expect(resolveWritePolicy(pinned, "all")).toEqual({ policy: "owner", source: "env" });
    expect(envOverridesPolicy(pinned)).toBe(true);
    expect(envOverridesPolicy(BASE_ENV)).toBe(false);
  });

  it("ignores a malformed WRITE_POLICY or stored value rather than reading it as any policy", () => {
    const bad = { ...BASE_ENV, WRITE_POLICY: "everyone" } as unknown as Env;
    expect(resolveWritePolicy(bad, "inbox")).toEqual({ policy: "inbox", source: "stored" });
    expect(resolveWritePolicy(bad, null)).toEqual({ policy: "follows", source: "default" });
    expect(resolveWritePolicy(BASE_ENV, "3")).toEqual({ policy: "follows", source: "default" });
    expect(envOverridesPolicy(bad)).toBe(false);
  });

  it("no longer reads ALLOW_FOLLOWS", () => {
    const legacy = { ...BASE_ENV, ALLOW_FOLLOWS: "false" } as unknown as Env;
    expect(resolveWritePolicy(legacy, null)).toEqual({ policy: "follows", source: "default" });
  });
});

describe("isAllowedWriter, policy by policy", () => {
  // Seeds one follow into the cache and returns their keypair, plus a
  // stranger the owner does not follow.
  async function seed() {
    const friend = randomKeypair();
    const stranger = randomKeypair();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", friend.pubkeyHex]] }), 1);
      refreshFollows(sql, BASE_ENV);
    });
    return { friend, stranger };
  }

  it("owner and inbox admit the owner and an allowlisted pubkey, and nobody else", async () => {
    const { friend, stranger } = await seed();
    const named = randomKeypair();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      allowPubkey(sql, named.pubkeyHex, null, 1);
      for (const policy of ["owner", "inbox"] as WritePolicy[]) {
        expect(isAllowedWriter(sql, BASE_ENV, OWNER_PUBKEY_HEX, { policy })).toEqual({ allowed: true, isOwner: true });
        expect(isAllowedWriter(sql, BASE_ENV, named.pubkeyHex, { policy }).allowed).toBe(true);
        expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { policy })).toEqual({
          allowed: false,
          reason: "owner-only",
        });
        // Even an event that mentions the owner: that is the `mentions`
        // test, and it is not consulted below that policy.
        const mention = mentionOwner(stranger.secretKeyHex);
        expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: mention.tags }).allowed).toBe(false);
      }
    });
  });

  it("follows adds the follow list and refuses a stranger as 'not a follow'", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { policy: "follows" })).toEqual({
        allowed: true,
        isOwner: false,
      });
      const mention = mentionOwner(stranger.secretKeyHex);
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy: "follows", tags: mention.tags })).toEqual({
        allowed: false,
        reason: "not-follow",
      });
    });
  });

  it("mentions adds any author whose event p-tags the owner", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const policy: WritePolicy = "mentions";
      const mention = mentionOwner(stranger.secretKeyHex);
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: mention.tags })).toEqual({
        allowed: true,
        isOwner: false,
      });
      const plain = signEvent(stranger.secretKeyHex, { kind: 1, content: "no mention" });
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: plain.tags })).toEqual({
        allowed: false,
        reason: "not-mention",
      });
      // A p-tag naming somebody else is not a mention of the owner.
      const other = signEvent(stranger.secretKeyHex, { kind: 1, tags: [["p", randomKeypair().pubkeyHex]] });
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: other.tags }).allowed).toBe(false);
      // Follows still get in without mentioning anyone.
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { policy, tags: plain.tags }).allowed).toBe(true);
    });
  });

  it("mentions caps a stranger's event at MAX_MENTION_EVENT_INDEXED_TAGS indexed tags, and a follow's at nothing", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const policy: WritePolicy = "mentions";
      const filler = (n: number): string[][] => Array.from({ length: n }, () => ["t", "tag"]);
      // The owner's `p` is one indexed tag itself, so the cap allows
      // MAX - 1 more and refuses MAX more.
      const atCap = mentionOwner(stranger.secretKeyHex, filler(MAX_MENTION_EVENT_INDEXED_TAGS - 1));
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: atCap.tags }).allowed).toBe(true);
      const overCap = mentionOwner(stranger.secretKeyHex, filler(MAX_MENTION_EVENT_INDEXED_TAGS));
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: overCap.tags })).toEqual({
        allowed: false,
        reason: "too-many-tags",
      });
      // Multi-letter tags cost no rows and are not counted.
      const heavyButFree = mentionOwner(
        stranger.secretKeyHex,
        Array.from({ length: MAX_MENTION_EVENT_INDEXED_TAGS * 2 }, () => ["imeta", "url https://x"]),
      );
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: heavyButFree.tags }).allowed).toBe(true);
      // A follow is somebody the owner chose; their kind-3 is exactly the
      // event this cap would refuse, and it is not applied to them.
      const contacts = signEvent(friend.secretKeyHex, {
        kind: 3,
        tags: Array.from({ length: 200 }, () => ["p", randomKeypair().pubkeyHex]),
      });
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { policy, tags: contacts.tags }).allowed).toBe(true);
    });
  });

  it("all admits any author with any event, and applies no tag cap", async () => {
    const { stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const plain = signEvent(stranger.secretKeyHex, { kind: 1, content: "no mention" });
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy: "all", tags: plain.tags })).toEqual({
        allowed: true,
        isOwner: false,
      });
      const contacts = signEvent(stranger.secretKeyHex, {
        kind: 3,
        tags: Array.from({ length: 200 }, () => ["p", randomKeypair().pubkeyHex]),
      });
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy: "all", tags: contacts.tags }).allowed).toBe(true);
      // With no tags in hand at all, still admitted.
      expect(isAllowedWriter(sql, BASE_ENV, randomKeypair().pubkeyHex, { policy: "all" }).allowed).toBe(true);
    });
  });

  it("a ban refuses under every policy, all included", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      banPubkey(sql, friend.pubkeyHex, null, 1);
      banPubkey(sql, stranger.pubkeyHex, null, 1);
      const mention = mentionOwner(stranger.secretKeyHex);
      for (const policy of WRITE_POLICIES) {
        expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { policy }).allowed).toBe(false);
        expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { policy, tags: mention.tags })).toEqual({
          allowed: false,
          reason: "banned",
        });
      }
    });
  });

  it("the policies are cumulative: each admits everyone the one before it admits", async () => {
    const { friend, stranger } = await seed();
    const named = randomKeypair();
    const anyone = randomKeypair();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      allowPubkey(sql, named.pubkeyHex, null, 1);
      const mention = mentionOwner(stranger.secretKeyHex);
      const writers = [
        { pubkey: OWNER_PUBKEY_HEX, tags: [] as string[][] },
        { pubkey: named.pubkeyHex, tags: [] },
        { pubkey: friend.pubkeyHex, tags: [] },
        { pubkey: stranger.pubkeyHex, tags: mention.tags },
        { pubkey: anyone.pubkeyHex, tags: [] },
      ];
      const admitted = (policy: WritePolicy) =>
        new Set(
          writers
            .filter((w) => isAllowedWriter(sql, BASE_ENV, w.pubkey, { policy, tags: w.tags }).allowed)
            .map((w) => w.pubkey),
        );
      for (let i = 0; i + 1 < WRITE_POLICIES.length; i++) {
        const lower = admitted(WRITE_POLICIES[i]!);
        const higher = admitted(WRITE_POLICIES[i + 1]!);
        for (const pubkey of lower) expect(higher.has(pubkey)).toBe(true);
      }
      expect(admitted("owner").size).toBe(2);
      expect(admitted("mentions").size).toBe(4);
      expect(admitted("all").size).toBe(5);
    });
  });

  it("resolves the policy itself, from the stored setting, when the caller passes none", async () => {
    const { friend } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex).allowed).toBe(true);
      handleManagementCall(sql, BASE_ENV, "changewritepolicy", ["owner"], CALLER_IP, 1, OWNER_PUBKEY_HEX);
      expect(getStoredWritePolicy(sql)).toBe("owner");
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex).allowed).toBe(false);
    });
  });

  it("the follow cache is maintained under every policy, so opening to follows takes effect at once", async () => {
    // refreshFollows is not gated on the policy (ownership.ts): a relay
    // under `owner` keeps the table current so a later changewritepolicy
    // to `follows` finds it populated rather than admitting nobody until
    // the next cron tick.
    const friend = randomKeypair();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", friend.pubkeyHex]] }), 1);
      refreshFollows(sql, { ...BASE_ENV, WRITE_POLICY: "owner" } as unknown as Env);
      expect(sql.exec(`SELECT 1 FROM follows WHERE pubkey = ?`, friend.pubkeyHex).toArray().length).toBe(1);
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { policy: "inbox" }).allowed).toBe(false);
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { policy: "follows" }).allowed).toBe(true);
    });
  });
});

describe("changewritepolicy / getwritepolicy over the wire", () => {
  it("are listed by supportedmethods", () => {
    expect(SUPPORTED_METHODS).toContain("changewritepolicy");
    expect(SUPPORTED_METHODS).toContain("getwritepolicy");
  });

  it("reports the default before anything is stored, with no numbers anywhere", async () => {
    const reply = await callManagement("getwritepolicy");
    expect(reply.result).toMatchObject({ policy: "follows", source: "default" });
    const policies = (reply.result as { policies: { name: string; description: string }[] }).policies;
    expect(policies.map((p) => p.name)).toEqual([...WRITE_POLICIES]);
    expect(JSON.stringify(reply.result)).not.toMatch(/rung|\b[1-5]\b/);
  });

  it("a stored policy takes effect on the very next event, in both directions", async () => {
    const stranger = randomKeypair();
    const conn = await connectRelay();

    // Default (follows): a stranger mentioning the owner is refused.
    const refused = await publish(conn, mentionOwner(stranger.secretKeyHex));
    expect(refused[2]).toBe(false);
    expect(refused[3]).toContain("restricted:");

    // Open to mentions: the next mention is stored. No redeploy, no cron.
    const up = await callManagement("changewritepolicy", ["mentions"]);
    expect(up.result).toBe(true);
    expect(up.error).toContain('now in force is "mentions"');
    expect(up.error).not.toMatch(/rung/i);
    expect((await publish(conn, mentionOwner(stranger.secretKeyHex)))[2]).toBe(true);
    // Still not open: an event that does not mention the owner is
    // refused, and the refusal says what would have been accepted.
    const plain = await publish(conn, signEvent(stranger.secretKeyHex, { kind: 1, content: "unrelated" }));
    expect(plain[2]).toBe(false);
    expect(plain[3]).toContain("mention the owner");

    // Down to owner: mail is refused too.
    expect((await callManagement("changewritepolicy", ["owner"])).result).toBe(true);
    const mail = await publish(conn, giftWrap());
    expect(mail[2]).toBe(false);
    expect(mail[3]).toContain("restricted:");
    expect((await publish(conn, mentionOwner(stranger.secretKeyHex)))[2]).toBe(false);

    // inbox is exactly "owner plus mail".
    await callManagement("changewritepolicy", ["inbox"]);
    expect((await publish(conn, giftWrap()))[2]).toBe(true);
    expect((await publish(conn, mentionOwner(stranger.secretKeyHex)))[2]).toBe(false);

    // The owner writes under every policy.
    expect((await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "mine" })))[2]).toBe(true);
    conn.close();
  });

  it("all requires the confirmation string, and then lets anyone publish anything", async () => {
    const stranger = randomKeypair();

    const first = await callManagement("changewritepolicy", ["all"]);
    expect(first.result).toBeUndefined();
    expect(first.error).toContain("ANYONE");
    expect(first.error).toContain(OPEN_POLICY_CONFIRMATION);
    // Nothing stored by the refused attempt, and the wrong string is as
    // good as none.
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ source: "default" });
    expect((await callManagement("changewritepolicy", ["all", "yes"])).result).toBeUndefined();
    expect((await relayInfo()).limitation.restricted_writes).toBe(true);

    const second = await callManagement("changewritepolicy", ["all", OPEN_POLICY_CONFIRMATION]);
    expect(second.result).toBe(true);
    expect(second.error).toContain('now in force is "all"');
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ policy: "all", source: "stored" });
    expect((await relayInfo()).limitation.restricted_writes).toBe(false);

    const conn = await connectRelay();
    const plain = await publish(conn, signEvent(stranger.secretKeyHex, { kind: 1, content: "from nobody in particular" }));
    expect(plain[2]).toBe(true);
    conn.close();

    // Closing again needs no confirmation.
    expect((await callManagement("changewritepolicy", ["owner"])).result).toBe(true);
    expect((await relayInfo()).limitation.restricted_writes).toBe(true);
  });

  it("an empty string clears the stored policy and falls back to the default", async () => {
    await callManagement("changewritepolicy", ["mentions"]);
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ policy: "mentions", source: "stored" });
    const cleared = await callManagement("changewritepolicy", [""]);
    expect(cleared.result).toBe(true);
    expect(cleared.error).toContain("Cleared");
    expect(cleared.error).toContain('now in force is "follows"');
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ policy: "follows", source: "default" });
  });

  it("refuses anything but a policy name, and lists the names", async () => {
    for (const bad of ["everyone", "3", 4, "open"]) {
      const reply = await callManagement("changewritepolicy", [bad]);
      expect(reply.result).toBeUndefined();
      expect(reply.error).toContain(WRITE_POLICIES.join(", "));
    }
    expect((await callManagement("changewritepolicy", [])).error).toContain("takes one parameter");
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ source: "default" });
  });

  it("still stores the value when WRITE_POLICY outranks it, and says so", async () => {
    // Direct call with a hand-built env, the exception documented for the
    // RELAY_NAME case in test/nip86-management.test.ts and for the same
    // reason: the bindings are fixed for the run.
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const pinned = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, WRITE_POLICY: "owner" } as unknown as Env;
      const reply = handleManagementCall(sql, pinned, "changewritepolicy", ["mentions"], CALLER_IP, 1, OWNER_PUBKEY_HEX);
      expect(reply.result).toBe(true);
      expect(reply.error).toContain("WRITE_POLICY is set");
      expect(reply.error).toContain('now in force is "owner"');
      expect(getStoredWritePolicy(sql)).toBe("mentions");
      const get = handleManagementCall(sql, pinned, "getwritepolicy", [], CALLER_IP, 1, OWNER_PUBKEY_HEX);
      expect(get.result).toMatchObject({ policy: "owner", source: "env" });
    });
  });

  it("/api/stats carries the policy by name and its source", async () => {
    const before = (await stub().getStats()) as { writePolicy: string; writePolicySource: string };
    expect(before).toMatchObject({ writePolicy: "follows", writePolicySource: "default" });
    expect("writeRung" in before).toBe(false);
    await callManagement("changewritepolicy", ["owner"]);
    const after = (await stub().getStats()) as { writePolicy: string; writePolicySource: string };
    expect(after).toMatchObject({ writePolicy: "owner", writePolicySource: "stored" });
  });
});
