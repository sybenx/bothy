// Unit coverage for the relay identity chain (src/nip11.ts): environment
// variable, then stored value (NIP-86 change*), then the owner's kind-0,
// then the hardcoded default. Pure-function tests against src/nip11.ts
// directly -- no DO/socket round trip needed to exercise precedence. The
// routing describe at the bottom is the exception: it goes through the
// Worker's fetch handler (and so touches the DO), because the
// Accept-header match lives in src/index.ts, not nip11.ts.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  buildRelayInfo,
  DEFAULT_DESCRIPTION,
  DEFAULT_NAME,
  resolveDescription,
  resolveIcon,
  resolveName,
} from "../src/nip11";
import {
  MAX_CREATED_AT_FUTURE_SECONDS,
  MAX_EVENT_BYTES,
  MAX_FILTER_LIMIT,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "../src/limits";
import type { RelaySettings } from "../src/storage";
import { version } from "../package.json";
import { isolateStorage } from "./helpers/isolate";

isolateStorage();

const NO_VARS = {} as unknown as Env;
const WITH_VARS = {
  RELAY_NAME: "env-name",
  RELAY_DESCRIPTION: "env-description",
  RELAY_ICON: "https://example.com/env.png",
} as unknown as Env;

// Nothing written by the management API -- the state a relay is in until
// someone calls a change* method.
const NO_SETTINGS: RelaySettings = { name: null, description: null, icon: null };
const STORED: RelaySettings = {
  name: "stored-name",
  description: "stored-description",
  icon: "https://example.com/stored.png",
};

const PROFILE = {
  name: "Aaron",
  picture: "https://example.com/aaron.png",
  about: "kind-0 about text",
  website: "https://example.com/aaron",
};

const OWNER_HEX = "a".repeat(64);
const RELAY_HEX = "c".repeat(64);

describe("resolveName", () => {
  it("falls back to the hardcoded default with nothing set anywhere", () => {
    expect(resolveName(NO_VARS, NO_SETTINGS, null)).toBe(DEFAULT_NAME);
  });

  it("derives a possessive name from the owner's kind-0, over the hardcoded default", () => {
    expect(resolveName(NO_VARS, NO_SETTINGS, PROFILE)).toBe("Aaron's relay");
  });

  it("adds \"'s\" to a kind-0 name already ending in s rather than a bare apostrophe", () => {
    expect(resolveName(NO_VARS, NO_SETTINGS, { ...PROFILE, name: "Chris" })).toBe("Chris's relay");
  });

  it("prefers a stored value over the owner's kind-0, and uses it verbatim", () => {
    // A stored name is a chosen relay name, not a derived one -- no
    // possessive.
    expect(resolveName(NO_VARS, STORED, PROFILE)).toBe("stored-name");
  });

  it("prefers the environment variable over a stored value", () => {
    expect(resolveName(WITH_VARS, STORED, PROFILE)).toBe("env-name");
  });

  it("uses the environment variable verbatim, with no possessive", () => {
    expect(resolveName(WITH_VARS, NO_SETTINGS, null)).toBe("env-name");
  });

  it("falls through to the next rung when a stored value is cleared", () => {
    // The empty-string clear (storage.ts setRelaySetting) deletes the
    // row, so a cleared name reads back as null and the kind-0 rung wins
    // again -- this is what makes changerelayname("") reversible.
    expect(resolveName(NO_VARS, { ...STORED, name: null }, PROFILE)).toBe("Aaron's relay");
  });

  it("falls through a kind-0 with no name at all", () => {
    expect(resolveName(NO_VARS, NO_SETTINGS, { ...PROFILE, name: null })).toBe(DEFAULT_NAME);
  });
});

describe("resolveDescription", () => {
  it("falls back to the hardcoded default with nothing set anywhere", () => {
    expect(resolveDescription(NO_VARS, NO_SETTINGS, null)).toBe(DEFAULT_DESCRIPTION);
  });

  it("uses the owner's kind-0 about over the hardcoded default", () => {
    expect(resolveDescription(NO_VARS, NO_SETTINGS, PROFILE)).toBe("kind-0 about text");
  });

  it("prefers a stored value over the owner's kind-0", () => {
    expect(resolveDescription(NO_VARS, STORED, PROFILE)).toBe("stored-description");
  });

  it("prefers the environment variable over a stored value", () => {
    expect(resolveDescription(WITH_VARS, STORED, PROFILE)).toBe("env-description");
  });

  it("falls through to the kind-0 rung when the stored value is cleared", () => {
    expect(resolveDescription(NO_VARS, { ...STORED, description: null }, PROFILE)).toBe("kind-0 about text");
  });
});

describe("resolveIcon", () => {
  it("is null with nothing set anywhere -- there is no hardcoded icon", () => {
    expect(resolveIcon(NO_VARS, NO_SETTINGS, null)).toBeNull();
  });

  it("uses the owner's kind-0 picture when nothing outranks it", () => {
    expect(resolveIcon(NO_VARS, NO_SETTINGS, PROFILE)).toBe("https://example.com/aaron.png");
  });

  it("prefers a stored value over the owner's kind-0", () => {
    expect(resolveIcon(NO_VARS, STORED, PROFILE)).toBe("https://example.com/stored.png");
  });

  it("prefers the environment variable over a stored value", () => {
    expect(resolveIcon(WITH_VARS, STORED, PROFILE)).toBe("https://example.com/env.png");
  });

  it("falls through to the kind-0 rung when the stored value is cleared", () => {
    expect(resolveIcon(NO_VARS, { ...STORED, icon: null }, PROFILE)).toBe("https://example.com/aaron.png");
  });
});

describe("buildRelayInfo", () => {
  it("falls back to the hardcoded defaults with no profile, no stored values and no env vars", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, null, null, RELAY_HEX);
    expect(info.name).toBe(DEFAULT_NAME);
    expect(info.description).toBe(DEFAULT_DESCRIPTION);
    expect(info.icon).toBeUndefined();
  });

  it("carries the whole chain through, not just the name", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, PROFILE, null, RELAY_HEX);
    expect(info.name).toBe("Aaron's relay");
    expect(info.description).toBe("kind-0 about text");
    expect(info.icon).toBe("https://example.com/aaron.png");
  });

  it("omits icon entirely rather than setting it to an empty string", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, { ...PROFILE, picture: null }, null, RELAY_HEX);
    expect(info).not.toHaveProperty("icon");
  });

  it("advertises software as a URL to the upstream project and version from package.json", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, null, null, RELAY_HEX);
    expect(info.software).toBe("https://github.com/sybenx/bothy");
    expect(info.version).toBe(version);
  });

  it("advertises NIP-86 now that the management API exists", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, null, null, RELAY_HEX) as { supported_nips: number[] };
    expect(info.supported_nips).toContain(86);
  });

  it("advertises a limitation object mirroring the enforced limits.ts constants", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, null, null, RELAY_HEX) as { limitation: Record<string, unknown> };
    expect(info.limitation).toEqual({
      restricted_writes: true,
      max_subscriptions: MAX_SUBSCRIPTIONS_PER_CONNECTION,
      max_limit: MAX_FILTER_LIMIT,
      default_limit: MAX_FILTER_LIMIT,
      created_at_upper_limit: MAX_CREATED_AT_FUTURE_SECONDS,
      max_message_length: MAX_EVENT_BYTES,
    });
  });

  // max_message_length is the one field in the block that can be absent:
  // the size cap is the only advertised limit an operator can turn off
  // (limits.ts MAX_EVENT_BYTES), and the block's rule is that it names
  // only what is enforced. Advertising 64KB on a relay that no longer
  // enforces it would tell clients the opposite of the truth.
  it("omits max_message_length entirely when the size cap is disabled", () => {
    const disabled = { MAX_EVENT_BYTES: "off" } as unknown as Env;
    const info = buildRelayInfo(disabled, NO_SETTINGS, null, null, RELAY_HEX) as { limitation: Record<string, unknown> };
    expect("max_message_length" in info.limitation).toBe(false);
  });

  it("advertises a raised size cap rather than the default", () => {
    const raised = { MAX_EVENT_BYTES: "262144" } as unknown as Env;
    const info = buildRelayInfo(raised, NO_SETTINGS, null, null, RELAY_HEX) as { limitation: Record<string, unknown> };
    expect(info.limitation.max_message_length).toBe(262144);
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

// `pubkey` and `contact` -- the two fields that let a client fetching
// this document tell who runs the relay. Without them it could read the
// operator's name and see their picture while having no way to identify
// them as a nostr user or reach them at all.
describe("buildRelayInfo identity fields", () => {
  it("publishes the owner pubkey when the relay is claimed", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, PROFILE, OWNER_HEX, RELAY_HEX);
    expect(info.pubkey).toBe(OWNER_HEX);
  });

  it("publishes the relay's own pubkey even while unclaimed, unlike the owner's", () => {
    // `self` is generated at schema-init time (schema.ts
    // seedRelayIdentity), independent of claim status -- there is no
    // "unknown" state for it the way there is for the owner's pubkey.
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, null, null, RELAY_HEX);
    expect(info.self).toBe(RELAY_HEX);
    expect(info).not.toHaveProperty("pubkey");
  });

  it("omits pubkey entirely while unclaimed rather than emitting an empty one", () => {
    // Not a degenerate case: this is the normal state of a freshly
    // deployed relay, and an empty string would assert an owner exists.
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, null, null, RELAY_HEX);
    expect(info).not.toHaveProperty("pubkey");
  });

  it("takes contact from the owner's kind-0 website", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, PROFILE, OWNER_HEX, RELAY_HEX);
    expect(info.contact).toBe("https://example.com/aaron");
  });

  it("omits contact when the kind-0 carries no website", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, { ...PROFILE, website: null }, OWNER_HEX, RELAY_HEX);
    expect(info).not.toHaveProperty("contact");
  });

  it("omits contact entirely when there is no profile at all", () => {
    const info = buildRelayInfo(NO_VARS, NO_SETTINGS, null, OWNER_HEX, RELAY_HEX);
    expect(info).not.toHaveProperty("contact");
  });

  it("does not let a stored relay name or env var stand in for a contact", () => {
    // contact has no environment-variable or NIP-86 rung, unlike
    // name/description/icon -- see resolveContact. A relay whose name is
    // overridden still reports the owner's own contact, or none.
    const info = buildRelayInfo(WITH_VARS, STORED, { ...PROFILE, website: null }, OWNER_HEX, RELAY_HEX);
    expect(info).not.toHaveProperty("contact");
  });
});
