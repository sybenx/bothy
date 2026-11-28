// A connection that keeps sending what this home refuses (relay.ts
// noteOutsiderRefusal). Every frame reaching the DO is billed, and before
// this the relay answered each refused EVENT with OK false forever: an
// outside relay re-broadcasting the network's notes at tens a second cost
// one message in and one out each, all day, and used up the free plan's
// daily allowance within the first hour. Now the socket is closed past
// OUTSIDER_REFUSALS_MAX refusals a minute and the address is turned away
// at the upgrade for a while; members are never counted.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay } from "./helpers/socket";
import { OUTSIDER_CLOSE_CODE, OUTSIDER_REFUSALS_MAX, OUTSIDER_SHUN_MS, REPEAT_SHUN_MS, SHUN_HEADER } from "../src/relay";

isolateStorage();

// A stranger's key: kind 1 from them is refused under every write policy
// but `all` (the default is `mentions`, and this mentions nobody).
const STRANGER_SK = "7f".repeat(32);

async function upgrade(ip: string): Promise<Response> {
  const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
  return stub.fetch("https://example.com/", { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } });
}

describe("refused messages from outside the home", () => {
  it("closes a broadcaster's socket after the cap instead of answering it all day", async () => {
    const conn = await connectRelay("198.51.100.70");
    const closed = (conn as unknown as { closed?: Promise<{ code: number }> }).closed;
    let refusals = 0;
    let open = true;
    // What an outside relay re-broadcasting the network's notes sends.
    for (let i = 0; i < OUTSIDER_REFUSALS_MAX + 20 && open; i++) {
      try {
        conn.send(["EVENT", signEvent(STRANGER_SK, { kind: 1, content: `note ${i}` })]);
        const frame = await conn.nextMessage(1000);
        if (frame[0] === "OK" && frame[2] === false) refusals++;
      } catch {
        open = false;
      }
    }
    // Answered up to the cap, then closed: no more replies, however long it sends.
    expect(refusals).toBeGreaterThanOrEqual(OUTSIDER_REFUSALS_MAX);
    expect(refusals).toBeLessThanOrEqual(OUTSIDER_REFUSALS_MAX + 1);
    expect(open).toBe(false);
    if (closed) expect((await closed).code).toBe(OUTSIDER_CLOSE_CODE);

    // Its next connection is turned away before a socket exists, with the
    // header the Worker keeps it out with.
    const again = await upgrade("198.51.100.70");
    expect(again.status).toBe(429);
    expect(Number(again.headers.get(SHUN_HEADER))).toBeGreaterThan(0);
    // Another address is not.
    const other = await upgrade("198.51.100.71");
    expect(other.status).toBe(101);
    other.webSocket?.accept();
    other.webSocket?.close(1000, "test done");
  });

  async function signedInOwner(ip: string) {
    const conn = await connectRelay(ip);
    // Sign in as the owner (NIP-42).
    conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
    const [, challenge] = await conn.nextMessage();
    await conn.nextMessage();
    conn.send(["AUTH", signEvent(OWNER_SECRET_KEY_HEX, { kind: 22242, content: "", tags: [["relay", "wss://example.com"], ["challenge", challenge as string]] })]);
    expect((await conn.nextMessage())[2]).toBe(true);
    return conn;
  }

  it("never counts the owner, however many of their events are refused", async () => {
    const conn = await signedInOwner("198.51.100.72");
    // Invalid events the owner sends are refused (a bad id), each answered.
    for (let i = 0; i < OUTSIDER_REFUSALS_MAX + 10; i++) {
      const e = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: `mine ${i}` });
      conn.send(["EVENT", { ...e, content: "tampered" }]);
      const f = await conn.nextMessage();
      expect(f[0]).toBe("OK");
      expect(f[2]).toBe(false);
    }
    conn.close();
  });

  it("closes any socket, a member's too, that stays far over the message throttle", async () => {
    const conn = await signedInOwner("198.51.100.73");
    const closed = (conn as unknown as { closed: Promise<{ code: number }> }).closed;
    // A client stuck in a loop: every frame past the allowance still costs a
    // billed message and a NOTICE. 200 per 10 s is a member's allowance.
    for (let i = 0; i < 2 * 200 + 10; i++) {
      try {
        conn.send(["CLOSE", `loop-${i}`]);
      } catch {
        break;
      }
    }
    expect((await closed).code).toBe(OUTSIDER_CLOSE_CODE);
  });

  it("turns a looping app's address away, for longer the second time, and keeps that in storage", async () => {
    const ip = "198.51.100.74";
    async function loopUntilClosed() {
      const conn = await signedInOwner(ip);
      const closed = (conn as unknown as { closed: Promise<{ code: number }> }).closed;
      for (let i = 0; i < 2 * 200 + 10; i++) {
        try {
          conn.send(["CLOSE", `loop-${i}`]);
        } catch {
          break;
        }
      }
      expect((await closed).code).toBe(OUTSIDER_CLOSE_CODE);
    }
    await loopUntilClosed();
    const first = await upgrade(ip);
    expect(first.status).toBe(429);
    const firstSeconds = Number(first.headers.get(SHUN_HEADER));
    expect(firstSeconds).toBeGreaterThan(0);
    expect(firstSeconds).toBeLessThanOrEqual(OUTSIDER_SHUN_MS / 1000);

    // Saved, not only in memory: what a hibernated object wakes up to.
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    const { runInDurableObject } = await import("cloudflare:test");
    const saved = await runInDurableObject(stub, (_i, state) => state.storage.kv.get<{ until: number; strikes: number }>(`shun:${ip}`));
    expect(saved?.strikes).toBe(1);

    // Its time runs out; it loops again the same day: two hours this time.
    await runInDurableObject(stub, (instance, state) => {
      (instance as unknown as { shunned: Map<string, number> }).shunned.clear();
      const s = state.storage.kv.get<{ until: number; strikes: number; last: number }>(`shun:${ip}`)!;
      state.storage.kv.put(`shun:${ip}`, { ...s, until: Date.now() - 1 });
    });
    await loopUntilClosed();
    const second = await upgrade(ip);
    expect(second.status).toBe(429);
    expect(Number(second.headers.get(SHUN_HEADER))).toBeGreaterThan(OUTSIDER_SHUN_MS / 1000);
    expect(Number(second.headers.get(SHUN_HEADER))).toBeLessThanOrEqual(REPEAT_SHUN_MS / 1000);
  });
});
