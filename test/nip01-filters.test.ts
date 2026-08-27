// NIP-01 filter semantics (nips/01.md lines 123-149): ids/authors/kinds/
// #<tag>/since/until/limit, AND-within-a-filter, OR-across-filters, and
// the ordering + tie-break rules for `limit`.
//
// All fixtures are owner-authored since only the owner can write (see
// test/ownership.test.ts) -- this single-user relay never has more than
// one distinct author's events stored, so "authors" is tested via list
// membership (owner's key present among others) rather than by storing
// events from multiple authors.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { collectStored, connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-01 filters", () => {
  it("ids filter matches only the listed event ids", async () => {
    const conn = await connectRelay();
    const a = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "a" });
    const b = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "b" });
    await publish(conn, a);
    await publish(conn, b);

    const events = await collectStored(conn, "subIds", [{ ids: [a.id] }]);

    expect(events.map((e) => e.id)).toEqual([a.id]);
    conn.close();
  });

  it("authors filter matches by list membership", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "mine" });
    await publish(conn, event);

    const stranger = randomKeypair().pubkeyHex;
    const events = await collectStored(conn, "subAuthors", [
      { authors: [stranger, OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id)).toEqual([event.id]);
    conn.close();
  });

  it("authors filter excludes pubkeys not in the list", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "mine" });
    await publish(conn, event);

    const stranger = randomKeypair().pubkeyHex;
    const events = await collectStored(conn, "subAuthorsMiss", [{ authors: [stranger] }]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("kinds filter matches any of the listed kinds", async () => {
    const conn = await connectRelay();
    const kind1 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "k1" });
    const kind7 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 7, content: "k7" });
    const kind2 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 2, content: "k2" });
    for (const e of [kind1, kind7, kind2]) {
      await publish(conn, e);
    }

    const events = await collectStored(conn, "subKinds", [
      { kinds: [1, 7], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id).sort()).toEqual([kind1.id, kind7.id].sort());
    conn.close();
  });

  it("#<letter> tag filter matches events with that tag value", async () => {
    const conn = await connectRelay();
    // Deliberately not OWNER_PUBKEY_HEX: an unauthenticated `#p` filter
    // naming the owner is gated behind NIP-42 AUTH (relay.ts handleReq)
    // since it's also how an anonymous
    // reader could discover gift wrap volume/timing -- see
    // test/nip59-giftwrap.test.ts. This test is about generic
    // `#<letter>` matching, not that policy, so it uses an unrelated
    // pubkey to stay out of its way.
    const taggedPubkey = randomKeypair().pubkeyHex;
    const tagged = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      tags: [["p", taggedPubkey]],
      content: "mentions",
    });
    const untagged = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "no mention" });
    for (const e of [tagged, untagged]) {
      await publish(conn, e);
    }

    const events = await collectStored(conn, "subP", [{ "#p": [taggedPubkey] }]);

    expect(events.map((e) => e.id)).toEqual([tagged.id]);
    conn.close();
  });

  it("only the first value of a tag is indexed (NIP-01 tags convention)", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      tags: [["t", "indexed-value", "secondary-value"]],
      content: "tagged",
    });
    await publish(conn, event);

    const matches = await collectStored(conn, "subTag1", [{ "#t": ["indexed-value"] }]);
    expect(matches.map((e) => e.id)).toEqual([event.id]);

    const nonMatches = await collectStored(conn, "subTag2", [{ "#t": ["secondary-value"] }]);
    expect(nonMatches).toEqual([]);
    conn.close();
  });

  it("since/until bound created_at inclusively on both ends", async () => {
    const conn = await connectRelay();
    const before = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "before", created_at: 1000 });
    const atSince = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "at since", created_at: 1010 });
    const atUntil = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "at until", created_at: 1020 });
    const after = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "after", created_at: 1030 });
    for (const e of [before, atSince, atUntil, after]) {
      await publish(conn, e);
    }

    const events = await collectStored(conn, "subRange", [
      { kinds: [1], authors: [OWNER_PUBKEY_HEX], since: 1010, until: 1020 },
    ]);

    expect(events.map((e) => e.id).sort()).toEqual([atSince.id, atUntil.id].sort());
    conn.close();
  });

  it("multiple conditions within one filter are ANDed", async () => {
    const conn = await connectRelay();
    const target = "e".repeat(64);
    const matchesBoth = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      tags: [["e", target]],
      content: "both",
    });
    const kindOnly = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "kind only" });
    const tagOnly = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 7,
      tags: [["e", target]],
      content: "tag only",
    });
    for (const e of [matchesBoth, kindOnly, tagOnly]) {
      await publish(conn, e);
    }

    const events = await collectStored(conn, "subAnd", [{ kinds: [1], "#e": [target] }]);

    expect(events.map((e) => e.id)).toEqual([matchesBoth.id]);
    conn.close();
  });

  it("multiple filters in one REQ are ORed", async () => {
    const conn = await connectRelay();
    const kind1 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "k1" });
    const kind7 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 7, content: "k7" });
    const kind2 = signEvent(OWNER_SECRET_KEY_HEX, { kind: 2, content: "k2" });
    for (const e of [kind1, kind7, kind2]) {
      await publish(conn, e);
    }

    const events = await collectStored(conn, "subOr", [
      { kinds: [1], authors: [OWNER_PUBKEY_HEX] },
      { kinds: [7], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events.map((e) => e.id).sort()).toEqual([kind1.id, kind7.id].sort());
    conn.close();
  });

  it("limit returns the last N by created_at, newest first, ties broken by lowest id", async () => {
    const conn = await connectRelay();
    const base = 1700000000;
    const older = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "older", created_at: base });
    const tieA = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "tie a", created_at: base + 10 });
    const tieB = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "tie b", created_at: base + 10 });
    for (const e of [older, tieA, tieB]) {
      await publish(conn, e);
    }

    const events = await collectStored(conn, "subLimit", [
      { kinds: [1], authors: [OWNER_PUBKEY_HEX], limit: 2 },
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]!.created_at).toBe(base + 10);
    expect(events[1]!.created_at).toBe(base + 10);
    const [expectedFirst, expectedSecond] = [tieA, tieB].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(events[0]!.id).toBe(expectedFirst!.id);
    expect(events[1]!.id).toBe(expectedSecond!.id);
    conn.close();
  });
});
