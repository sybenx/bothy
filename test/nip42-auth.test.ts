// NIP-42 Authentication of clients to relays (nips/42.md).
//
// Gift wrap reads (relay.ts handleReq) are this
// relay's first auth-gated resource, so the full challenge/response
// round trip (lines 61-99) is now reachable and tested below, alongside
// what NIP-42 makes unconditional regardless of whether a real challenge
// was issued: client AUTH messages MUST be answered with an OK (line 37),
// and the relay's verification checklist (lines 103-109) -- kind,
// freshness, challenge-matching, and relay-tag matching -- must reject
// events that fail it. See test/nip59-giftwrap.test.ts and
// test/nip59-deletion.test.ts for the gift wrap accept/delete paths this
// gate protects.
import { describe, expect, it } from "vitest";
import type { NostrEvent } from "../src/nostr";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, type Frame, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-42 AUTH", () => {
  it("answers a client AUTH message with an OK", async () => {
    const conn = await connectRelay();
    const authEvent = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", "a-challenge-the-relay-never-issued"],
      ],
    });

    conn.send(["AUTH", authEvent]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("OK");
    expect(frame[1]).toBe(authEvent.id);
    expect(typeof frame[3]).toBe("string");
    conn.close();
  });

  it("rejects an AUTH event whose challenge does not match one the relay issued", async () => {
    const conn = await connectRelay();
    const authEvent = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", "a-challenge-the-relay-never-issued"],
      ],
    });

    conn.send(["AUTH", authEvent]);
    const [, , ok, message] = await conn.nextMessage();

    expect(ok).toBe(false);
    expect((message as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("rejects an AUTH event whose kind is not 22242", async () => {
    const conn = await connectRelay();
    const wrongKind = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", "whatever"],
      ],
    });

    conn.send(["AUTH", wrongKind]);
    const [, , ok, message] = await conn.nextMessage();

    expect(ok).toBe(false);
    expect((message as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("rejects an AUTH event whose created_at is far from the current time", async () => {
    const conn = await connectRelay();
    const stale = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 22242,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", "whatever"],
      ],
    });

    conn.send(["AUTH", stale]);
    const [, , ok, message] = await conn.nextMessage();

    expect(ok).toBe(false);
    expect((message as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });
});

describe("NIP-42 gift wrap read gate", () => {
  it("issues an AUTH challenge and closes an unauthenticated REQ for gift wraps", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "subGiftWraps", { kinds: [1059] }]);

    const authFrame = await conn.nextMessage();
    expect(authFrame[0]).toBe("AUTH");
    expect(typeof authFrame[1]).toBe("string");

    const closedFrame = await conn.nextMessage();
    expect(closedFrame[0]).toBe("CLOSED");
    expect(closedFrame[1]).toBe("subGiftWraps");
    expect((closedFrame[2] as string).startsWith("auth-required:")).toBe(true);
    conn.close();
  });

  it("serves gift wraps to the owner after a successful AUTH", async () => {
    const conn = await connectRelay();
    const giftWrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "hello",
    });
    await publish(conn, giftWrap);

    conn.send(["REQ", "subGated", { kinds: [1059] }]);
    const [, challenge] = await conn.nextMessage();
    await conn.nextMessage(); // CLOSED, auth-required

    const authEvent = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", challenge as string],
      ],
    });
    conn.send(["AUTH", authEvent]);
    const [, , authOk] = await conn.nextMessage();
    expect(authOk).toBe(true);

    conn.send(["REQ", "subGated2", { kinds: [1059] }]);
    const events: unknown[] = [];
    for (;;) {
      const frame = await conn.nextMessage();
      if (frame[0] === "EOSE") break;
      events.push(frame);
    }
    expect(events.length).toBe(1);
    conn.close();
  });

  it("rejects an AUTH event whose relay tag does not match this relay", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "subChallenge", { kinds: [1059] }]);
    const [, challenge] = await conn.nextMessage();
    await conn.nextMessage(); // CLOSED, auth-required

    const authEvent = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 22242,
      tags: [
        ["relay", "wss://a-totally-different-relay.example"],
        ["challenge", challenge as string],
      ],
    });
    conn.send(["AUTH", authEvent]);
    const [, , ok, message] = await conn.nextMessage();

    expect(ok).toBe(false);
    expect((message as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("restricts gift wrap reads for a pubkey that authenticated but is not the owner", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "subStranger", { kinds: [1059] }]);
    const [, challenge] = await conn.nextMessage();
    await conn.nextMessage(); // CLOSED, auth-required

    const stranger = randomKeypair();
    const authEvent = signEvent(stranger.secretKeyHex, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", challenge as string],
      ],
    });
    conn.send(["AUTH", authEvent]);
    const [, , authOk] = await conn.nextMessage();
    expect(authOk).toBe(true);

    conn.send(["REQ", "subStranger2", { kinds: [1059] }]);
    const frame = await conn.nextMessage();
    expect(frame[0]).toBe("CLOSED");
    expect((frame[2] as string).startsWith("restricted:")).toBe(true);
    conn.close();
  });
});

// The gate (relay.ts handleReqInner) answers to two rules, and which one
// applies is decided by the filter alone, never by what is stored.
//
// A filter NAMING kind 1059 is refused with auth-required, read off
// `f.kinds` with no storage access. A filter that names no kinds is
// answered normally with the gift wraps omitted from the result
// (filters.ts excludeGiftWraps).
//
// The second half used to be a refusal too, decided by probing storage:
// re-run the filter restricted to kind 1059, refuse if anything came
// back. That gate leaked the thing it protected. Its answer varied with
// the contents of the inbox, so the refusal WAS the answer -- an
// unauthenticated `{"#p":[owner],"since":S,"until":U,"limit":1}` said
// auth-required when a wrap fell in the window and EOSE when none did,
// and bisecting since/until yielded arrival times and an exact count
// without ever naming 1059. The oracle test below is the regression, and
// the two "omits" tests are what replaced the probe: the shapes that once
// forced a refusal are now served, minus the wraps.
// The REQ-time gate above proves nothing about *future* events: a filter
// that matches no stored gift wrap at registration time (most simply,
// any `#p` filter naming the owner while the inbox is empty) registers
// ungated, and every gift wrap accepted afterward necessarily p-tags the
// owner (relay.ts handleGiftWrap), so it matches. The live push path
// (relay.ts broadcast) must therefore enforce the same
// authenticated-recipient rule itself -- these two lock that in from
// both sides.
describe("NIP-42 gift wrap read gate: live broadcast", () => {
  it("does not push a live gift wrap to an unauthenticated subscription", async () => {
    const subscriber = await connectRelay();
    // Empty relay: the REQ-time gate finds no stored kind-1059 match, so
    // this sub is (correctly) accepted without an AUTH challenge.
    subscriber.send(["REQ", "subLiveLeak", { "#p": [OWNER_PUBKEY_HEX] }]);
    const eose = await subscriber.nextMessage();
    expect(eose[0]).toBe("EOSE");

    const sender = await connectRelay();
    const giftWrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "sealed",
    });
    const [, , ok] = await publish(sender, giftWrap);
    expect(ok).toBe(true);

    await expect(subscriber.nextMessage(200)).rejects.toThrow();
    subscriber.close();
    sender.close();
  });

  it("pushes a live gift wrap to the owner once authenticated", async () => {
    const subscriber = await connectRelay();
    // A kinds:[1059] REQ is gated by shape regardless of storage, so it
    // works as a challenge trigger even on an empty relay.
    subscriber.send(["REQ", "subChallengeTrigger", { kinds: [1059] }]);
    const [, challenge] = await subscriber.nextMessage();
    await subscriber.nextMessage(); // CLOSED, auth-required

    const authEvent = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", challenge as string],
      ],
    });
    subscriber.send(["AUTH", authEvent]);
    const [, , authOk] = await subscriber.nextMessage();
    expect(authOk).toBe(true);

    subscriber.send(["REQ", "subLiveAuthed", { "#p": [OWNER_PUBKEY_HEX] }]);
    const eose = await subscriber.nextMessage();
    expect(eose[0]).toBe("EOSE");

    const sender = await connectRelay();
    const giftWrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "sealed",
    });
    await publish(sender, giftWrap);

    const frame = await subscriber.nextMessage();
    expect(frame[0]).toBe("EVENT");
    expect(frame[1]).toBe("subLiveAuthed");
    expect((frame[2] as { id: string }).id).toBe(giftWrap.id);
    subscriber.close();
    sender.close();
  });
});

describe("NIP-42 gift wrap read gate: filter-shape coverage", () => {
  it("gates a filter naming kind 1059 alongside an unrelated constraint", async () => {
    const conn = await connectRelay();
    await publish(
      conn,
      signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", OWNER_PUBKEY_HEX]], content: "x" }),
    );

    conn.send(["REQ", "shapeA", { kinds: [1059], since: 0 }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("AUTH");
    conn.close();
  });

  it("gates a filter naming kind 1059 alongside other kinds", async () => {
    const conn = await connectRelay();
    await publish(
      conn,
      signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", OWNER_PUBKEY_HEX]], content: "x" }),
    );

    conn.send(["REQ", "shapeB", { kinds: [1, 1059] }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("AUTH");
    conn.close();
  });

  it("omits a gift wrap from an ids-only filter naming it, rather than refusing", async () => {
    // An id is an unguessable content hash, so an ids-only filter is no
    // discovery vector for anyone who does not already hold the event --
    // but that is not the rule this relay promises (CLAUDE.md "What it
    // is": gift wraps go only to the authenticated p-tagged recipient,
    // with no carve-out for "unless you already know the id"). The rule
    // is kept; what changed is that keeping it no longer requires saying
    // so. The client asked for an id and gets nothing back, which is what
    // it would get for an id this relay never stored.
    const conn = await connectRelay();
    const giftWrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "x",
    });
    await publish(conn, giftWrap);

    conn.send(["REQ", "shapeC", { ids: [giftWrap.id] }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("EOSE");
    conn.close();
  });

  it("omits a gift wrap from a #p filter while still serving the events beside it", async () => {
    // The shape a NIP-17 client's relay list produces, and the one the
    // probe was worst at. The probe had to look at least as far into the
    // tag index as the REQ itself could -- so it ran at the REQ's own
    // limit, which made the common kinds-less REQ pay a bounded but
    // limit-proportional read on every send (141 rows measured at limit
    // 20 against a 500-wrap inbox) purely to decide whether to refuse.
    //
    // Nothing probes now. The wrap is dropped by the query that was
    // already running, and the ten ordinary notes sitting in the same tag
    // range come back, which the refusal used to take with it.
    const conn = await connectRelay();
    const now = Math.floor(Date.now() / 1000);
    const giftWrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "x",
      created_at: now - 100,
    });
    await publish(conn, giftWrap);
    // Ten newer events carrying the same `#p` value, so the gift wrap is
    // the eleventh row of the tag range rather than the first -- deeper
    // than a limit-1 probe would ever have looked.
    for (let i = 0; i < 10; i++) {
      await publish(
        conn,
        signEvent(OWNER_SECRET_KEY_HEX, {
          kind: 1,
          tags: [["p", OWNER_PUBKEY_HEX]],
          content: `note ${i}`,
          created_at: now - 50 + i,
        }),
      );
    }

    conn.send(["REQ", "shapeE", { "#p": [OWNER_PUBKEY_HEX], limit: 20 }]);
    const events: NostrEvent[] = [];
    for (;;) {
      const frame = await conn.nextMessage();
      if (frame[0] === "EOSE") break;
      expect(frame[0]).toBe("EVENT");
      events.push(frame[2] as NostrEvent);
    }

    expect(events.some((e) => e.id === giftWrap.id)).toBe(false);
    expect(events.every((e) => e.kind !== 1059)).toBe(true);
    expect(events.length).toBe(10);
    conn.close();
  });

  it("answers a windowed #p probe identically whether or not a gift wrap falls inside it", async () => {
    // The oracle, and the reason refusal was the wrong shape for this
    // gate. Two windows, one holding a gift wrap and one holding nothing
    // at all: under the storage probe the first answered `auth-required`
    // and the second `EOSE`, which is a one-bit read of the owner's inbox
    // per REQ, and bisecting since/until turns those bits into exact
    // arrival times and an exact count. Neither filter names kind 1059,
    // so nothing in the request says the client is asking about gift
    // wraps -- the gate volunteered it.
    //
    // Asserted as an equality between the two answers rather than against
    // a literal, because the property is indistinguishability: whatever
    // the relay says about a window, it must say the same thing about a
    // window whose only difference is a gift wrap.
    const conn = await connectRelay();
    const occupied = 1_600_000_000;
    const empty = 1_500_000_000;
    await publish(
      conn,
      signEvent(randomKeypair().secretKeyHex, {
        kind: 1059,
        tags: [["p", OWNER_PUBKEY_HEX]],
        content: "x",
        created_at: occupied,
      }),
    );

    async function probe(sub: string, at: number): Promise<Frame> {
      conn.send(["REQ", sub, { "#p": [OWNER_PUBKEY_HEX], since: at - 60, until: at + 60, limit: 1 }]);
      for (;;) {
        const frame = await conn.nextMessage();
        if (frame[1] === sub) return frame;
      }
    }

    const hit = await probe("oracleHit", occupied);
    const miss = await probe("oracleMiss", empty);

    expect(hit[0]).toBe("EOSE");
    expect(hit[0]).toBe(miss[0]);
    conn.close();
  });

  it("does not gate a #p filter whose kinds excludes 1059, even naming an undefined kind range", async () => {
    const conn = await connectRelay();
    await publish(
      conn,
      signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", OWNER_PUBKEY_HEX]], content: "x" }),
    );

    // kind 500 is in NIP-01's undefined range (45-999) and is stored like
    // a regular kind (test/nip01-kinds.test.ts) -- `kind IN (500)` still
    // ANDs against everything else in the filter, so it structurally
    // cannot return the kind-1059 row above regardless of the `#p` match.
    conn.send(["REQ", "shapeD", { kinds: [500], "#p": [OWNER_PUBKEY_HEX] }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("EOSE");
    conn.close();
  });
});
