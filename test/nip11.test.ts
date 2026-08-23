// Unit coverage for buildRelayInfo's fallback chain (ROADMAP.md chunk 5:
// "Derive NIP-11 name and icon from the owner's kind 0 at claim time...
// Hardcoded fallbacks in code for when the lookup fails"). Pure-function
// test against src/nip11.ts directly -- no DO/socket round trip needed to
// exercise name/icon precedence. The routing describe at the bottom is
// the exception: it goes through the Worker's fetch handler (and so
// touches the DO for the owner profile), because the Accept-header match
// lives in src/index.ts, not nip11.ts.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { buildRelayInfo, DEFAULT_DESCRIPTION, DEFAULT_NAME } from "../src/nip11";
import { isolateStorage } from "./helpers/isolate";

isolateStorage();

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

// The Accept-header routing in src/index.ts. Clients commonly send
// compound Accept headers ("application/nostr+json, */*"); an exact
// equality match served those clients the admin page instead of the
// relay information document.
describe("NIP-11 routing", () => {
  async function fetchWithAccept(accept: string): Promise<Response> {
    return exports.default.fetch(
      new Request("https://example.com/", { headers: { Accept: accept } }),
    );
  }

  it("serves the NIP-11 document for a bare application/nostr+json Accept header", async () => {
    const response = await fetchWithAccept("application/nostr+json");
    expect(response.headers.get("Content-Type")).toBe("application/nostr+json");
    const body = (await response.json()) as { supported_nips: number[] };
    expect(body.supported_nips).toContain(11);
  });

  it("serves the NIP-11 document for a compound Accept header", async () => {
    const response = await fetchWithAccept("application/nostr+json, */*");
    expect(response.headers.get("Content-Type")).toBe("application/nostr+json");
    const body = (await response.json()) as { supported_nips: number[] };
    expect(body.supported_nips).toContain(11);
  });
});
