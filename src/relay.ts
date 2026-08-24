import { DurableObject } from "cloudflare:workers";
import {
  applyBackfillPage,
  type BackfillState,
  type BackfillStatus,
  getBackfillStatus,
  hasBackfillHeadroom,
  seedBackfillRelays,
} from "./backfill";
import { matchesAnyFilter, parseFilter } from "./filters";
import { recordHost } from "./host";
import {
  BACKFILL_PAGE_SIZE,
  clampFilterLimit,
  GIFT_WRAP_RATE_LIMIT_WINDOW_MS,
  isUnconstrainedFilter,
  LIVE_FEED_MAX_LIFETIME_MS,
  MAX_EVENTS_PER_REQ,
  MAX_GIFT_WRAP_BYTES,
  MAX_GIFT_WRAPS,
  MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
  MAX_LIVE_FEED_CONNECTIONS,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "./limits";
import { resolveIcon } from "./nip11";
import { type Filter, GIFT_WRAP_KIND, type NostrEvent, pTagValues, VANISH_KIND } from "./nostr";
import {
  allowFollowsEnabled,
  CONTACT_LIST_KIND,
  claimOwner,
  getOwnerPubkey,
  getOwnerProfile,
  isAllowedWriter,
  MUTE_LIST_KIND,
  refreshFollows,
  refreshMutes,
  refreshProfile,
} from "./ownership";
import type { Profile } from "./profile-lookup";
import { normalizePubkey } from "./pubkey";
import { initSchema } from "./schema";
import {
  applyDeletion,
  applyVanish,
  estimateRowsWritten24h,
  eventExists,
  expirationOf,
  giftWrapCount,
  isDeleted,
  queryFilter,
  queryFilters,
  storeEvent,
} from "./storage";
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";

// Replies to a client-level "ping" with "pong" entirely inside the
// runtime -- it does not wake this object or count against DO duration.
// See CLAUDE.md "Architecture".
const PING_PONG = new WebSocketRequestResponsePair("ping", "pong");

// Tag on the hibernation API's own connection registry (getWebSockets)
// that marks a socket as the admin page's live feed (ROADMAP.md chunk
// 7) rather than a nostr protocol client -- see handleLiveFeed below.
// Using acceptWebSocket's built-in tagging means broadcast() can find
// these sockets with ctx.getWebSockets(LIVE_FEED_TAG) without keeping a
// second, memory-only registry that would need reconstructing after
// hibernation.
const LIVE_FEED_TAG = "live-feed";

// Live feed connection state -- just the connect time, used by the DO
// alarm below to enforce LIVE_FEED_MAX_LIFETIME_MS server-side. Same
// attachment mechanism as ConnState (survives hibernation/eviction), but
// a distinct, smaller shape since a live feed socket has no subs/auth to
// track.
interface LiveFeedState {
  connectedAt: number;
}

function getLiveFeedState(ws: WebSocket): LiveFeedState {
  return (ws.deserializeAttachment() as LiveFeedState | null) ?? { connectedAt: Date.now() };
}

// NIP-42's own kind for AUTH events (nips/42.md).
const AUTH_KIND = 22242;
// How far a client's AUTH `created_at` may drift from "now" before it's
// rejected as stale -- NIP-42 doesn't fix a number, this mirrors the
// ~10 minute window other relays use.
const AUTH_MAX_DRIFT_SECONDS = 600;

// Per-connection subscriptions, keyed by subscription id, plus the
// connecting IP for per-IP throttling. Persisted via WebSocket
// attachment (not object memory) so it survives hibernation -- see
// CLAUDE.md "The budget" on why an in-memory-only map would be wrong
// here: the object can be evicted between messages on an otherwise idle
// connection, and the attachment is what's still there on the next one.
//
// `host` is this connection's own request host (captured at connect
// time from the upgrade request's URL), used to check NIP-42 AUTH and
// NIP-62 vanish `relay` tags against -- see relayTagMatchesHost below.
// `challenge`/`authedPubkey` back the real NIP-42 challenge/response flow
// gating gift wrap reads (ROADMAP.md chunk 6): a challenge is issued
// lazily, the first time a REQ needs one, not proactively at connect.
type Subscriptions = Record<string, Filter[]>;
interface ConnState {
  ip: string;
  host: string;
  subs: Subscriptions;
  challenge?: string;
  authedPubkey?: string;
}

function getState(ws: WebSocket): ConnState {
  return (ws.deserializeAttachment() as ConnState | null) ?? { ip: "unknown", host: "unknown", subs: {} };
}

function setState(ws: WebSocket, state: ConnState): void {
  ws.serializeAttachment(state);
}

// NIP-42 (nips/42.md "Signed Event Verification"): "checking if the
// domain name is correct should be enough." Also used for NIP-62's
// `relay` tag, which additionally allows the literal sentinel
// `ALL_RELAYS` (nips/62.md) -- checked by the caller, not here.
function relayTagMatchesHost(tagValue: string, host: string): boolean {
  try {
    return new URL(tagValue).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// Per-IP message rate limit (CLAUDE.md "Threat model": "Per-IP
// throttling inside the DO"). Deliberately in-memory rather than in
// SQLite: it's a best-effort abuse mitigation, not a correctness
// guarantee, so it's fine for it to reset on hibernation -- persisting
// it would cost rows-written for no real benefit.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_MESSAGES = 50;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function send(ws: WebSocket, message: unknown[]): void {
  ws.send(JSON.stringify(message));
}

function ok(ws: WebSocket, id: string, accepted: boolean, message: string): void {
  send(ws, ["OK", id, accepted, message]);
}

// Maps ownership.ts isAllowedWriter's rejection reasons to distinct
// NIP-01 OK messages, written for the person reading them in their
// client rather than for a developer reading logs. "muted" gets the
// `blocked:` prefix -- it's a permanent, person-specific refusal, not a
// generic access restriction -- everything else gets `restricted:` per
// NIP-01's own worked example (nips/01.md line 173).
function writeRejectionMessage(reason: "unclaimed" | "muted" | "not-follow" | "owner-only"): string {
  switch (reason) {
    case "unclaimed":
      return "restricted: relay has not been claimed yet";
    case "muted":
      return "blocked: this pubkey has been muted by the relay owner";
    case "not-follow":
      return "restricted: writes are limited to the owner and people the owner follows, and this pubkey isn't one of them";
    case "owner-only":
      return "restricted: writes are limited to the relay owner";
  }
}

export class Relay extends DurableObject<Env> {
  // Per-IP sliding window counters for webSocketMessage throttling --
  // see the RATE_LIMIT_* constants above for why this is memory, not
  // storage.
  private rateLimits = new Map<string, { windowStart: number; count: number }>();

  // Separate per-IP counter just for gift wrap writes (limits.ts
  // GIFT_WRAP_RATE_LIMIT_WINDOW_MS/MAX_GIFT_WRAPS_PER_IP_PER_WINDOW) --
  // the general rate limit above bounds connection-level message spam
  // across every frame type; this one specifically bounds rows-written
  // risk on the one write path anyone can use without being the owner.
  private giftWrapRateLimits = new Map<string, { windowStart: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initSchema(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(PING_PONG);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // Opportunistic: every real client connection passes through here,
    // so this is the most reliable single place to learn the
    // deployment's own host (src/host.ts) for backfill's self-skip.
    // recordHost is a no-op write once the host is already known.
    recordHost(this.ctx.storage.sql, new URL(request.url).host);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // The admin page's live feed (ROADMAP.md chunk 7) is a distinct,
    // push-only, unauthenticated channel -- not a nostr protocol
    // connection -- so it's routed to its own path rather than reusing
    // REQ/EVENT semantics. Keeping it separate means it never has to
    // satisfy isUnconstrainedFilter (CLAUDE.md "Threat model": reject
    // filters with no authors/kinds) just to see "everything," and the
    // gift-wrap NIP-42 read gate (handleReq below) never has to reason
    // about it: liveBroadcast unconditionally never sends kind 1059,
    // full stop, so there's no unauthenticated-viewer case to gate.
    if (new URL(request.url).pathname === "/live") {
      // Capped independently of the general per-IP/per-connection limits
      // above, which are tuned for the nostr protocol path -- this is an
      // unauthenticated, filter-less, always-broadcast channel, so its
      // own cap is what actually bounds worst-case broadcast fan-out
      // (liveBroadcast below iterates every open live socket per stored
      // event) and concurrent DO-side attachment state.
      if (this.ctx.getWebSockets(LIVE_FEED_TAG).length >= MAX_LIVE_FEED_CONNECTIONS) {
        return new Response("too many live feed connections", { status: 503 });
      }

      // acceptWebSocket (not server.accept()) is what makes this
      // connection hibernatable -- same reasoning as the tagged branch
      // below, see CLAUDE.md "Architecture".
      this.ctx.acceptWebSocket(server, [LIVE_FEED_TAG]);
      server.serializeAttachment({ connectedAt: Date.now() } satisfies LiveFeedState);
      await this.scheduleLiveFeedAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    // acceptWebSocket (not server.accept()) is what makes this connection
    // hibernatable. Calling accept() instead pins the object in memory
    // and bills DO duration for the connection's entire lifetime -- see
    // CLAUDE.md "Architecture".
    this.ctx.acceptWebSocket(server);
    setState(server, {
      ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
      host: new URL(request.url).host,
      subs: {},
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // TOFU claim: the first pubkey submitted here owns the relay,
  // permanently, with no signature check on the claim itself. This is
  // deliberate, not a shortcut -- a signature would buy no real security,
  // since every event is verified against its own signature regardless of
  // who owns the relay, so a wrong claim can never be used to forge
  // anything. The worst case of someone else claiming first is that the
  // relay archives a stranger's public notes at the real owner's expense,
  // and recovery is free: delete the Worker, deploy again. Requiring a
  // signature here would only move the hard step (proving control of a
  // key before you have anything working) onto this page, for a threat
  // that doesn't cost anything to recover from.
  //
  // RPC method, called directly by the Worker (src/index.ts) rather than
  // over fetch() -- this is the only code path that may write the `owner`
  // row (ownership.ts).
  async claim(
    rawPubkey: unknown,
    profile?: Profile,
    host?: string,
  ): Promise<{ status: "claimed" | "conflict" | "disabled" | "invalid"; pubkey?: string }> {
    if (this.env.OWNER_PUBKEY) return { status: "disabled" };
    if (typeof rawPubkey !== "string") return { status: "invalid" };
    const pubkey = normalizePubkey(rawPubkey);
    if (!pubkey) return { status: "invalid" };

    const sql = this.ctx.storage.sql;
    if (host) recordHost(sql, host);
    if (!claimOwner(sql, pubkey, profile)) return { status: "conflict" };
    return { status: "claimed", pubkey };
  }

  // Backs the NIP-11 document's name/icon (src/nip11.ts) -- derived from
  // the owner's kind 0 at claim time rather than a deploy-time var, see
  // ROADMAP.md chunk 5. Null when unclaimed, when OWNER_PUBKEY skips
  // storage entirely, or when the claim-time profile lookup failed; the
  // caller (nip11.ts) falls back to hardcoded defaults in all those cases.
  async getProfile(host?: string): Promise<{ name: string | null; picture: string | null } | null> {
    if (host) recordHost(this.ctx.storage.sql, host);
    return getOwnerProfile(this.ctx.storage.sql, this.env);
  }

  // Backs GET /api/stats (src/index.ts) -- see CLAUDE.md "Admin page".
  async getStats(host?: string): Promise<{
    claimed: boolean;
    ownerPubkey: string | null;
    totalEvents: number;
    events24h: number;
    storageBytes: number;
    rowsWrittenEstimate24h: number;
    backfill: BackfillStatus | null;
    icon: string | null;
    // Whether writes beyond the owner are currently possible at all
    // (CLAUDE.md "Writes are owner-gated"), plus the numbers that
    // back that state -- see the ALLOW_FOLLOWS-gate comment in
    // ownership.ts isAllowedWriter. Surfaced so an owner who enabled
    // ALLOW_FOLLOWS but never published a kind-3 here (an empty allowlist
    // that silently blocks every follow) has a visible signal instead of
    // a mystery.
    writePolicy: "owner" | "follows";
    followCount: number;
    followsRefreshedAt: number | null;
    // NIP-51 mute count -- see ownership.ts refreshMutes for why this is
    // only ever the public, unencrypted subset of what the owner has
    // muted in their own client.
    muteCount: number;
  }> {
    const sql = this.ctx.storage.sql;
    if (host) recordHost(sql, host);
    const owner = getOwnerPubkey(sql, this.env);
    const since = nowSeconds() - 86400;

    const totalEvents =
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events`).toArray()[0]?.n ?? 0;
    const events24h =
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE created_at > ?`, since).toArray()[0]
        ?.n ?? 0;
    const followCount =
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM follows`).toArray()[0]?.n ?? 0;
    const followsRefreshedAt =
      sql.exec<{ t: number | null }>(`SELECT MAX(fetched_at) AS t FROM follows`).toArray()[0]?.t ?? null;
    const muteCount = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM mutes`).toArray()[0]?.n ?? 0;

    return {
      claimed: owner !== null,
      ownerPubkey: owner,
      totalEvents,
      events24h,
      storageBytes: sql.databaseSize,
      rowsWrittenEstimate24h: estimateRowsWritten24h(sql, since),
      backfill: owner !== null ? getBackfillStatus(sql) : null,
      // Same source as the NIP-11 document's icon (src/nip11.ts
      // resolveIcon) -- the admin page uses this to set the browser
      // tab's favicon from the owner's kind-0 picture. Null falls back
      // to the static default favicon client-side.
      icon: resolveIcon(this.env, getOwnerProfile(sql, this.env)),
      writePolicy: allowFollowsEnabled(this.env) ? "follows" : "owner",
      followCount,
      followsRefreshedAt,
      muteCount,
    };
  }

  // Cron entry point (src/index.ts scheduled()) -- refreshes the
  // ALLOW_FOLLOWS cache, the NIP-51 mute cache, and, at most once/day, the
  // cached NIP-11/favicon icon from the owner's locally-stored kind-0
  // (ownership.ts refreshProfile). All are no-ops on their common paths
  // (feature off; empty list; already refreshed today), so this stays
  // cheap on most ticks.
  async runCron(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = nowSeconds();
    refreshFollows(sql, this.env, now);
    refreshMutes(sql, this.env, now);
    refreshProfile(sql, this.env, now);
  }

  // One-shot backfill (ROADMAP.md chunk 7), read side. Called once per
  // cron tick by backfill-worker.ts (the Worker, never this object,
  // opens the outbound sockets -- see that file's header comment) to
  // decide whether to discover relays, fetch a page, or do nothing. Null
  // when unclaimed -- there's no owner pubkey to backfill and no relay
  // list to discover yet.
  async getBackfillState(): Promise<BackfillState | null> {
    const sql = this.ctx.storage.sql;
    const owner = getOwnerPubkey(sql, this.env);
    if (owner === null) return null;
    const now = nowSeconds();
    return { ...getBackfillStatus(sql), ownerPubkey: owner, canIngestNow: hasBackfillHeadroom(sql, now) };
  }

  // Seeds backfill_relays from the owner's kind-10002 write relays, once
  // the Worker has resolved them from well-known relays (backfill-worker.ts
  // discoverWriteRelays). A pure write, no outbound connection here.
  async discoverBackfillRelays(relayUrls: string[]): Promise<void> {
    seedBackfillRelays(this.ctx.storage.sql, relayUrls, nowSeconds());
  }

  // Stores one page of raw EVENT payloads the Worker already fetched over
  // its own short-lived outbound socket (backfill-worker.ts fetchPage) --
  // see backfill.ts applyBackfillPage for validation/dedup/tombstone/
  // storage-semantics ordering. Null when unclaimed (shouldn't happen in
  // practice, since the Worker only calls this after getBackfillState
  // returned a real owner, but this object must not guess an owner that
  // doesn't exist).
  async ingestBackfillPage(
    relayUrl: string,
    rawEvents: unknown[],
  ): Promise<{ stored: number; exhausted: boolean } | null> {
    const sql = this.ctx.storage.sql;
    const owner = getOwnerPubkey(sql, this.env);
    if (owner === null) return null;
    return applyBackfillPage(sql, owner, relayUrl, rawEvents, BACKFILL_PAGE_SIZE, nowSeconds());
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    // The live feed (LIVE_FEED_TAG) is push-only and never has an
    // attachment set (setState is never called for it in fetch()) --
    // nothing it could legitimately send needs NIP-01 handling, so it's
    // routed away before frame parsing rather than falling through to
    // "unknown message type" against state meant for real relay clients.
    if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) return;

    if (this.isRateLimited(ws)) {
      send(ws, ["NOTICE", "rate-limited: slow down"]);
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      send(ws, ["NOTICE", "error: could not parse message"]);
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") {
      send(ws, ["NOTICE", "error: malformed message"]);
      return;
    }

    switch (frame[0]) {
      case "EVENT":
        this.handleEvent(ws, frame[1]);
        return;
      case "REQ":
        this.handleReq(ws, frame);
        return;
      case "CLOSE":
        this.handleClose(ws, frame[1]);
        return;
      case "AUTH":
        this.handleAuth(ws, frame[1]);
        return;
      default:
        send(ws, ["NOTICE", `error: unknown message type ${frame[0]}`]);
    }
  }

  // True when this connection's IP has sent too many messages within
  // the current window -- CLAUDE.md "Threat model": "Per-IP throttling
  // inside the DO."
  private isRateLimited(ws: WebSocket): boolean {
    const { ip } = getState(ws);
    const now = Date.now();
    const entry = this.rateLimits.get(ip);
    if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > RATE_LIMIT_MAX_MESSAGES;
  }

  private handleEvent(ws: WebSocket, raw: unknown): void {
    const event = parseEventShape(raw);
    if (!event) {
      send(ws, ["NOTICE", "error: malformed event"]);
      return;
    }

    // NIP-62 vanish requests and NIP-59 gift wraps each have their own,
    // entirely different authorization -- neither goes through
    // isAllowedWriter below (ROADMAP.md chunk 6). See handleVanish and
    // handleGiftWrap.
    if (event.kind === VANISH_KIND) {
      this.handleVanish(ws, event);
      return;
    }
    if (event.kind === GIFT_WRAP_KIND) {
      this.handleGiftWrap(ws, event);
      return;
    }

    // Ownership is checked before id/signature validity, not after.
    // Schnorr verification is the most expensive per-event operation
    // (CLAUDE.md "The budget": "the CPU risk") and a non-owner write is
    // rejected unconditionally regardless of whether it's well-formed --
    // there's no reason to pay for a check whose result can't change the
    // outcome. This also means a non-owner event with a bad id or bad
    // signature still gets "restricted:"/"blocked:", not "invalid:", which
    // is fine: NIP-01 doesn't require checking id/sig before authorization.
    const sql = this.ctx.storage.sql;
    const auth = isAllowedWriter(sql, this.env, event.pubkey);
    if (!auth.allowed) {
      ok(ws, event.id, false, writeRejectionMessage(auth.reason));
      return;
    }

    this.acceptEvent(ws, sql, event);
  }

  // NIP-59 (nips/59.md) Gift Wrap accept path -- ROADMAP.md chunk 6's one
  // deliberate exception to owner-only writes: any pubkey may write a
  // kind-1059 event as long as it p-tags the owner. CLAUDE.md "Threat
  // model" calls this out as "the only unauthenticated write path in the
  // project" and "the only unbounded write path" -- hence the extra
  // abuse controls below, on top of the general per-connection rate
  // limit already applied to every message in webSocketMessage.
  private handleGiftWrap(ws: WebSocket, event: NostrEvent): void {
    const sql = this.ctx.storage.sql;
    const owner = getOwnerPubkey(sql, this.env);
    if (owner === null) {
      ok(ws, event.id, false, "restricted: relay has not been claimed yet");
      return;
    }
    if (!pTagValues(event.tags).includes(owner)) {
      ok(ws, event.id, false, "restricted: gift wrap is not addressed to this relay's owner");
      return;
    }

    if (JSON.stringify(event).length > MAX_GIFT_WRAP_BYTES) {
      ok(ws, event.id, false, "blocked: gift wrap exceeds the maximum allowed size");
      return;
    }

    if (this.isGiftWrapRateLimited(getState(ws).ip)) {
      ok(ws, event.id, false, "rate-limited: too many gift wraps from this connection, slow down");
      return;
    }

    if (giftWrapCount(sql) >= MAX_GIFT_WRAPS) {
      ok(ws, event.id, false, "blocked: gift wrap inbox storage is full");
      return;
    }

    this.acceptEvent(ws, sql, event);
  }

  // See limits.ts GIFT_WRAP_RATE_LIMIT_WINDOW_MS/MAX_GIFT_WRAPS_PER_IP_PER_WINDOW
  // for why this is a separate counter from isRateLimited below.
  private isGiftWrapRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.giftWrapRateLimits.get(ip);
    if (!entry || now - entry.windowStart >= GIFT_WRAP_RATE_LIMIT_WINDOW_MS) {
      this.giftWrapRateLimits.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > MAX_GIFT_WRAPS_PER_IP_PER_WINDOW;
  }

  // NIP-62 (nips/62.md) Request to Vanish -- deliberately NOT routed
  // through isAllowedWriter. See storage.ts applyVanish's comment for why
  // a vanish request's authority comes from the requester vanishing
  // their own data, not from relay-write permission. Not stored as an
  // events row either way (the spec says relays MAY keep it for
  // bookkeeping, not MUST -- skipped here to avoid paying the row cost
  // for an action, not content).
  private handleVanish(ws: WebSocket, event: NostrEvent): void {
    // Relay-tag match is checked first, cheaply, before paying for a
    // hash or a schnorr verification on a request that isn't even meant
    // for this relay -- same CPU-ordering reasoning as the ownership
    // check in handleEvent above.
    const relayTags = event.tags
      .filter((t) => t[0] === "relay")
      .map((t) => t[1])
      .filter((v): v is string => v !== undefined);
    if (relayTags.length === 0) {
      ok(ws, event.id, false, "invalid: a vanish request must include a relay tag");
      return;
    }
    const { host } = getState(ws);
    const targetsThisRelay = relayTags.some((tag) => tag === "ALL_RELAYS" || relayTagMatchesHost(tag, host));
    if (!targetsThisRelay) {
      ok(ws, event.id, false, "invalid: relay tag does not name this relay");
      return;
    }

    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }
    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }

    applyVanish(this.ctx.storage.sql, event.pubkey, event.created_at);
    ok(ws, event.id, true, "");
  }

  // Shared tail of the write path once authorization is settled --
  // id/tombstone/signature/duplicate/expiration checks and storage.
  // Used by both the owner-gated path in handleEvent and handleGiftWrap
  // above, whose authorization is entirely different but converges here.
  private acceptEvent(ws: WebSocket, sql: SqlStorage, event: NostrEvent): void {
    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }

    // Checked before signature verification for the same CPU reason as
    // the ownership check above: a tombstoned id can never legitimately
    // be re-stored (NIP-09/NIP-62 durability -- schema.ts `deleted_ids`),
    // so there's no reason to pay for schnorr before rejecting it. This
    // is what makes gift wrap deletion actually mean something: the
    // sender still holds their own signed copy and can always resend it.
    if (isDeleted(sql, event.id)) {
      ok(ws, event.id, false, "blocked: this event was deleted and cannot be re-published");
      return;
    }

    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }

    if (eventExists(sql, event.id)) {
      ok(ws, event.id, true, "duplicate: already have this event");
      return;
    }

    const expiration = expirationOf(event);
    if (expiration !== null && expiration <= nowSeconds()) {
      ok(ws, event.id, false, "invalid: event already expired");
      return;
    }

    const result = storeEvent(sql, event);
    if (event.kind === 5 && result.stored) {
      applyDeletion(sql, event);
    }
    ok(ws, event.id, result.ok, result.message);

    if (result.stored) {
      // Refresh the follow/mute cache the instant the owner publishes a
      // new kind-3/kind-10000, rather than waiting up to an hour for the
      // next cron tick (docs/budget.md "NIP-51 mute list" and CLAUDE.md
      // "Owner-only writes"). Gated on `event.pubkey === owner`, not just
      // `event.kind` -- under ALLOW_FOLLOWS a follow can publish their own
      // kind-3 through this same accept path, and refreshFollows/
      // refreshMutes always re-derive from the *owner's* most recent event
      // regardless of whose write triggered the call, so this only costs
      // an extra check, never a wrong overwrite. Still, gating here means
      // a follow's own kind-3 can never even trigger a redundant refresh.
      const owner = getOwnerPubkey(sql, this.env);
      if (event.pubkey === owner) {
        const now = nowSeconds();
        if (event.kind === CONTACT_LIST_KIND) refreshFollows(sql, this.env, now);
        if (event.kind === MUTE_LIST_KIND) refreshMutes(sql, this.env, now);
      }
      this.broadcast(result.stored);
      this.liveBroadcast(result.stored);
    }
  }

  private handleReq(ws: WebSocket, frame: unknown[]): void {
    const subId = frame[1];
    if (typeof subId !== "string") {
      send(ws, ["NOTICE", "error: malformed REQ"]);
      return;
    }

    const state = getState(ws);
    if (!(subId in state.subs) && Object.keys(state.subs).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      send(ws, ["CLOSED", subId, "rate-limited: too many open subscriptions"]);
      return;
    }

    const filters: Filter[] = [];
    for (const raw of frame.slice(2)) {
      const filter = parseFilter(raw);
      if (!filter) {
        send(ws, ["CLOSED", subId, "error: malformed filter"]);
        return;
      }
      if (isUnconstrainedFilter(filter)) {
        send(ws, ["CLOSED", subId, "invalid: filter must have an authors or kinds constraint"]);
        return;
      }
      filters.push(clampFilterLimit(filter));
    }

    // NIP-42 gate on gift wrap reads (ROADMAP.md chunk 6, CLAUDE.md
    // "Threat model": "an anonymous query returns every DM envelope the
    // owner has received, leaking volume and timing"). Rather than
    // guessing which filter shapes (kinds/authors/ids/tags, in whatever
    // combination) could surface a kind-1059 row, ask storage directly:
    // re-run the filter restricted to kind 1059 and see if anything comes
    // back. An earlier version of this gate tried to reason about it
    // instead ("ids/authors alone can't leak, since a gift wrap's id/
    // pubkey is unguessable without already possessing it") and missed
    // that an ids-only filter naming a real, already-known gift wrap id
    // sailed straight through ungated -- true that nothing *new* leaks to
    // someone who already has the event, but that's not the rule ROADMAP.md
    // states ("Serve gift wraps only to the authenticated p-tagged
    // recipient", no exception for "unless you already know the id").
    // Reusing the real query engine here means the gate can't drift out
    // of sync with whatever storage.ts actually considers a match, the
    // way the hand-rolled version did. Cheap: one extra rows-read query
    // per filter, `limit: 1` since only existence matters, and skipped
    // entirely when `kinds` already rules out 1059 without touching
    // storage at all.
    const owner = getOwnerPubkey(this.ctx.storage.sql, this.env);
    const requestsGiftWraps = filters.some((f) => {
      if (f.kinds !== undefined) return f.kinds.includes(GIFT_WRAP_KIND);
      if (owner === null) return false;
      return queryFilter(this.ctx.storage.sql, { ...f, kinds: [GIFT_WRAP_KIND], limit: 1 }, nowSeconds())
        .length > 0;
    });
    if (requestsGiftWraps && state.authedPubkey !== owner) {
      if (state.authedPubkey === undefined) {
        if (!state.challenge) {
          state.challenge = crypto.randomUUID();
          setState(ws, state);
        }
        send(ws, ["AUTH", state.challenge]);
        send(ws, ["CLOSED", subId, "auth-required: authentication required to read gift wraps"]);
      } else {
        send(ws, ["CLOSED", subId, "restricted: not allowed to read gift wraps"]);
      }
      return;
    }

    state.subs[subId] = filters;
    setState(ws, state);

    const events = queryFilters(this.ctx.storage.sql, filters, nowSeconds()).slice(0, MAX_EVENTS_PER_REQ);
    for (const event of events) {
      send(ws, ["EVENT", subId, event]);
    }
    send(ws, ["EOSE", subId]);
  }

  private handleClose(ws: WebSocket, subId: unknown): void {
    if (typeof subId !== "string") return;
    const state = getState(ws);
    delete state.subs[subId];
    setState(ws, state);
  }

  // NIP-42 (nips/42.md): AUTH MUST be answered with OK. Gift wrap reads
  // (ROADMAP.md chunk 6, handleReq) are this relay's first auth-gated
  // resource, so this now checks against a challenge actually issued to
  // this connection (state.challenge, set lazily in handleReq) rather
  // than always failing. On success, the authenticated pubkey is stored
  // on the connection for handleReq to check.
  private handleAuth(ws: WebSocket, raw: unknown): void {
    const event = parseEventShape(raw);
    if (!event) {
      send(ws, ["NOTICE", "error: malformed event"]);
      return;
    }
    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }
    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }
    if (event.kind !== AUTH_KIND) {
      ok(ws, event.id, false, `invalid: kind must be ${AUTH_KIND}`);
      return;
    }
    if (Math.abs(nowSeconds() - event.created_at) > AUTH_MAX_DRIFT_SECONDS) {
      ok(ws, event.id, false, "invalid: created_at is too far from now");
      return;
    }
    const state = getState(ws);
    const challenge = event.tags.find((t) => t[0] === "challenge")?.[1];
    if (!challenge || !state.challenge || challenge !== state.challenge) {
      ok(ws, event.id, false, "invalid: no matching challenge was issued");
      return;
    }
    // NIP-42 "Signed Event Verification": "that the relay tag matches
    // the relay URL." Without this, an AUTH event signed for a
    // *different* relay's challenge-less flow could be replayed here to
    // claim the owner's identity.
    const relayTag = event.tags.find((t) => t[0] === "relay")?.[1];
    if (!relayTag || !relayTagMatchesHost(relayTag, state.host)) {
      ok(ws, event.id, false, "invalid: relay tag does not match this relay");
      return;
    }
    state.authedPubkey = event.pubkey;
    setState(ws, state);
    ok(ws, event.id, true, "");
  }

  private broadcast(event: NostrEvent): void {
    // The NIP-42 gate in handleReq proves nothing about *future* events:
    // it probes storage at REQ time, so a filter that matches no stored
    // gift wrap when registered (most simply, a `#p` filter naming the
    // owner while the inbox is empty) is accepted ungated -- and every
    // gift wrap accepted afterward necessarily p-tags the owner
    // (handleGiftWrap), so it matches. This push path must therefore
    // enforce the same authenticated-recipient rule itself, exactly as
    // liveBroadcast below already refuses kind 1059 for its permanently
    // unauthenticated channel. Owner looked up only on the gated kind so
    // the common path stays free of the extra read.
    const gated = event.kind === GIFT_WRAP_KIND;
    const owner = gated ? getOwnerPubkey(this.ctx.storage.sql, this.env) : null;
    for (const ws of this.ctx.getWebSockets()) {
      // ctx.getWebSockets() with no tag argument returns every socket,
      // live feed ones included -- those carry a LiveFeedState
      // attachment (connectedAt only, no `subs`), not a ConnState, so
      // they're routed to liveBroadcast instead, never here.
      if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) continue;
      const state = getState(ws);
      // Same condition handleReq's gate enforces for stored reads:
      // kind-1059 events go only to the connection authenticated as the
      // owner (the p-tagged recipient, per handleGiftWrap's accept rule).
      if (gated && state.authedPubkey !== owner) continue;
      for (const [subId, filters] of Object.entries(state.subs)) {
        if (matchesAnyFilter(event, filters)) {
          send(ws, ["EVENT", subId, event]);
        }
      }
    }
  }

  // Pushes a redacted notice of a newly stored event to every open live
  // feed connection (ROADMAP.md chunk 7). Gift wraps are never sent here,
  // full stop, regardless of who is connected -- the admin page has no
  // way to authenticate (CLAUDE.md "Admin page" is static, unsigned), so
  // every live feed viewer is permanently the unauthenticated case NIP-42
  // gates gift wrap reads against elsewhere (handleReq above). Only
  // kind/time/a truncated id go out, never tags or content, so even a
  // non-gift-wrap DM-adjacent event (e.g. a kind-1 reply quoting
  // something sensitive) doesn't leak its body to whoever has the admin
  // page open.
  private liveBroadcast(event: NostrEvent): void {
    if (event.kind === GIFT_WRAP_KIND) return;
    const live = this.ctx.getWebSockets(LIVE_FEED_TAG);
    if (live.length === 0) return;
    const notice = JSON.stringify({ kind: event.kind, created_at: event.created_at, id: event.id.slice(0, 8) });
    for (const ws of live) {
      ws.send(notice);
    }
  }

  // Ensures a DO alarm is scheduled no later than this connection's own
  // expiry (ROADMAP.md chunk 7 follow-up: "close them after a fixed
  // duration regardless of client behavior"). Alarms -- unlike a JS
  // timer -- are hibernation-compatible: the platform wakes the object
  // at the scheduled time even if it evicted in the meantime, runs
  // alarm() below, and lets it hibernate again afterward, so this never
  // pins the object in memory the way an open outbound connection or an
  // in-process setTimeout would (CLAUDE.md "The budget"). Only schedules
  // when the existing alarm (if any) is later than this connection's own
  // expiry -- an earlier live feed connection's alarm already fires
  // first and, in alarm() below, reschedules for whatever's next, so a
  // busier admin page (several tabs/reconnects) doesn't multiply
  // `setAlarm` calls (each one is a row write, CLAUDE.md: "setAlarm()
  // counts as a write").
  private async scheduleLiveFeedAlarm(): Promise<void> {
    const desired = Date.now() + LIVE_FEED_MAX_LIFETIME_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > desired) {
      await this.ctx.storage.setAlarm(desired);
    }
  }

  // DO alarm handler -- closes any live feed connection past its max
  // lifetime and reschedules for whichever remaining connection expires
  // next, if any. `ws.close()` here is the same hibernation-compatible
  // API the client-initiated paths use (webSocketClose below just
  // mirrors it back); calling it from inside an alarm invocation, which
  // is itself a brief, billed wake rather than a standing timer, is what
  // keeps this from pinning the object -- see scheduleLiveFeedAlarm's
  // comment above.
  override async alarm(): Promise<void> {
    const now = Date.now();
    let nextExpiry: number | null = null;
    for (const ws of this.ctx.getWebSockets(LIVE_FEED_TAG)) {
      const expiresAt = getLiveFeedState(ws).connectedAt + LIVE_FEED_MAX_LIFETIME_MS;
      if (expiresAt <= now) {
        ws.close(1000, "live feed connection lifetime exceeded, reconnect");
      } else if (nextExpiry === null || expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }
    if (nextExpiry !== null) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    ws.close(code, reason);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }
}
