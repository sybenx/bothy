import { nip11Response } from "./nip11";
import { lookupProfile } from "./profile-lookup";
import { normalizePubkey } from "./pubkey";

export { Relay } from "./relay";

function relayStub(env: Env) {
  // Exactly one Relay instance for the whole deployment -- see
  // CLAUDE.md "Architecture". Do not shard.
  const id = env.RELAY.idFromName("relay");
  return env.RELAY.get(id);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handleClaim(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "malformed request body" }, 400);
  }
  const rawPubkey = (body as { pubkey?: unknown } | null)?.pubkey;
  // Looked up here, in the stateless Worker, not inside the claim() RPC --
  // an outbound WebSocket from inside the DO would pin it in memory for
  // up to 15 minutes (CLAUDE.md "The budget"; profile-lookup.ts). This
  // duplicates claim()'s own normalization, but that's cheap and pure;
  // it's the only way to know which pubkey to look up before calling in.
  const normalized = typeof rawPubkey === "string" ? normalizePubkey(rawPubkey) : null;
  const profile = normalized ? await lookupProfile(normalized) : null;

  const result = await relayStub(env).claim(rawPubkey, profile ?? undefined);
  switch (result.status) {
    case "disabled":
      // CLAUDE.md "Claim implementation": "If OWNER_PUBKEY is set in
      // env... return 404 from /api/claim."
      return new Response("not found", { status: 404 });
    case "invalid":
      return json({ error: "invalid pubkey: expected npub1... or 64-char hex" }, 400);
    case "conflict":
      return json({ error: "already claimed" }, 409);
    case "claimed":
      return json({ pubkey: result.pubkey });
  }
}

async function handleStats(env: Env): Promise<Response> {
  const stats = await relayStub(env).getStats();
  return json(stats);
}

async function handleProfile(request: Request): Promise<Response> {
  const pubkey = new URL(request.url).searchParams.get("pubkey");
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ error: "expected a ?pubkey= hex query param" }, 400);
  }
  const profile = await lookupProfile(pubkey);
  return json({ profile });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Accept") === "application/nostr+json") {
      const profile = await relayStub(env).getProfile();
      return nip11Response(env, profile);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return relayStub(env).fetch(request);
    }

    if (url.pathname === "/api/claim") return handleClaim(request, env);
    if (url.pathname === "/api/stats") return handleStats(env);
    if (url.pathname === "/api/profile") return handleProfile(request);

    return env.ASSETS.fetch(request);
  },

  // ALLOW_FOLLOWS refresh (ROADMAP.md chunk 4) -- a no-op when the env
  // var is unset, see Relay.runCron().
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await relayStub(env).runCron();
  },
} satisfies ExportedHandler<Env>;
