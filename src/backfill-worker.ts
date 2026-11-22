// One-shot backfill, Worker-side half. Every outbound WebSocket backfill
// opens lives here, in the Worker's scheduled() handler, never in the
// Relay Durable Object: an outbound WebSocket keeps the DO in memory for
// up to 15 minutes, defeating hibernation. The DO only answers RPCs:
// getBackfillState, and discoverBackfillRelays/ingestBackfillPage to
// store what was fetched here.
import { BACKFILL_FETCH_TIMEOUT_MS, BACKFILL_PAGE_SIZE } from "./limits";
import { RELAY_LIST_KIND, writeRelaysFrom } from "./nostr";
import { WELL_KNOWN_RELAYS } from "./profile-lookup";
import { relayStub } from "./relay-stub";

export interface FetchPageResult {
  events: unknown[];
  // True only when a real EOSE arrived for this subscription; false for
  // a timeout, socket error, close, or constructor throw. A failed fetch
  // can look like a short page, and backfill.ts applyBackfillPage's
  // exhaustion rule depends on telling them apart.
  eose: boolean;
  // Every frame that was neither EVENT nor EOSE for this subscription
  // (CLOSED, NOTICE, AUTH, ...), so a refusal such as auth-required is
  // distinguishable from a relay that said nothing.
  refusals: string[];
}

// These strings come from a remote relay and are persisted (backfill.ts)
// and shown on the admin page, so count and length are capped.
const MAX_REFUSAL_FRAMES = 5;
const MAX_REFUSAL_LENGTH = 300;

// Collects every EVENT for one REQ until EOSE, CLOSED, an error or the
// timeout, then closes the socket. Same shape as profile-lookup.ts
// queryOne, but collecting a page rather than the first result.
export function fetchPage(relayUrl: string, filter: Record<string, unknown>, timeoutMs: number): Promise<FetchPageResult> {
  return new Promise((resolve) => {
    const events: unknown[] = [];
    const refusals: string[] = [];
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
      resolve({ events, eose, refusals });
    };

    const recordRefusal = (frame: unknown[]) => {
      if (refusals.length >= MAX_REFUSAL_FRAMES) return;
      refusals.push(JSON.stringify(frame).slice(0, MAX_REFUSAL_LENGTH));
    };

    let socket: WebSocket;
    try {
      socket = new WebSocket(relayUrl);
    } catch (err) {
      // Reported as a refusal so it is distinguishable from a timeout.
      resolve({
        events: [],
        eose: false,
        refusals: [`connect failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_REFUSAL_LENGTH)],
      });
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
        } else if (frame[0] === "CLOSED" && frame[1] === subId) {
          // CLOSED ends the subscription, so resolve now instead of
          // waiting out the timeout. Does NOT set eose: a refusal is not
          // "no more history" and must never retire the relay.
          recordRefusal(frame);
          done();
        } else {
          // NOTICE, AUTH, OK, and anything for another subscription id.
          // An AUTH challenge is the likeliest reason a relay withholds
          // history.
          recordRefusal(frame);
        }
      } catch {
        // malformed frame from a remote relay -- ignore, let the timeout resolve
      }
    });
    socket.addEventListener("error", done);
    socket.addEventListener("close", done);
  });
}

// Resolves the owner's write relays from their newest kind-10002 on the
// well-known relays (profile-lookup.ts WELL_KNOWN_RELAYS); bothy starts
// empty, so it cannot be its own source. The highest created_at wins if
// they disagree. Empty on total failure, which the caller retries next
// tick.
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

// Called once per cron tick (index.ts scheduled()). One RPC decides
// whether there is work, so a done or unclaimed relay opens no socket.
export async function runBackfillTick(env: Env): Promise<void> {
  const stub = relayStub(env);
  const state = await stub.getBackfillState();
  if (state === null || state.status === "done") return;

  if (state.status === "pending") {
    const relays = await discoverWriteRelays(state.ownerPubkey);
    if (relays.length > 0) {
      await stub.discoverBackfillRelays(relays);
    }
    return;
  }

  if (state.nextRelay === null || state.nextUntil === null) return;

  // Saves a wasted fetch on a day with no headroom; the authoritative
  // check is in applyBackfillPage (backfill.ts hasBackfillHeadroom). It
  // is also what lifts "paused-budget": a paused backfill waits here
  // until headroom returns after 00:00 UTC, then fetches as if running,
  // and applyBackfillPage sets the status from that page.
  if (!state.canIngestNow) return;

  const filter = { authors: [state.ownerPubkey], until: state.nextUntil, limit: BACKFILL_PAGE_SIZE };
  const { events, eose, refusals } = await fetchPage(state.nextRelay, filter, BACKFILL_FETCH_TIMEOUT_MS);
  await stub.ingestBackfillPage(state.nextRelay, events, eose, refusals);
}
