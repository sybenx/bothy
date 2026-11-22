// The `network` policy's list, Worker-side half (src/network.ts has the
// rest). Each hourly tick asks the relay which follows' contact lists it
// needs, fetches them from limits.ts NETWORK_RELAYS in one REQ per relay, and
// hands back whatever came, unverified: the relay checks every signature.
// Here because an outbound WebSocket would pin the Durable Object in
// memory (backfill-worker.ts gives the details). Does nothing unless the
// policy in force is `network`.
import { fetchPage } from "./backfill-worker";
import { BACKFILL_FETCH_TIMEOUT_MS, NETWORK_RELAYS } from "./limits";
import { relayStub } from "./relay-stub";

export async function runNetworkTick(env: Env): Promise<void> {
  const stub = relayStub(env);
  const work = await stub.getNetworkWork();
  if (work === null || work.authors.length === 0) return;
  const pages = await Promise.all(
    NETWORK_RELAYS.map((url) =>
      fetchPage(url, { kinds: [3], authors: work.authors }, BACKFILL_FETCH_TIMEOUT_MS),
    ),
  );
  await stub.ingestNetworkLists(
    work.authors,
    pages.flatMap((page) => page.events),
  );
}
