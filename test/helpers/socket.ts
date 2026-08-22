import { env } from "cloudflare:workers";
import type { NostrEvent } from "./event";

// A relay-to-client frame: ["EVENT", subId, event] | ["OK", id, ok, msg] |
// ["EOSE", subId] | ["CLOSED", subId, msg] | ["NOTICE", msg] |
// ["AUTH", challenge]. Left loosely typed since callers narrow by frame[0].
export type Frame = [string, ...unknown[]];

export interface RelayConn {
  send(message: unknown[]): void;
  nextMessage(timeoutMs?: number): Promise<Frame>;
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 250;

// Shared plumbing behind connectRelay/connectLiveFeed below: opens a
// hibernation-safe WebSocket to the single relay Durable Object at the
// given path and wraps it in the same queue/waiter machinery either
// caller's frame shape can flow through.
async function connectPath<T>(path: string): Promise<{
  send(message: unknown): void;
  nextMessage(timeoutMs?: number): Promise<T>;
  close(): void;
  // Resolves with the close code/reason once the socket closes, whether
  // the client or the server (e.g. the live feed's max-lifetime alarm)
  // initiated it -- lets tests distinguish "the server closed this" from
  // "nothing arrived yet."
  closed: Promise<{ code: number; reason: string }>;
}> {
  const id = env.RELAY.idFromName("relay");
  const stub = env.RELAY.get(id);
  const response = await stub.fetch(`https://example.com${path}`, {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("expected a websocket response");
  socket.accept();

  const queue: T[] = [];
  const waiters: Array<(frame: T) => void> = [];

  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as T;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });

  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    socket.addEventListener("close", (event: CloseEvent) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });

  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    nextMessage(timeoutMs = DEFAULT_TIMEOUT_MS) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onFrame);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no message received from relay within ${timeoutMs}ms`));
        }, timeoutMs);
        function onFrame(frame: T) {
          clearTimeout(timer);
          resolve(frame);
        }
        waiters.push(onFrame);
      });
    },
    close() {
      socket.close(1000, "test done");
    },
    closed,
  };
}

// Opens a hibernation-safe WebSocket to the single relay Durable Object,
// the same path exercised in test/hibernation.test.ts.
export async function connectRelay(): Promise<RelayConn> {
  return connectPath<Frame>("/");
}

// The redacted notice shape src/relay.ts liveBroadcast sends to the
// admin page's live feed (ROADMAP.md chunk 7) -- kind/time/truncated id
// only, never tags or content.
export interface LiveNotice {
  kind: number;
  created_at: number;
  id: string;
}

export interface LiveFeedConn {
  // Real live feed clients never send anything -- exposed only so tests
  // can assert the server ignores it rather than mishandling it as a
  // nostr protocol frame (see relay.ts webSocketMessage's early return
  // for LIVE_FEED_TAG).
  send(message: unknown): void;
  nextMessage(timeoutMs?: number): Promise<LiveNotice>;
  close(): void;
  closed: Promise<{ code: number; reason: string }>;
}

// Opens the live feed's own push-only path, distinct from the nostr
// protocol connection above -- see src/relay.ts fetch()'s "/live" branch.
export async function connectLiveFeed(): Promise<LiveFeedConn> {
  return connectPath<LiveNotice>("/live");
}

// Publishes an event and returns the ["OK", id, ok, message] reply.
export async function publish(
  conn: RelayConn,
  event: NostrEvent,
): Promise<[string, string, boolean, string]> {
  conn.send(["EVENT", event]);
  const frame = await conn.nextMessage();
  return frame as [string, string, boolean, string];
}

// Opens sub, collects EVENT frames for it until EOSE, then returns them.
export async function collectStored(
  conn: RelayConn,
  subId: string,
  filters: Record<string, unknown>[],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NostrEvent[]> {
  conn.send(["REQ", subId, ...filters]);
  const events: NostrEvent[] = [];
  for (;;) {
    const frame = await conn.nextMessage(timeoutMs);
    if (frame[0] === "EVENT" && frame[1] === subId) {
      events.push(frame[2] as NostrEvent);
    } else if (frame[0] === "EOSE" && frame[1] === subId) {
      return events;
    } else {
      throw new Error(`unexpected frame while collecting sub ${subId}: ${JSON.stringify(frame)}`);
    }
  }
}
