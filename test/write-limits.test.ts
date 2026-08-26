// Write-path abuse caps (src/limits.ts) -- what an author who IS allowed
// to write can cost. Distinct from test/ownership.test.ts and
// test/follows.test.ts, which cover who may write at all, and from
// test/read-limits.test.ts, which bounds the public read path.
//
// The gap these close: ALLOW_FOLLOWS became an opt-out in v0.2.0, so the
// write path went from one trusted author to hundreds of followed
// pubkeys while every abuse cap in the project was still scoped to
// kind-1059 gift wraps. Each scenario below is named for the abuse it
// refuses, not for the constant it reads.
import { describe, expect, it, vi } from "vitest";
import { MAX_EVENT_BYTES } from "../src/limits";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

// relay.ts calls verifySignature through this module, so spying on it is
// what proves the size check runs BEFORE schnorr rather than after --
// same technique as test/write-path-ordering.test.ts.
vi.mock("../src/validate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validate")>();
  return { ...actual, verifySignature: vi.fn(actual.verifySignature) };
});

isolateStorage();

// Publishing the owner's kind-3 over the wire refreshes the follow cache
// immediately (relay.ts acceptEvent), so the returned keypair may write
// from that point on.
async function addFollow(conn: RelayConn) {
  const friend = randomKeypair();
  const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
    kind: 3,
    tags: [["p", friend.pubkeyHex]],
  });
  const [, , ok] = await publish(conn, contacts);
  expect(ok).toBe(true);
  return friend;
}

// Comfortably past the cap once JSON-serialized, without being so large
// that signing it dominates the test's runtime.
const OVERSIZED_CONTENT = "x".repeat(MAX_EVENT_BYTES + 8_000);

describe("event size cap", () => {
  it("refuses an oversized event from a follow, before paying for signature verification", async () => {
    const conn = await connectRelay();
    const friend = await addFollow(conn);

    const { verifySignature } = await import("../src/validate");
    vi.mocked(verifySignature).mockClear();

    const huge = signEvent(friend.secretKeyHex, { kind: 1, content: OVERSIZED_CONTENT });
    const [, id, ok, message] = await publish(conn, huge);

    expect(id).toBe(huge.id);
    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    // The signature on this event is genuinely valid -- if the size check
    // ran after schnorr, verifySignature would show a call here. It is the
    // whole point of putting the cheapest check first (docs/budget.md).
    expect(verifySignature).not.toHaveBeenCalled();
    conn.close();
  });

  it("refuses an oversized event from the OWNER too", async () => {
    // A cap the owner can exceed does not bound stored bytes at all --
    // the owner is the one author guaranteed to be writing here.
    const conn = await connectRelay();
    const huge = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: OVERSIZED_CONTENT });

    const [, , ok, message] = await publish(conn, huge);

    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("accepts an event comfortably under the cap from a follow", async () => {
    const conn = await connectRelay();
    const friend = await addFollow(conn);

    const long = signEvent(friend.secretKeyHex, {
      kind: 1,
      content: "x".repeat(MAX_EVENT_BYTES - 2_000),
    });
    const [, , ok] = await publish(conn, long);

    expect(ok).toBe(true);
    conn.close();
  });
});
