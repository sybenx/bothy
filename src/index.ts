import { runBackfillTick } from "./backfill-worker";
import { logExhaustion } from "./exhaustion";
import { HTTP_RATE_LIMIT_PERIOD_SECONDS, secondsUntilUtcMidnight } from "./limits";
import { MANAGEMENT_CONTENT_TYPE } from "./nip86";
import { nip11Response } from "./nip11";
import { ownerReason, verifyNip98 } from "./nip98";
import { lookupProfileCached } from "./profile-lookup";
import { normalizeIp } from "./ip";
import { normalizePubkey } from "./pubkey";
import { relayStub } from "./relay-stub";

export { Relay } from "./relay";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Per-IP HTTP rate limiting, via Cloudflare's Rate Limiting binding. The
// limit and window are declared in wrangler.jsonc, which is also where
// the reasoning for the two namespaces and their values lives -- nothing
// here restates a number that the runtime enforces from there.
//
// Returns a 429 to send back, or null to continue. The check is placed at
// the top of each handler rather than at the top of route(), because
// static assets must not be rate limited: they are served from
// env.ASSETS, cost neither a Worker request against the daily 100,000 nor
// any Durable Object time, and are free and unmetered on Workers Free.
// Throttling the admin page would spend the guard on the one path that
// does not need it.
//
// An absent binding means "allowed", not "denied" -- see env.d.ts. The
// failure this protects against is expensive; the failure of refusing
// every request because a binding did not provision would be total.
async function rateLimited(
  limiter: RateLimit | undefined,
  request: Request,
): Promise<Response | null> {
  if (limiter === undefined) return null;
  // Normalized for the same reason nip86.ts normalizes a blockip
  // argument (src/ip.ts): one address must not get two allowances by
  // arriving in two spellings. Cloudflare sends a canonical form today,
  // so this is belt-and-braces rather than a live bug.
  const key = normalizeIp(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return new Response(
    JSON.stringify({ error: "rate limited", retryAfterSeconds: HTTP_RATE_LIMIT_PERIOD_SECONDS }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(HTTP_RATE_LIMIT_PERIOD_SECONDS),
      },
    },
  );
}

async function handleClaim(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

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
  //
  // Goes through the cache (profile-lookup.ts lookupProfileCached) so the
  // submit reuses whatever /api/profile already fetched for the same
  // pubkey moments earlier -- the claim form looks up the profile as you
  // type it and then again on submit, which is the same question asked
  // twice within seconds.
  const normalized = typeof rawPubkey === "string" ? normalizePubkey(rawPubkey) : null;

  // Everything that can refuse this call runs before the outbound lookup,
  // because /api/claim has the same amplifier shape /api/profile did: it
  // opens two WebSockets to relay.damus.io and nos.lol
  // (profile-lookup.ts), and it stayed permanently open to anyone long
  // after the one claim it exists for had happened. A claimed relay
  // answered 409 -- but only after making those two connections on behalf
  // of whoever asked. Now a call that cannot possibly succeed costs at
  // most one indexed read and no outbound traffic at all.
  //
  // These three checks mirror claim()'s own first three, in the same
  // order, and none of them replaces it: claim() remains the authority.
  // The Durable Object is single-threaded, so the check-then-write inside
  // it is what actually makes TOFU atomic, and it still answers
  // "conflict" if it loses a race this pre-check could not have seen.
  if (env.OWNER_PUBKEY) return new Response("not found", { status: 404 });
  if (normalized === null) return json({ error: "invalid pubkey: expected npub1... or 64-char hex" }, 400);
  if ((await relayStub(env).getOwner()) !== null) return json({ error: "already claimed" }, 409);

  const profile = await lookupProfileCached(normalized);

  const result = await relayStub(env).claim(rawPubkey, profile ?? undefined, new URL(request.url).host);
  switch (result.status) {
    case "disabled":
      // CLAUDE.md "What it is": "If OWNER_PUBKEY is set in
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
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

  // Read the body as bytes before anything else: the NIP-98 `payload`
  // tag binds the SHA256 of exactly these bytes, so they are hashed
  // as-sent, before any decoding or parsing can normalize them.
  const body = new Uint8Array(await request.arrayBuffer());

  // Verify first, touch the Durable Object second, and the order is the
  // whole point. This used to fetch the owner before looking at the
  // Authorization header at all, so a POST with no header -- or no body,
  // or a header full of nonsense -- still woke the object from
  // hibernation and spent a request against the daily 100,000. An
  // unauthenticated flood therefore cost a DO wake each, at no cost to
  // the sender. Exactly the shape of the gift wrap gate probe
  // (CLAUDE.md "The budget"): an expensive operation sitting on the far
  // side of no gate.
  //
  // Now the DO is reached only by a caller who has already produced a
  // valid schnorr signature over this exact method, URL and body. That
  // still is not proof of *ownership* -- anyone can sign their own
  // event -- but it is proof of work no flood gets for free, and the
  // rate limiter above bounds what remains.
  const auth = verifyNip98(request, body, Math.floor(Date.now() / 1000));
  if (!auth.ok) {
    // nips/98.md: "Failed validation should return a 401 Unauthorized
    // response." The reason travels in the body rather than being
    // swallowed -- every failure mode here (clock skew, a wrong `u` tag,
    // the wrong key) is something the operator can fix in seconds once
    // told which one it was, and guessing at it otherwise.
    return managementResponse({ error: auth.reason }, 401);
  }

  // The first DO round trip of the request, and the last thing standing
  // between a valid signature and a management call.
  const denial = ownerReason(auth.pubkey, await relayStub(env).getOwner());
  if (denial !== null) return managementResponse({ error: denial }, 401);

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
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

  const stats = await relayStub(env).getStats(new URL(request.url).host);
  return json(stats);
}

// The claim form's courtesy profile preview, and nothing else: you paste
// a pubkey, it shows you the name and avatar attached to it so you can
// see it is yours before binding the relay to it permanently. A typo
// guard for a one-time, irreversible setup step (CLAUDE.md "What it is").
//
// Which means it is a setup endpoint, and it is now scoped to setup. It
// used to be permanently open: unauthenticated, uncached, and opening two
// outbound WebSockets to relay.damus.io and nos.lol per request
// (profile-lookup.ts). A flood spent the day's 100,000 requests and the
// duration budget, and -- the part that is not ours to spend -- pointed
// this deployment's IP at third-party relays on demand, making it an
// amplifier toward the same infrastructure backfill and the claim-time
// lookup depend on. Getting throttled or blocked by damus for traffic a
// stranger caused is a failure this relay cannot fix from its own side.
//
// It cannot be authenticated -- during a TOFU claim there is by
// definition no owner to authenticate against, which is the whole premise
// (ownership.ts). So the available scope is time, not identity: it
// answers while the relay is unclaimed and 404s the moment it is not,
// which is the same window the claim form itself is rendered in
// (public/index.html switches to the claimed view off /api/stats). On a
// claimed relay -- which is every relay, for all but the first few
// minutes of its life -- this path no longer reaches the network at all.
//
// Ordering: the free format check, then ownership, then the fetch. The
// ownership check is a DO round trip and the cache lookup is free, but
// the cache is deliberately consulted *after* it. Serving a cached answer
// to a claimed relay would leave the endpoint open for the cache's
// lifetime after the thing that justified it ended.
async function handleProfile(request: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(env.RATE_LIMIT_PROFILE, request);
  if (limited !== null) return limited;

  const pubkey = new URL(request.url).searchParams.get("pubkey");
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ error: "expected a ?pubkey= hex query param" }, 400);
  }

  // 404, matching /api/claim's disabled branch above rather than
  // inventing a second vocabulary for "this endpoint is not part of this
  // relay any more". A claimed relay has no profile endpoint.
  if ((await relayStub(env).getOwner()) !== null) {
    return new Response("not found", { status: 404 });
  }

  const profile = await lookupProfileCached(pubkey);
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
    // Rate limited like the rest: serving this document is a DO round
    // trip (getIdentity), and nothing about an Accept header makes the
    // caller trustworthy.
    const limited = await rateLimited(env.RATE_LIMIT_API, request);
    if (limited !== null) return limited;
    const { profile, settings, ownerPubkey, relayPubkey } = await relayStub(env).getIdentity(url.host);
    return nip11Response(env, settings, profile, ownerPubkey, relayPubkey);
  }

  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    // The upgrade is an HTTP request and it wakes the Durable Object;
    // the per-IP throttle in relay.ts only starts counting once the
    // connection exists, so a connect-and-drop loop paid nothing before
    // this. Bounding connects per minute rather than messages is the
    // right axis here -- a client that stays connected is not the
    // problem, and is not charged for staying.
    const limited = await rateLimited(env.RATE_LIMIT_API, request);
    if (limited !== null) return limited;
    return relayStub(env).fetch(request);
  }

  if (url.pathname === "/api/claim") return handleClaim(request, env);
  if (url.pathname === "/api/stats") return handleStats(request, env);
  if (url.pathname === "/api/profile") return handleProfile(request, env);

  return env.ASSETS.fetch(request);
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
