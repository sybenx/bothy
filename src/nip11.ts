// NIP-11 relay information document. `supported_nips` only lists NIPs
// actually implemented so far -- update it as later chunks land protocol
// support, not ahead of them.
export function buildRelayInfo(env: Env): Record<string, unknown> {
  const info: Record<string, unknown> = {
    name: env.RELAY_NAME,
    description: env.RELAY_DESCRIPTION,
    supported_nips: [11],
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
