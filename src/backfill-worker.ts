// One-shot backfill (ROADMAP.md chunk 7), Worker-side half. Every
// outbound WebSocket this feature ever opens lives here, in the
// stateless Worker's scheduled() handler -- never inside the Relay
// Durable Object. CLAUDE.md "The budget": "an outbound connection keeps
// the DO in memory for up to 15 minutes even with no traffic," which is
// exactly the cost hibernation exists to avoid. The DO's role is limited
// to answering "what's the state" (getBackfillState) and "here's a page
// I already fetched, please store it" (discoverBackfillRelays,
// ingestBackfillPage) -- both plain RPC calls, the same mechanism
// src/index.ts already uses for claim()/getStats(), not fetch().
import { BACKFILL_FETCH_TIMEOUT_MS, BACKFILL_PAGE_SIZE } from "./limits";
import { RELAY_LIST_KIND, writeRelaysFrom } from "./nostr";
import { WELL_KNOWN_RELAYS } from "./profile-lookup";
import { relayStub } from "./relay-stub";

export interface FetchPageResult {
  events: unknown[];
  // True only when an actual EOSE frame arrived for this subscription --
  // false for a timeout, a socket error, a socket close, and the
  // WebSocket constructor throwing. backfill.ts applyBackfillPage's
  // exhaustion rule depends on this distinction: a timed-out or failed
  // fetch can look exactly like a short page (few or zero events
  // collected before termination), but only a real EOSE means the relay
  // actually told us it has nothing more.
  eose: boolean;
}

// Collects every EVENT payload a relay sends for one REQ until EOSE or a
// timeout, then closes the socket -- same short-lived-connection shape as
// profile-lookup.ts's queryOne, just collecting many results instead of
// resolving on the first one, since a backfill page is the whole point.
function fetchPage(relayUrl: string, filter: Record<string, unknown>, timeoutMs: number): Promise<FetchPageResult> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    let settled = false;
    let eose = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
      resolve({ events, eose });
    };

    let socket: WebSocket;
    try {
      socket = new WebSocket(relayUrl);
    } catch {
      resolve({ events: [], eose: false });
      return;
    }

    const timer = setTimeout(done, timeoutMs);
    const subId = "backfill";

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", subId, filter]));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const frame = JSON.parse(event.data) as unknown[];
        if (frame[0] === "EVENT" && frame[1] === subId) {
          events.push(frame[2]);
        } else if (frame[0] === "EOSE" && frame[1] === subId) {
          eose = true;
          done();
        }
      } catch {
        // malformed frame from a remote relay -- ignore, let the timeout resolve
      }
    });
    socket.addEventListener("error", done);
    socket.addEventListener("close", done);
  });
}

// Resolves the owner's write relays from their most recent kind-10002
// across the well-known relays (same courtesy-discovery relays
// profile-lookup.ts already uses for the claim-time kind-0 lookup) --
// bothy itself starts empty, so it cannot be the source of its own
// backfill relay list. Picks whichever response has the highest
// created_at, in case the well-known relays disagree. Returns an empty
// array on total failure, which the caller treats as "try again next
// tick," not "give up."
async function discoverWriteRelays(ownerPubkey: string): Promise<string[]> {
  const pages = await Promise.all(
    WELL_KNOWN_RELAYS.map((url) =>
      fetchPage(url, { kinds: [RELAY_LIST_KIND], authors: [ownerPubkey], limit: 1 }, BACKFILL_FETCH_TIMEOUT_MS),
    ),
  );
  let best: { created_at: number; tags: string[][] } | null = null;
  for (const page of pages) {
    for (const raw of page.events) {
      const e = raw as { created_at?: unknown; tags?: unknown };
      if (typeof e.created_at !== "number" || !Array.isArray(e.tags)) continue;
      if (best === null || e.created_at > best.created_at) {
        best = { created_at: e.created_at, tags: e.tags as string[][] };
      }
    }
  }
  return best ? writeRelaysFrom(best.tags) : [];
}

// Called once per cron tick (src/index.ts scheduled()), alongside the
// existing ALLOW_FOLLOWS refresh. A cheap no-op once backfill is done or
// the relay is unclaimed -- getBackfillState's single RPC call covers
// both checks so this function only ever opens an outbound socket when
// there's real work to do.
export async function runBackfillTick(env: Env): Promise<void> {
  const stub = relayStub(env);
  const state = await stub.getBackfillState();
  if (state === null || state.status === "done" || state.status === "paused-budget") {
    // paused-budget resolves itself: the next successful ingest call
    // (once the daily quota resets) flips status back via
    // applyBackfillPage, not this function -- but there is nothing to
    // fetch until then, so skip opening a socket for a page that would
    // just fail to store again before 00:00 UTC.
    return;
  }

  if (state.status === "pending") {
    const relays = await discoverWriteRelays(state.ownerPubkey);
    if (relays.length > 0) {
      await stub.discoverBackfillRelays(relays);
    }
    return;
  }

  if (state.nextRelay === null || state.nextUntil === null) return;

  // Yield to the owner's own live traffic (backfill.ts hasBackfillHeadroom)
  // -- skip opening an outbound socket at all when today's rows-written
  // estimate already leaves backfill no reserved room. ingestBackfillPage
  // checks this same condition again, authoritatively, right before
  // writing -- this earlier check only saves a wasted outbound connection
  // on a day backfill isn't going to be allowed to write anyway.
  if (!state.canIngestNow) return;

  const filter = { authors: [state.ownerPubkey], until: state.nextUntil, limit: BACKFILL_PAGE_SIZE };
  const { events, eose } = await fetchPage(state.nextRelay, filter, BACKFILL_FETCH_TIMEOUT_MS);
  await stub.ingestBackfillPage(state.nextRelay, events, eose);
}
