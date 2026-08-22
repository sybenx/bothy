// /api/stats and the static admin page (CLAUDE.md "Admin page";
// ROADMAP.md chunk 4).
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("GET /api/stats", () => {
  it("reports claimed status and event counts", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "counted" });
    await publish(conn, event);
    conn.close();

    const response = await exports.default.fetch("https://example.com/api/stats");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      claimed: boolean;
      totalEvents: number;
      events24h: number;
    };

    expect(body).toMatchObject({
      claimed: true,
      totalEvents: expect.any(Number),
      events24h: expect.any(Number),
      storageBytes: expect.any(Number),
      rowsWrittenEstimate24h: expect.any(Number),
    });
    expect(body.totalEvents).toBeGreaterThanOrEqual(1);
    expect(body.events24h).toBeGreaterThanOrEqual(1);
  });
});

describe("GET /api/profile", () => {
  it("rejects a request with no pubkey", async () => {
    const response = await exports.default.fetch("https://example.com/api/profile");
    expect(response.status).toBe(400);
  });
});

describe("admin page fallback", () => {
  it("serves something other than the old placeholder for an unmatched path", async () => {
    const response = await exports.default.fetch("https://example.com/");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("bothy");
  });
});
