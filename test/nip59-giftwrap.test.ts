// NIP-59 (nips/59.md) Gift Wrap: kind 1059, signed by a random one-time
// key, `p`-tagged to its recipient. The one deliberate exception to
// owner-only writes -- CLAUDE.md "Threat model" calls it
// "the only unauthenticated write path in the project" and "the only
// unbounded write path", hence the extra abuse controls (limits.ts)
// exercised here alongside the accept/reject rules. Recipient-authorized
// deletion and its tombstone durability live in test/nip59-deletion.test.ts;
// the NIP-42 read gate lives in test/nip42-auth.test.ts.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_GIFT_WRAPS } from "../src/limits";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-59 gift wrap accept path", () => {
  it("accepts a kind-1059 event from a stranger when its p tag names the owner", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "encrypted seal goes here",
    });

    const [, id, ok] = await publish(conn, giftWrap);

    expect(id).toBe(giftWrap.id);
    expect(ok).toBe(true);
    conn.close();
  });

  it("rejects a kind-1059 event whose p tag does not name the owner", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const someoneElse = randomKeypair().pubkeyHex;
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", someoneElse]],
      content: "not for the owner",
    });

    const [, , ok, message] = await publish(conn, giftWrap);

    expect(ok).toBe(false);
    expect(message.startsWith("restricted:")).toBe(true);
    conn.close();
  });

  it("accepts a gift wrap with a created_at randomized up to two days in the past", async () => {
    // NIP-59 recommends randomizing created_at to hinder timing analysis;
    // a naive freshness check would wrongly reject valid mail.
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 24 * 60 * 60;
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "backdated",
      created_at: twoDaysAgo,
    });

    const [, , ok] = await publish(conn, giftWrap);

    expect(ok).toBe(true);
    conn.close();
  });

  // The size cap enforced here is now the general MAX_EVENT_BYTES
  // (limits.ts), not a gift-wrap-specific one -- MAX_GIFT_WRAP_BYTES was
  // folded into it at the same 64KB rather than kept as a second constant
  // that had to agree. Hence "invalid:" rather than the "blocked:" this
  // path used to answer with. Covered generally in test/write-limits.test.ts;
  // kept here because a gift wrap is the write path where an unbounded
  // size costs the most, and this suite should keep proving it is bounded.
  it("rejects a gift wrap larger than the size cap", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "x".repeat(100_000),
    });

    const [, , ok, message] = await publish(conn, giftWrap);

    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("rate-limits gift wraps from a single connection", async () => {
    const conn = await connectRelay();
    let lastMessage = "";
    let sawRateLimited = false;
    for (let i = 0; i < 10; i++) {
      const giftWrap = signEvent(randomKeypair().secretKeyHex, {
        kind: 1059,
        tags: [["p", OWNER_PUBKEY_HEX]],
        content: `message ${i}`,
      });
      const [, , ok, message] = await publish(conn, giftWrap);
      lastMessage = message;
      if (!ok && message.startsWith("rate-limited:")) {
        sawRateLimited = true;
        break;
      }
    }

    expect(sawRateLimited).toBe(true);
    expect(lastMessage.startsWith("rate-limited:")).toBe(true);
    conn.close();
  });

  it("rejects a gift wrap once the total storage cap is reached", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    // Seed directly via SQL -- signing MAX_GIFT_WRAPS real events just to
    // fill the cap would make this test needlessly slow, and the cap
    // check (storage.ts giftWrapCount) only cares about row count.
    await runInDurableObject(stub, async (_instance, state) => {
      for (let i = 0; i < MAX_GIFT_WRAPS; i++) {
        state.storage.sql.exec(
          `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          i.toString(16).padStart(64, "0"),
          "f".repeat(64),
          1700000000 + i,
          1059,
          JSON.stringify([["p", OWNER_PUBKEY_HEX]]),
          "seeded",
          "0".repeat(128),
          null,
        );
      }
    });

    const conn = await connectRelay();
    const giftWrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "one too many",
    });
    const [, , ok, message] = await publish(conn, giftWrap);

    expect(ok).toBe(false);
    expect(message.startsWith("blocked:")).toBe(true);
    conn.close();
  });
});

// relay.ts handleGiftWrap also rejects with "restricted: relay has not
// been claimed yet" when getOwnerPubkey returns null. Not tested here at
// the wire level: vitest.config.ts injects a fixed OWNER_PUBKEY binding
// globally for this test run (every DO instance, regardless of name, has
// env.OWNER_PUBKEY set), so there is no way to exercise an unclaimed
// relay over the wire -- the same limitation test/claim.test.ts documents
// and works around for the claim endpoint itself. getOwnerPubkey
// returning null when unclaimed is already covered directly in
// claim.test.ts ("is unclaimed until a claim is written"); handleGiftWrap's
// branch on that null is a one-line check with nothing left to verify
// beyond what these two suites already prove independently.
