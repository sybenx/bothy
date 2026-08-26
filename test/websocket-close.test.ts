// RFC 6455 section 7.4.1 reserved close codes (src/relay.ts
// webSocketClose). 1005, 1006 and 1015 exist to describe how a connection
// ended and "MUST NOT be set as a status code in a Close frame by an
// endpoint" -- the runtime delivers them to webSocketClose for exactly
// that descriptive purpose, and echoing one straight back threw
// `Invalid WebSocket close code` on every abnormal disconnect. On a relay
// whose clients are browsers and phones, that is routine traffic, not an
// exceptional case: it accounted for the great majority of this Worker's
// logged errors.
//
// These call webSocketClose directly rather than closing a client socket
// with the code, and that is not a shortcut -- it is the only way to reach
// this state. A reserved code is equally illegal for a client to SEND, so
// no wire-level close can deliver one; the runtime synthesizes them when
// a peer disappears. Same documented category of exception as the
// direct-storage tests in docs/test-notes.md.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Relay } from "../src/relay";
import { isolateStorage } from "./helpers/isolate";
import { connectRelay } from "./helpers/socket";

isolateStorage();

const RESERVED = [
  { code: 1005, meaning: "no status code was present" },
  { code: 1006, meaning: "the peer vanished without a close frame" },
  { code: 1015, meaning: "the TLS handshake failed" },
];

describe("reserved WebSocket close codes", () => {
  for (const { code, meaning } of RESERVED) {
    it(`does not throw when the runtime reports ${code} (${meaning})`, async () => {
      const conn = await connectRelay();
      const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

      await runInDurableObject(stub, async (instance: Relay, state) => {
        const sockets = state.getWebSockets();
        expect(sockets.length).toBeGreaterThan(0);
        // Rejects with "Invalid WebSocket close code" if the handler
        // echoes the reserved code back instead of mapping it.
        await expect(instance.webSocketClose(sockets[0]!, code, "", false)).resolves.toBeUndefined();
      });

      conn.close();
    });
  }

  it("still passes a normal close code straight through", async () => {
    // The mapping must not swallow the ordinary case -- 1000 and the rest
    // of the sendable range are echoed as they always were.
    const conn = await connectRelay();
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    await runInDurableObject(stub, async (instance: Relay, state) => {
      const sockets = state.getWebSockets();
      await expect(
        instance.webSocketClose(sockets[0]!, 1000, "going away", false),
      ).resolves.toBeUndefined();
    });

    conn.close();
  });

  it("does not throw on a socket error either", async () => {
    // webSocketError closes with no code at all, which is already safe --
    // asserted so a future edit can't quietly give it the same bug.
    const conn = await connectRelay();
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    await runInDurableObject(stub, async (instance: Relay, state) => {
      const sockets = state.getWebSockets();
      await expect(instance.webSocketError(sockets[0]!, new Error("boom"))).resolves.toBeUndefined();
    });

    conn.close();
  });
});
