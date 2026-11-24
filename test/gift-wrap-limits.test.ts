// The gift wrap rate limit (relay.ts giftWrapRefusal, limits.ts
// maxGiftWrapsPerIp/maxGiftWrapsPerMember). A wrap is signed by a
// throwaway key, so who sent it comes from the connection's NIP-42 AUTH:
// signed in as the owner or a member, it is counted per pubkey (120 a
// minute); otherwise per IP (5 a minute), and a connection that has not
// signed in is asked to. Also the neighbours raised for members in the
// same change: signals (600 a minute) and the frame throttle (per person,
// 200 per 10 seconds).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
  MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW,
  MAX_SIGNALS_PER_SENDER_PER_WINDOW,
} from "../src/limits";
import { SIGNAL_KIND } from "../src/nostr";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
const OWNER: Keypair = { secretKeyHex: OWNER_SECRET_KEY_HEX, pubkeyHex: OWNER_PUBKEY_HEX };

// A block no other test file uses: the throttles are in memory and live
// as long as the Durable Object, across tests.
let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `10.77.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

async function newMember(): Promise<Keypair> {
  const member = randomKeypair();
  expect((await callManagement("allowpubkey", [member.pubkeyHex])).result).toBe(true);
  return member;
}

async function authenticate(conn: RelayConn, who: Keypair, challenge?: string): Promise<void> {
  if (challenge === undefined) {
    conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
    const frame = await conn.nextMessage();
    challenge = frame[1] as string;
    await conn.nextMessage();
  }
  conn.send([
    "AUTH",
    signEvent(who.secretKeyHex, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", challenge],
      ],
    }),
  ]);
  const [, , ok] = await conn.nextMessage();
  expect(ok).toBe(true);
}

async function connectAs(who: Keypair | null, ip = freshIp()): Promise<RelayConn> {
  const conn = await connectRelay(ip);
  if (who !== null) await authenticate(conn, who);
  return conn;
}

function wrap(to: string, extraTags: string[][] = []): NostrEvent {
  return signEvent(randomKeypair().secretKeyHex, { kind: 1059, tags: [["p", to], ...extraTags], content: "sealed" });
}

function ring(to: string): NostrEvent {
  return wrap(to, [["ring"], ["expiration", String(Math.floor(Date.now() / 1000) + 60)]]);
}

// Sends `count` wraps to `to` and returns how many were accepted before
// the first refusal, and that refusal ("" if none). An AUTH frame sent
// with a refusal is skipped and reported.
async function sendWraps(
  conn: RelayConn,
  to: string,
  count: number,
): Promise<{ accepted: number; refusal: string; challenged: boolean }> {
  let accepted = 0;
  let challenged = false;
  for (let i = 0; i < count; i++) {
    conn.send(["EVENT", wrap(to)]);
    let frame = await conn.nextMessage();
    if (frame[0] === "AUTH") {
      challenged = true;
      frame = await conn.nextMessage();
    }
    if (frame[2] !== true) return { accepted, refusal: frame[3] as string, challenged };
    accepted++;
  }
  return { accepted, refusal: "", challenged };
}

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  Object.assign(mutableEnv, vars);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(vars)) delete mutableEnv[key];
  }
}

describe("gift wrap limit for signed-in members", () => {
  it("lets a member send far more than 5 a minute", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const conn = await connectAs(alice);
    expect(await sendWraps(conn, bob.pubkeyHex, 30)).toEqual({ accepted: 30, refusal: "", challenged: false });
    conn.close();
  });

  it("lets the owner send far more than 5 a minute", async () => {
    const bob = await newMember();
    const conn = await connectAs(OWNER);
    expect((await sendWraps(conn, bob.pubkeyHex, 12)).accepted).toBe(12);
    conn.close();
  });

  it(`refuses a member over their own ${MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW} a minute`, async () => {
    const alice = await newMember();
    const conn = await connectAs(alice);
    const result = await sendWraps(conn, OWNER_PUBKEY_HEX, MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW + 1);
    expect(result).toEqual({
      accepted: MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW,
      refusal: "rate-limited: too many gift wraps from you, slow down",
      challenged: false,
    });
    conn.close();
  });

  it("gives two members behind one address a counter each", async () => {
    await withEnv({ MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE: "6" }, async () => {
      const alice = await newMember();
      const bob = await newMember();
      const ip = freshIp();
      const aliceConn = await connectAs(alice, ip);
      const bobConn = await connectAs(bob, ip);
      expect(await sendWraps(aliceConn, bob.pubkeyHex, 7)).toEqual({
        accepted: 6,
        refusal: "rate-limited: too many gift wraps from you, slow down",
        challenged: false,
      });
      expect((await sendWraps(bobConn, alice.pubkeyHex, 6)).accepted).toBe(6);
      // Neither spent the address's allowance for people not signed in.
      const stranger = await connectAs(null, ip);
      expect((await sendWraps(stranger, alice.pubkeyHex, MAX_GIFT_WRAPS_PER_IP_PER_WINDOW)).accepted).toBe(
        MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
      );
      aliceConn.close();
      bobConn.close();
      stranger.close();
    });
  });

  it("shares one member's counter across their connections and addresses", async () => {
    await withEnv({ MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE: "10" }, async () => {
      const alice = await newMember();
      const phone = await connectAs(alice);
      const laptop = await connectAs(alice);
      expect((await sendWraps(phone, OWNER_PUBKEY_HEX, 6)).accepted).toBe(6);
      expect(await sendWraps(laptop, OWNER_PUBKEY_HEX, 5)).toEqual({
        accepted: 4,
        refusal: "rate-limited: too many gift wraps from you, slow down",
        challenged: false,
      });
      phone.close();
      laptop.close();
    });
  });

  it("keeps rings out of the member counter", async () => {
    await withEnv({ MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE: "3" }, async () => {
      const alice = await newMember();
      const bob = await newMember();
      const conn = await connectAs(alice);
      expect((await sendWraps(conn, bob.pubkeyHex, 4)).accepted).toBe(3);
      expect(await publish(conn, ring(bob.pubkeyHex))).toEqual(["OK", expect.any(String), true, ""]);
      conn.close();
    });
  });
});

describe("gift wrap limit for everyone else", () => {
  it(`refuses a stranger over ${MAX_GIFT_WRAPS_PER_IP_PER_WINDOW} a minute, with an AUTH challenge`, async () => {
    const conn = await connectAs(null);
    expect(await sendWraps(conn, OWNER_PUBKEY_HEX, MAX_GIFT_WRAPS_PER_IP_PER_WINDOW + 1)).toEqual({
      accepted: MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
      refusal: "auth-required: too many gift wraps from this address; members, sign in to send more",
      challenged: true,
    });
    conn.close();
  });

  it("still counts a signed-in non-member per address", async () => {
    const ip = freshIp();
    const first = await connectAs(randomKeypair(), ip);
    const second = await connectAs(randomKeypair(), ip);
    expect((await sendWraps(first, OWNER_PUBKEY_HEX, 3)).accepted).toBe(3);
    expect(await sendWraps(second, OWNER_PUBKEY_HEX, 3)).toEqual({
      accepted: MAX_GIFT_WRAPS_PER_IP_PER_WINDOW - 3,
      refusal: "rate-limited: too many gift wraps from this address, slow down",
      challenged: false,
    });
    first.close();
    second.close();
  });

  it("lets a member's app that sent before signing in sign in and send the refused wrap again", async () => {
    const alice = await newMember();
    const conn = await connectAs(null);
    expect((await sendWraps(conn, OWNER_PUBKEY_HEX, MAX_GIFT_WRAPS_PER_IP_PER_WINDOW)).accepted).toBe(
      MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
    );
    const refused = wrap(OWNER_PUBKEY_HEX);
    conn.send(["EVENT", refused]);
    const [type, challenge] = await conn.nextMessage();
    expect(type).toBe("AUTH");
    expect((await conn.nextMessage())[3]).toMatch(/^auth-required:/);
    await authenticate(conn, alice, challenge as string);
    expect(await publish(conn, refused)).toEqual(["OK", refused.id, true, ""]);
    expect((await sendWraps(conn, OWNER_PUBKEY_HEX, 10)).accepted).toBe(10);
    conn.close();
  });

  it("keeps rings out of the address counter", async () => {
    const bob = await newMember();
    const conn = await connectAs(null);
    expect((await sendWraps(conn, bob.pubkeyHex, MAX_GIFT_WRAPS_PER_IP_PER_WINDOW + 1)).accepted).toBe(
      MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
    );
    const ringing = ring(bob.pubkeyHex);
    expect(await publish(conn, ringing)).toEqual(["OK", ringing.id, true, ""]);
    conn.close();
  });
});

describe("gift wrap limit env overrides", () => {
  it("MAX_GIFT_WRAPS_PER_IP_PER_MINUTE sets the per-address limit", async () => {
    await withEnv({ MAX_GIFT_WRAPS_PER_IP_PER_MINUTE: "2" }, async () => {
      const conn = await connectAs(null);
      expect((await sendWraps(conn, OWNER_PUBKEY_HEX, 3)).accepted).toBe(2);
      conn.close();
    });
  });

  it("MAX_GIFT_WRAPS_PER_IP_PER_MINUTE=off removes it", async () => {
    await withEnv({ MAX_GIFT_WRAPS_PER_IP_PER_MINUTE: "off" }, async () => {
      const conn = await connectAs(null);
      expect((await sendWraps(conn, OWNER_PUBKEY_HEX, 12)).accepted).toBe(12);
      conn.close();
    });
  });

  it("MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE sets the per-member limit, and a bad value keeps the default", async () => {
    const alice = await newMember();
    await withEnv({ MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE: "4" }, async () => {
      const conn = await connectAs(alice);
      expect((await sendWraps(conn, OWNER_PUBKEY_HEX, 5)).accepted).toBe(4);
      conn.close();
    });
    const bob = await newMember();
    await withEnv({ MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE: "lots" }, async () => {
      const conn = await connectAs(bob);
      expect((await sendWraps(conn, OWNER_PUBKEY_HEX, 20)).accepted).toBe(20);
      conn.close();
    });
  });

  it("MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE=off removes it", async () => {
    const alice = await newMember();
    await withEnv({ MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE: "off" }, async () => {
      const conn = await connectAs(alice);
      const result = await sendWraps(conn, OWNER_PUBKEY_HEX, MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW + 5);
      expect(result.accepted).toBe(MAX_GIFT_WRAPS_PER_MEMBER_PER_WINDOW + 5);
      conn.close();
    });
  });
});

describe("member limits raised alongside", () => {
  it(`lets a member send more than the old 120 signals a minute, in a burst past 50 frames`, async () => {
    expect(MAX_SIGNALS_PER_SENDER_PER_WINDOW).toBe(600);
    const alice = await newMember();
    const bob = await newMember();
    const conn = await connectAs(alice);
    let accepted = 0;
    for (let i = 0; i < 130; i++) {
      const signal = signEvent(randomKeypair().secretKeyHex, {
        kind: SIGNAL_KIND,
        tags: [["p", bob.pubkeyHex]],
        content: "typing",
      });
      if ((await publish(conn, signal))[2] === true) accepted++;
    }
    expect(accepted).toBe(130);
    conn.close();
  });

  it("MAX_SIGNALS_PER_MEMBER_PER_MINUTE sets the signal limit", async () => {
    const alice = await newMember();
    const bob = await newMember();
    await withEnv({ MAX_SIGNALS_PER_MEMBER_PER_MINUTE: "3" }, async () => {
      const conn = await connectAs(alice);
      const answers: string[] = [];
      for (let i = 0; i < 4; i++) {
        const signal = signEvent(randomKeypair().secretKeyHex, {
          kind: SIGNAL_KIND,
          tags: [["p", bob.pubkeyHex]],
          content: "typing",
        });
        answers.push((await publish(conn, signal))[3]);
      }
      expect(answers).toEqual(["", "", "", "rate-limited: too many signals, slow down"]);
      conn.close();
    });
  });

  it("keeps the 50-per-10-seconds frame limit per address for anyone not signed in as a member", async () => {
    const ip = freshIp();
    const stranger = await connectAs(randomKeypair(), ip);
    let throttled = false;
    for (let i = 0; i < 60; i++) {
      stranger.send(["CLOSE", `nothing-${i}`]);
    }
    stranger.send(["EVENT", wrap(OWNER_PUBKEY_HEX)]);
    for (;;) {
      const frame = await stranger.nextMessage();
      if (frame[0] === "OK") {
        throttled = frame[3] === "rate-limited: slow down";
        break;
      }
    }
    expect(throttled).toBe(true);
    stranger.close();
  });
});
