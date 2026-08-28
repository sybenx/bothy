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
// describing the database it had just discarded. Those counts moved into
// storage (`stats_snapshot`) for reasons that had nothing to do with
// tests, and are maintained counters now
// (schema.ts `maintained_counts`/`event_hour_counts`) for reasons that
// had nothing to do with tests either. Both live where `reset()` reaches,
// so there is no cached stats state a test can fail to clear.
//
// One consequence worth knowing before writing a fixture: `reset()`
// re-seeds the counters from an empty table, so they start at zero with
// everything else. A test that inserts into `events` directly rather than
// publishing over the wire bypasses insertEventRow and leaves the
// counters behind -- correct behaviour, and what
// storage.ts auditMaintainedCounts would log. Assert counts against
// events you published, not against rows you seeded.
export function isolateStorage(): void {
  afterEach(async () => {
    await reset();
  });
}
