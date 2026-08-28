// Read-abuse mitigations (CLAUDE.md "Threat model"): reads are public by
// design, so these caps -- not authentication -- are what stands between
// a normal deployment and a stranger burning the daily 5M rows-read /
// 100k DO-requests ceiling.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";
import {
  boundFilter,
  MAX_FILTER_COMBINATIONS,
  MAX_FILTER_LIMIT,
  MAX_FILTER_ROWS_READ,
  MAX_FILTERS_PER_REQ,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "../src/limits";

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

// One REQ frame, any number of filters, each independently admitted at up
// to MAX_FILTER_ROWS_READ -- while the per-IP throttle in relay.ts counts
// the frame as one message. The per-filter cap read like a per-message
// one and was not, so the quantity a single message could spend was
// bounded by the 1MiB frame size and nothing else.
describe("filters per REQ", () => {
  it("accepts a REQ carrying the maximum number of filters", async () => {
    // Its own IP: the throttle test above deliberately exhausts the
    // bucket every connection shares when none is given.
    const conn = await connectRelay("10.0.0.11");
    const filters = Array.from({ length: MAX_FILTERS_PER_REQ }, (_, i) => ({ kinds: [3000 + i], limit: 1 }));
    conn.send(["REQ", "sub-max-filters", ...filters]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("EOSE");
    conn.close();
  });

  it("shares one filter's rows-read budget across the whole frame", async () => {
    // MAX_FILTER_ROWS_READ is the cap on a REQ, and it was enforced per
    // filter -- so ten filters at the cap were ten times the cap. Each
    // filter in a multi-filter frame now gets a share, which shows up as
    // a tighter clamp on its limit than the same filter alone would get.
    const alone = boundFilter({ kinds: [1], limit: MAX_FILTER_LIMIT });
    expect(alone.ok).toBe(true);
    if (alone.ok) expect(alone.cost.rowsRead).toBeLessThanOrEqual(MAX_FILTER_ROWS_READ);

    const share = Math.floor(MAX_FILTER_ROWS_READ / MAX_FILTERS_PER_REQ);
    const shared = boundFilter({ kinds: [1], limit: MAX_FILTER_LIMIT }, share);
    expect(shared.ok).toBe(true);
    if (shared.ok && alone.ok) {
      expect(shared.cost.rowsRead).toBeLessThanOrEqual(share);
      // The whole frame, at the cap, is what one filter alone may cost.
      expect(shared.cost.rowsRead * MAX_FILTERS_PER_REQ).toBeLessThanOrEqual(MAX_FILTER_ROWS_READ);
      expect(shared.filter.limit!).toBeLessThan(alone.filter.limit!);
    }
  });

  it("closes a REQ carrying more filters than the cap", async () => {
    // Measured before this cap existed: a REQ carrying 200 filters was
    // answered with EOSE, having run all 200.
    const conn = await connectRelay("10.0.0.12");
    const filters = Array.from({ length: MAX_FILTERS_PER_REQ + 1 }, (_, i) => ({ kinds: [3000 + i], limit: 1 }));
    conn.send(["REQ", "sub-too-many-filters", ...filters]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("CLOSED");
    expect(frame[1]).toBe("sub-too-many-filters");
    expect((frame[2] as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });
});

// The query count a filter expands into, capped independently of what
// those queries are priced to read -- see limits.ts
// MAX_FILTER_COMBINATIONS. The shape below is the one that motivated it:
// naming a single id made the identical filter price at 1 row instead of
// 5,005,000, because the ids access path was the cheapest and was priced
// as though the filter ran once. It runs `combinations` times.
describe("filter combination cap", () => {
  it("refuses an authors list that would expand past the query-count cap, ids or no ids", async () => {
    const conn = await connectRelay("10.0.0.13");
    const authors = Array.from({ length: MAX_FILTER_COMBINATIONS + 1 }, (_, i) =>
      i.toString(16).padStart(64, "f"),
    );

    conn.send(["REQ", "sub-combos", { authors, limit: 1 }]);
    const plain = await conn.nextMessage();
    expect(plain[0]).toBe("CLOSED");

    // The same filter with one id added. This used to be admitted: the
    // `ids` path priced it at one row per id and the query count vanished
    // from the estimate entirely, so a single 64-hex string turned a
    // refused filter into a free one.
    conn.send(["REQ", "sub-combos-ids", { ids: ["0".repeat(64)], authors, limit: 1 }]);
    const withIds = await conn.nextMessage();
    expect(withIds[0]).toBe("CLOSED");
    expect((withIds[2] as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("still admits an ordinary many-author filter below the cap", async () => {
    // The property the cap must not break: a client with hundreds of
    // follows is not abusive, it is a client with hundreds of follows.
    const conn = await connectRelay("10.0.0.14");
    const authors = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(64, "a"));
    conn.send(["REQ", "sub-follows", { authors, kinds: [1], limit: 20 }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("EOSE");
    conn.close();
  });
});

// The WebSocket attachment subscriptions are persisted in has a hard
// 16KiB ceiling, and serializeAttachment enforces it by THROWING. Nothing
// checked it: an ordinary `{"authors":[<400 keys>],"kinds":[1]}` -- ~26KB
// serialized, and admitted by every cap in limits.ts -- ran its query,
// sent its events, and then took an uncaught exception in place of the
// EOSE, leaving the client waiting on a reply that never came.
describe("connection state size", () => {
  it("closes a REQ whose filters cannot fit in the connection attachment", async () => {
    const conn = await connectRelay("10.0.0.15");
    const authors = Array.from({ length: 400 }, (_, i) => i.toString(16).padStart(64, "a"));
    conn.send(["REQ", "sub-huge", { authors, kinds: [1], limit: 20 }]);
    const frame = await conn.nextMessage();

    expect(frame[0]).toBe("CLOSED");
    expect(frame[1]).toBe("sub-huge");
    expect((frame[2] as string).startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("leaves an existing subscription intact when a later REQ is refused for size", async () => {
    // A refusal must not evict what it could not join. The check runs
    // against a copy of the state for exactly this reason.
    const conn = await connectRelay("10.0.0.16");
    conn.send(["REQ", "sub-small", { kinds: [1], limit: 1 }]);
    expect((await conn.nextMessage())[0]).toBe("EOSE");

    const authors = Array.from({ length: 400 }, (_, i) => i.toString(16).padStart(64, "a"));
    conn.send(["REQ", "sub-huge2", { authors, kinds: [1], limit: 20 }]);
    expect((await conn.nextMessage())[0]).toBe("CLOSED");

    // The surviving subscription still receives a live event.
    const publisher = await connectRelay("10.0.0.17");
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "after refusal" });
    await publish(publisher, event);
    const pushed = await conn.nextMessage();

    expect(pushed[0]).toBe("EVENT");
    expect(pushed[1]).toBe("sub-small");
    conn.close();
    publisher.close();
  });
});
