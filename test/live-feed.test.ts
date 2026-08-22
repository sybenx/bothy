// Admin page live feed (ROADMAP.md chunk 7) -- a push-only, unauthenticated
// WebSocket channel at "/live", separate from the nostr protocol
// connection ("/"), that notifies whoever has the admin page open of
// newly stored events. CLAUDE.md "Admin page": "Never render gift wrap
// p tags or content to an unauthenticated viewer" -- since the admin
// page is static and unsigned, every live feed viewer is permanently
// that unauthenticated case, so src/relay.ts liveBroadcast enforces it
// by never sending gift wraps here at all, rather than trying to gate
// per-viewer the way NIP-42 gates real REQ subscriptions.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIVE_FEED_MAX_LIFETIME_MS, MAX_LIVE_FEED_CONNECTIONS } from "../src/limits";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectLiveFeed, connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("live feed", () => {
  it("sends a redacted kind/time/truncated-id notice for a newly stored event", async () => {
    const live = await connectLiveFeed();
    const conn = await connectRelay();

    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "hello live feed" });
    await publish(conn, event);

    const notice = await live.nextMessage();
    expect(notice.kind).toBe(1);
    expect(notice.created_at).toBe(event.created_at);
    expect(notice.id).toBe(event.id.slice(0, 8));
    // Never the full id, and never tags/content.
    expect(notice.id).not.toBe(event.id);
    expect(notice).not.toHaveProperty("tags");
    expect(notice).not.toHaveProperty("content");
    expect(notice).not.toHaveProperty("pubkey");

    conn.close();
    live.close();
  });

  it("never sends a notice for a gift wrap, even though it was stored", async () => {
    const live = await connectLiveFeed();
    const conn = await connectRelay();

    const stranger = randomKeypair();
    const giftWrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
      content: "encrypted seal goes here",
    });
    const [, , ok] = await publish(conn, giftWrap);
    expect(ok).toBe(true);

    // A second, ordinary event confirms the feed is alive and would have
    // delivered the gift wrap's notice first had one been sent -- ruling
    // out "nothing arrived because the feed is broken."
    const followUp = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "after the gift wrap" });
    await publish(conn, followUp);

    const notice = await live.nextMessage();
    expect(notice.kind).toBe(1);
    expect(notice.id).toBe(followUp.id.slice(0, 8));

    conn.close();
    live.close();
  });

  it("ignores messages sent on the live feed connection instead of treating them as NIP-01 frames", async () => {
    const live = await connectLiveFeed();
    // The live feed is push-only; sending it something shouldn't crash
    // the object or produce a nostr-shaped reply back.
    live.send(["REQ", "x", {}]);

    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "still works" });
    await publish(conn, event);

    const notice = await live.nextMessage();
    expect(notice.id).toBe(event.id.slice(0, 8));

    conn.close();
    live.close();
  });

  it("survives Durable Object eviction with the live feed WebSocket intact", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    const live = await connectLiveFeed();

    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets("live-feed")).toHaveLength(1);
    });

    await evictDurableObject(stub);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets("live-feed")).toHaveLength(1);
    });

    live.close();
  });
});

describe("live feed: connection cap", () => {
  it("rejects a new live feed connection once MAX_LIVE_FEED_CONNECTIONS is reached", async () => {
    const conns = await Promise.all(
      Array.from({ length: MAX_LIVE_FEED_CONNECTIONS }, () => connectLiveFeed()),
    );

    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const response = await stub.fetch("https://example.com/live", {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(503);
    expect(response.webSocket).toBeNull();

    for (const conn of conns) conn.close();
  });

  it("accepts a new connection again once one of the capped connections closes", async () => {
    const conns = await Promise.all(
      Array.from({ length: MAX_LIVE_FEED_CONNECTIONS }, () => connectLiveFeed()),
    );
    const first = conns[0]!;
    first.close();
    await first.closed;

    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const response = await stub.fetch("https://example.com/live", {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "test done");
    for (const conn of conns.slice(1)) conn.close();
  });
});

describe("live feed: server-enforced max lifetime", () => {
  it("closes a live feed connection past its max lifetime when the DO alarm fires, regardless of client behavior", async () => {
    const live = await connectLiveFeed();
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    // Backdate the connection's own attachment past the lifetime ceiling
    // and invoke the alarm directly -- equivalent to what a real
    // ctx.storage.setAlarm() wake would do, without a real test waiting
    // out LIVE_FEED_MAX_LIFETIME_MS of wall-clock time.
    await runInDurableObject(stub, async (instance: Relay, state) => {
      const ws = state.getWebSockets("live-feed")[0]!;
      ws.serializeAttachment({ connectedAt: Date.now() - LIVE_FEED_MAX_LIFETIME_MS - 1000 });
      await instance.alarm();
    });

    const { code } = await live.closed;
    expect(code).toBe(1000);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets("live-feed")).toHaveLength(0);
    });
  });

  it("leaves a connection well within its lifetime open when the alarm fires", async () => {
    const live = await connectLiveFeed();
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    await runInDurableObject(stub, async (instance: Relay) => {
      await instance.alarm();
    });

    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets("live-feed")).toHaveLength(1);
    });

    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "still connected" });
    await publish(conn, event);
    const notice = await live.nextMessage();
    expect(notice.id).toBe(event.id.slice(0, 8));

    conn.close();
    live.close();
  });

  it("reschedules the alarm for whichever remaining connection expires next", async () => {
    const a = await connectLiveFeed();
    const b = await connectLiveFeed();
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    await runInDurableObject(stub, async (instance: Relay, state) => {
      const sockets = state.getWebSockets("live-feed");
      expect(sockets).toHaveLength(2);
      // Backdate only one connection past the ceiling; the other stays
      // fresh, so the alarm handler should close one and reschedule for
      // the other rather than assuming "nothing left to track." Which of
      // a/b this lands on doesn't matter -- getWebSockets order isn't a
      // guarantee this test should depend on.
      sockets[0]!.serializeAttachment({ connectedAt: Date.now() - LIVE_FEED_MAX_LIFETIME_MS - 1000 });
      sockets[1]!.serializeAttachment({ connectedAt: Date.now() });
      await instance.alarm();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });

    const result = await Promise.race([
      a.closed.then((r) => ({ which: "a", ...r })),
      b.closed.then((r) => ({ which: "b", ...r })),
    ]);
    expect(result.code).toBe(1000);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets("live-feed")).toHaveLength(1);
    });

    a.close();
    b.close();
  });
});
