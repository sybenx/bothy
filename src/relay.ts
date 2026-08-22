import { DurableObject } from "cloudflare:workers";
import { initSchema } from "./schema";

// Replies to a client-level "ping" with "pong" entirely inside the
// runtime -- it does not wake this object or count against DO duration.
// See CLAUDE.md "Architecture".
const PING_PONG = new WebSocketRequestResponsePair("ping", "pong");

export class Relay extends DurableObject {
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

  // NIP-01 EVENT/REQ/CLOSE handling lands in chunk 3. This stub only
  // establishes the hibernation-safe handler shape chunk 1 requires.
  override async webSocketMessage(
    _ws: WebSocket,
    _message: string | ArrayBuffer,
  ): Promise<void> {}

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
