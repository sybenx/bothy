// "There is a newer bothy than the one you are running" -- the read side
// of README.md "Keeping it updated", and the only part of that flow that
// lives in the relay rather than in GitHub Actions.
//
// It exists because the updater is opt-in by construction: the deploy
// button's clone arrives without .github/workflows/, so a downstream copy
// only ever auto-updates if its owner went and committed sync.yml. Nothing
// in that arrangement ever tells an owner who didn't that a release
// happened. This does, on the page they already open to read their
// relay's numbers.
//
// Runs in the Worker (index.ts handleStats), never in the Durable Object.
// The DO's outbound requests are budgeted and hibernation-sensitive
// (CLAUDE.md "The budget"); this is a courtesy notice on an
// unauthenticated read path, which is the last thing that should be able
// to wake or hold the object. It also means the check costs zero rows
// written and zero rows read: nothing about it is stored.
//
// The version being compared is already public -- NIP-11 has served it
// since the first release (nip11.ts), and it is on /api/stats above this
// field -- so publishing the comparison beside it tells a stranger
// nothing the two numbers didn't already. What it saves is the owner
// having to do that comparison themselves, by hand, having first thought
// to.
import {
  UPSTREAM_VERSION_CACHE_TTL_MS,
  UPSTREAM_VERSION_ERROR_CACHE_TTL_MS,
  UPSTREAM_VERSION_MAX_BYTES,
  UPSTREAM_VERSION_TIMEOUT_MS,
} from "./limits";

// raw.githubusercontent, not api.github.com, and the choice is about who
// pays for being wrong. The REST API rate-limits unauthenticated callers
// by IP at 60/hour, and a Worker's outbound IP is shared with every other
// Worker in its colo -- so this relay would be spending, and could be
// refused by, an allowance it neither controls nor can see. The raw host
// is a CDN serving a static file with no such counter.
//
// package.json's `version` rather than the tag list, because that field
// is this project's single source of truth for the version (CLAUDE.md
// "Release step") and is what the running relay reports about itself. A
// tag can exist before the bump lands or after it; comparing the same
// field to itself cannot drift.
//
// `main`, not a release ref: Cloudflare deploys downstream copies from
// `main` and the sync workflow pulls from `main`, so the branch this
// names is exactly the code an update would bring.
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

// Semver-ish, deliberately: three dot-separated integers, optionally
// followed by a pre-release or build suffix this project has never used.
// Anything else is treated as unparseable rather than coerced, because
// the only action a comparison here can trigger is telling an owner to
// update, and a wrong "yes" is worse than a missing one.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseVersion(value: string): [number, number, number] | null {
  const match = VERSION_RE.exec(value.trim());
  if (match === null) return null;
  // Read through a checked destructure rather than indexed access with
  // non-null assertions: the regex guarantees three numeric groups, but
  // noUncheckedIndexedAccess types every one of them as possibly
  // undefined, and this file has no business asserting past that.
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return [Number(major), Number(minor), Number(patch)];
}

// True only when `candidate` is strictly ahead of `current`. Equal
// versions, older versions, and anything unparseable on either side all
// answer false -- a relay running ahead of upstream (a local edit, a
// release in flight) is a normal state and not something to nag about.
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
// Isolate-local cache, the same shape and for the same reason as
// profile-lookup.ts lookupProfileCached: `caches.default` would be the
// obvious tool and is free, but it needs a custom domain
// (developers.cloudflare.com/workers/runtime-apis/cache/, checked
// 2026-08-27) and bothy's premise is a one-click deploy onto workers.dev.
// Isolate-scoped means it is lost on eviction and not shared across
// colos, which is the right trade here: what it has to prevent is one
// isolate re-fetching per request, and an isolate that has just been
// created is not the one doing that.
//
// Failures are cached too, on their own shorter TTL -- without that, a
// githubusercontent outage would turn every page load into another
// outbound attempt, which is exactly the amplification the /api/profile
// cache exists to prevent (profile-lookup.ts).
// ---------------------------------------------------------------------

interface CacheEntry {
  version: string | null;
  expiresAt: number;
}

let cached: CacheEntry | null = null;
// Requests arriving while a fetch is already running share it rather than
// starting their own -- N simultaneous cold requests would otherwise all
// miss, all fetch, and only then all write the same entry.
let inFlight: Promise<string | null> | null = null;

async function fetchUpstreamVersion(): Promise<string | null> {
  try {
    const response = await fetch(UPSTREAM_PACKAGE_JSON_URL, {
      signal: AbortSignal.timeout(UPSTREAM_VERSION_TIMEOUT_MS),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;
    // Read as text and length-checked before parsing, so a URL that has
    // stopped being a small JSON file cannot pull an unbounded body into
    // the isolate. Content-Length is not trusted for this: it is absent
    // on a chunked response, and the body is what has to be bounded.
    const body = await response.text();
    if (body.length > UPSTREAM_VERSION_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(body);
    const version = (parsed as { version?: unknown } | null)?.version;
    if (typeof version !== "string" || parseVersion(version) === null) return null;
    return version;
  } catch {
    // Network error, timeout, malformed JSON -- all the same thing to a
    // caller: no answer. Never rethrown: this runs beside the stats round
    // trip and must not be able to fail the page.
    return null;
  }
}

// Upstream's current version, from the cache when it is fresh and from
// the network at most once per isolate per TTL otherwise. Takes no
// argument on purpose: knowing what upstream released does not depend on
// what this relay is running, which is what lets index.ts start this
// before it has asked the Durable Object anything and overlap the two.
//
// Never throws; null means "no answer" (see UpstreamVersion above).
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

// The two version strings turned into the pair /api/stats serves. The
// comparison lives here, in TypeScript that tests cover, rather than in
// the admin page's JavaScript, so "what counts as newer" is stated once.
export function describeUpdate(latest: string | null, current: string): UpstreamVersion {
  if (latest === null) return NO_ANSWER;
  return { latestVersion: latest, updateAvailable: isNewerVersion(latest, current) };
}

// The env opt-out, read the same defensive way every other optional
// variable in this project is (CLAUDE.md "Configuration"): only the exact
// string "off" disables the check, so no truthy value can silently turn
// it off, and an unset variable leaves it on. Someone who would rather
// their relay never make an outbound request to GitHub sets
// UPDATE_CHECK=off in the Cloudflare dashboard and gets a stats response
// with latestVersion: null, which the admin page renders as no notice at
// all -- the same as a check that found nothing.
export function updateCheckEnabled(env: Env): boolean {
  return (env.UPDATE_CHECK ?? "").trim().toLowerCase() !== "off";
}

// Test seam only, beside profile-lookup.ts's resetProfileCache and for
// the same reason: the cache is isolate-scoped and the vitest pool reuses
// one isolate across a file, so a test that asserts a miss has to be able
// to start from empty. Nothing in src/ calls this.
export function resetUpstreamVersionCache(): void {
  cached = null;
  inFlight = null;
}
