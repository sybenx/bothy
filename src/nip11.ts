// NIP-11 relay information document. `supported_nips` only lists NIPs
// actually implemented so far -- update it as later chunks land protocol
// support, not ahead of them.

import { MAX_FILTER_LIMIT, MAX_SUBSCRIPTIONS_PER_CONNECTION } from "./limits";
import type { RelaySettings } from "./storage";
import { version } from "../package.json";

// Hardcoded fallbacks (ROADMAP.md chunk 5: "Hardcoded fallbacks in code
// for when the lookup fails"). The bottom rung of the chain below: used
// when nothing else in it resolved.
export const DEFAULT_NAME = "bothy";
export const DEFAULT_DESCRIPTION = "A single-user nostr relay.";

export type OwnerProfile = { name: string | null; picture: string | null; about: string | null } | null;

// ---------------------------------------------------------------------
// The relay identity chain. Name, description and icon each resolve in
// the same order, highest to lowest:
//
//   1. environment variable   (RELAY_NAME/RELAY_DESCRIPTION/RELAY_ICON)
//   2. stored value           (NIP-86 change*, src/nip86.ts)
//   3. the owner's kind-0     (cached at claim time, ownership.ts)
//   4. hardcoded default      (above)
//
// The environment variable sits on top because it is the one rung whose
// holder demonstrably controls the deployment itself: someone with the
// Cloudflare dashboard has already won any argument with the relay's own
// storage. NIP-86 still stores a value written underneath a set variable
// rather than discarding it -- see src/nip86.ts changeIdentity, which
// says so in the response.
//
// Every resolver here is used by BOTH the NIP-11 document and
// /api/stats (src/relay.ts getStats), so the document a client fetches
// and the readout the admin page shows can never disagree -- the pattern
// resolveIcon already established when it was the only one.
// ---------------------------------------------------------------------

// A relay name taken from the owner's kind-0 is DERIVED, not chosen: the
// owner named themselves, not their relay, so "Aaron" becomes "Aaron's
// relay" rather than a relay literally called Aaron. Always "'s", names
// already ending in s included -- "Chris's relay", not "Chris' relay".
// One rule with no exception is one fewer thing to get wrong, and it
// matches how the name is spoken.
//
// The other three rungs are chosen relay names and are used verbatim: an
// operator who sets RELAY_NAME or calls changerelayname has named the
// relay itself, and possessivising that would be putting words in their
// mouth.
function possessive(ownerName: string): string {
  return `${ownerName}'s relay`;
}

export function resolveName(env: Env, stored: RelaySettings, profile: OwnerProfile): string {
  if (env.RELAY_NAME) return env.RELAY_NAME;
  if (stored.name) return stored.name;
  if (profile?.name) return possessive(profile.name);
  return DEFAULT_NAME;
}

// kind-0's `about` is the profile field that corresponds to a relay
// description, so it takes the kind-0 rung here the way `name` and
// `picture` do for the other two. Used verbatim -- unlike a name, a
// description needs no grammatical adjustment to read correctly.
export function resolveDescription(env: Env, stored: RelaySettings, profile: OwnerProfile): string {
  if (env.RELAY_DESCRIPTION) return env.RELAY_DESCRIPTION;
  if (stored.description) return stored.description;
  if (profile?.about) return profile.about;
  return DEFAULT_DESCRIPTION;
}

// Shared between the NIP-11 document and /api/stats (src/relay.ts
// getStats), which the admin page uses to set the browser tab's favicon
// from the same source rather than inventing a second resolution path.
// There is no hardcoded icon -- null means "no icon", which the NIP-11
// document expresses by omitting the field entirely (buildRelayInfo
// below) and the admin page by keeping its static default favicon.
export function resolveIcon(env: Env, stored: RelaySettings, profile: OwnerProfile): string | null {
  return env.RELAY_ICON || stored.icon || profile?.picture || null;
}

export function buildRelayInfo(
  env: Env,
  stored: RelaySettings,
  profile: OwnerProfile,
): Record<string, unknown> {
  const info: Record<string, unknown> = {
    name: resolveName(env, stored, profile),
    description: resolveDescription(env, stored, profile),
    // NIP-42 (ROADMAP.md chunk 6): real as of gift wrap reads being the
    // first auth-gated resource -- relay.ts issues an actual challenge
    // and checks it, not just the unconditional AUTH-message checklist.
    // NIP-59/62: gift wrap accept/read/delete and vanish requests, same
    // chunk. NIP-86: the management API (src/nip86.ts). NIP-98 is not
    // listed -- it is verified here only as NIP-86's authentication
    // (src/nip98.ts), and this relay offers no general NIP-98 HTTP auth
    // a client could use for anything else.
    supported_nips: [1, 9, 11, 40, 42, 59, 62, 86],
    // Points at the upstream project, not the deployer's own cloned repo
    // -- the NIP requires a URL identifying the implementation, not the
    // deployment, and every deploy button clone shares this same software.
    software: "https://github.com/sybenx/bothy",
    // package.json's `version` is the single source of truth (CLAUDE.md
    // "Release step") -- never hardcode this string elsewhere.
    version,
    // Only constraints actually enforced -- imported from limits.ts so
    // this document can never drift from the real caps. No
    // max_message_length/max_event_tags/max_content_length/
    // min_pow_difficulty: none of those are enforced anywhere in this
    // codebase, and advertising an unenforced limit is worse than
    // advertising none.
    limitation: {
      // This relay is never fully open -- see ownership.ts isAllowedWriter.
      restricted_writes: true,
      max_subscriptions: MAX_SUBSCRIPTIONS_PER_CONNECTION,
      max_limit: MAX_FILTER_LIMIT,
      // clampFilterLimit (limits.ts) defaults a filter's limit to this
      // when the filter omits one.
      default_limit: MAX_FILTER_LIMIT,
    },
  };
  const icon = resolveIcon(env, stored, profile);
  if (icon) {
    info.icon = icon;
  }
  return info;
}

export function nip11Response(env: Env, stored: RelaySettings, profile: OwnerProfile): Response {
  return new Response(JSON.stringify(buildRelayInfo(env, stored, profile)), {
    headers: {
      "Content-Type": "application/nostr+json",
      // NIP-11 is fetched cross-origin by web clients before they ever
      // open a connection.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
