import { reset } from "cloudflare:test";
import { afterEach } from "vitest";

// Storage isolation in this vitest plugin is per test FILE, not per test
// (https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).
// Protocol conformance tests share one relay pubkey and one DO instance
// within a file, so without this every test would see every other test's
// stored events. Call once per test file that writes events.
export function isolateStorage(): void {
  afterEach(async () => {
    await reset();
  });
}
