// Members: invite codes (nip86.ts createinvite/redeeminvite), an inbox for
// every member (relay.ts handleGiftWrap and the gift wrap read gate), push
// when their mail arrives (relay.ts drainInboxPushes), and removal
// (storage.ts unallowPubkey, sweepFormerMembers).
//
// The contract the friend web app builds against is the HTTP and socket
// traffic these tests make: redeem a code with a NIP-98-signed
// redeeminvite, subscribe with subscribepush, authenticate with NIP-42 and
// read `{"kinds":[1059],"#p":[me]}`.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INVITE_DEFAULT_TTL_SECONDS,
  MAX_PUSHES_PER_TICK,
  MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY,
  MEMBER_INVITE_MAX_USES,
  MEMBER_REMOVAL_GRACE_SECONDS,
} from "../src/limits";
import { buildRelayInfo } from "../src/nip11";
import {
  ANYONE_CALLABLE_METHODS,
  handleManagementCall,
  NOT_A_MEMBER_REASON,
  REDEEM_REFUSAL_MESSAGE,
} from "../src/nip86";
import type { Relay } from "../src/relay";
import { sweepFormerMembers } from "../src/storage";
import { signEvent, withCorruptSignature, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement, nip98Header } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { decryptPush, makeDevice, type FakeDevice } from "./helpers/push";
import { collectStored, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
const mutableEnv = env as unknown as Record<string, unknown>;

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

// A fresh address per connection: the gift wrap throttle is five per IP
// per window (limits.ts MAX_GIFT_WRAPS_PER_IP_PER_WINDOW), and the tests
// below send more wraps than that. A block no other test file uses.
let nextIp = 0;
function connect(): Promise<RelayConn> {
  nextIp++;
  return connectRelay(`172.20.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`);
}

interface CapturedPush {
  url: string;
  body: Uint8Array;
}

let captured: CapturedPush[] = [];
let replyStatus: (url: string) => number = () => 201;
let realFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  replyStatus = () => 201;
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://push.example")) return realFetch(input as RequestInfo, init);
    captured.push({ url, body: new Uint8Array(init?.body as ArrayBuffer) });
    return new Response(null, { status: replyStatus(url) });
  }) as typeof fetch;
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

// ---------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------

async function createInvite(params: unknown[] = []): Promise<string> {
  const reply = await callManagement("createinvite", params);
  expect(reply.error).toBeUndefined();
  return (reply.result as { code: string }).code;
}

async function redeem(code: string, who: Keypair) {
  return callManagement("redeeminvite", [code], { secretKeyHex: who.secretKeyHex });
}

async function newMember(): Promise<Keypair> {
  const member = randomKeypair();
  const reply = await redeem(await createInvite(), member);
  expect(reply.result).toBe(true);
  return member;
}

function wrapFor(...recipients: string[]): NostrEvent {
  return signEvent(randomKeypair().secretKeyHex, {
    kind: 1059,
    tags: recipients.map((p) => ["p", p]),
    content: "sealed contents the relay cannot read",
  });
}

async function sendWrap(wrap: NostrEvent): Promise<[boolean, string]> {
  const conn = await connect();
  const [, , ok, message] = await publish(conn, wrap);
  conn.close();
  return [ok, message];
}

async function subscribe(member: Keypair, device: FakeDevice) {
  return callManagement("subscribepush", [{ endpoint: device.endpoint, keys: device.keys }], {
    secretKeyHex: member.secretKeyHex,
  });
}

async function fireAlarm(): Promise<void> {
  await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
}

async function authenticate(conn: RelayConn, secretKeyHex: string): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage();
  conn.send([
    "AUTH",
    signEvent(secretKeyHex, {
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

async function readOwnMail(who: Keypair): Promise<NostrEvent[]> {
  const conn = await connect();
  await authenticate(conn, who.secretKeyHex);
  const events = await collectStored(conn, "inbox", [{ kinds: [1059], "#p": [who.pubkeyHex] }]);
  conn.close();
  return events;
}

async function sqlRows<T extends Record<string, SqlStorageValue>>(
  query: string,
  ...bindings: unknown[]
): Promise<T[]> {
  return runInDurableObject(stub(), (_i: Relay, state) =>
    state.storage.sql.exec<T>(query, ...bindings).toArray(),
  );
}

// ---------------------------------------------------------------------

describe("invite codes", () => {
  it("makes a code only the owner can ask for", async () => {
    const reply = await callManagement("createinvite");
    const invite = reply.result as { code: string; uses: number; expires_at: number };
    expect(invite.code).toMatch(/^[0-9a-f]{32}$/);
    expect(invite.uses).toBe(1);
    expect(invite.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(
      INVITE_DEFAULT_TTL_SECONDS - 60,
    );

    const member = await newMember();
    for (const who of [randomKeypair(), member]) {
      const refused = await callManagement("createinvite", [], { secretKeyHex: who.secretKeyHex });
      expect(refused.status).toBe(401);
    }
  });

  it("is single-use by default", async () => {
    const code = await createInvite();
    const first = randomKeypair();
    const second = randomKeypair();
    expect((await redeem(code, first)).result).toBe(true);
    const refused = await redeem(code, second);
    expect(refused.result).toBeUndefined();
    expect(refused.error).toBe(REDEEM_REFUSAL_MESSAGE);

    const members = (await callManagement("listallowedpubkeys")).result as {
      pubkey: string;
      reason: string;
    }[];
    expect(members).toEqual([{ pubkey: first.pubkeyHex, reason: "joined with an invite" }]);
  });

  it("admits as many people as the owner asked for, and no more", async () => {
    const code = await createInvite([3]);
    let listed = (await callManagement("listunusedinvites")).result as { code: string; uses_left: number }[];
    expect(listed).toEqual([expect.objectContaining({ code, uses_left: 3 })]);

    for (let i = 0; i < 3; i++) expect((await redeem(code, randomKeypair())).result).toBe(true);
    expect((await redeem(code, randomKeypair())).error).toBe(REDEEM_REFUSAL_MESSAGE);
    listed = (await callManagement("listunusedinvites")).result as { code: string; uses_left: number }[];
    expect(listed).toEqual([]);
  });

  it("does not spend a use when a member redeems again", async () => {
    // An app retrying a request whose answer it never saw.
    const code = await createInvite([2]);
    const member = randomKeypair();
    expect((await redeem(code, member)).result).toBe(true);
    expect((await redeem(code, member)).result).toBe(true);
    const listed = (await callManagement("listunusedinvites")).result as { uses_left: number }[];
    expect(listed[0]!.uses_left).toBe(1);
  });

  it("refuses uses and lifetimes outside the bounds, naming them", async () => {
    for (const params of [[0], [MEMBER_INVITE_MAX_USES + 1], [1.5], ["2"]]) {
      expect((await callManagement("createinvite", params)).error).toContain(
        `1 to ${MEMBER_INVITE_MAX_USES}`,
      );
    }
    expect((await callManagement("createinvite", [1, 31 * 24 * 60 * 60])).error).toContain("30 days");
  });

  it("expires", async () => {
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      const made = handleManagementCall(
        sql,
        env,
        "createinvite",
        [5, 60],
        "203.0.113.9",
        1_000,
        OWNER_PUBKEY_HEX,
      );
      const code = (made.result as { code: string }).code;
      const early = randomKeypair().pubkeyHex;
      const late = randomKeypair().pubkeyHex;
      expect(handleManagementCall(sql, env, "redeeminvite", [code], "203.0.113.9", 1_059, early).result).toBe(
        true,
      );
      const expired = handleManagementCall(sql, env, "redeeminvite", [code], "203.0.113.9", 1_060, late);
      expect(expired.error).toBe(REDEEM_REFUSAL_MESSAGE);
      expect(sql.exec(`SELECT 1 FROM allowed_pubkeys WHERE pubkey = ?`, late).toArray()).toEqual([]);
    });
  });

  it("can be revoked, and then admits nobody", async () => {
    const code = await createInvite([5]);
    expect((await callManagement("revokeinvite", [code])).result).toBe(true);
    expect((await redeem(code, randomKeypair())).error).toBe(REDEEM_REFUSAL_MESSAGE);
    expect((await callManagement("revokeinvite", [code])).error).toContain("already revoked");
  });

  it("cannot be forged", async () => {
    const code = await createInvite();
    const joiner = randomKeypair();

    // A code the relay never made, however well-formed.
    expect((await redeem("0".repeat(32), joiner)).error).toBe(REDEEM_REFUSAL_MESSAGE);

    // The right code under a signature that does not verify, or one made
    // for a different request: refused before the relay is reached, and
    // the use is not spent.
    const body = JSON.stringify({ method: "redeeminvite", params: [code] });
    const header = nip98Header(body, { secretKeyHex: joiner.secretKeyHex });
    const event = JSON.parse(atob(header.slice("Nostr ".length))) as NostrEvent;
    const forged = `Nostr ${btoa(JSON.stringify(withCorruptSignature(event)))}`;
    expect((await callManagement("redeeminvite", [code], { authHeader: forged })).status).toBe(401);
    const otherBody = nip98Header(JSON.stringify({ method: "redeeminvite", params: ["x"] }), {
      secretKeyHex: joiner.secretKeyHex,
    });
    expect((await callManagement("redeeminvite", [code], { authHeader: otherBody })).status).toBe(401);

    // A pubkey offered in the body is not who joins: the signer is.
    const bystander = randomKeypair();
    const reply = await callManagement("redeeminvite", [code, bystander.pubkeyHex], {
      secretKeyHex: joiner.secretKeyHex,
    });
    expect(reply.result).toBe(true);
    const members = (await callManagement("listallowedpubkeys")).result as { pubkey: string }[];
    expect(members.map((m) => m.pubkey)).toEqual([joiner.pubkeyHex]);
  });

  it("is one of the two methods a stranger may call", async () => {
    expect(ANYONE_CALLABLE_METHODS).toEqual(["redeeminvite", "requestjoin"]);
    const stranger = randomKeypair();
    for (const method of ["listallowedpubkeys", "listunusedinvites", "unallowpubkey"]) {
      const reply = await callManagement(method, [stranger.pubkeyHex], {
        secretKeyHex: stranger.secretKeyHex,
      });
      expect(reply.status).toBe(401);
    }
  });
});

describe("an inbox for every member", () => {
  it("accepts mail addressed to a member", async () => {
    const member = await newMember();
    const wrap = wrapFor(member.pubkeyHex);
    expect(await sendWrap(wrap)).toEqual([true, ""]);
    expect((await readOwnMail(member)).map((e) => e.id)).toEqual([wrap.id]);
  });

  it("refuses mail addressed to somebody who is not a member", async () => {
    const [ok, message] = await sendWrap(wrapFor(randomKeypair().pubkeyHex));
    expect(ok).toBe(false);
    expect(message).toBe(
      "restricted: gift wrap is not addressed to this relay's owner or one of its members",
    );
  });

  it("lets a member read only their own mail", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const forAlice = wrapFor(alice.pubkeyHex);
    const forOwner = wrapFor(OWNER_PUBKEY_HEX);
    await sendWrap(forAlice);
    await sendWrap(forOwner);

    expect(await readOwnMail(bob)).toEqual([]);
    expect((await readOwnMail(alice)).map((e) => e.id)).toEqual([forAlice.id]);

    const conn = await connect();
    await authenticate(conn, bob.secretKeyHex);
    for (const filter of [
      { kinds: [1059] },
      { kinds: [1059], "#p": [alice.pubkeyHex] },
      { kinds: [1059], "#p": [bob.pubkeyHex, OWNER_PUBKEY_HEX] },
    ]) {
      conn.send(["REQ", "peek", filter]);
      const [type, , reason] = await conn.nextMessage();
      expect(type).toBe("CLOSED");
      expect(reason).toContain("only the gift wraps addressed to you");
    }
    // A filter that does not name the kind gets no mail by omission.
    expect(await collectStored(conn, "broad", [{ "#p": [alice.pubkeyHex] }])).toEqual([]);
    conn.close();
  });

  it("delivers new mail live to the member's own subscription only", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const aliceConn = await connect();
    await authenticate(aliceConn, alice.secretKeyHex);
    expect(await collectStored(aliceConn, "inbox", [{ kinds: [1059], "#p": [alice.pubkeyHex] }])).toEqual([]);
    const bobConn = await connect();
    await authenticate(bobConn, bob.secretKeyHex);
    // Bob asks for anything p-tagged to Alice without naming the kind,
    // which the REQ gate answers by omission. The live path must agree.
    expect(await collectStored(bobConn, "broad", [{ "#p": [alice.pubkeyHex] }])).toEqual([]);

    const wrap = wrapFor(alice.pubkeyHex);
    await sendWrap(wrap);
    const [type, subId, event] = await aliceConn.nextMessage();
    expect([type, subId, (event as NostrEvent).id]).toEqual(["EVENT", "inbox", wrap.id]);
    await expect(bobConn.nextMessage(300)).rejects.toThrow();
    aliceConn.close();
    bobConn.close();
  });
});

describe("push for members", () => {
  it("announces a member's mail to that member's devices with a payload that carries nothing about it", async () => {
    const alice = await newMember();
    const bob = await newMember();
    const aliceDevice = await makeDevice("https://push.example/alice");
    const bobDevice = await makeDevice("https://push.example/bob");
    expect((await subscribe(alice, aliceDevice)).result).toBe(true);
    expect((await subscribe(bob, bobDevice)).result).toBe(true);

    const wrap = wrapFor(alice.pubkeyHex);
    await sendWrap(wrap);
    await fireAlarm();

    expect(captured.map((p) => p.url)).toEqual([aliceDevice.endpoint]);
    const plaintext = await decryptPush(aliceDevice, captured[0]!.body);
    const payload = JSON.parse(plaintext) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["kind", "room"]);
    expect(payload.kind).toBe("message");
    expect(typeof payload.room).toBe("string");
    // Nothing the wrap carried, and nobody's key.
    for (const secret of [wrap.id, wrap.pubkey, wrap.content, alice.pubkeyHex, wrap.sig]) {
      expect(plaintext).not.toContain(secret);
    }
  });

  it("folds a burst of mail into one notification", async () => {
    const alice = await newMember();
    const device = await makeDevice("https://push.example/alice-burst");
    await subscribe(alice, device);
    for (let i = 0; i < 3; i++) await sendWrap(wrapFor(alice.pubkeyHex));
    await fireAlarm();
    expect(captured.length).toBe(1);
  });

  it("queues nothing for a member with no devices", async () => {
    const alice = await newMember();
    await sendWrap(wrapFor(alice.pubkeyHex));
    expect(await sqlRows(`SELECT pubkey FROM inbox_push`)).toEqual([]);
  });

  it("does not push to a member whose app is open", async () => {
    const alice = await newMember();
    const device = await makeDevice("https://push.example/alice-open");
    await subscribe(alice, device);
    const conn = await connect();
    await authenticate(conn, alice.secretKeyHex);
    await sendWrap(wrapFor(alice.pubkeyHex));
    await fireAlarm();
    expect(captured).toEqual([]);
    expect(await sqlRows(`SELECT pubkey FROM inbox_push`)).toEqual([]);
    conn.close();
  });

  it("forgets an endpoint the push service reports gone", async () => {
    const alice = await newMember();
    const dead = await makeDevice("https://push.example/alice-dead");
    const flaky = await makeDevice("https://push.example/alice-flaky");
    await subscribe(alice, dead);
    await subscribe(alice, flaky);
    replyStatus = (url) => (url === dead.endpoint ? 410 : 503);
    await sendWrap(wrapFor(alice.pubkeyHex));
    await fireAlarm();
    const rows = await sqlRows<{ endpoint: string }>(
      `SELECT endpoint FROM push_subscriptions WHERE pubkey = ?`,
      alice.pubkeyHex,
    );
    expect(rows.map((r) => r.endpoint)).toEqual([flaky.endpoint]);
  });

  it("spends no more than one invocation's subrequests, serving each member whole, and resumes on the next alarm", async () => {
    const perMember = MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY;
    const memberCount = Math.floor(MAX_PUSHES_PER_TICK / perMember) + 2;
    const code = await createInvite([memberCount]);
    const members: Keypair[] = [];
    for (let i = 0; i < memberCount; i++) {
      const member = randomKeypair();
      expect((await redeem(code, member)).result).toBe(true);
      for (let d = 0; d < perMember; d++) {
        await subscribe(member, await makeDevice(`https://push.example/m${i}-d${d}`));
      }
      members.push(member);
    }
    for (const member of members) expect((await sendWrap(wrapFor(member.pubkeyHex)))[0]).toBe(true);

    await fireAlarm();
    const firstTick = captured.length;
    expect(firstTick).toBeLessThanOrEqual(MAX_PUSHES_PER_TICK);
    expect(firstTick % perMember).toBe(0);
    await fireAlarm();
    expect(captured.length).toBe(memberCount * perMember);
    expect(new Set(captured.map((p) => p.url)).size).toBe(memberCount * perMember);
  });

  it("lets a member who joined by invite subscribe even with groups paused", async () => {
    const alice = await newMember();
    const saved = mutableEnv.GROUPS;
    mutableEnv.GROUPS = "off";
    try {
      const reply = await subscribe(alice, await makeDevice("https://push.example/alice-paused"));
      expect(reply.result).toBe(true);
    } finally {
      mutableEnv.GROUPS = saved;
    }
  });
});

describe("removing a member", () => {
  it("refuses new mail for them, drops their devices and stops their pushes", async () => {
    const alice = await newMember();
    const device = await makeDevice("https://push.example/alice-removed");
    await subscribe(alice, device);
    // Queued but not yet sent when the owner removes them.
    await sendWrap(wrapFor(alice.pubkeyHex));

    expect((await callManagement("unallowpubkey", [alice.pubkeyHex])).result).toBe(true);
    await fireAlarm();
    expect(captured).toEqual([]);
    expect(
      await sqlRows(`SELECT endpoint FROM push_subscriptions WHERE pubkey = ?`, alice.pubkeyHex),
    ).toEqual([]);

    const [ok, message] = await sendWrap(wrapFor(alice.pubkeyHex));
    expect(ok).toBe(false);
    expect(message).toContain("not addressed to this relay's owner or one of its members");
    // How their app learns it has lost its home here: a stable reason,
    // with or without a device to register.
    const refused = await subscribe(alice, device);
    expect([refused.status, refused.error]).toEqual([401, NOT_A_MEMBER_REASON]);
    const probe = await callManagement("unsubscribepush", [device.endpoint], {
      secretKeyHex: alice.secretKeyHex,
    });
    expect([probe.status, probe.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });

  it("keeps their stored mail readable for the grace period, then sweeps it", async () => {
    const alice = await newMember();
    const kept = wrapFor(alice.pubkeyHex);
    const shared = wrapFor(alice.pubkeyHex, OWNER_PUBKEY_HEX);
    await sendWrap(kept);
    await sendWrap(shared);
    await callManagement("unallowpubkey", [alice.pubkeyHex]);

    expect((await readOwnMail(alice)).map((e) => e.id).sort()).toEqual([kept.id, shared.id].sort());

    const removedAt = (
      await sqlRows<{ removed_at: number }>(
        `SELECT removed_at FROM former_members WHERE pubkey = ?`,
        alice.pubkeyHex,
      )
    )[0]!.removed_at;
    const sweep = (nowSec: number) =>
      runInDurableObject(stub(), (_i: Relay, state) =>
        sweepFormerMembers(state.storage.sql, nowSec, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100),
      );

    expect(await sweep(removedAt + MEMBER_REMOVAL_GRACE_SECONDS - 1)).toEqual({ removed: 0, finished: 0 });
    expect((await readOwnMail(alice)).length).toBe(2);

    expect(await sweep(removedAt + MEMBER_REMOVAL_GRACE_SECONDS)).toEqual({ removed: 1, finished: 1 });
    // The wrap that is also the owner's mail stays.
    expect((await readOwnMail(alice)).map((e) => e.id)).toEqual([shared.id]);
    expect(await sqlRows(`SELECT pubkey FROM former_members`)).toEqual([]);
  });

  it("stops the clock if they are let back in", async () => {
    const alice = await newMember();
    await sendWrap(wrapFor(alice.pubkeyHex));
    await callManagement("unallowpubkey", [alice.pubkeyHex]);
    expect((await redeem(await createInvite(), alice)).result).toBe(true);
    expect(await sqlRows(`SELECT pubkey FROM former_members`)).toEqual([]);
    const result = await runInDurableObject(stub(), (_i: Relay, state) =>
      sweepFormerMembers(state.storage.sql, 2 ** 40, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100),
    );
    expect(result).toEqual({ removed: 0, finished: 0 });
    expect((await readOwnMail(alice)).length).toBe(1);
  });

  it("starts no clock for a pubkey that was never a member", async () => {
    await callManagement("unallowpubkey", [randomKeypair().pubkeyHex]);
    expect(await sqlRows(`SELECT pubkey FROM former_members`)).toEqual([]);
  });
});

describe("what the relay says about its members", () => {
  it("counts them on NIP-11 and /api/stats, beside whether push is on", async () => {
    await newMember();
    await newMember();
    const info = buildRelayInfo(
      env,
      { name: null, description: null, icon: null, writePolicy: null },
      null,
      OWNER_PUBKEY_HEX,
      "f".repeat(64),
      2,
    );
    expect(info.member_count).toBe(2);
    expect(
      buildRelayInfo(
        env,
        { name: null, description: null, icon: null, writePolicy: null },
        null,
        null,
        "f".repeat(64),
        2,
      ).member_count,
    ).toBeUndefined();

    const doc = (await (
      await exportsFetch("https://example.com/", { headers: { Accept: "application/nostr+json" } })
    ).json()) as Record<string, unknown>;
    expect(doc.member_count).toBe(2);
    expect(typeof doc.push_key).toBe("string");

    const stats = (await (await exportsFetch("https://example.com/api/stats")).json()) as Record<
      string,
      unknown
    >;
    expect(stats.memberCount).toBe(2);
    expect(stats.pushPolicy).toBe("on");
    delete mutableEnv.VAPID_PRIVATE_KEY;
    const off = (await (await exportsFetch("https://example.com/api/stats")).json()) as Record<
      string,
      unknown
    >;
    expect(off.pushPolicy).toBe("off");
  });
});

function exportsFetch(url: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(url, init));
}
