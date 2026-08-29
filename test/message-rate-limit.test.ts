// Per-IP WebSocket message throttle (src/relay.ts isRateLimited,
// RATE_LIMIT_MAX_MESSAGES/RATE_LIMIT_WINDOW_MS). Distinct from
// test/rate-limit.test.ts, which covers the HTTP-level per-IP limiter --
// this one covers the message-level throttle inside the Durable Object,
// which starts counting only after a connection is already open.
//
// A rate-limited EVENT frame used to get only a bare NOTICE, with no
// per-event verdict at all. That's a silent drop for a machine client that
// blocks on OK to know whether an event was delivered -- a WebRTC
// signalling client waiting on ICE candidates, say. handleRateLimitedMessage
// now answers a throttled EVENT frame with OK false and a rate-limited:
// prefix instead, and falls back to the plain NOTICE only when the frame
// can't be parsed into an id at all.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay, type RelayConn } from "./helpers/socket";

isolateStorage();

// One more than RATE_LIMIT_MAX_MESSAGES (50, src/relay.ts) -- the first
// call after an entry exists always increments before comparing, so this
// is the first message guaranteed to see isRateLimited return true. CLOSE
// is used to prime the counter because handleClose never replies, so
// priming never races the message under test for the next reply on the
// socket.
const MESSAGES_TO_EXHAUST_ALLOWANCE = 50;

async function exhaustAllowance(conn: RelayConn): Promise<void> {
  for (let i = 0; i < MESSAGES_TO_EXHAUST_ALLOWANCE; i++) {
    conn.send(["CLOSE", `priming-sub-${i}`]);
  }
}

describe("per-IP WebSocket message throttle", () => {
  it("answers a rate-limited EVENT frame with OK false rather than a bare NOTICE", async () => {
    const conn = await connectRelay("203.0.113.60");
    await exhaustAllowance(conn);

    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "throttled" });
    conn.send(["EVENT", event]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("OK");
    expect(frame[1]).toBe(event.id);
    expect(frame[2]).toBe(false);
    expect(frame[3]).toContain("rate-limited:");

    conn.close();
  });

  it("falls back to NOTICE for a rate-limited frame that isn't a parseable EVENT", async () => {
    const conn = await connectRelay("203.0.113.61");
    await exhaustAllowance(conn);

    conn.send(["REQ", "sub1", {}]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("NOTICE");
    expect(frame[1]).toContain("rate-limited:");

    conn.close();
  });

  it("falls back to NOTICE for a rate-limited EVENT frame with a malformed event", async () => {
    const conn = await connectRelay("203.0.113.62");
    await exhaustAllowance(conn);

    conn.send(["EVENT", { kind: 1 }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("NOTICE");
    expect(frame[1]).toContain("rate-limited:");

    conn.close();
  });

  it("does not throttle a different address sharing no allowance", async () => {
    const throttled = await connectRelay("203.0.113.63");
    await exhaustAllowance(throttled);

    const fresh = await connectRelay("203.0.113.64");
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "not throttled" });
    fresh.send(["EVENT", event]);
    const frame = await fresh.nextMessage();

    expect(frame[0]).toBe("OK");
    expect(frame[2]).toBe(true);

    throttled.close();
    fresh.close();
  });
});
