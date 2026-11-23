import { runBackfillTick } from "./backfill-worker";
import { runNetworkTick } from "./network-worker";
import { logExhaustion } from "./exhaustion";
import {
  HTTP_RATE_LIMIT_PERIOD_SECONDS,
  photoMaxBytes,
  photoStorageBytes,
  secondsUntilUtcMidnight,
  VAULT_OPEN_FLOOR_MS,
} from "./limits";
import {
  extensionFor,
  type PhotoType,
  SEALED_PHOTO_TYPE,
  sha256Hex,
  sniffPhotoType,
  verifyBlossomAuth,
} from "./photos";
import {
  ADMIN_CALLABLE_METHODS,
  ANYONE_CALLABLE_METHODS,
  GUEST_PUSH_METHODS,
  MANAGEMENT_CONTENT_TYPE,
  MEMBER_CALLABLE_METHODS,
  NOT_A_MEMBER_REASON,
  STORAGE_CALLABLE_METHODS,
  STORAGE_ONLY_REASON,
  UNSIGNED_METHODS,
  adminOnlyReason,
  type ManagementResponse,
} from "./nip86";
import { VAULT_NOT_FOUND } from "./vault";
import { checkOwnKeyProof } from "./own-keys";
import { nip11Response } from "./nip11";
import { verifyClaimAuthEvent } from "./nip42";
import { ownerReason, verifyNip98 } from "./nip98";
import { lookupProfileCached } from "./profile-lookup";
import { normalizeIp } from "./ip";
import { normalizePubkey } from "./pubkey";
import { relayStub } from "./relay-stub";
import { cachedUpstreamVersion, describeUpdate, updateCheckEnabled } from "./upstream-version";

export { Relay } from "./relay";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// json() plus CORS_HEADERS, for POST /api/claim-signed. CORS_HEADERS is
// declared further down; safe, since nothing calls this before the module
// has finished evaluating.
function corsJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// Per-IP HTTP rate limiting via Cloudflare's Rate Limiting binding, which
// runs before the Durable Object is reached. Limits and their reasoning
// live in wrangler.jsonc; nothing here restates them.
//
// Returns a 429, or null to continue. Called per handler rather than at
// the top of route(), so static assets (env.ASSETS: free, unmetered, never
// touch the DO) are not limited.
//
// An absent binding means "allowed" (see env.d.ts): refusing every
// request because a binding did not provision would be worse than no
// limit.
async function rateLimited(
  limiter: RateLimit | undefined,
  request: Request,
): Promise<Response | null> {
  if (limiter === undefined) return null;
  // Normalized (src/ip.ts) so one address cannot get two allowances under
  // two spellings.
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
  // Present when the claim comes from the phone that scanned the admin
  // page's QR (ownership.ts claimWithNonce). Authenticates nothing; it
  // lets /api/claim-status tell the desktop page its QR landed.
  const rawNonce = (body as { nonce?: unknown } | null)?.nonce;
  // Normalized here as well as in claim() so the Worker knows which
  // profile to look up: the lookup opens outbound WebSockets, which must
  // happen in the Worker, never the DO (an outbound socket pins the DO in
  // memory for up to 15 minutes; see profile-lookup.ts). Cached, so the
  // submit reuses the /api/profile preview fetched seconds earlier.
  const normalized = typeof rawPubkey === "string" ? normalizePubkey(rawPubkey) : null;

  // Everything that can refuse runs before the outbound lookup, so a
  // claim that cannot succeed (e.g. on an already claimed relay) costs at
  // most one indexed read and opens no connections to third-party relays
  // on a stranger's behalf.
  //
  // These mirror claim()'s checks in the same order (the code's liveness
  // is a storage question only claim() answers), but claim() remains the
  // authority: its check-then-write in the single-threaded DO is what
  // makes TOFU atomic, and it answers "conflict" on a race this pre-check
  // could not see.
  if (env.OWNER_PUBKEY) return new Response("not found", { status: 404 });
  if (normalized === null) return json({ error: "invalid pubkey: expected npub1... or 64-char hex" }, 400);
  if (rawNonce !== undefined && (typeof rawNonce !== "string" || rawNonce.length === 0 || rawNonce.length > 64)) {
    return json({ error: "malformed claim code" }, 400);
  }
  if ((await relayStub(env).getOwner()) !== null) return json({ error: "already claimed" }, 409);

  const profile = await lookupProfileCached(normalized);

  const result = await relayStub(env).claim(
    rawPubkey,
    profile ?? undefined,
    new URL(request.url).host,
    rawNonce,
  );
  switch (result.status) {
    case "disabled":
      // OWNER_PUBKEY set: the claim endpoints do not exist.
      return new Response("not found", { status: 404 });
    case "invalid":
      return json({ error: "invalid pubkey: expected npub1... or 64-char hex" }, 400);
    case "conflict":
      return json({ error: "already claimed" }, 409);
    case "invalid-nonce":
      return json({ error: "this claim code has expired or was already used -- generate a new one" }, 410);
    case "claimed":
      return json({ pubkey: result.pubkey });
  }
}

// POST /api/claim-nonce: called by bothy's own admin page (same origin)
// when the owner presses the button to show a claim QR, never on page
// load. An unclaimed relay is public, so minting per view would let a
// crawler write rows for free. Mints the code the QR carries; see
// ownership.ts issueClaimNonce.
async function handleClaimNonce(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

  // Before the DO is touched, as in /api/claim.
  if (env.OWNER_PUBKEY) return new Response("not found", { status: 404 });

  const result = await relayStub(env).issueClaimNonce();
  switch (result.status) {
    case "disabled":
      return new Response("not found", { status: 404 });
    case "conflict":
      return json({ error: "already claimed" }, 409);
    case "limited":
      return json(
        { error: "blocked: too many claim codes outstanding -- wait for one to expire and try again" },
        429,
      );
    case "issued":
      return json({ nonce: result.nonce, exp: result.expiresAt });
  }
}

// POST /api/claim-signed: a proof-of-possession claim. The body is a
// signed kind-22242 NIP-42 AUTH event naming a code from /api/claim-nonce
// and this relay's host (checklist: nip42.ts verifyClaimAuthEvent). No
// signer app implements this yet; it is kept for one that does (e.g.
// over NIP-46).
//
// CORS-enabled, unlike the other claim endpoints, because a web-based
// signer calls it from its own origin. Safe for the same reason as the
// management endpoint (see CORS_HEADERS): the body is a signed event and
// there is no cookie or session to borrow.
async function handleClaimSigned(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

  if (env.OWNER_PUBKEY) return new Response("not found", { status: 404 });

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return corsJson({ error: "malformed request body" }, 400);
  }

  const host = new URL(request.url).host;
  const verified = verifyClaimAuthEvent(raw, host, Math.floor(Date.now() / 1000));
  if (!verified.ok) return corsJson({ error: verified.reason }, 400);

  const result = await relayStub(env).claimSigned(verified.challenge, verified.pubkey, host);
  switch (result.status) {
    case "disabled":
      return new Response("not found", { status: 404 });
    case "invalid-nonce":
      return corsJson({ error: "unknown or expired claim code -- generate a new QR and try again" }, 400);
    case "conflict":
      return corsJson({ error: "already claimed" }, 409);
    case "claimed":
      return corsJson({ pubkey: result.pubkey });
  }
}

// GET /api/claim-status?nonce=: polled by the admin page while a QR is
// shown. Answers after the claim too (unlike /api/profile): the page's
// last poll must see the claim land rather than a 404, and the answer
// reveals nothing sensitive.
async function handleClaimStatus(request: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

  if (env.OWNER_PUBKEY) return new Response("not found", { status: 404 });

  const nonce = new URL(request.url).searchParams.get("nonce");
  if (!nonce) return json({ error: "expected a ?nonce= query param" }, 400);

  const status = await relayStub(env).getClaimStatus(nonce);
  return json({ status });
}

// NIP-86 relay management (nips/86.md), Worker-side half: verify the
// NIP-98 event over the body, then hand the call to the Durable Object
// (src/nip86.ts handleManagementCall).
//
// Verification lives here so a forged request costs no DO time. The DO's
// manage() RPC does no authentication of its own: this function must stay
// its only caller.
//
// Never consults `blocked_ips`, so an operator who blocks their own
// address can still call unblockip.
async function handleManagement(request: Request, env: Env): Promise<Response> {
  // vaultopen's time floor counts from here (handleUnsignedVault).
  const arrivedAt = Date.now();
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

  // Read the body as bytes before anything else: the NIP-98 `payload`
  // tag binds the SHA256 of exactly these bytes, so they are hashed
  // as-sent, before any decoding or parsing can normalize them.
  const body = new Uint8Array(await request.arrayBuffer());

  // The restore vault's unsigned methods (nip86.ts UNSIGNED_METHODS) take
  // no NIP-98 header at all, and any header sent is ignored.
  const unsigned = unsignedVaultCall(body);
  if (unsigned !== null) return handleUnsignedVault(request, env, unsigned, arrivedAt);

  // Verify BEFORE touching the Durable Object. Otherwise a POST with no
  // valid header still wakes the DO and spends one of the day's 100,000
  // requests, free for the sender. A valid signature over this exact
  // request is not proof of ownership, but no flood gets it for free.
  const auth = verifyNip98(request, body, Math.floor(Date.now() / 1000));
  if (!auth.ok) {
    // 401 per nips/98.md, with the reason in the body.
    return managementResponse({ error: auth.reason }, 401);
  }

  // Parsed before the owner round trip (it is free) because the method
  // name decides which gate applies: subscribepush/unsubscribepush are
  // callable by members too (nip86.ts MEMBER_CALLABLE_METHODS), and
  // redeeminvite by anyone (ANYONE_CALLABLE_METHODS).
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return managementResponse({ error: "request body is not valid JSON" });
  }
  const call = parsed as { method?: unknown; params?: unknown } | null;
  const params = Array.isArray(call?.params) ? (call.params as unknown[]) : [];

  // redeeminvite skips both gates below: its caller is not a member yet,
  // and the invite code, checked in the DO, is the authority. The
  // signature still had to verify, so the pubkey it joins is the signer's.
  const method = typeof call?.method === "string" ? call.method : null;
  const anyoneCallable = method !== null && ANYONE_CALLABLE_METHODS.includes(method);

  // memberkeys answers the storage service's key and no other, the owner
  // included: it is a machine's read of the member list, not a person's.
  if (method !== null && STORAGE_CALLABLE_METHODS.includes(method)) {
    if (!(await relayStub(env).isStorageService(auth.pubkey))) {
      return managementResponse({ error: method === "memberkeys" ? STORAGE_ONLY_REASON : `${method} is only for this home's box` }, 401);
    }
    return managementResponse(
      await relayStub(env).manage(call?.method, params, request.headers.get("CF-Connecting-IP") ?? "unknown", auth.pubkey),
    );
  }

  // The first DO round trip of the request.
  const denial = anyoneCallable ? null : ownerReason(auth.pubkey, await relayStub(env).getOwner());
  if (denial !== null) {
    // A non-owner passes only if the method is admin- or member-callable
    // AND the signer has that role, checked in that order: the first is
    // free, the second is another round trip, so a stranger signing
    // `banpubkey` costs no extra. relay.ts getRole: owner, admin, member
    // (of the relay, or of the group `_`) or none.
    //
    // An unclaimed relay has no members, so this refuses there whatever
    // the method.
    const adminCallable = method !== null && ADMIN_CALLABLE_METHODS.includes(method);
    const memberCallable = method !== null && MEMBER_CALLABLE_METHODS.includes(method);
    if (!adminCallable && !memberCallable) return managementResponse({ error: denial }, 401);
    const role = await relayStub(env).getRole(auth.pubkey);
    let allowed = adminCallable ? role === "admin" : role === "admin" || role === "member";
    // A home group's guest (on a group's roster here, not in the home) may
    // register and drop their own devices, so the group can wake them.
    if (!allowed && role === "none" && GUEST_PUSH_METHODS.includes(method!)) {
      allowed = await relayStub(env).isGroupGuest(auth.pubkey);
    }
    if (!allowed) {
      // A member's own methods refuse a non-member with their own reason:
      // this is how an app learns its user has lost their home here (a
      // removed member's subscribepush or unsubscribepush), and "not
      // signed by the owner" would not tell it. An admin's methods say
      // which role they need.
      const reason = memberCallable ? NOT_A_MEMBER_REASON : adminOnlyReason(method!);
      return managementResponse({ error: reason }, 401);
    }
  }

  // addmykey's second signature, the other key's proof, is checked here
  // like the first, before the Durable Object (src/own-keys.ts).
  if (method === "addmykey") {
    const refusal = checkOwnKeyProof(params, auth.pubkey, new URL(request.url).host, nowSec());
    if (refusal !== null) return managementResponse({ error: refusal });
  }

  const result = await relayStub(env).manage(
    call?.method,
    params,
    request.headers.get("CF-Connecting-IP") ?? "unknown",
    // The pubkey the signature proved, not one the body offered -- see
    // nip86.ts handleManagementCall and schema.ts `push_subscriptions`.
    auth.pubkey,
  );
  return managementResponse(result);
}

// The method and params of a vaultchallenge or vaultopen call, or null for
// anything else (which then goes through NIP-98 as usual).
function unsignedVaultCall(body: Uint8Array): { method: string; params: unknown[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const call = parsed as { method?: unknown; params?: unknown } | null;
  if (typeof call?.method !== "string" || !UNSIGNED_METHODS.includes(call.method)) return null;
  return { method: call.method, params: Array.isArray(call.params) ? (call.params as unknown[]) : [] };
}

// vaultchallenge and vaultopen (src/vault.ts). Every vaultopen answer,
// found or not, rate limited or not, leaves no sooner than
// VAULT_OPEN_FLOOR_MS after the request arrived, so the row lookup and
// the signature check behind it cannot be timed.
async function handleUnsignedVault(
  request: Request,
  env: Env,
  call: { method: string; params: unknown[] },
  arrivedAt: number,
): Promise<Response> {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (call.method === "vaultchallenge") {
    return managementResponse(await relayStub(env).vaultChallenge(ip));
  }
  let reply: ManagementResponse;
  try {
    reply = await relayStub(env).vaultOpen(call.params, ip);
  } catch {
    reply = { error: VAULT_NOT_FOUND };
  }
  const wait = VAULT_OPEN_FLOOR_MS - (Date.now() - arrivedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  return managementResponse(reply);
}

// ---------------------------------------------------------------------
// CORS on the management endpoint (and on /api/claim-signed via
// corsJson). Safe, and must not be removed as an oversight.
//
// Every management call is authenticated by a NIP-98 signature over this
// exact method, URL and body, carried in a header a page must construct
// deliberately. There is no cookie, session or other ambient authority
// for a cross-origin request to borrow, which is what the same-origin
// policy protects. `*` rather than a reflected origin: with no credentials
// there is no origin to keep secret, and a wildcard cannot be combined
// with credentials. A preflight reveals only that the endpoint exists,
// which NIP-11 `supported_nips` already advertises.
//
// Without it the API works only from a page this relay served; hearth is
// served from GitHub Pages, so its management calls (invites, push
// subscription) would fail in the browser.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  // GET, HEAD, PUT and DELETE for the photo server (src/photos.ts), whose
  // Blossom clients run in browsers on other origins like every NIP-86
  // client does, and whose auth is a signed header in the same way.
  "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, POST, OPTIONS",
  // The two headers a NIP-86 call sets; both are non-simple
  // (application/nostr+json+rpc is not a CORS-safelisted media type).
  // The X- ones are Blossom's upload headers (BUD-06).
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-SHA-256, X-Content-Type, X-Content-Length",
  // Blossom puts the reason for a refusal here (BUD-01).
  "Access-Control-Expose-Headers": "X-Reason",
  // A day, so repeated calls preflight once rather than doubling every
  // request against the per-IP allowance.
  "Access-Control-Max-Age": "86400",
};

// The preflight, answered for any path: the management endpoint is the
// relay root (nips/86.md), and an OPTIONS request carries no Content-Type,
// so route()'s management branch cannot recognise it and it would
// otherwise fall through to the asset handler's 405.
//
// NOT rate limited: it reaches no DO and reads nothing, and counting it
// would halve a preflighting client's per-IP allowance.
function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// ---------------------------------------------------------------------
// Profile photos (src/photos.ts): Blossom's GET/HEAD /<sha256>, PUT
// /upload and DELETE /<sha256>. Null when the request is none of those,
// so route() carries on. Everything that can be checked without the
// Durable Object (rate, size, signature, type) is checked here first, so
// a refused upload costs no DO time.
// ---------------------------------------------------------------------

const PHOTO_PATH = /^\/([0-9a-f]{64})(?:\.(?:jpg|jpeg|png|webp))?$/;

function photoError(status: number, reason: string): Response {
  return new Response(reason, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "X-Reason": reason, ...CORS_HEADERS },
  });
}

async function routePhotos(request: Request, env: Env, url: URL): Promise<Response | null> {
  const blob = PHOTO_PATH.exec(url.pathname);
  const isUpload = url.pathname === "/upload";
  if (blob === null && !isUpload) return null;
  if (photoStorageBytes(env) === null) return photoError(404, "this relay stores no photos");

  if (blob !== null && (request.method === "GET" || request.method === "HEAD")) {
    const limited = await rateLimited(env.RATE_LIMIT_PHOTOS, request);
    if (limited !== null) return limited;
    const photo = await relayStub(env).getPhoto(blob[1]!);
    if (photo === null) return photoError(404, "no photo with that hash is stored here");
    return new Response(request.method === "HEAD" ? null : photo.data, {
      headers: {
        "Content-Type": photo.type,
        "Content-Length": String(photo.data.byteLength),
        // Content-addressed: the bytes behind a hash never change.
        "Cache-Control": "public, max-age=31536000, immutable",
        ...CORS_HEADERS,
      },
    });
  }

  if (blob !== null && request.method === "DELETE") {
    const limited = await rateLimited(env.RATE_LIMIT_API, request);
    if (limited !== null) return limited;
    const sha256 = blob[1]!;
    const auth = verifyBlossomAuth(request.headers.get("Authorization"), "delete", sha256, nowSec());
    if (!auth.ok) return photoError(401, auth.reason);
    if (!(await relayStub(env).deletePhoto(auth.pubkey, sha256))) {
      return photoError(404, "you have no photo with that hash here");
    }
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (isUpload && request.method === "PUT") {
    const limited = await rateLimited(env.RATE_LIMIT_API, request);
    if (limited !== null) return limited;
    const max = photoMaxBytes(env);
    const declared = Number(request.headers.get("Content-Length") ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      return photoError(413, `a photo here can be at most ${max} bytes`);
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > max) return photoError(413, `a photo here can be at most ${max} bytes`);
    if (bytes.byteLength === 0) return photoError(400, "the upload is empty");
    const sha256 = await sha256Hex(bytes);
    const auth = verifyBlossomAuth(request.headers.get("Authorization"), "upload", sha256, nowSec());
    if (!auth.ok) return photoError(401, auth.reason);
    const sniffed = sniffPhotoType(bytes);
    const claimed = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
    // Bytes that are no image are a sealed photo (photos.ts
    // SEALED_PHOTO_TYPE) when sent as one; the Durable Object then takes
    // them from members only.
    const type: PhotoType | null = sniffed ?? (claimed === SEALED_PHOTO_TYPE ? SEALED_PHOTO_TYPE : null);
    if (type === null) {
      return photoError(415, "only JPEG, PNG and WebP photos are stored here");
    }
    if (sniffed !== null && claimed && claimed !== SEALED_PHOTO_TYPE && claimed !== sniffed) {
      return photoError(415, `the bytes are ${sniffed}, not ${claimed}`);
    }
    const stored = await relayStub(env).uploadPhoto(auth.pubkey, sha256, type, bytes);
    if (stored.status !== 200) return photoError(stored.status, stored.reason);
    // BUD-02 blob descriptor.
    return new Response(
      JSON.stringify({
        url: `${url.origin}/${sha256}${extensionFor(type)}`,
        sha256,
        size: bytes.byteLength,
        type,
        uploaded: stored.uploadedAt,
      }),
      { headers: { "Content-Type": "application/json", ...CORS_HEADERS } },
    );
  }

  return photoError(405, "photos are fetched with GET, uploaded with PUT /upload and deleted with DELETE");
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function managementResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": MANAGEMENT_CONTENT_TYPE, ...CORS_HEADERS },
  });
}

async function handleStats(request: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(env.RATE_LIMIT_API, request);
  if (limited !== null) return limited;

  // The "newer bothy available" check (src/upstream-version.ts) runs here
  // in the Worker, not in getStats: it is an outbound request, which the
  // DO must not make on a read path (it costs duration and blocks
  // hibernation).
  //
  // Started before the DO round trip and awaited after, so they overlap
  // (bounded by UPSTREAM_VERSION_TIMEOUT_MS). It never rejects
  // (cachedUpstreamVersion answers null on failure). Compared against the
  // version getStats reports, so package.json stays the one source.
  const upstream = updateCheckEnabled(env) ? cachedUpstreamVersion() : Promise.resolve(null);

  const stats = await relayStub(env).getStats(new URL(request.url).host);

  return json({ ...stats, ...describeUpdate(await upstream, stats.version) });
}

// The claim form's profile preview: shows the name and avatar for a
// pasted pubkey, as a typo guard before the irreversible claim.
//
// Each cache miss opens two outbound WebSockets to third-party relays
// (profile-lookup.ts), so an open endpoint would make this deployment an
// amplifier toward relays that backfill and the claim lookup depend on.
// It cannot be authenticated (there is no owner yet), so it is scoped by
// time instead: it answers only while the relay is unclaimed and 404s
// after. Also rate limited at a sixth of the other paths.
//
// The owner check runs BEFORE the cache, though the cache is free:
// serving cached answers on a claimed relay would keep the endpoint open
// for the cache's lifetime.
async function handleProfile(request: Request, env: Env): Promise<Response> {
  const limited = await rateLimited(env.RATE_LIMIT_PROFILE, request);
  if (limited !== null) return limited;

  const pubkey = new URL(request.url).searchParams.get("pubkey");
  if (!pubkey || !/^[0-9a-f]{64}$/.test(pubkey)) {
    return json({ error: "expected a ?pubkey= hex query param" }, 400);
  }

  // 404, as /api/claim answers when disabled.
  if ((await relayStub(env).getOwner()) !== null) {
    return new Response("not found", { status: 404 });
  }

  const profile = await lookupProfileCached(pubkey);
  return json({ profile });
}

// The routing table, separate from `fetch` so the exhaustion wrapper there
// covers it.
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // First: an OPTIONS request carries neither the Content-Type nor the
  // Accept header the branches below test (see preflightResponse).
  if (request.method === "OPTIONS") return preflightResponse();

  // NIP-86 BEFORE NIP-11: "application/nostr+json+rpc" contains
  // "application/nostr+json", so a management client that also sends that
  // Accept header would otherwise get the info document. Substring match,
  // since clients send e.g. "application/nostr+json+rpc; charset=utf-8".
  if (
    request.method === "POST" &&
    request.headers.get("Content-Type")?.includes(MANAGEMENT_CONTENT_TYPE)
  ) {
    return handleManagement(request, env);
  }

  // Substring match: clients send compound Accept headers
  // ("application/nostr+json, */*").
  if (request.headers.get("Accept")?.includes("application/nostr+json")) {
    // Rate limited: serving this is a DO round trip (getIdentity).
    const limited = await rateLimited(env.RATE_LIMIT_API, request);
    if (limited !== null) return limited;
    const { profile, settings, ownerPubkey, relayPubkey, memberCount, photoBytes } = await relayStub(env).getIdentity(
      url.host,
    );
    return nip11Response(env, settings, profile, ownerPubkey, relayPubkey, memberCount, {
      url: `${url.origin}/`,
      usedBytes: photoBytes,
    });
  }

  if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
    // The upgrade wakes the DO, and relay.ts's per-IP message throttle
    // only counts once a connection exists, so this is what bounds a
    // connect-and-drop loop. Connects are limited, not staying connected.
    const limited = await rateLimited(env.RATE_LIMIT_API, request);
    if (limited !== null) return limited;
    return relayStub(env).fetch(request);
  }

  const photos = await routePhotos(request, env, url);
  if (photos !== null) return photos;

  if (url.pathname === "/api/claim") return handleClaim(request, env);
  if (url.pathname === "/api/claim-nonce") return handleClaimNonce(request, env);
  if (url.pathname === "/api/claim-signed") return handleClaimSigned(request, env);
  if (url.pathname === "/api/claim-status") return handleClaimStatus(request, env);
  if (url.pathname === "/api/stats") return handleStats(request, env);
  if (url.pathname === "/api/profile") return handleProfile(request, env);

  return env.ASSETS.fetch(request);
}

export default {
  // Wrapped as a whole: when a Cloudflare free-tier allowance is used up,
  // every DO path fails at once while the static admin page still loads,
  // so the failure must be named (src/exhaustion.ts) to be diagnosable.
  // Non-exhaustion errors are logged and rethrown, never turned into a
  // quiet 503.
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      const verdict = logExhaustion(`fetch ${new URL(request.url).pathname}`, err);
      if (!verdict.exhausted) throw err;
      // 503 with Retry-After, not 500: a temporary refusal with a known
      // end (allowances reset at 00:00 UTC).
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

  // The hourly tick: the DO's maintenance (Relay.runCron) and backfill,
  // which share one trigger rather than use a second of the account's 5
  // cron triggers. Backfill runs here in the Worker because it opens
  // outbound sockets (see backfill-worker.ts).
  //
  // Each is caught separately so one failing can never stop the other.
  // Both go through logExhaustion: the tick runs whether or not anyone is
  // connected, so it is usually the first thing to hit an exhausted
  // allowance.
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
    try {
      await runNetworkTick(env);
    } catch (err) {
      logExhaustion("scheduled: runNetworkTick", err);
    }
  },
} satisfies ExportedHandler<Env>;
