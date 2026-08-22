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

// Opens a hibernation-safe WebSocket to the single relay Durable Object,
// the same path exercised in test/hibernation.test.ts.
export async function connectRelay(): Promise<RelayConn> {
  const id = env.RELAY.idFromName("relay");
  const stub = env.RELAY.get(id);
  const response = await stub.fetch("https://example.com/", {
    headers: { Upgrade: "websocket" },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error("expected a websocket response");
  socket.accept();

  const queue: Frame[] = [];
  const waiters: Array<(frame: Frame) => void> = [];

  socket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const frame = JSON.parse(event.data) as Frame;
    const waiter = waiters.shift();
    if (waiter) waiter(frame);
    else queue.push(frame);
  });

  return {
    send(message) {
      socket.send(JSON.stringify(message));
    },
    nextMessage(timeoutMs = DEFAULT_TIMEOUT_MS) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<Frame>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(onFrame);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no message received from relay within ${timeoutMs}ms`));
        }, timeoutMs);
        function onFrame(frame: Frame) {
          clearTimeout(timer);
          resolve(frame);
        }
        waiters.push(onFrame);
      });
    },
    close() {
      socket.close(1000, "test done");
    },
  };
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
