// "A newer bothy exists": the read side of README.md "Keeping it
// updated". The deploy button's clone arrives without .github/workflows/,
// so a copy only auto-updates if its owner committed sync.yml; this is
// how an owner who did not learns a release happened.
//
// Runs in the Worker (index.ts handleStats), never in the Durable Object:
// an outbound request there costs DO duration and blocks hibernation, and
// this is a courtesy notice on an unauthenticated path. Nothing is
// stored, so it costs zero rows.
//
// Publishing the comparison discloses nothing new: the running version
// is already public on NIP-11 and /api/stats.
import {
  UPSTREAM_VERSION_CACHE_TTL_MS,
  UPSTREAM_VERSION_ERROR_CACHE_TTL_MS,
  UPSTREAM_VERSION_MAX_BYTES,
  UPSTREAM_VERSION_TIMEOUT_MS,
} from "./limits";

// raw.githubusercontent, not api.github.com: the REST API limits
// unauthenticated callers to 60/hour per IP, and a Worker's outbound IP
// is shared with every other Worker in its colo, so that allowance is
// neither ours nor visible. The raw host is a CDN with no such counter.
//
// package.json `version` rather than tags: it is the field the running
// relay reports about itself (imported into NIP-11 and /api/stats), so
// both sides of the comparison are the same field. A tag can lag or lead
// the bump.
//
// `main`, because downstream copies deploy from `main` and the sync
// workflow pulls from it.
export const UPSTREAM_PACKAGE_JSON_URL =
  "https://raw.githubusercontent.com/sybenx/bothy/main/package.json";

export interface UpstreamVersion {
  // Upstream's version, or null when the check was disabled, failed, or
  // returned something unparseable. Null is not "up to date" -- it is "no
  // answer", and every consumer treats it as nothing to show.
  latestVersion: string | null;
  // Strictly newer than what this relay is running. False whenever
  // latestVersion is null, so a failed check can never raise a notice.
  updateAvailable: boolean;
}

const NO_ANSWER: UpstreamVersion = { latestVersion: null, updateAvailable: false };

// Three dot-separated integers, optionally with a pre-release/build
// suffix (ignored). Anything else is unparseable rather than coerced: the
// only outcome is telling an owner to update, and a wrong "yes" is worse
// than a missing one.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseVersion(value: string): [number, number, number] | null {
  const match = VERSION_RE.exec(value.trim());
  if (match === null) return null;
  // Checked rather than asserted: noUncheckedIndexedAccess types each
  // group as possibly undefined.
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return [Number(major), Number(minor), Number(patch)];
}

// True only when `candidate` is strictly ahead of `current`. Equal,
// older, or unparseable answers false; running ahead of upstream (a local
// edit, a release in flight) is normal.
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === null || b === null) return false;
  for (let i = 0; i < 3; i++) {
    const left = a[i] as number;
    const right = b[i] as number;
    if (left !== right) return left > right;
  }
  return false;
}

// ---------------------------------------------------------------------
// Isolate-local cache, for the reason given on profile-lookup.ts
// lookupProfileCached (`caches.default` needs a custom domain; bothy
// deploys to workers.dev). Lost on eviction and not shared across colos,
// which is fine: it only has to stop one isolate re-fetching per request.
//
// Failures are cached too, on a shorter TTL, so an upstream outage does
// not turn every page load into another outbound attempt.
// ---------------------------------------------------------------------

interface CacheEntry {
  version: string | null;
  expiresAt: number;
}

let cached: CacheEntry | null = null;
// Concurrent cold requests share one fetch instead of each starting one.
let inFlight: Promise<string | null> | null = null;

async function fetchUpstreamVersion(): Promise<string | null> {
  try {
    const response = await fetch(UPSTREAM_PACKAGE_JSON_URL, {
      signal: AbortSignal.timeout(UPSTREAM_VERSION_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    // Length-checked before parsing so the URL cannot feed an unbounded
    // body into JSON.parse. Content-Length is not used: a chunked
    // response omits it.
    const body = await response.text();
    if (body.length > UPSTREAM_VERSION_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(body);
    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version !== "string" || parseVersion(version) === null) return null;
    return version;
  } catch {
    // Any failure is "no answer". Never rethrown: this must not be able
    // to fail the stats response.
    return null;
  }
}

// Upstream's current version, fetched at most once per isolate per TTL.
// Takes no argument so index.ts can start it before the Durable Object
// round trip and overlap the two. Never throws; null means "no answer".
export async function cachedUpstreamVersion(): Promise<string | null> {
  const now = Date.now();
  if (cached !== null && cached.expiresAt > now) return cached.version;

  if (inFlight === null) {
    inFlight = fetchUpstreamVersion()
      .then((version) => {
        cached = {
          version,
          expiresAt:
            Date.now() +
            (version === null
              ? UPSTREAM_VERSION_ERROR_CACHE_TTL_MS
              : UPSTREAM_VERSION_CACHE_TTL_MS),
        };
        return version;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

// The pair /api/stats serves. Compared here, under test, rather than in
// the admin page, so "what counts as newer" is defined once.
export function describeUpdate(latest: string | null, current: string): UpstreamVersion {
  if (latest === null) return NO_ANSWER;
  return { latestVersion: latest, updateAvailable: isNewerVersion(latest, current) };
}

// UPDATE_CHECK: only the exact string "off" (case-insensitive) disables
// the check; unset or anything else leaves it on. Off yields
// latestVersion: null, which the admin page renders as no notice.
export function updateCheckEnabled(env: Env): boolean {
  return (env.UPDATE_CHECK ?? "").trim().toLowerCase() !== "off";
}

// Test seam only: the vitest pool reuses one isolate across a file.
export function resetUpstreamVersionCache(): void {
  cached = null;
  inFlight = null;
}
