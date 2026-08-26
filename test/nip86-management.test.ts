// NIP-86 relay management API (src/nip86.ts), method behaviour. The
// NIP-98 gate in front of all of this has its own file
// (test/nip98-auth.test.ts); everything here is already authenticated as
// the owner and is about what each method actually does.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { handleManagementCall, SELF_BLOCK_CONFIRMATION, SUPPORTED_METHODS } from "../src/nip86";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { callManagement } from "./helpers/management";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const CALLER_IP = "203.0.113.10";

function note(kind: number, content: string) {
  return signEvent(OWNER_SECRET_KEY_HEX, { kind, content });
}

describe("supportedmethods", () => {
  it("returns exactly the methods this relay implements", async () => {
    const reply = await callManagement("supportedmethods");
    expect(reply.result).toEqual([...SUPPORTED_METHODS]);
  });

  it("omits the methods bothy deliberately does not implement", async () => {
    // The discovery mechanism has to be accurate or a partial
    // implementation is just a broken one -- a client that trusts this
    // list will call whatever is in it.
    const listed = (await callManagement("supportedmethods")).result as string[];
    for (const absent of ["listeventsneedingmoderation", "allowkind", "disallowkind", "listallowedkinds"]) {
      expect(listed).not.toContain(absent);
    }
  });

  it("explains why the kind allowlist methods are absent instead of calling them unknown", async () => {
    for (const method of ["allowkind", "disallowkind", "listallowedkinds"]) {
      const reply = await callManagement(method, [1]);
      expect(reply.status).toBe(200);
      expect(reply.result).toBeUndefined();
      expect(reply.error).toContain("every event kind");
      expect(reply.error).not.toContain("unknown method");
    }
  });

  it("returns a generic unknown-method error for anything else", async () => {
    const reply = await callManagement("createrole", ["moderator"]);
    expect(reply.error).toContain("unknown method");
    expect(reply.error).toContain("supportedmethods");
  });
});

describe("banevent / allowevent / listbannedevents", () => {
  it("tombstones an id that is not stored, so the event is refused when it later arrives", async () => {
    // The whole point of banning an id you don't hold: banning is not
    // "delete this row", it is "never accept this".
    const event = note(1, "banned before it ever arrived");

    const ban = await callManagement("banevent", [event.id, "spam"]);
    expect(ban.result).toBe(true);

    const conn = await connectRelay();
    const reply = await publish(conn, event);
    expect(reply[2]).toBe(false);
    expect(reply[3]).toContain("blocked:");
    conn.close();
  });

  it("deletes a stored event and keeps it from being republished", async () => {
    const event = note(1, "stored, then banned");

    const conn = await connectRelay();
    expect((await publish(conn, event))[2]).toBe(true);

    await callManagement("banevent", [event.id]);

    const republish = await publish(conn, event);
    expect(republish[2]).toBe(false);
    conn.close();
  });

  it("allowevent removes the tombstone, so the event can be stored again", async () => {
    const event = note(1, "banned then allowed");

    await callManagement("banevent", [event.id, "mistake"]);
    const conn = await connectRelay();
    expect((await publish(conn, event))[2]).toBe(false);

    const allow = await callManagement("allowevent", [event.id]);
    expect(allow.result).toBe(true);

    expect((await publish(conn, event))[2]).toBe(true);
    conn.close();
  });

  it("allowevent also drops the event from the banned list", async () => {
    const event = note(1, "listed then unlisted");
    await callManagement("banevent", [event.id, "noisy"]);
    await callManagement("allowevent", [event.id]);
    expect((await callManagement("listbannedevents")).result).toEqual([]);
  });

  it("lists banned events with the reason given", async () => {
    const event = note(1, "with a reason");
    await callManagement("banevent", [event.id, "off topic"]);
    expect((await callManagement("listbannedevents")).result).toEqual([
      { id: event.id, reason: "off topic" },
    ]);
  });

  it("records a null reason when none is given rather than inventing one", async () => {
    const event = note(1, "no reason");
    await callManagement("banevent", [event.id]);
    expect((await callManagement("listbannedevents")).result).toEqual([{ id: event.id, reason: null }]);
  });

  it("does NOT list the owner's own NIP-09 deletions as banned events", async () => {
    // deleted_ids holds every tombstone, including ordinary NIP-09
    // deletions and NIP-62 vanish requests. listbannedevents reads
    // banned_events instead, precisely so an owner deleting their own
    // note does not see it reported back as something they banned.
    const deletedNote = note(1, "the owner deletes this themselves");
    const bannedNote = note(1, "this one is actually banned");

    const conn = await connectRelay();
    expect((await publish(conn, deletedNote))[2]).toBe(true);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, { kind: 5, tags: [["e", deletedNote.id]] });
    expect((await publish(conn, deletion))[2]).toBe(true);
    conn.close();

    await callManagement("banevent", [bannedNote.id, "banned"]);

    const listed = (await callManagement("listbannedevents")).result as { id: string }[];
    expect(listed.map((b) => b.id)).toEqual([bannedNote.id]);
  });

  it("rejects an id that is not 64 hex characters", async () => {
    for (const bad of ["not-hex", "abc", "A".repeat(64)]) {
      const reply = await callManagement("banevent", [bad]);
      expect(reply.result).toBeUndefined();
      expect(reply.error).toContain("hex event id");
    }
  });
});

describe("banpubkey / unbanpubkey / listbannedpubkeys", () => {
  it("rejects a pubkey that is neither npub nor 64-character hex", async () => {
    const reply = await callManagement("banpubkey", ["not-a-pubkey"]);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toContain("pubkey");
  });

  it("refuses to ban the relay owner's own pubkey", async () => {
    const reply = await callManagement("banpubkey", [OWNER_PUBKEY_HEX]);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toContain("owner");
    expect((await callManagement("listbannedpubkeys")).result).toEqual([]);
  });

  it("refuses to ban the owner's pubkey given as npub, too", async () => {
    // bech32("npub", OWNER_PUBKEY_HEX) -- see test/claim.test.ts.
    const ownerNpub = "npub17vjpx0uj7gp4xlxhl8z0rncs0qpqzkg3rgvy27qfec7pr9gdsl4suwp7ea";
    const reply = await callManagement("banpubkey", [ownerNpub]);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toContain("owner");
  });

  it("bans a pubkey and lists it with the reason given", async () => {
    const stranger = randomKeypair().pubkeyHex;
    const ban = await callManagement("banpubkey", [stranger, "spammer"]);
    expect(ban.result).toBe(true);
    expect((await callManagement("listbannedpubkeys")).result).toEqual([{ pubkey: stranger, reason: "spammer" }]);
  });

  it("unbanpubkey removes it from the list", async () => {
    const stranger = randomKeypair().pubkeyHex;
    await callManagement("banpubkey", [stranger]);
    const unban = await callManagement("unbanpubkey", [stranger]);
    expect(unban.result).toBe(true);
    expect((await callManagement("listbannedpubkeys")).result).toEqual([]);
  });

  it("refuses a write from a banned pubkey even though it is also a follow", async () => {
    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", friend.pubkeyHex]] });

    const conn = await connectRelay();
    // acceptEvent refreshes the follow cache immediately on an owner
    // kind-3 (relay.ts), so friend can write right after this.
    expect((await publish(conn, contacts))[2]).toBe(true);
    expect((await publish(conn, signEvent(friend.secretKeyHex, { kind: 1, content: "hi" })))[2]).toBe(true);

    await callManagement("banpubkey", [friend.pubkeyHex, "actually banned"]);

    const rejected = await publish(conn, signEvent(friend.secretKeyHex, { kind: 1, content: "still trying" }));
    expect(rejected[2]).toBe(false);
    expect(rejected[3]).toContain("blocked:");
    conn.close();
  });
});

describe("allowpubkey / unallowpubkey / listallowedpubkeys", () => {
  it("rejects a pubkey that is neither npub nor 64-character hex", async () => {
    const reply = await callManagement("allowpubkey", ["nope"]);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toContain("pubkey");
  });

  it("allows a pubkey and lists it with the reason given", async () => {
    const stranger = randomKeypair().pubkeyHex;
    const allow = await callManagement("allowpubkey", [stranger, "trusted friend"]);
    expect(allow.result).toBe(true);
    expect((await callManagement("listallowedpubkeys")).result).toEqual([
      { pubkey: stranger, reason: "trusted friend" },
    ]);
  });

  it("unallowpubkey removes it from the list", async () => {
    const stranger = randomKeypair().pubkeyHex;
    await callManagement("allowpubkey", [stranger]);
    const unallow = await callManagement("unallowpubkey", [stranger]);
    expect(unallow.result).toBe(true);
    expect((await callManagement("listallowedpubkeys")).result).toEqual([]);
  });

  it("lets an allowlisted stranger write even though they are not a follow", async () => {
    const stranger = randomKeypair();
    await callManagement("allowpubkey", [stranger.pubkeyHex, "manual grant"]);

    const conn = await connectRelay();
    const reply = await publish(conn, signEvent(stranger.secretKeyHex, { kind: 1, content: "granted" }));
    expect(reply[2]).toBe(true);
    conn.close();
  });

  it("a ban still wins over an allowlist entry for the same pubkey", async () => {
    const stranger = randomKeypair();
    await callManagement("allowpubkey", [stranger.pubkeyHex]);
    await callManagement("banpubkey", [stranger.pubkeyHex]);

    const conn = await connectRelay();
    const reply = await publish(conn, signEvent(stranger.secretKeyHex, { kind: 1, content: "blocked anyway" }));
    expect(reply[2]).toBe(false);
    conn.close();
  });
});

describe("blockip / unblockip / listblockedips", () => {
  it("blocks another address and lists it", async () => {
    const block = await callManagement("blockip", ["198.51.100.4", "flooding"], { ip: CALLER_IP });
    expect(block.result).toBe(true);
    expect((await callManagement("listblockedips", [], { ip: CALLER_IP })).result).toEqual([
      { ip: "198.51.100.4", reason: "flooding" },
    ]);
  });

  it("refuses to block the address the request came from without the confirmation string", async () => {
    const reply = await callManagement("blockip", [CALLER_IP, "oops"], { ip: CALLER_IP });
    expect(reply.result).toBeUndefined();
    expect(reply.error).toContain(SELF_BLOCK_CONFIRMATION);
    // The refusal has to say plainly that the management API stays
    // reachable -- otherwise the operator's fear is that confirming locks
    // them out for good.
    expect(reply.error).toContain("never IP-blocked");
    expect((await callManagement("listblockedips", [], { ip: CALLER_IP })).result).toEqual([]);
  });

  it("blocks the caller's own address once the confirmation string is passed as the reason", async () => {
    const reply = await callManagement("blockip", [CALLER_IP, SELF_BLOCK_CONFIRMATION], { ip: CALLER_IP });
    expect(reply.result).toBe(true);
    expect((await callManagement("listblockedips", [], { ip: CALLER_IP })).result).toEqual([
      { ip: CALLER_IP, reason: SELF_BLOCK_CONFIRMATION },
    ]);
  });

  it("does not demand confirmation when blocking a different address", async () => {
    const reply = await callManagement("blockip", ["198.51.100.9"], { ip: CALLER_IP });
    expect(reply.result).toBe(true);
  });

  it("refuses a WebSocket connection from a blocked address", async () => {
    await callManagement("blockip", ["198.51.100.20", "abuse"], { ip: CALLER_IP });
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const response = await stub.fetch("https://example.com/", {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "198.51.100.20" },
    });
    expect(response.status).toBe(403);
  });

  it("still accepts a WebSocket connection from an address that is not blocked", async () => {
    await callManagement("blockip", ["198.51.100.20", "abuse"], { ip: CALLER_IP });
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const response = await stub.fetch("https://example.com/", {
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "198.51.100.21" },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test done");
  });

  it("keeps the management endpoint reachable from a blocked address", async () => {
    // The rule that makes self-block recoverable: an IP block gates
    // WebSocket connections and nothing else, so unblockip is always
    // callable from the address that was just blocked.
    await callManagement("blockip", [CALLER_IP, SELF_BLOCK_CONFIRMATION], { ip: CALLER_IP });

    const stillWorks = await callManagement("listblockedips", [], { ip: CALLER_IP });
    expect(stillWorks.status).toBe(200);
    expect(stillWorks.result).toEqual([{ ip: CALLER_IP, reason: SELF_BLOCK_CONFIRMATION }]);

    const unblock = await callManagement("unblockip", [CALLER_IP], { ip: CALLER_IP });
    expect(unblock.result).toBe(true);
    expect((await callManagement("listblockedips", [], { ip: CALLER_IP })).result).toEqual([]);
  });

  it("rejects an empty address", async () => {
    const reply = await callManagement("blockip", [""], { ip: CALLER_IP });
    expect(reply.error).toContain("non-empty");
  });
});

describe("changerelayname / changerelaydescription / changerelayicon", () => {
  async function relayInfo(): Promise<Record<string, unknown>> {
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(
      new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
    );
    return (await response.json()) as Record<string, unknown>;
  }

  it("stores a name and serves it in the NIP-11 document", async () => {
    const reply = await callManagement("changerelayname", ["Signal Hill"]);
    expect(reply.result).toBe(true);
    expect((await relayInfo()).name).toBe("Signal Hill");
  });

  it("stores a description and an icon the same way", async () => {
    await callManagement("changerelaydescription", ["Notes and other stuff."]);
    await callManagement("changerelayicon", ["https://example.com/hill.png"]);
    const info = await relayInfo();
    expect(info.description).toBe("Notes and other stuff.");
    expect(info.icon).toBe("https://example.com/hill.png");
  });

  it("clears a stored value when passed an empty string, falling back down the chain", async () => {
    await callManagement("changerelayname", ["Signal Hill"]);
    expect((await relayInfo()).name).toBe("Signal Hill");

    const cleared = await callManagement("changerelayname", [""]);
    expect(cleared.result).toBe(true);
    expect(cleared.error).toContain("Cleared");
    // Nothing below the stored rung is set in this environment, so the
    // hardcoded default is what surfaces.
    expect((await relayInfo()).name).toBe("bothy");
  });

  it("teaches the empty-string escape hatch and the NIP-11 readback on every successful change", async () => {
    for (const [method, value] of [
      ["changerelayname", "Signal Hill"],
      ["changerelaydescription", "Notes."],
      ["changerelayicon", "https://example.com/i.png"],
    ]) {
      const reply = await callManagement(method, [value]);
      expect(reply.result).toBe(true);
      expect(reply.error).toContain("empty string");
      expect(reply.error).toContain("application/nostr+json");
    }
  });

  it("reports the effective name through /api/stats, from the same resolver the NIP-11 document uses", async () => {
    await callManagement("changerelayname", ["Signal Hill"]);
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(new Request("https://example.com/api/stats"));
    const stats = (await response.json()) as { relayName: string };
    expect(stats.relayName).toBe("Signal Hill");
    expect(stats.relayName).toBe((await relayInfo()).name);
  });

  it("rejects a non-string parameter rather than storing something odd", async () => {
    const reply = await callManagement("changerelayname", [42]);
    expect(reply.result).toBeUndefined();
    expect(reply.error).toContain("one string parameter");
  });

  // The env-var rung can't be exercised through the Worker: the test
  // environment's bindings are fixed by vitest.config.ts. Dropping to
  // handleManagementCall against real DO storage with a synthetic Env is
  // the only way to assert the store-and-warn behaviour, and it is a
  // documented exception rather than the norm (docs/test-notes.md).
  it("still stores the value when an environment variable outranks it, and says so", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const withEnvVar = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, RELAY_NAME: "from-the-dashboard" } as unknown as Env;

      const reply = handleManagementCall(sql, withEnvVar, "changerelayname", ["Signal Hill"], CALLER_IP, 1000);

      expect(reply.result).toBe(true);
      expect(reply.error).toContain("RELAY_NAME");
      expect(reply.error).toContain("takes precedence");
      // Stored anyway -- never silently discarded. It takes effect the
      // moment RELAY_NAME is cleared.
      const stored = sql
        .exec<{ value: string }>(`SELECT value FROM relay_settings WHERE key = 'name'`)
        .toArray()[0];
      expect(stored?.value).toBe("Signal Hill");
    });
  });
});
