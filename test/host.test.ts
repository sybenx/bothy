// src/host.ts -- the deployment's own-host detection backfill.ts uses to
// skip self-seeding (see test/backfill.test.ts for the seedBackfillRelays
// integration coverage). normalizeHost is pure, so it's exercised
// directly here rather than through a DO.
import { describe, expect, it } from "vitest";
import { normalizeHost } from "../src/host";

describe("normalizeHost", () => {
  it("extracts a lowercased host from a full relay URL", () => {
    expect(normalizeHost("wss://Relay.Example.com")).toBe("relay.example.com");
  });

  it("ignores a trailing slash", () => {
    expect(normalizeHost("wss://relay.example.com/")).toBe("relay.example.com");
  });

  it("treats a bare host (no scheme) the same as a full URL", () => {
    expect(normalizeHost("relay.example.com")).toBe(normalizeHost("wss://relay.example.com"));
  });

  it("preserves a non-default port", () => {
    expect(normalizeHost("wss://relay.example.com:8443/")).toBe("relay.example.com:8443");
  });

  it("returns null for something that isn't a URL or a host at all", () => {
    expect(normalizeHost("not a url")).toBeNull();
  });
});
