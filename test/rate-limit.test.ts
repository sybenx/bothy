// Per-IP HTTP rate limiting (src/index.ts rateLimited, wrangler.jsonc's
// `ratelimits` block).
//
// Everything HTTP was previously defended by its per-request cost alone
// (CLAUDE.md "The budget": "nothing rate-limits the HTTP endpoints"),
// against callers who pay nothing per request. The per-IP throttle in
// relay.ts covers WebSocket *messages*, which is a different axis
// entirely -- it starts counting after the connection exists, so it never
// saw a connect-and-drop loop at all.
//
// The limit and window are enforced by the Cloudflare runtime from
// wrangler.jsonc, not by code in this repo, so nothing here asserts a
// number: these tests pin the *shape* -- that an allowance exists, that
// it is per address, that /api/profile's is strictly tighter than the
// rest, and that static assets are outside it. A test asserting "60"
// would be restating the config file rather than checking it.
//
// Every test uses its own CF-Connecting-IP. The allowance is keyed by
// address and shared across this whole file, so two tests on one address
// would be one test measured twice.
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { HTTP_RATE_LIMIT_PERIOD_SECONDS } from "../src/limits";
import { isolateStorage } from "./helpers/isolate";

isolateStorage();

// More than TWICE any allowance configured in wrangler.jsonc, and the
// factor of two is the point rather than headroom for its own sake. The
// window is fixed, not sliding, so a probe can straddle a rollover and
// have its count split across two windows -- 45 then 35 against a limit
// of 60 never trips it, and the test fails claiming the limiter is
// missing. At more than 2x the largest limit, one rollover still leaves a
// full allowance's worth of requests inside a single window. The early
// stop below means the common case never pays for the extra attempts.
const PROBE_ATTEMPTS = 150;

interface Allowance {
  admitted: number;
  refused: number;
  firstRefusal: Response | null;
}

// Refusals to observe past the first before stopping. Enough to catch a
// limiter that lets requests back through within the same window -- which
// would be a worse bug than one that never fired -- without paying for
// the whole remainder of the probe, since every request here is a real
// Durable Object round trip.
const REFUSALS_TO_CONFIRM = 5;

// Counts how many requests an address gets through before the first 429.
// Every admission is asserted to precede every refusal. That makes
// `admitted` the allowance in the ordinary case, but not a number to
// assert against directly: a probe that straddles a window rollover is
// admitted more than the configured limit before the first refusal, which
// is correct behaviour for a fixed window and would be a flaky failure for
// any test that pinned it. Only comparisons and "greater than zero" are
// safe to build on.
async function measureAllowance(
  path: string,
  ip: string,
  init: RequestInit = {},
): Promise<Allowance> {
  let admitted = 0;
  let refused = 0;
  let firstRefusal: Response | null = null;
  for (let i = 0; i < PROBE_ATTEMPTS && refused < REFUSALS_TO_CONFIRM; i++) {
    const response = await exports.default.fetch(
      new Request(`https://example.com${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), "CF-Connecting-IP": ip },
      }),
    );
    if (response.status === 429) {
      refused++;
      if (firstRefusal === null) firstRefusal = response.clone();
    } else {
      // Admitted requests count regardless of what they answered: a 404
      // from a claimed relay's /api/profile is still a request the
      // limiter let through, which is what is being measured.
      admitted++;
      expect(refused).toBe(0);
    }
    await response.arrayBuffer();
  }
  return { admitted, refused, firstRefusal };
}

describe("per-IP HTTP rate limiting", () => {
  it("admits an allowance, then refuses the rest of the window with 429", async () => {
    const { admitted, refused, firstRefusal } = await measureAllowance("/api/stats", "203.0.113.1");

    expect(admitted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);

    // Retry-After is the difference between a client backing off once and
    // a client spending the rest of its own allowance discovering the
    // window length by trial.
    expect(firstRefusal?.headers.get("Retry-After")).toBe(String(HTTP_RATE_LIMIT_PERIOD_SECONDS));
    const body = (await firstRefusal!.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toContain("rate limited");
    expect(body.retryAfterSeconds).toBe(HTTP_RATE_LIMIT_PERIOD_SECONDS);
  });

  it("keys the allowance by address, so one caller cannot spend another's", async () => {
    const exhausted = await measureAllowance("/api/stats", "203.0.113.2");
    expect(exhausted.refused).toBeGreaterThan(0);

    const other = await exports.default.fetch(
      new Request("https://example.com/api/stats", {
        headers: { "CF-Connecting-IP": "203.0.113.3" },
      }),
    );
    expect(other.status).toBe(200);
  });

  it("shares one allowance across every path that wakes the Durable Object", async () => {
    // The guarantee worth having is "this address cannot wake the object
    // more than N times a minute". Per-path counters would multiply N by
    // the number of paths, so /api/stats exhausting the budget must also
    // close the NIP-11 document and the WebSocket upgrade to that address
    // -- they are one counter, deliberately (wrangler.jsonc).
    const ip = "203.0.113.4";
    expect((await measureAllowance("/api/stats", ip)).refused).toBeGreaterThan(0);

    const nip11 = await exports.default.fetch(
      new Request("https://example.com/", {
        headers: { Accept: "application/nostr+json", "CF-Connecting-IP": ip },
      }),
    );
    expect(nip11.status).toBe(429);

    const upgrade = await exports.default.fetch(
      new Request("https://example.com/", {
        headers: { Upgrade: "websocket", "CF-Connecting-IP": ip },
      }),
    );
    expect(upgrade.status).toBe(429);
  });

  it("bounds WebSocket upgrades, which relay.ts's per-message throttle never sees", async () => {
    // An upgrade wakes the Durable Object and spends one of the day's
    // 100,000 requests before a single protocol message has been sent, so
    // a connect-and-drop loop cost the relay real budget while staying
    // permanently below the per-message throttle. Bounding connects is a
    // separate axis from bounding messages, and this is the one that was
    // missing.
    const { admitted, refused } = await measureAllowance("/", "203.0.113.5", {
      headers: { Upgrade: "websocket" },
    });
    expect(admitted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("gives /api/profile a strictly tighter allowance than the rest", async () => {
    // Not a tidier number for its own sake: /api/profile is the only
    // endpoint whose cost lands on infrastructure that is not ours (two
    // outbound WebSockets to relay.damus.io and nos.lol per uncached
    // miss, src/profile-lookup.ts), so it is the one place where the
    // relay can be made into an amplifier. That is why it has its own
    // namespace rather than sharing the counter above.
    const profile = await measureAllowance("/api/profile?pubkey=" + "a".repeat(64), "203.0.113.6");
    const api = await measureAllowance("/api/stats", "203.0.113.7");

    expect(profile.refused).toBeGreaterThan(0);
    expect(profile.admitted).toBeLessThan(api.admitted);
  });

  it("never rate limits the static admin page", async () => {
    // public/ is served from env.ASSETS and never touches the Durable
    // Object; static assets are free and unmetered on Workers Free, so
    // they are the one path with nothing to protect. Throttling them
    // would spend the guard on the page an operator loads to find out
    // why the relay is refusing them.
    const ip = "203.0.113.8";
    expect((await measureAllowance("/api/stats", ip)).refused).toBeGreaterThan(0);

    const page = await exports.default.fetch(
      new Request("https://example.com/", { headers: { "CF-Connecting-IP": ip } }),
    );
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("bothy");
  });
});
