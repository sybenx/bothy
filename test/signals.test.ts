// Sealed signals (relay.ts handleSignal, kind 21059): typing, seen and call
// setup between members, delivered live to the recipient and never stored.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MAX_GIFT_WRAPS_PER_IP_PER_WINDOW, MAX_SIGNALS_PER_SENDER_PER_WINDOW, SIGNAL_MAX_BYTES } from "../src/limits";
import { SIGNAL_KIND } from "../src/nostr";
import type { Relay } from "../src/relay";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { randomKeypair, type Keypair } from "./helpers/keys";
import { collectStored, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.29.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

async function newMember(): Promise<Keypair> {
  const member = randomKeypair();
  expect((await callManagement("allowpubkey", [member.pubkeyHex])).result).toBe(true);
  return member;
}

async function authenticate(conn: RelayConn, who: Keypair): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage();
  conn.send([
    "AUTH",
    signEvent(who.secretKeyHex, {
      kind: 22242,
      tags: [
        ["relay", "wss://example.com"],
        ["challenge", challenge as string],
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

function signal(to: string, content = "sealed", kind = SIGNAL_KIND): NostrEvent {
  return signEvent(randomKeypair().secretKeyHex, { kind, tags: [["p", to]], content });
}

// Opens a live subscription for the signals addressed to `who` and waits
// for its EOSE.
async function listen(conn: RelayConn, who: Keypair, subId = "signals"): Promise<void> {
  expect(await collectStored(conn, subId, [{ kinds: [SIGNAL_KIND], "#p": [who.pubkeyHex] }])).toEqual([]);
}

async function nothingArrives(conn: RelayConn): Promise<void> {
  await expect(conn.nextMessage(300)).rejects.toThrow(/no message/);
}

describe("sealed signals", () => {
  it("are advertised on NIP-11", async () => {
    const info = await (
      await exports.default.fetch(new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }))
    ).json<Record<string, unknown>>();
    expect(info.signals).toEqual({ v: 1 });
  });

  it("reach only the p-tagged member's live subscription, and are never stored", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const carol = await newMember();
    const bobConn = await connectAs(bob);
    const carolConn = await connectAs(carol);
    await listen(bobConn, bob);
    // Carol asks for Bob's signals: refused or simply never served.
    carolConn.send(["REQ", "peek", { kinds: [SIGNAL_KIND], "#p": [bob.pubkeyHex] }]);
    await carolConn.nextMessage();
    await listen(carolConn, carol, "own");

    const aliceConn = await connectAs(alice);
    const event = signal(bob.pubkeyHex);
    expect(await publish(aliceConn, event)).toEqual(["OK", event.id, true, ""]);

    expect(await bobConn.nextMessage()).toEqual(["EVENT", "signals", event]);
    await nothingArrives(carolConn);

    // A later REQ finds nothing, and nothing is in the database.
    const later = await connectAs(bob);
    expect(await collectStored(later, "again", [{ kinds: [SIGNAL_KIND], "#p": [bob.pubkeyHex] }])).toEqual([]);
    const rows = await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) =>
      state.storage.sql.exec(`SELECT id FROM events WHERE id = ?`, event.id).toArray(),
    );
    expect(rows).toEqual([]);
    for (const conn of [aliceConn, bobConn, carolConn, later]) conn.close();
  });

  it("are refused from a connection that is not a member, or not authenticated", async () => {
    const bob = await newMember();
    const stranger = await connectAs(randomKeypair());
    const anonymous = await connectAs(null);
    for (const conn of [stranger, anonymous]) {
      const event = signal(bob.pubkeyHex);
      expect(await publish(conn, event)).toEqual([
        "OK",
        event.id,
        false,
        "restricted: signals are for this home's members; authenticate first",
      ]);
      conn.close();
    }
  });

  it("are refused when addressed to nobody in the home, or too big", async () => {
    const alice = await newMember();
    const conn = await connectAs(alice);
    const nobody = signal(randomKeypair().pubkeyHex);
    expect((await publish(conn, nobody))[2]).toBe(false);
    const big = signal(alice.pubkeyHex, "x".repeat(SIGNAL_MAX_BYTES));
    expect(await publish(conn, big)).toEqual([
      "OK",
      big.id,
      false,
      `invalid: a signal can be at most ${SIGNAL_MAX_BYTES} bytes`,
    ]);
    conn.close();
  });

  it("do not count against the gift wrap limit, and have their own", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const ip = freshIp();
    const conn = await connectAs(alice, ip);
    for (let i = 0; i < MAX_GIFT_WRAPS_PER_IP_PER_WINDOW + 3; i++) {
      expect((await publish(conn, signal(bob.pubkeyHex)))[2]).toBe(true);
    }
    // Mail from the same address still goes through.
    const wrap = signal(bob.pubkeyHex, "mail", 1059);
    expect((await publish(conn, wrap))[2]).toBe(true);

    // The signal limit, per sender, whatever the address: spread over
    // fresh connections so the per-address frame throttle never trips.
    let refused = "";
    let other = await connectAs(alice);
    for (let i = 0; i < MAX_SIGNALS_PER_SENDER_PER_WINDOW && refused === ""; i++) {
      if (i > 0 && i % 30 === 0) {
        other.close();
        other = await connectAs(alice);
      }
      const [, , ok, message] = await publish(other, signal(bob.pubkeyHex));
      if (!ok) refused = message;
    }
    expect(refused).toBe("rate-limited: too many signals, slow down");
    conn.close();
    other.close();
  });
});
