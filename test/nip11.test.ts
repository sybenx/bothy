// Unit coverage for buildRelayInfo's fallback chain (ROADMAP.md chunk 5:
// "Derive NIP-11 name and icon from the owner's kind 0 at claim time...
// Hardcoded fallbacks in code for when the lookup fails"). Pure-function
// test against src/nip11.ts directly -- no DO/socket round trip needed to
// exercise name/icon precedence.
import { describe, expect, it } from "vitest";
import { buildRelayInfo, DEFAULT_DESCRIPTION, DEFAULT_NAME } from "../src/nip11";

const NO_VARS = {} as unknown as Env;
const WITH_VARS = { RELAY_NAME: "dashboard-name", RELAY_ICON: "https://example.com/dashboard.png" } as unknown as Env;

describe("buildRelayInfo", () => {
  it("falls back to the hardcoded defaults with no profile and no dashboard vars", () => {
    const info = buildRelayInfo(NO_VARS, null);
    expect(info.name).toBe(DEFAULT_NAME);
    expect(info.description).toBe(DEFAULT_DESCRIPTION);
    expect(info.icon).toBeUndefined();
  });

  it("uses the RELAY_NAME/RELAY_ICON dashboard vars over the hardcoded default when there's no owner profile", () => {
    const info = buildRelayInfo(WITH_VARS, null);
    expect(info.name).toBe("dashboard-name");
    expect(info.icon).toBe("https://example.com/dashboard.png");
  });

  it("prefers the owner's kind-0 name/picture over the dashboard vars", () => {
    const info = buildRelayInfo(WITH_VARS, { name: "alice", picture: "https://example.com/alice.png" });
    expect(info.name).toBe("alice");
    expect(info.icon).toBe("https://example.com/alice.png");
  });

  it("falls through to the dashboard var when the profile has a null name", () => {
    const info = buildRelayInfo(WITH_VARS, { name: null, picture: null });
    expect(info.name).toBe("dashboard-name");
    expect(info.icon).toBe("https://example.com/dashboard.png");
  });

  it("omits icon entirely rather than setting it to an empty string", () => {
    const info = buildRelayInfo(NO_VARS, { name: "alice", picture: null });
    expect(info).not.toHaveProperty("icon");
  });
});
