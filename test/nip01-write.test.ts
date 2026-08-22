// NIP-01 "From relay to client": OK MUST be sent in response to EVENT,
// 3rd param true/false, 4th param either "" or a machine-readable
// `prefix: message` (nips/01.md lines 156-180).
//
// All events here are signed by the OWNER key so that signature/id
// validity is the only variable under test -- ownership gating itself is
// covered separately in test/ownership.test.ts.
import { describe, expect, it } from "vitest";
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
  "mute",
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
