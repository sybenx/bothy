// NIP-01 "From relay to client": OK MUST be sent in response to EVENT,
// 3rd param true/false, 4th param either "" or a machine-readable
// `prefix: message` (nips/01.md lines 156-180).
//
// All events here are signed by the OWNER key so that signature/id
// validity is the only variable under test -- ownership gating itself is
// covered separately in test/ownership.test.ts.
import { describe, expect, it } from "vitest";
import { MAX_CREATED_AT_FUTURE_SECONDS } from "../src/limits";
import { signEvent, withCorruptSignature, withTamperedContent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const STANDARD_PREFIXES = [
  "duplicate",
  "pow",
  "blocked",
  "rate-limited",
  "invalid",
  "restricted",
  "error",
];

describe("NIP-01 EVENT/OK", () => {
  it("accepts a validly signed event with OK true", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "hello" });

    const [, id, ok, message] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(true);
    conn.close();
  });

  it("OK's 4th element is a string, present even on success", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "hello" });

    const [, , , message] = await publish(conn, event);

    expect(typeof message).toBe("string");
    conn.close();
  });

  it("accepts duplicate resubmission with OK true and a duplicate: prefix", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "hello again" });

    await publish(conn, event);
    const [, id, ok, message] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(true);
    expect(message.startsWith("duplicate:")).toBe(true);
    conn.close();
  });

  it("rejects an event whose signature does not verify", async () => {
    const conn = await connectRelay();
    const event = withCorruptSignature(
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "bad sig" }),
    );

    const [, id, ok, message] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("rejects an event whose id does not match the hash of its contents", async () => {
    const conn = await connectRelay();
    const event = withTamperedContent(
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "original" }),
    );

    const [, , ok, message] = await publish(conn, event);

    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("every OK false message uses one of the standardized machine-readable prefixes", async () => {
    const conn = await connectRelay();
    const event = withCorruptSignature(
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "bad sig" }),
    );

    const [, , ok, message] = await publish(conn, event);

    expect(ok).toBe(false);
    const prefix = message.split(":")[0];
    expect(STANDARD_PREFIXES).toContain(prefix);
    conn.close();
  });
});

// limits.ts MAX_CREATED_AT_FUTURE_SECONDS -- self-inflicted-damage
// prevention against a wrong client clock permanently bricking a
// replaceable kind, not abuse prevention. See that constant's comment
// for the full "why". No lower bound -- backfill and republished
// personal archives depend on old timestamps working forever.
describe("created_at future limit", () => {
  it("accepts and stores an event dated years in the past (the archive case)", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "from the archives",
      created_at: Math.floor(Date.now() / 1000) - 5 * 365 * 86400,
    });

    const [, id, ok] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(true);
    conn.close();
  });

  it("accepts an event dated slightly ahead, inside the window", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "a little ahead of clock skew",
      created_at: Math.floor(Date.now() / 1000) + MAX_CREATED_AT_FUTURE_SECONDS - 60,
    });

    const [, id, ok] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(true);
    conn.close();
  });

  it("rejects an event dated beyond the window with an invalid: prefix", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "from the future",
      created_at: Math.floor(Date.now() / 1000) + MAX_CREATED_AT_FUTURE_SECONDS + 60,
    });

    const [, id, ok, message] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("refuses a far-future kind-3 so a later normally-dated kind-3 still replaces the stored one", async () => {
    const conn = await connectRelay();
    const now = Math.floor(Date.now() / 1000);

    const brickAttempt = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      content: "",
      tags: [["p", "a".repeat(64)]],
      created_at: now + MAX_CREATED_AT_FUTURE_SECONDS + 3600,
    });
    const [, , brickOk] = await publish(conn, brickAttempt);
    expect(brickOk).toBe(false);

    const normalUpdate = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 3,
      content: "",
      tags: [["p", "b".repeat(64)]],
      created_at: now,
    });
    const [, , normalOk] = await publish(conn, normalUpdate);
    expect(normalOk).toBe(true);

    conn.close();
  });
});
