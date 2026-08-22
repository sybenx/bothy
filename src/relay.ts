import { DurableObject } from "cloudflare:workers";
import { matchesAnyFilter, parseFilter } from "./filters";
import {
  clampFilterLimit,
  isUnconstrainedFilter,
  MAX_EVENTS_PER_REQ,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
} from "./limits";
import type { Filter, NostrEvent } from "./nostr";
import { claimOwner, getOwnerPubkey, isAllowedWriter, refreshFollows } from "./ownership";
import { normalizePubkey } from "./pubkey";
import { pruneExpiredRetention } from "./retention";
import { initSchema } from "./schema";
import { applyDeletion, eventExists, expirationOf, queryFilters, storeEvent } from "./storage";
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";

// Replies to a client-level "ping" with "pong" entirely inside the
// runtime -- it does not wake this object or count against DO duration.
// See CLAUDE.md "Architecture".
const PING_PONG = new WebSocketRequestResponsePair("ping", "pong");

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
type Subscriptions = Record<string, Filter[]>;
interface ConnState {
  ip: string;
  subs: Subscriptions;
}

function getState(ws: WebSocket): ConnState {
  return (ws.deserializeAttachment() as ConnState | null) ?? { ip: "unknown", subs: {} };
}

function setState(ws: WebSocket, state: ConnState): void {
  ws.serializeAttachment(state);
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

export class Relay extends DurableObject<Env> {
  // Per-IP sliding window counters for webSocketMessage throttling --
  // see the RATE_LIMIT_* constants above for why this is memory, not
  // storage.
  private rateLimits = new Map<string, { windowStart: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    initSchema(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(PING_PONG);
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // acceptWebSocket (not server.accept()) is what makes this connection
    // hibernatable. Calling accept() instead pins the object in memory
    // and bills DO duration for the connection's entire lifetime -- see
    // CLAUDE.md "Architecture".
    this.ctx.acceptWebSocket(server);
    setState(server, { ip: request.headers.get("CF-Connecting-IP") ?? "unknown", subs: {} });

    return new Response(null, { status: 101, webSocket: client });
  }

  // TOFU claim (CLAUDE.md "Ownership"). RPC method, called directly by
  // the Worker (src/index.ts) rather than over fetch() -- this is the
  // only code path that may write the `owner` row (ownership.ts).
  async claim(rawPubkey: unknown): Promise<{ status: "claimed" | "conflict" | "disabled" | "invalid"; pubkey?: string }> {
    if (this.env.OWNER_PUBKEY) return { status: "disabled" };
    if (typeof rawPubkey !== "string") return { status: "invalid" };
    const pubkey = normalizePubkey(rawPubkey);
    if (!pubkey) return { status: "invalid" };

    const sql = this.ctx.storage.sql;
    if (!claimOwner(sql, pubkey)) return { status: "conflict" };
    return { status: "claimed", pubkey };
  }

  // Backs GET /api/stats (src/index.ts) -- see CLAUDE.md "Admin page".
  async getStats(): Promise<{
    claimed: boolean;
    ownerPubkey: string | null;
    totalEvents: number;
    events24h: number;
    storageBytes: number;
    rowsWrittenEstimate24h: number;
  }> {
    const sql = this.ctx.storage.sql;
    const owner = getOwnerPubkey(sql, this.env);
    const since = nowSeconds() - 86400;

    const totalEvents =
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events`).toArray()[0]?.n ?? 0;
    const recent = sql
      .exec<{ id: string }>(`SELECT id FROM events WHERE created_at > ?`, since)
      .toArray();
    // Row-cost formula from schema.ts: 3 base rows + 2 per single-letter
    // tag. A read-only estimate, not a tracked counter -- see
    // limits.ts/relay.ts comments on why this relay avoids extra writes
    // just to measure itself.
    let rowsWrittenEstimate24h = 0;
    if (recent.length > 0) {
      const tagCounts = sql
        .exec<{ event_id: string; n: number }>(
          `SELECT event_id, COUNT(*) AS n FROM event_tags WHERE event_id IN (${recent
            .map(() => "?")
            .join(", ")}) GROUP BY event_id`,
          ...recent.map((r) => r.id),
        )
        .toArray();
      const tagsByEvent = new Map(tagCounts.map((r) => [r.event_id, r.n]));
      for (const r of recent) {
        rowsWrittenEstimate24h += 3 + 2 * (tagsByEvent.get(r.id) ?? 0);
      }
    }

    return {
      claimed: owner !== null,
      ownerPubkey: owner,
      totalEvents,
      events24h: recent.length,
      storageBytes: sql.databaseSize,
      rowsWrittenEstimate24h,
    };
  }

  // Cron entry point (src/index.ts scheduled()) -- refreshes the
  // ALLOW_FOLLOWS cache and applies RETENTION_DAYS pruning. Both are
  // no-ops when their env var is unset, so this is cheap on the common
  // (feature-off) path.
  async runCron(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const now = nowSeconds();
    refreshFollows(sql, this.env, now);
    pruneExpiredRetention(sql, this.env, now);
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

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

    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }
    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }

    const sql = this.ctx.storage.sql;
    if (!isAllowedWriter(sql, this.env, event.pubkey)) {
      ok(ws, event.id, false, "restricted: not allowed to write.");
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
      this.broadcast(result.stored);
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

  // NIP-42 (nips/42.md): AUTH MUST be answered with OK. This relay has
  // no auth-gated resource yet and never issues a challenge (see
  // docs/test-notes.md), so the challenge-match check below always
  // fails -- that's the correct behaviour for "no challenge was ever
  // issued", not a bug to fix here.
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
    const challenge = event.tags.find((t) => t[0] === "challenge")?.[1];
    if (!challenge || !this.issuedChallenge(challenge)) {
      ok(ws, event.id, false, "invalid: no matching challenge was issued");
      return;
    }
    ok(ws, event.id, true, "");
  }

  // Always false today -- nothing in this relay issues an AUTH challenge
  // yet (reads are public, writes are gated by ownership + signature).
  // Kept as its own method so the day a challenge-issuing path exists,
  // it's obvious where to plug the check in.
  private issuedChallenge(_challenge: string): boolean {
    return false;
  }

  private broadcast(event: NostrEvent): void {
    for (const ws of this.ctx.getWebSockets()) {
      const { subs } = getState(ws);
      for (const [subId, filters] of Object.entries(subs)) {
        if (matchesAnyFilter(event, filters)) {
          send(ws, ["EVENT", subId, event]);
        }
      }
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
