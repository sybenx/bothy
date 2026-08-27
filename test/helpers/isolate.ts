import { env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach } from "vitest";
import type { Relay } from "../../src/relay";

// Storage isolation in this vitest plugin is per test FILE, not per test
// (https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).
// Protocol conformance tests share one relay pubkey and one DO instance
// within a file, so without this every test would see every other test's
// stored events. Call once per test file that writes events.
//
// Also clears the Durable Object's in-memory /api/stats cache
// (relay.ts statsCache). `reset()` empties storage without going through
// any write path the object can observe, so a test that resets and then
// reads /api/stats would otherwise be answered from a cache describing
// the database it just discarded. Nothing in production clears the cache
// this way -- it expires on its own after STATS_CACHE_TTL_MS.
export function isolateStorage(): void {
  afterEach(async () => {
    await reset();
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, (instance: Relay) => instance.resetStatsCache());
  });
}
