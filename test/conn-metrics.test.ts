import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ConnMetricsSnapshot } from "../src/conn-metrics";
import { connectRelay } from "./helpers/socket";

// src/conn-metrics.ts: why connections end, on /api/stats. Asserted as
// growth rather than exact counts -- the counters are module memory and
// every other test file's connections land in them too.

async function connections(): Promise<ConnMetricsSnapshot> {
  const stats = (await (await SELF.fetch("https://example.com/api/stats")).json()) as {
    connections: ConnMetricsSnapshot;
  };
  return stats.connections;
}

async function untilClosed(predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("close was never recorded");
}

describe("connection diagnostics", () => {
  it("counts a refused REQ by category, with numbers masked", async () => {
    const before = (await connections()).refusals;
    const conn = await connectRelay();
    conn.send(["REQ", "dms", { kinds: [1059] }]);
    await conn.nextMessage(); // AUTH
    await conn.nextMessage(); // CLOSED
    conn.close();

    const key = "auth-required: authentication required to read gift wraps";
    expect((await connections()).refusals[key] ?? 0).toBe((before[key] ?? 0) + 1);
  });

  it("records a closed connection's code, lifetime and REQ count", async () => {
    const before = await connections();
    const conn = await connectRelay();
    conn.send(["REQ", "s", { kinds: [1], limit: 1 }]);
    while ((await conn.nextMessage())[0] !== "EOSE");
    conn.close();

    await untilClosed(async () => {
      const after = await connections();
      return (after.lifetimes["<15s"] ?? 0) > (before.lifetimes["<15s"] ?? 0);
    });
    const after = await connections();
    expect(after.reqsPerConnection["1-4"] ?? 0).toBe((before.reqsPerConnection["1-4"] ?? 0) + 1);
    const nostrCloses = (s: ConnMetricsSnapshot): number =>
      Object.entries(s.closeCodes)
        .filter(([k]) => k.startsWith("nostr:"))
        .reduce((n, [, v]) => n + v, 0);
    expect(nostrCloses(after)).toBe(nostrCloses(before) + 1);
  });
});
