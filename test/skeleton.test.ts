// Smoke tests for chunk 1's "Done when" criteria (see ROADMAP.md):
// NIP-11 returns valid JSON, and the relay accepts and holds a WebSocket
// connection. Full NIP-01 protocol conformance is chunk 2/3's job, not
// this file's -- do not add protocol assertions here.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEFAULT_DESCRIPTION, DEFAULT_NAME } from "../src/nip11";

describe("NIP-11", () => {
  it("returns a valid relay information document", async () => {
    const response = await exports.default.fetch("https://example.com/", {
      headers: { Accept: "application/nostr+json" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/nostr+json");

    const body = await response.json();
    // The global test env's OWNER_PUBKEY binding (vitest.config.ts) skips
    // claim-time storage entirely, so there's no owner profile to derive
    // name/icon from here -- falls back to the hardcoded defaults, since
    // no RELAY_NAME/RELAY_DESCRIPTION dashboard var is set either.
    expect(body).toMatchObject({
      name: DEFAULT_NAME,
      description: DEFAULT_DESCRIPTION,
      supported_nips: expect.arrayContaining([11]),
    });
  });
});

describe("WebSocket upgrade", () => {
  it("holds an open connection to the relay Durable Object", async () => {
    const response = await exports.default.fetch("https://example.com/", {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeTruthy();

    socket!.accept();
    socket!.close(1000, "test done");
  });
});
