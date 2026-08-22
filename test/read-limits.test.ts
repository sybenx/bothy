// Read-abuse mitigations (CLAUDE.md "Threat model"): reads are public by
// design, so these caps -- not authentication -- are what stands between
// a normal deployment and a stranger burning the daily 5M rows-read /
// 100k DO-requests ceiling.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";
import { MAX_SUBSCRIPTIONS_PER_CONNECTION } from "../src/limits";

isolateStorage();

describe("subscription cap", () => {
  it("closes a REQ beyond the per-connection subscription limit", async () => {
    const conn = await connectRelay();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) {
      conn.send(["REQ", `sub${i}`, { kinds: [1], authors: [OWNER_PUBKEY_HEX] }]);
      // drain to EOSE
      for (;;) {
        const frame = await conn.nextMessage();
        if (frame[0] === "EOSE") break;
      }
    }

    conn.send(["REQ", "one-too-many", { kinds: [1], authors: [OWNER_PUBKEY_HEX] }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("CLOSED");
    expect(frame[1]).toBe("one-too-many");
    expect((frame[2] as string).startsWith("rate-limited:")).toBe(true);
    conn.close();
  });

  it("replacing an existing subscription id does not count against the cap", async () => {
    const conn = await connectRelay();
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CONNECTION; i++) {
      conn.send(["REQ", `sub${i}`, { kinds: [1], authors: [OWNER_PUBKEY_HEX] }]);
      for (;;) {
        const frame = await conn.nextMessage();
        if (frame[0] === "EOSE") break;
      }
    }

    // Re-send the same id already open -- a replacement, not a new sub.
    conn.send(["REQ", "sub0", { kinds: [7], authors: [OWNER_PUBKEY_HEX] }]);
    const frame = await conn.nextMessage();
    expect(frame[0]).toBe("EOSE");
    conn.close();
  });
});

describe("unconstrained filter rejection", () => {
  it("rejects a filter with no ids, authors, kinds, or tag constraint", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "sub-unconstrained", { since: 0 }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("CLOSED");
    expect((frame[2] as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("accepts a filter constrained only by a #<letter> tag", async () => {
    const conn = await connectRelay();
    conn.send(["REQ", "sub-tag-only", { "#e": ["0".repeat(64)] }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("EOSE");
    conn.close();
  });
});

describe("per-IP message throttle", () => {
  it("rate-limits a connection sending an excessive burst of messages", async () => {
    const conn = await connectRelay();
    // CLOSE on a subscription id that was never opened is a cheap no-op
    // message -- enough to trip the throttle without touching storage.
    for (let i = 0; i < 55; i++) {
      conn.send(["CLOSE", "never-opened"]);
    }

    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "after burst" });
    conn.send(["EVENT", event]);
    const frame = await conn.nextMessage(1000);

    expect(frame[0]).toBe("NOTICE");
    expect((frame[1] as string).startsWith("rate-limited:")).toBe(true);
    conn.close();
  });
});
