// Chunk 1's "Done when" criteria (ROADMAP.md) requires a hibernation test
// that confirms the Relay object becomes eligible to hibernate after the
// last message. evictDurableObject() tears down the in-memory instance
// while (by default) hibernating rather than closing any accepted
// WebSockets -- if this object were using ws.accept() instead of
// ctx.acceptWebSocket(), the socket would not survive eviction, and
// re-fetching its state from storage would fail this assertion.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Relay } from "../src/relay";

describe("hibernation", () => {
  it("survives eviction with the accepted WebSocket intact", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);

    const response = await stub.fetch("https://example.com/", {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (!socket) throw new Error("expected a websocket response");
    socket.accept();

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      expect(state.getWebSockets()).toHaveLength(1);
    });

    // Default eviction options hibernate rather than close accepted
    // sockets -- this is the behaviour being asserted.
    await evictDurableObject(stub);

    await runInDurableObject(stub, async (_instance: Relay, state) => {
      expect(state.getWebSockets()).toHaveLength(1);
    });

    socket.close(1000, "test done");
  });
});
