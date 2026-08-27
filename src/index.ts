import { runBackfillTick } from "./backfill-worker";
import { logExhaustion } from "./exhaustion";
import { MANAGEMENT_CONTENT_TYPE } from "./nip86";
import { nip11Response } from "./nip11";
import { verifyNip98 } from "./nip98";
import { lookupProfile } from "./profile-lookup";
import { normalizePubkey } from "./pubkey";
import { relayStub } from "./relay-stub";

export { Relay } from "./relay";

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

  const result = await relayStub(env).claim(rawPubkey, profile ?? undefined, new URL(request.url).host);
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

// NIP-86 relay management (nips/86.md), Worker-side half: read the body,
// verify the NIP-98 event over it, then hand the call to the Durable
// Object (src/nip86.ts handleManagementCall) to actually touch storage.
//
// Verification lives here rather than in the DO because the schnorr
// verify is the expensive step (src/validate.ts) and
// a forged request should never cost Durable Object time at all. The DO's
// manage() RPC does no authentication of its own -- this function is the
// only caller, and it must stay that way.
//
// Deliberately never consults `blocked_ips`. An operator who blocks their
// own address must still be able to call unblockip; see the
// connection-time check in src/relay.ts and blockip in src/nip86.ts.
async function handleManagement(request: Request, env: Env): Promise<Response> {
  // Read the body as bytes before anything else: the NIP-98 `payload`
  // tag binds the SHA256 of exactly these bytes, so they are hashed
  // as-sent, before any decoding or parsing can normalize them.
  const body = new Uint8Array(await request.arrayBuffer());

  const owner = await relayStub(env).getOwner();
  const auth = verifyNip98(request, body, owner, Math.floor(Date.now() / 1000));
  if (!auth.ok) {
    // nips/98.md: "Failed validation should return a 401 Unauthorized
    // response." The reason travels in the body rather than being
    // swallowed -- every failure mode here (clock skew, a wrong `u` tag,
    // the wrong key) is something the operator can fix in seconds once
    // told which one it was, and guessing at it otherwise.
    return managementResponse({ error: auth.reason }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return managementResponse({ error: "request body is not valid JSON" });
  }
  const call = parsed as { method?: unknown; params?: unknown } | null;
  const params = Array.isArray(call?.params) ? (call.params as unknown[]) : [];

  const result = await relayStub(env).manage(
    call?.method,
    params,
    request.headers.get("CF-Connecting-IP") ?? "unknown",
  );
  return managementResponse(result);
}

function managementResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": MANAGEMENT_CONTENT_TYPE },
  });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  const stats = await relayStub(env).getStats(new URL(request.url).host);
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

// The routing table, split out from `fetch` below so the exhaustion
// wrapper there has something to wrap.
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // NIP-86 is checked BEFORE NIP-11, and the order is load-bearing:
  // "application/nostr+json+rpc" contains "application/nostr+json" as a
  // substring, so a management client that also sets an Accept header
  // would otherwise be served the relay information document instead of
  // having its command run. Substring match here too, for the same
  // reason as below -- a real client sends
  // "application/nostr+json+rpc; charset=utf-8".
  if (
    request.method === "POST" &&
    request.headers.get("Content-Type")?.includes(MANAGEMENT_CONTENT_TYPE)
  ) {
    return handleManagement(request, env);
  }

  // Substring match, not equality -- clients commonly send compound
  // Accept headers ("application/nostr+json, */*"), and NIP-11 only
  // requires the media type be present, not that it stand alone.
  if (request.headers.get("Accept")?.includes("application/nostr+json")) {
    const { profile, settings } = await relayStub(env).getIdentity(url.host);
    return nip11Response(env, settings, profile);
  }

  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    return relayStub(env).fetch(request);
  }

  if (url.pathname === "/api/claim") return handleClaim(request, env);
  if (url.pathname === "/api/stats") return handleStats(request, env);
  if (url.pathname === "/api/profile") return handleProfile(request);

  return env.ASSETS.fetch(request);
}

// Cloudflare's free-tier allowances reset at 00:00 UTC, so this is a real
// retry time rather than a guess -- see CLAUDE.md "The budget".
function secondsUntilUtcMidnight(nowMs: number): number {
  const msPerDay = 86_400_000;
  return Math.ceil((msPerDay - (nowMs % msPerDay)) / 1000);
}

export default {
  // Wrapped as a whole rather than per handler, because the failure this
  // catches is not route-specific: when a Cloudflare allowance is
  // consumed, every path that reaches the Durable Object fails at once
  // while the static admin page -- served from env.ASSETS, which never
  // touches the DO -- keeps returning 200. That combination is exactly
  // what made the last outage undiagnosable from the outside: the only
  // symptom was a page that loaded the word "bothy" and no numbers, and
  // nothing anywhere named a resource or a ceiling. See src/exhaustion.ts.
  //
  // Non-exhaustion errors are logged and rethrown, so this cannot turn an
  // ordinary bug into a quiet 503.
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      const verdict = logExhaustion(`fetch ${new URL(request.url).pathname}`, err);
      if (!verdict.exhausted) throw err;
      // 503 with a Retry-After, not a 500. This is a temporary refusal
      // with a known end time, and saying so is the difference between
      // "the relay is broken" and "the relay is out of budget until
      // midnight" -- a distinction the owner could not make last time.
      return new Response(
        JSON.stringify({
          error: `relay is out of its daily ${verdict.resource} allowance`,
          exhausted: verdict.resource,
          resets: "00:00 UTC",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(secondsUntilUtcMidnight(Date.now())),
          },
        },
      );
    }
  },

  // ALLOW_FOLLOWS refresh -- a no-op when the env var is unset, see
  // Relay.runCron(). One-shot backfill shares this same trigger rather
  // than requesting a second of the account's 5 available cron triggers
  // -- see backfill-worker.ts for why its outbound sockets are opened
  // here, in the Worker, and not inside runCron().
  //
  // These two do unrelated jobs and must not share a failure: each is
  // caught and logged independently, so an exception in runCron (e.g. a
  // storage error while refreshing the follow cache) can never silently
  // stop backfill from ever running again, and vice versa.
  //
  // Both go through logExhaustion rather than a bare console.error. The
  // cron tick is where budget exhaustion shows up FIRST -- it runs hourly
  // whether or not anyone is connected, and the whole of the relay's
  // client-independent read floor is spent here (CLAUDE.md "The budget")
  // -- so a tick that dies on an allowance is the earliest warning the
  // deployment gets.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    try {
      await relayStub(env).runCron();
    } catch (err) {
      logExhaustion("scheduled: runCron", err);
    }
    try {
      await runBackfillTick(env);
    } catch (err) {
      logExhaustion("scheduled: runBackfillTick", err);
    }
  },
} satisfies ExportedHandler<Env>;
