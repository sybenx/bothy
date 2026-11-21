// Best-effort kind-0 lookup for the claim step: a courtesy against typos,
// not a security control, so a failed lookup never blocks a claim. Runs in
// the Worker (index.ts), never the Durable Object: an outbound WebSocket
// from the DO pins it in memory for up to 15 minutes. WELL_KNOWN_RELAYS
// is also backfill-worker.ts's source for the owner's kind-10002.
import { PROFILE_CACHE_MAX_ENTRIES, PROFILE_CACHE_TTL_MS } from "./limits";

export const WELL_KNOWN_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
const LOOKUP_TIMEOUT_MS = 2500;

export interface Profile {
  name?: string;
  picture?: string;
  // Backs the NIP-11 description fallback (nip11.ts resolveDescription).
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
// Cache, for /api/profile (index.ts handleProfile) and the claim submit.
//
// Each miss opens two outbound WebSockets to third-party relays on an
// unauthenticated request. A flood would land on relays bothy depends on
// (the same two backfill uses) and could get this deployment's IP
// throttled or blocked by them. index.ts scopes /api/profile to the
// pre-claim window and rate-limits it; this cache keeps that window from
// amplifying.
//
// In-isolate, not the Cache API: `caches.default` works only on custom
// domains (developers.cloudflare.com/workers/runtime-apis/cache/,
// checked 2026-08-27), and bothy deploys to workers.dev, where it would
// silently no-op. Lost on eviction and not shared across colos, which is
// acceptable: a flood concentrates on the isolates it is already hitting.
// ---------------------------------------------------------------------

interface CacheEntry {
  profile: Profile | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
// Concurrent requests for one pubkey share one lookup; otherwise a burst
// would all miss and all fetch before the first result is cached.
const inFlight = new Map<string, Promise<Profile | null>>();

// Negative results are cached too: a flood of pubkeys with no kind-0
// would otherwise never hit.
export async function lookupProfileCached(pubkey: string): Promise<Profile | null> {
  const now = Date.now();
  const hit = cache.get(pubkey);
  if (hit !== undefined && hit.expiresAt > now) return hit.profile;

  const pending = inFlight.get(pubkey);
  if (pending !== undefined) return pending;

  const lookup = lookupProfile(pubkey)
    .then((profile) => {
      // Bounded against a stream of distinct pubkeys. FIFO (Map keeps
      // insertion order), not LRU: under a flood every entry is equally
      // worthless.
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

// Test seam only: the vitest pool reuses one isolate across a file.
export function resetProfileCache(): void {
  cache.clear();
  inFlight.clear();
}

// Test seam only: lets a test prove a request was refused before any
// lookup ran, since a cache entry is the only trace a lookup leaves.
export function profileCacheSize(): number {
  return cache.size;
}
