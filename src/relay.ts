import { DurableObject } from "cloudflare:workers";
import { matchesAnyFilter, parseFilter } from "./filters";
import type { Filter, NostrEvent } from "./nostr";
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

// Per-connection subscriptions, keyed by subscription id. Persisted via
// WebSocket attachment (not object memory) so it survives hibernation --
// see CLAUDE.md "The budget" on why an in-memory-only map would be wrong
// here: the object can be evicted between messages on an otherwise idle
// connection, and the attachment is what's still there on the next one.
type Subscriptions = Record<string, Filter[]>;

function getSubscriptions(ws: WebSocket): Subscriptions {
  return (ws.deserializeAttachment() as Subscriptions | null) ?? {};
}

function setSubscriptions(ws: WebSocket, subs: Subscriptions): void {
  ws.serializeAttachment(subs);
}

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

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

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

    const ownerPubkey = this.env.OWNER_PUBKEY;
    if (!ownerPubkey || event.pubkey !== ownerPubkey) {
      ok(ws, event.id, false, "restricted: not allowed to write.");
      return;
    }

    const sql = this.ctx.storage.sql;
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
    const filters: Filter[] = [];
    for (const raw of frame.slice(2)) {
      const filter = parseFilter(raw);
      if (!filter) {
        send(ws, ["CLOSED", subId, "error: malformed filter"]);
        return;
      }
      filters.push(filter);
    }

    const subs = getSubscriptions(ws);
    subs[subId] = filters;
    setSubscriptions(ws, subs);

    const events = queryFilters(this.ctx.storage.sql, filters, nowSeconds());
    for (const event of events) {
      send(ws, ["EVENT", subId, event]);
    }
    send(ws, ["EOSE", subId]);
  }

  private handleClose(ws: WebSocket, subId: unknown): void {
    if (typeof subId !== "string") return;
    const subs = getSubscriptions(ws);
    delete subs[subId];
    setSubscriptions(ws, subs);
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
      const subs = getSubscriptions(ws);
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
