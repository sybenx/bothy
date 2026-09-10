// The write ladder (src/write-policy.ts, docs/rungs.md): four cumulative
// rungs, one number, resolved env-then-stored-then-default and enforced
// by ownership.ts isAllowedWriter and relay.ts handleGiftWrap.
//
// Three layers, in three describe blocks. The pure functions (parseRung,
// resolveWriteRung) need no storage. The gate itself is driven directly
// against real SqlStorage with a hand-built env, the same exception
// test/follows.test.ts documents and for the same reason: the rung under
// test has to be chosen per assertion, and the global bindings are fixed
// for the run. The last block goes over the wire, because the global env
// sets neither WRITE_RUNG nor ALLOW_FOLLOWS -- so the STORED rung is what
// takes effect there, which is exactly the path an owner moving the
// ladder from a client takes: a changewritepolicy call, and then the very
// next event answered under the new policy.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_MENTION_EVENT_INDEXED_TAGS } from "../src/limits";
import { handleManagementCall, SUPPORTED_METHODS } from "../src/nip86";
import { isAllowedWriter, refreshFollows } from "../src/ownership";
import { allowPubkey, banPubkey, getStoredWriteRung, storeEvent } from "../src/storage";
import {
  DEFAULT_WRITE_RUNG,
  envOverridingRung,
  parseRung,
  resolveWriteRung,
  RUNG_NAMES,
  type WriteRung,
} from "../src/write-policy";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { callManagement } from "./helpers/management";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const BASE_ENV = { OWNER_PUBKEY: OWNER_PUBKEY_HEX } as unknown as Env;

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

describe("parseRung", () => {
  it("accepts a number, a numeric string, or a rung name, case-insensitively", () => {
    expect(parseRung(3)).toEqual({ ok: true, rung: 3 });
    expect(parseRung("3")).toEqual({ ok: true, rung: 3 });
    expect(parseRung(" Follows ")).toEqual({ ok: true, rung: 3 });
    for (const [rung, name] of Object.entries(RUNG_NAMES)) {
      expect(parseRung(name)).toEqual({ ok: true, rung: Number(rung) });
    }
  });

  it("refuses rung 5 by name rather than as malformed", () => {
    // The ladder document calls rung 5 a cliff; an operator asking for
    // it gets that explanation (nip86.ts), which needs the parser to
    // tell "asked for open" apart from "typed nonsense".
    expect(parseRung("5")).toEqual({ ok: false, reason: "open" });
    expect(parseRung("open")).toEqual({ ok: false, reason: "open" });
    expect(parseRung(5)).toEqual({ ok: false, reason: "open" });
  });

  it("treats everything else as malformed", () => {
    for (const bad of ["0", "6", "", "true", "yes", null, undefined, {}, "3.5", "-1"]) {
      expect(parseRung(bad)).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("resolveWriteRung", () => {
  it("defaults to rung 3 with nothing set anywhere", () => {
    expect(resolveWriteRung(BASE_ENV, null)).toEqual({ rung: DEFAULT_WRITE_RUNG, source: "default" });
    expect(DEFAULT_WRITE_RUNG).toBe(3);
  });

  it("uses the stored value when no environment variable names a rung", () => {
    expect(resolveWriteRung(BASE_ENV, "4")).toEqual({ rung: 4, source: "stored" });
    expect(resolveWriteRung(BASE_ENV, "owner")).toEqual({ rung: 1, source: "stored" });
  });

  it("reads the legacy ALLOW_FOLLOWS=false as rung 2, above the stored value", () => {
    // Rung 2 and not 1: that variable never refused gift wraps, so a relay
    // that set it keeps accepting exactly what it accepted before.
    const legacy = { ...BASE_ENV, ALLOW_FOLLOWS: "false" } as unknown as Env;
    expect(resolveWriteRung(legacy, null)).toEqual({ rung: 2, source: "legacy-env" });
    expect(resolveWriteRung(legacy, "4")).toEqual({ rung: 2, source: "legacy-env" });
    // Only the exact string, the same rule the old opt-out had.
    expect(resolveWriteRung({ ...BASE_ENV, ALLOW_FOLLOWS: "no" } as unknown as Env, null).source).toBe("default");
  });

  it("lets WRITE_RUNG outrank everything, including the legacy variable", () => {
    const both = { ...BASE_ENV, WRITE_RUNG: "mentions", ALLOW_FOLLOWS: "false" } as unknown as Env;
    expect(resolveWriteRung(both, "1")).toEqual({ rung: 4, source: "env" });
  });

  it("ignores a malformed WRITE_RUNG rather than reading it as any rung", () => {
    // A typo in the dashboard costs the override, not the policy -- the
    // same rule limits.ts resolveLimit applies to the write caps.
    const bad = { ...BASE_ENV, WRITE_RUNG: "everyone" } as unknown as Env;
    expect(resolveWriteRung(bad, "2")).toEqual({ rung: 2, source: "stored" });
    expect(resolveWriteRung(bad, null)).toEqual({ rung: 3, source: "default" });
    // And a malformed stored value falls through the same way.
    expect(resolveWriteRung(BASE_ENV, "5")).toEqual({ rung: 3, source: "default" });
  });

  it("names the environment variable that is winning, or none", () => {
    expect(envOverridingRung(BASE_ENV)).toBeNull();
    expect(envOverridingRung({ ...BASE_ENV, WRITE_RUNG: "1" } as unknown as Env)).toBe("WRITE_RUNG");
    expect(envOverridingRung({ ...BASE_ENV, ALLOW_FOLLOWS: "false" } as unknown as Env)).toBe("ALLOW_FOLLOWS");
    expect(envOverridingRung({ ...BASE_ENV, WRITE_RUNG: "junk" } as unknown as Env)).toBeNull();
  });
});

describe("isAllowedWriter, rung by rung", () => {
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

  it("rungs 1 and 2 admit the owner and an allowlisted pubkey, and nobody else", async () => {
    const { friend, stranger } = await seed();
    const named = randomKeypair();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      allowPubkey(sql, named.pubkeyHex, null, 1);
      for (const rung of [1, 2] as WriteRung[]) {
        expect(isAllowedWriter(sql, BASE_ENV, OWNER_PUBKEY_HEX, { rung })).toEqual({ allowed: true, isOwner: true });
        expect(isAllowedWriter(sql, BASE_ENV, named.pubkeyHex, { rung }).allowed).toBe(true);
        expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { rung })).toEqual({
          allowed: false,
          reason: "owner-only",
        });
        // Even an event that mentions the owner: that is rung 4's test,
        // and it is not consulted below rung 4.
        const mention = mentionOwner(stranger.secretKeyHex);
        expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung, tags: mention.tags }).allowed).toBe(false);
      }
    });
  });

  it("rung 3 adds the follow list and refuses a stranger as 'not a follow'", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { rung: 3 })).toEqual({ allowed: true, isOwner: false });
      const mention = mentionOwner(stranger.secretKeyHex);
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung: 3, tags: mention.tags })).toEqual({
        allowed: false,
        reason: "not-follow",
      });
    });
  });

  it("rung 4 adds any author whose event p-tags the owner", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const mention = mentionOwner(stranger.secretKeyHex);
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung: 4, tags: mention.tags })).toEqual({
        allowed: true,
        isOwner: false,
      });
      const plain = signEvent(stranger.secretKeyHex, { kind: 1, content: "no mention" });
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung: 4, tags: plain.tags })).toEqual({
        allowed: false,
        reason: "not-mention",
      });
      // A p-tag naming somebody else is not a mention of the owner.
      const other = signEvent(stranger.secretKeyHex, { kind: 1, tags: [["p", randomKeypair().pubkeyHex]] });
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung: 4, tags: other.tags }).allowed).toBe(false);
      // Follows still get in without mentioning anyone.
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { rung: 4, tags: plain.tags }).allowed).toBe(true);
    });
  });

  it("rung 4 caps a stranger's event at MAX_MENTION_EVENT_INDEXED_TAGS indexed tags, and a follow's at nothing", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const filler = (n: number): string[][] => Array.from({ length: n }, () => ["t", "tag"]);
      // The owner's `p` is one indexed tag itself, so the cap allows
      // MAX - 1 more and refuses MAX more.
      const atCap = mentionOwner(stranger.secretKeyHex, filler(MAX_MENTION_EVENT_INDEXED_TAGS - 1));
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung: 4, tags: atCap.tags }).allowed).toBe(true);
      const overCap = mentionOwner(stranger.secretKeyHex, filler(MAX_MENTION_EVENT_INDEXED_TAGS));
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung: 4, tags: overCap.tags })).toEqual({
        allowed: false,
        reason: "too-many-tags",
      });
      // Multi-letter tags cost no rows and are not counted.
      const heavyButFree = mentionOwner(
        stranger.secretKeyHex,
        Array.from({ length: MAX_MENTION_EVENT_INDEXED_TAGS * 2 }, () => ["imeta", "url https://x"]),
      );
      expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung: 4, tags: heavyButFree.tags }).allowed).toBe(true);
      // A follow is somebody the owner chose; their kind-3 is exactly the
      // event this cap would refuse, and it is not applied to them.
      const contacts = signEvent(friend.secretKeyHex, {
        kind: 3,
        tags: Array.from({ length: 200 }, () => ["p", randomKeypair().pubkeyHex]),
      });
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { rung: 4, tags: contacts.tags }).allowed).toBe(true);
    });
  });

  it("a ban refuses at every rung, a mention included", async () => {
    const { friend, stranger } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      banPubkey(sql, friend.pubkeyHex, null, 1);
      banPubkey(sql, stranger.pubkeyHex, null, 1);
      const mention = mentionOwner(stranger.secretKeyHex);
      for (const rung of [1, 2, 3, 4] as WriteRung[]) {
        expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { rung }).allowed).toBe(false);
        expect(isAllowedWriter(sql, BASE_ENV, stranger.pubkeyHex, { rung, tags: mention.tags })).toEqual({
          allowed: false,
          reason: "banned",
        });
      }
    });
  });

  it("the rungs are cumulative: each admits everyone the one below it admits", async () => {
    const { friend, stranger } = await seed();
    const named = randomKeypair();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      allowPubkey(sql, named.pubkeyHex, null, 1);
      const mention = mentionOwner(stranger.secretKeyHex);
      const writers = [
        { pubkey: OWNER_PUBKEY_HEX, tags: [] as string[][] },
        { pubkey: named.pubkeyHex, tags: [] },
        { pubkey: friend.pubkeyHex, tags: [] },
        { pubkey: stranger.pubkeyHex, tags: mention.tags },
      ];
      const admitted = (rung: WriteRung) =>
        new Set(writers.filter((w) => isAllowedWriter(sql, BASE_ENV, w.pubkey, { rung, tags: w.tags }).allowed).map((w) => w.pubkey));
      for (const rung of [1, 2, 3] as WriteRung[]) {
        const lower = admitted(rung);
        const higher = admitted((rung + 1) as WriteRung);
        for (const pubkey of lower) expect(higher.has(pubkey)).toBe(true);
      }
      // And the top rung admits all four; the bottom, two.
      expect(admitted(4).size).toBe(4);
      expect(admitted(1).size).toBe(2);
    });
  });

  it("resolves the rung itself, from the stored setting, when the caller passes none", async () => {
    const { friend } = await seed();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex).allowed).toBe(true);
      handleManagementCall(sql, BASE_ENV, "changewritepolicy", ["owner"], "203.0.113.1", 1, OWNER_PUBKEY_HEX);
      expect(getStoredWriteRung(sql)).toBe("1");
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex).allowed).toBe(false);
    });
  });

  it("the follow cache is maintained at every rung, so raising the rung takes effect at once", async () => {
    // refreshFollows is not gated on the rung (ownership.ts): a relay at
    // rung 1 keeps the table current so a later changewritepolicy to 3
    // finds it populated rather than admitting nobody until the next
    // cron tick.
    const friend = randomKeypair();
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      storeEvent(sql, signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", friend.pubkeyHex]] }), 1);
      refreshFollows(sql, { ...BASE_ENV, ALLOW_FOLLOWS: "false" } as unknown as Env);
      expect(sql.exec(`SELECT 1 FROM follows WHERE pubkey = ?`, friend.pubkeyHex).toArray().length).toBe(1);
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { rung: 2 }).allowed).toBe(false);
      expect(isAllowedWriter(sql, BASE_ENV, friend.pubkeyHex, { rung: 3 }).allowed).toBe(true);
    });
  });
});

describe("changewritepolicy / getwritepolicy over the wire", () => {
  it("are listed by supportedmethods", async () => {
    expect(SUPPORTED_METHODS).toContain("changewritepolicy");
    expect(SUPPORTED_METHODS).toContain("getwritepolicy");
  });

  it("reports the default before anything is stored", async () => {
    const reply = await callManagement("getwritepolicy");
    expect(reply.result).toMatchObject({ rung: 3, name: "follows", source: "default" });
    const rungs = (reply.result as { rungs: { rung: number; name: string }[] }).rungs;
    expect(rungs.map((r) => r.rung)).toEqual([1, 2, 3, 4]);
  });

  it("a stored rung takes effect on the very next event, in both directions", async () => {
    const stranger = randomKeypair();
    const conn = await connectRelay();

    // Default (3): a stranger mentioning the owner is refused.
    const refused = await publish(conn, mentionOwner(stranger.secretKeyHex));
    expect(refused[2]).toBe(false);
    expect(refused[3]).toContain("restricted:");

    // Up to 4: the next mention is stored. No redeploy, no cron tick.
    const up = await callManagement("changewritepolicy", ["mentions"]);
    expect(up.result).toBe(true);
    expect(up.error).toContain("now in force is 4 (mentions)");
    const accepted = await publish(conn, mentionOwner(stranger.secretKeyHex));
    expect(accepted[2]).toBe(true);
    // Still not an open relay: an event that does not mention the owner
    // is refused, and the refusal says what would have been accepted.
    const plain = await publish(conn, signEvent(stranger.secretKeyHex, { kind: 1, content: "unrelated" }));
    expect(plain[2]).toBe(false);
    expect(plain[3]).toContain("mention the owner");

    // Down to 1: mail is refused too.
    const down = await callManagement("changewritepolicy", ["1"]);
    expect(down.result).toBe(true);
    const mail = await publish(conn, giftWrap());
    expect(mail[2]).toBe(false);
    expect(mail[3]).toContain("restricted:");
    const mentionAgain = await publish(conn, mentionOwner(stranger.secretKeyHex));
    expect(mentionAgain[2]).toBe(false);

    // Rung 2 is exactly "1 plus mail".
    await callManagement("changewritepolicy", ["inbox"]);
    expect((await publish(conn, giftWrap()))[2]).toBe(true);
    expect((await publish(conn, mentionOwner(stranger.secretKeyHex)))[2]).toBe(false);

    // The owner writes at every rung.
    expect((await publish(conn, signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "mine" })))[2]).toBe(true);
    conn.close();
  });

  it("an empty string clears the stored rung and falls back to the default", async () => {
    await callManagement("changewritepolicy", ["4"]);
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ rung: 4, source: "stored" });
    const cleared = await callManagement("changewritepolicy", [""]);
    expect(cleared.result).toBe(true);
    expect(cleared.error).toContain("Cleared");
    expect(cleared.error).toContain("now in force is 3 (follows)");
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ rung: 3, source: "default" });
  });

  it("refuses rung 5 with the cliff, not with 'malformed'", async () => {
    for (const open of ["5", "open", 5]) {
      const reply = await callManagement("changewritepolicy", [open]);
      expect(reply.result).toBeUndefined();
      expect(reply.error).toContain("open relay");
      expect(reply.error).toContain("docs/rungs.md");
      expect(reply.error).not.toContain("takes one parameter");
    }
    // And nothing was stored by the attempt.
    expect((await callManagement("getwritepolicy")).result).toMatchObject({ source: "default" });
  });

  it("refuses a malformed rung and names the accepted forms", async () => {
    const reply = await callManagement("changewritepolicy", ["everyone"]);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toContain("owner, inbox, follows, mentions");
    expect((await callManagement("changewritepolicy", [])).error).toContain("takes one parameter");
  });

  it("still stores the value when an environment variable outranks it, and says so", async () => {
    // Direct call with a hand-built env, the exception documented for the
    // RELAY_NAME case in test/nip86-management.test.ts and for the same
    // reason: the bindings are fixed for the run.
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const pinned = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, WRITE_RUNG: "1" } as unknown as Env;
      const reply = handleManagementCall(sql, pinned, "changewritepolicy", ["mentions"], "203.0.113.1", 1, OWNER_PUBKEY_HEX);
      expect(reply.result).toBe(true);
      expect(reply.error).toContain("WRITE_RUNG is set");
      expect(reply.error).toContain("now in force is 1 (owner)");
      expect(getStoredWriteRung(sql)).toBe("4");

      const legacy = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, ALLOW_FOLLOWS: "false" } as unknown as Env;
      const get = handleManagementCall(sql, legacy, "getwritepolicy", [], "203.0.113.1", 1, OWNER_PUBKEY_HEX);
      expect(get.result).toMatchObject({ rung: 2, source: "legacy-env" });
    });
  });

  it("/api/stats carries the rung, its name and its source", async () => {
    const before = (await (await env.RELAY.get(env.RELAY.idFromName("relay")).getStats()) as {
      writePolicy: string;
      writeRung: number;
      writeRungSource: string;
    });
    expect(before).toMatchObject({ writePolicy: "follows", writeRung: 3, writeRungSource: "default" });
    await callManagement("changewritepolicy", ["owner"]);
    const after = (await env.RELAY.get(env.RELAY.idFromName("relay")).getStats()) as {
      writePolicy: string;
      writeRung: number;
      writeRungSource: string;
    };
    expect(after).toMatchObject({ writePolicy: "owner", writeRung: 1, writeRungSource: "stored" });
  });
});
