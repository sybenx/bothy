// NIP-11 relay information document. `supported_nips` only lists NIPs
// actually implemented so far -- update it as later chunks land protocol
// support, not ahead of them.

// Hardcoded fallbacks (ROADMAP.md chunk 5: "Hardcoded fallbacks in code
// for when the lookup fails"). Used when there's no owner-profile
// override and no RELAY_NAME/RELAY_DESCRIPTION dashboard var either.
export const DEFAULT_NAME = "bothy";
export const DEFAULT_DESCRIPTION = "A single-user nostr relay.";

export type OwnerProfile = { name: string | null; picture: string | null } | null;

export function buildRelayInfo(env: Env, profile: OwnerProfile): Record<string, unknown> {
  const info: Record<string, unknown> = {
    // The owner's kind-0 name/picture (resolved at claim time, see
    // ownership.ts getOwnerProfile) takes priority over the
    // RELAY_NAME/RELAY_ICON dashboard override, which takes priority
    // over the hardcoded default -- ROADMAP.md chunk 5: "Derive NIP-11
    // name and icon from the owner's kind 0 at claim time."
    name: profile?.name || env.RELAY_NAME || DEFAULT_NAME,
    description: env.RELAY_DESCRIPTION || DEFAULT_DESCRIPTION,
    // NIP-42 (ROADMAP.md chunk 6): real as of gift wrap reads being the
    // first auth-gated resource -- relay.ts issues an actual challenge
    // and checks it, not just the unconditional AUTH-message checklist.
    // NIP-59/62: gift wrap accept/read/delete and vanish requests, same
    // chunk.
    supported_nips: [1, 9, 11, 40, 42, 59, 62],
  };
  const icon = profile?.picture || env.RELAY_ICON;
  if (icon) {
    info.icon = icon;
  }
  return info;
}

export function nip11Response(env: Env, profile: OwnerProfile): Response {
  return new Response(JSON.stringify(buildRelayInfo(env, profile)), {
    headers: {
      "Content-Type": "application/nostr+json",
      // NIP-11 is fetched cross-origin by web clients before they ever
      // open a connection.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
