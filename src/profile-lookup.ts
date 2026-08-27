// Best-effort kind-0 profile lookup for the claim confirm step (CLAUDE.md
// "Claim implementation": "Resolve and display the profile before
// confirming... a courtesy against typos, not a security control... If
// the lookup fails, allow the claim anyway; never block on it."). Runs
// in the Worker (src/index.ts), not the Durable Object -- a short-lived
// outbound WebSocket from the DO would pin it in memory for up to 15
// minutes (CLAUDE.md "The budget"); the stateless Worker has no such
// cost.
// Also reused by backfill-worker.ts to discover the owner's kind-10002
// relay list -- same rationale, a courtesy discovery path from the
// stateless Worker, not a security-relevant source of truth.
import { PROFILE_CACHE_MAX_ENTRIES, PROFILE_CACHE_TTL_MS } from "./limits";

export const WELL_KNOWN_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
const LOOKUP_TIMEOUT_MS = 2500;

export interface Profile {
  name?: string;
  picture?: string;
  // kind-0's bio field, which backs the kind-0 rung of the NIP-11
  // description (nip11.ts resolveDescription) the way name/picture back
  // the name and icon rungs.
  about?: string;
  // Backs NIP-11's `contact` (nip11.ts resolveContact).
  website?: string;
}

function queryOne(relayUrl: string, pubkey: string): Promise<Profile | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: Profile | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closing/closed
      }
      resolve(result);
    };

    let socket: WebSocket;
    try {
      socket = new WebSocket(relayUrl);
    } catch {
      resolve(null);
      return;
    }

    const timer = setTimeout(() => done(null), LOOKUP_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify(["REQ", "profile", { kinds: [0], authors: [pubkey], limit: 1 }]));
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      try {
        const frame = JSON.parse(event.data) as unknown[];
        if (frame[0] === "EVENT" && frame[1] === "profile") {
          const content = JSON.parse((frame[2] as { content: string }).content) as Record<string, unknown>;
          const profile: Profile = {};
          if (typeof content.name === "string") profile.name = content.name;
          if (typeof content.picture === "string") profile.picture = content.picture;
          if (typeof content.about === "string") profile.about = content.about;
          if (typeof content.website === "string") profile.website = content.website;
          done(profile);
        } else if (frame[0] === "EOSE") {
          done(null);
        }
      } catch {
        // malformed frame from a remote relay -- ignore, let the timeout resolve
      }
    });
    socket.addEventListener("error", () => done(null));
    socket.addEventListener("close", () => done(null));
  });
}

export async function lookupProfile(pubkey: string): Promise<Profile | null> {
  const results = await Promise.all(WELL_KNOWN_RELAYS.map((url) => queryOne(url, pubkey)));
  return results.find((r) => r !== null) ?? null;
}

// ---------------------------------------------------------------------
// Caching, for /api/profile (src/index.ts handleProfile).
//
// The uncached endpoint opened two outbound WebSockets to third-party
// relays per request, on nothing but an unauthenticated query string.
// That is worse than an expensive read: the cost lands on infrastructure
// that is not ours and that this relay depends on -- damus and nos.lol
// are the same two relays backfill and the claim-time lookup use -- so a
// flood pointed at /api/profile makes this deployment's IP look like the
// abuser and can get it throttled or blocked by exactly the relays it
// needs. Scoping the endpoint to the pre-claim window is the primary
// fix; this cache is what keeps even that window from amplifying.
//
// In-isolate, not the Cache API. `caches.default` would be the obvious
// choice and is free, but "Workers deployed to custom domains have access
// to functional cache operations"
// (developers.cloudflare.com/workers/runtime-apis/cache/, checked
// 2026-08-27) -- and bothy's whole premise is a one-click deploy that
// lands on a workers.dev subdomain with no domain to configure. A cache
// that silently no-ops on the deployment shape this project is built for
// is worse than no cache, because the comment would claim a defence that
// isn't there.
//
// Isolate-scoped means it is lost on eviction and not shared across
// colos, the same trade the in-memory throttles in relay.ts already make
// (CLAUDE.md "Threat model": "In-memory limits across eviction"). It is
// the right shape against the threat regardless: a flood concentrates on
// the isolates it is already talking to.
// ---------------------------------------------------------------------

interface CacheEntry {
  profile: Profile | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
// Requests for the same pubkey that arrive while a lookup is already
// running share that lookup rather than starting their own. Without this
// the cache is useless against the burst it exists for: N simultaneous
// requests all miss, all fetch, and only then all write the same entry.
const inFlight = new Map<string, Promise<Profile | null>>();

// Negative results are cached too, and that is the load-bearing half. A
// pubkey nobody has published a kind-0 for is the cheap thing to ask
// about repeatedly -- caching only hits would leave the flood path
// completely uncached, since an attacker generating random pubkeys never
// hits.
export async function lookupProfileCached(pubkey: string): Promise<Profile | null> {
  const now = Date.now();
  const hit = cache.get(pubkey);
  if (hit !== undefined && hit.expiresAt > now) return hit.profile;

  const pending = inFlight.get(pubkey);
  if (pending !== undefined) return pending;

  const lookup = lookupProfile(pubkey)
    .then((profile) => {
      // Bounded so a stream of distinct pubkeys cannot grow the isolate's
      // memory without limit. Map iterates in insertion order, so the
      // first key is the oldest -- FIFO, not LRU: this is a flood guard,
      // and under a flood every entry is equally worthless.
      if (cache.size >= PROFILE_CACHE_MAX_ENTRIES) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      cache.set(pubkey, { profile, expiresAt: Date.now() + PROFILE_CACHE_TTL_MS });
      return profile;
    })
    .finally(() => {
      inFlight.delete(pubkey);
    });

  inFlight.set(pubkey, lookup);
  return lookup;
}

// Test seam only. The cache is isolate-scoped and the vitest pool reuses
// one isolate across a file, so a test that asserts a miss has to be able
// to start from empty; nothing in src/ calls this.
export function resetProfileCache(): void {
  cache.clear();
  inFlight.clear();
}

// Test seam only, beside resetProfileCache and for the same reason: it is
// what lets a test prove /api/profile refused a request *before* reaching
// the network, rather than merely that it answered 404. An entry here is
// the only externally visible trace a lookup leaves.
export function profileCacheSize(): number {
  return cache.size;
}
