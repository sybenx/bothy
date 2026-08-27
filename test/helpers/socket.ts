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

// Wall-clock budget for "the relay never replied," not a latency assertion --
// nothing in this project's protocol behavior is timing-sensitive. Generous
// enough to absorb Durable Object cold-start plus contention from running
// the full suite in parallel (observed replies as slow as ~272ms under load
// that complete in 88-133ms in isolation), while still failing fast if a
// reply genuinely never arrives.
const DEFAULT_TIMEOUT_MS = 2000;

// Shared plumbing behind connectRelay/connectLiveFeed below: opens a
// hibernation-safe WebSocket to the single relay Durable Object at the
// given path and wraps it in the same queue/waiter machinery either
// caller's frame shape can flow through.
// `ip` sets CF-Connecting-IP, which is what relay.ts keys its per-IP
// throttles and NIP-86 blockip on. Omitted, the DO sees "unknown" and
// every test connection shares one bucket -- fine for suites that don't
// care, and exactly what has to be controlled for the per-pubkey throttle
// tests, whose whole point is that a pubkey's limit does not move when
// its address does.
async function connectPath<T>(path: string, ip?: string): Promise<{
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
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (ip) headers["CF-Connecting-IP"] = ip;
  const response = await stub.fetch(`https://example.com${path}`, { headers });
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
export async function connectRelay(ip?: string): Promise<RelayConn> {
  return connectPath<Frame>("/", ip);
}

// The redacted notice shape src/relay.ts liveBroadcast sends to the
// admin page's live feed -- kind/time/truncated id
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
