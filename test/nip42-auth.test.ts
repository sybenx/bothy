// NIP-42 Authentication of clients to relays (nips/42.md).
//
// This relay has no auth-gated resource today (reads are public, writes
// are owner-only and gated by signature + ownership, not AUTH -- see
// CLAUDE.md "Threat model"), so there is no scenario in which the relay
// itself issues a challenge. That means the full challenge/response
// round trip (lines 61-99) isn't reachable through the wire protocol yet
// and isn't tested here. What NIP-42 makes unconditional regardless of
// whether a challenge was ever issued is tested instead: client AUTH
// messages MUST be answered with an OK (line 37), and the relay's
// verification checklist (lines 103-109) -- kind, freshness, and
// challenge-matching -- must reject events that fail it.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay } from "./helpers/socket";

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
