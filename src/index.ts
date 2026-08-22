import { nip11Response } from "./nip11";
import { lookupProfile } from "./profile-lookup";

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
  const pubkey = (body as { pubkey?: unknown } | null)?.pubkey;

  const result = await relayStub(env).claim(pubkey);
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
      return nip11Response(env);
    }

    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      return relayStub(env).fetch(request);
    }

    if (url.pathname === "/api/claim") return handleClaim(request, env);
    if (url.pathname === "/api/stats") return handleStats(env);
    if (url.pathname === "/api/profile") return handleProfile(request);

    return env.ASSETS.fetch(request);
  },

  // ALLOW_FOLLOWS refresh and RETENTION_DAYS pruning (ROADMAP.md chunk 4).
  // Both are no-ops when their env var is unset -- see Relay.runCron().
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await relayStub(env).runCron();
  },
} satisfies ExportedHandler<Env>;
