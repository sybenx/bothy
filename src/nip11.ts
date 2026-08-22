// NIP-11 relay information document. `supported_nips` only lists NIPs
// actually implemented so far -- update it as later chunks land protocol
// support, not ahead of them.
export function buildRelayInfo(env: Env): Record<string, unknown> {
  const info: Record<string, unknown> = {
    name: env.RELAY_NAME,
    description: env.RELAY_DESCRIPTION,
    // NIP-42 is deliberately not listed: this relay answers AUTH per its
    // unconditional requirements (kind/freshness/challenge-match) but
    // never issues a challenge itself, since there's no auth-gated
    // resource yet -- see test/nip42-auth.test.ts and CLAUDE.md "Threat
    // model". Claiming NIP-42 support here would promise clients a
    // challenge/response flow that doesn't exist.
    supported_nips: [1, 9, 11, 40],
  };
  if (env.RELAY_ICON) {
    info.icon = env.RELAY_ICON;
  }
  return info;
}

export function nip11Response(env: Env): Response {
  return new Response(JSON.stringify(buildRelayInfo(env)), {
    headers: {
      "Content-Type": "application/nostr+json",
      // NIP-11 is fetched cross-origin by web clients before they ever
      // open a connection.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
