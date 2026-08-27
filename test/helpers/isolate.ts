import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

// Storage isolation in this vitest plugin is per test FILE, not per test
// (https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).
// Protocol conformance tests share one relay pubkey and one DO instance
// within a file, so without this every test would see every other test's
// stored events. Call once per test file that writes events.
//
// This used to need a second step: the /api/stats counts were memoized in
// memory (relay.ts statsCache), and `reset()` empties storage without
// going through any write path the object can observe, so a test that
// reset storage and then read /api/stats was answered from a cache
// describing the database it had just discarded. The cache now lives in
// storage itself (schema.ts `stats_snapshot`), for reasons that had
// nothing to do with tests -- the object hibernates between admin page
// visits and in-memory state does not survive it -- and `reset()` clears
// it along with everything else. There is no longer any cached stats
// state a test can fail to clear.
export function isolateStorage(): void {
  afterEach(async () => {
    await reset();
  });
}
