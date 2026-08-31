// The "a newer bothy exists" check (src/upstream-version.ts) and the two
// fields it adds to /api/stats.
//
// Every test here stubs global fetch. The Worker under test runs in the
// same isolate as the test file ("cloudflare:test"'s own note on SELF),
// so a stub installed here is what the module calls -- which is what
// makes these assertions about parsing, caching and coalescing rather
// than about whether githubusercontent happened to answer. Nothing in
// this file touches the network.
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isolateStorage } from "./helpers/isolate";
import worker from "../src/index";
import { version } from "../package.json";
import {
  UPSTREAM_PACKAGE_JSON_URL,
  cachedUpstreamVersion,
  describeUpdate,
  isNewerVersion,
  resetUpstreamVersionCache,
  updateCheckEnabled,
} from "../src/upstream-version";
import { UPSTREAM_VERSION_MAX_BYTES } from "../src/limits";

isolateStorage();

// Counts calls as well as answering them: the cache and the in-flight
// coalescing are only observable as "how many times did this run".
function stubFetch(handler: () => Response | Promise<Response>): { calls: () => number } {
  let calls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    expect(String(input)).toBe(UPSTREAM_PACKAGE_JSON_URL);
    calls++;
    return handler();
  });
  return { calls: () => calls };
}

function packageJson(v: unknown): Response {
  return new Response(JSON.stringify({ name: "bothy", version: v }), {
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  resetUpstreamVersionCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetUpstreamVersionCache();
});

describe("version comparison", () => {
  it("is true only when the candidate is strictly ahead", () => {
    expect(isNewerVersion("0.12.1", "0.12.0")).toBe(true);
    expect(isNewerVersion("0.13.0", "0.12.9")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.99.99")).toBe(true);

    expect(isNewerVersion("0.12.0", "0.12.0")).toBe(false);
    expect(isNewerVersion("0.12.0", "0.12.1")).toBe(false);
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(false);
  });

  it("compares each component as a number, not as text", () => {
    // The failure this pins: string ordering puts "0.9.0" after "0.10.0",
    // which would tell every relay on 0.10 that it was behind.
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.2.10", "0.2.9")).toBe(true);
  });

  it("refuses to guess about anything that is not three numbers", () => {
    expect(isNewerVersion("v0.13.0", "0.12.0")).toBe(false);
    expect(isNewerVersion("0.13", "0.12.0")).toBe(false);
    expect(isNewerVersion("latest", "0.12.0")).toBe(false);
    expect(isNewerVersion("0.13.0", "not-a-version")).toBe(false);
    expect(isNewerVersion("", "0.12.0")).toBe(false);
  });

  it("accepts a pre-release suffix and compares the numbers before it", () => {
    expect(isNewerVersion("0.13.0-rc.1", "0.12.0")).toBe(true);
    expect(isNewerVersion("0.12.0-rc.1", "0.12.0")).toBe(false);
  });
});

describe("describeUpdate", () => {
  it("reports no answer as no answer, never as up to date", () => {
    expect(describeUpdate(null, "0.12.0")).toEqual({
      latestVersion: null,
      updateAvailable: false,
    });
  });

  it("carries the upstream version through whether or not it is newer", () => {
    expect(describeUpdate("0.13.0", "0.12.0")).toEqual({
      latestVersion: "0.13.0",
      updateAvailable: true,
    });
    expect(describeUpdate("0.12.0", "0.12.0")).toEqual({
      latestVersion: "0.12.0",
      updateAvailable: false,
    });
    // A relay running ahead of upstream -- an unreleased local change --
    // is a normal state, not something to nag about.
    expect(describeUpdate("0.12.0", "0.13.0")).toEqual({
      latestVersion: "0.12.0",
      updateAvailable: false,
    });
  });
});

describe("the opt-out", () => {
  // Cast through unknown: Env's generated half (the DO namespace, the
  // assets binding) is irrelevant to this function and constructing it
  // would say nothing about what is being tested.
  const withCheck = (value?: string): boolean =>
    updateCheckEnabled({ UPDATE_CHECK: value } as unknown as Env);

  it("is on unless the variable says exactly off", () => {
    expect(withCheck(undefined)).toBe(true);
    expect(withCheck("")).toBe(true);
    // The shape every optional cap in this project shares: only one exact
    // value disables, so no truthy or plausible-looking value can turn a
    // behaviour off by accident.
    expect(withCheck("false")).toBe(true);
    expect(withCheck("no")).toBe(true);
    expect(withCheck("0")).toBe(true);
  });

  it("accepts off in any case, with surrounding space", () => {
    expect(withCheck("off")).toBe(false);
    expect(withCheck("OFF")).toBe(false);
    expect(withCheck("  off  ")).toBe(false);
  });
});

describe("fetching upstream's version", () => {
  it("reads `version` out of upstream's package.json", async () => {
    stubFetch(() => packageJson("9.9.9"));
    expect(await cachedUpstreamVersion()).toBe("9.9.9");
  });

  it("fetches once per isolate and serves the rest from cache", async () => {
    const fetched = stubFetch(() => packageJson("9.9.9"));
    expect(await cachedUpstreamVersion()).toBe("9.9.9");
    expect(await cachedUpstreamVersion()).toBe("9.9.9");
    expect(await cachedUpstreamVersion()).toBe("9.9.9");
    expect(fetched.calls()).toBe(1);
  });

  it("coalesces concurrent misses into one request", async () => {
    // Without this the cache is useless against the burst it exists for:
    // N simultaneous requests all miss, all fetch, and only then all
    // write the same entry.
    const fetched = stubFetch(() => packageJson("9.9.9"));
    const answers = await Promise.all([
      cachedUpstreamVersion(),
      cachedUpstreamVersion(),
      cachedUpstreamVersion(),
      cachedUpstreamVersion(),
    ]);
    expect(answers).toEqual(["9.9.9", "9.9.9", "9.9.9", "9.9.9"]);
    expect(fetched.calls()).toBe(1);
  });

  it("answers null rather than throwing when the request fails", async () => {
    stubFetch(() => Promise.reject(new Error("network down")));
    expect(await cachedUpstreamVersion()).toBeNull();
  });

  it("answers null on a non-200, on malformed JSON, and on a missing version", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));
    expect(await cachedUpstreamVersion()).toBeNull();

    resetUpstreamVersionCache();
    stubFetch(() => new Response("{ not json"));
    expect(await cachedUpstreamVersion()).toBeNull();

    resetUpstreamVersionCache();
    stubFetch(() => packageJson(undefined));
    expect(await cachedUpstreamVersion()).toBeNull();

    resetUpstreamVersionCache();
    stubFetch(() => packageJson(13));
    expect(await cachedUpstreamVersion()).toBeNull();
  });

  it("rejects a version string it cannot compare", async () => {
    // Better to say nothing than to render "vwhatever available" in the
    // admin page's footer.
    stubFetch(() => packageJson("main"));
    expect(await cachedUpstreamVersion()).toBeNull();
  });

  it("refuses a body far larger than a package.json", async () => {
    // A URL that has stopped being a small JSON file must not be able to
    // pull an unbounded body into the isolate.
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ version: "9.9.9", padding: "x".repeat(UPSTREAM_VERSION_MAX_BYTES) }),
        ),
    );
    expect(await cachedUpstreamVersion()).toBeNull();
  });

  it("caches a failure too, so an outage cannot become a request per page load", async () => {
    const fetched = stubFetch(() => Promise.reject(new Error("network down")));
    expect(await cachedUpstreamVersion()).toBeNull();
    expect(await cachedUpstreamVersion()).toBeNull();
    expect(fetched.calls()).toBe(1);
  });
});

describe("GET /api/stats", () => {
  // The worker is called directly rather than through
  // `exports.default.fetch` so this file can choose its own UPDATE_CHECK:
  // the suite's binding (vitest.config.ts) turns the check off so no other
  // test reaches the network, and these tests are the ones that need it on.
  // "" rather than a value with meaning -- only the exact string "off"
  // disables, so an empty value is indistinguishable from unset.
  async function stats(
    updateCheck = "",
  ): Promise<{ latestVersion: string | null; updateAvailable: boolean }> {
    const response = await worker.fetch(new Request("https://example.com/api/stats"), {
      ...env,
      UPDATE_CHECK: updateCheck,
    } as Env);
    expect(response.status).toBe(200);
    return (await response.json()) as { latestVersion: string | null; updateAvailable: boolean };
  }

  it("reports a newer upstream release", async () => {
    stubFetch(() => packageJson("99.0.0"));
    expect(await stats()).toMatchObject({ latestVersion: "99.0.0", updateAvailable: true });
  });

  it("reports no update when upstream is the version this relay runs", async () => {
    stubFetch(() => packageJson(version));
    expect(await stats()).toMatchObject({ latestVersion: version, updateAvailable: false });
  });

  it("makes no request at all when the check is turned off", async () => {
    // The whole of what UPDATE_CHECK=off promises: not a quieter notice,
    // but no outbound request from this relay to GitHub, ever.
    const fetched = stubFetch(() => packageJson("99.0.0"));
    expect(await stats("off")).toMatchObject({ latestVersion: null, updateAvailable: false });
    expect(fetched.calls()).toBe(0);
  });

  it("still answers, with no notice, when the check fails", async () => {
    // The whole point of the placement in index.ts: this is a courtesy
    // notice on the page that reports the relay's own health, and it must
    // not be able to take that page down.
    stubFetch(() => Promise.reject(new Error("network down")));
    expect(await stats()).toMatchObject({ latestVersion: null, updateAvailable: false });
  });
});
