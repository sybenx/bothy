// Join requests (nip86.ts requestjoin, approvejoin, declinejoin,
// listjoinrequests), the message the relay sends its owner about each one
// (join-requests.ts), the owner's member screen (listmembers), and the
// short-lived single-use invite an app shows as a QR code.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { npubEncode } from "../src/bech32";
import {
  JOIN_REQUEST_NAME_MAX_LENGTH,
  JOIN_REQUEST_TTL_SECONDS,
  MAX_PENDING_JOIN_REQUESTS,
  MAX_REQUEST_JOINS_PER_IP_PER_WINDOW,
  MEMBER_REMOVAL_GRACE_SECONDS,
} from "../src/limits";
import { NOT_A_MEMBER_REASON } from "../src/nip86";
import { conversationKey, nip44Decrypt } from "../src/nip44";
import type { Relay } from "../src/relay";
import { listJoinRequests, recordJoinRequest, sweepExpiredJoinRequests } from "../src/storage";
import { verifySignature } from "../src/validate";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { decryptPush, makeDevice } from "./helpers/push";
import { collectStored, connectRelay, type RelayConn } from "./helpers/socket";

isolateStorage();

const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
const mutableEnv = env as unknown as Record<string, unknown>;

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

// Its own block of addresses: requestjoin is throttled per address, and
// every test here calls it.
let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.24.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

let captured: { url: string; body: Uint8Array }[] = [];
let realFetch: typeof fetch;

beforeEach(() => {
  captured = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://push.example")) return realFetch(input as RequestInfo, init);
    captured.push({ url, body: new Uint8Array(init?.body as ArrayBuffer) });
    return new Response(null, { status: 201 });
  }) as typeof fetch;
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

function requestJoin(who: Keypair, details?: unknown, ip = freshIp()) {
  return callManagement("requestjoin", details === undefined ? [] : [details], {
    secretKeyHex: who.secretKeyHex,
    ip,
  });
}

async function relayPubkey(): Promise<string> {
  const response = await (
    await import("cloudflare:workers")
  ).exports.default.fetch(
    new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
  );
  return ((await response.json()) as { self: string }).self;
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

async function ownerInbox(): Promise<NostrEvent[]> {
  const conn = await connectRelay(freshIp());
  await authenticate(conn, OWNER_SECRET_KEY_HEX);
  const events = await collectStored(conn, "inbox", [{ kinds: [1059], "#p": [OWNER_PUBKEY_HEX] }]);
  conn.close();
  return events;
}

// What the owner's app does with a wrap: open it, check the seal and the
// rumor agree on who sent it.
function open(wrap: NostrEvent) {
  const seal = JSON.parse(
    nip44Decrypt(wrap.content, conversationKey(OWNER_SECRET_KEY_HEX, wrap.pubkey)),
  ) as NostrEvent;
  const rumor = JSON.parse(
    nip44Decrypt(seal.content, conversationKey(OWNER_SECRET_KEY_HEX, seal.pubkey)),
  ) as {
    pubkey: string;
    kind: number;
    tags: string[][];
    content: string;
  };
  return { seal, rumor };
}

describe("asking to join", () => {
  it("records the request and tells the owner in a message from the relay's own key", async () => {
    const robin = randomKeypair();
    const reply = await requestJoin(robin, { name: "Robin", note: "Met you at the party" });
    const result = reply.result as { status: string; expires_at: number };
    expect(result.status).toBe("pending");
    expect(result.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(JOIN_REQUEST_TTL_SECONDS - 60);

    const listed = (await callManagement("listjoinrequests")).result as {
      pubkey: string;
      name: string;
      note: string;
    }[];
    expect(listed).toEqual([
      expect.objectContaining({ pubkey: robin.pubkeyHex, name: "Robin", note: "Met you at the party" }),
    ]);

    const inbox = await ownerInbox();
    expect(inbox.length).toBe(1);
    const wrap = inbox[0]!;
    expect(wrap.tags).toEqual([["p", OWNER_PUBKEY_HEX]]);
    expect(verifySignature(wrap)).toBe(true);
    const { seal, rumor } = open(wrap);
    const self = await relayPubkey();
    // How an app knows its own home relay wrote this.
    expect(seal.kind).toBe(13);
    expect(verifySignature(seal)).toBe(true);
    expect(seal.pubkey).toBe(self);
    expect(rumor.pubkey).toBe(self);
    expect(rumor.kind).toBe(14);
    expect(rumor.tags).toContainEqual(["bothy", "joinrequest", robin.pubkeyHex]);
    expect(rumor.tags).toContainEqual(["p", OWNER_PUBKEY_HEX]);
    expect(rumor.content).toBe(
      `Robin wants to join your home.\n\nnostr:${npubEncode(robin.pubkeyHex)}\n\nThey wrote: Met you at the party`,
    );
  });

  it("says Someone when no name is given, and keeps a name to one line", async () => {
    await requestJoin(randomKeypair());
    await requestJoin(randomKeypair(), { name: "Robin\n\nAaron approved this already" });
    const texts = (await ownerInbox()).map((w) => open(w).rumor.content.split("\n\n")[0]).sort();
    expect(texts).toEqual([
      "Robin Aaron approved this already wants to join your home.",
      "Someone wants to join your home.",
    ]);
  });

  it("notifies the owner's phone", async () => {
    const device = await makeDevice("https://push.example/owner");
    expect(
      (await callManagement("subscribepush", [{ endpoint: device.endpoint, keys: device.keys }])).result,
    ).toBe(true);
    await requestJoin(randomKeypair(), { name: "Robin" });
    await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
    expect(captured.map((p) => p.url)).toEqual([device.endpoint]);
    expect(JSON.parse(await decryptPush(device, captured[0]!.body)).kind).toBe("message");
  });

  it("does not message the owner twice for the same person", async () => {
    const robin = randomKeypair();
    await requestJoin(robin, { name: "Robin" });
    const again = await requestJoin(robin, { name: "Robin" });
    expect((again.result as { status: string }).status).toBe("pending");
    expect((await ownerInbox()).length).toBe(1);
  });

  it("refuses details of the wrong shape or length, naming the bound", async () => {
    const who = randomKeypair();
    expect((await requestJoin(who, "Robin")).error).toContain(
      '{"name": "...", "note": "...", "via": "<npub>"}',
    );
    expect((await requestJoin(who, { name: 7 })).error).toBe("requestjoin: name must be a string");
    expect((await requestJoin(who, { name: "x".repeat(JOIN_REQUEST_NAME_MAX_LENGTH + 1) })).error).toContain(
      `at most ${JOIN_REQUEST_NAME_MAX_LENGTH} characters`,
    );
  });

  it("throttles one address", async () => {
    const ip = freshIp();
    for (let i = 0; i < MAX_REQUEST_JOINS_PER_IP_PER_WINDOW; i++) {
      expect((await requestJoin(randomKeypair(), undefined, ip)).error).toBeUndefined();
    }
    expect((await requestJoin(randomKeypair(), undefined, ip)).error).toContain(
      "too many requests from this address",
    );
  });

  it("stops taking requests while too many wait, and says so", async () => {
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const now = Math.floor(Date.now() / 1000);
      for (let i = 0; i < MAX_PENDING_JOIN_REQUESTS; i++) {
        state.storage.sql.exec(
          `INSERT INTO join_requests (pubkey, requested_at, expires_at) VALUES (?, ?, ?)`,
          i.toString(16).padStart(64, "0"),
          now,
          now + 1000,
        );
      }
    });
    expect((await requestJoin(randomKeypair())).error).toBe(
      "requestjoin: too many requests are waiting for an answer here. Try again later.",
    );
    expect(await ownerInbox()).toEqual([]);
  });

  it("refuses a banned pubkey and answers a member as a member", async () => {
    const banned = randomKeypair();
    await callManagement("banpubkey", [banned.pubkeyHex]);
    expect((await requestJoin(banned)).error).toContain("does not accept requests from you");

    const member = randomKeypair();
    await callManagement("allowpubkey", [member.pubkeyHex]);
    expect((await requestJoin(member)).result).toEqual({ status: "member" });
    expect(await ownerInbox()).toEqual([]);
  });

  it("is owner-only to list and answer", async () => {
    const stranger = randomKeypair();
    for (const method of ["listjoinrequests", "approvejoin", "declinejoin", "listmembers"]) {
      const reply = await callManagement(method, [stranger.pubkeyHex], {
        secretKeyHex: stranger.secretKeyHex,
      });
      expect(reply.status).toBe(401);
    }
  });
});

describe("answering a request", () => {
  it("approval makes them a member, which their app learns on its next call", async () => {
    const robin = randomKeypair();
    await requestJoin(robin, { name: "Robin" });
    const device = await makeDevice("https://push.example/robin");
    const sub = { endpoint: device.endpoint, keys: device.keys };

    const before = await callManagement("subscribepush", [sub], { secretKeyHex: robin.secretKeyHex });
    expect([before.status, before.error]).toEqual([401, NOT_A_MEMBER_REASON]);

    expect((await callManagement("approvejoin", [npubEncode(robin.pubkeyHex)])).result).toBe(true);
    expect((await callManagement("listjoinrequests")).result).toEqual([]);

    expect((await requestJoin(robin)).result).toEqual({ status: "member" });
    expect((await callManagement("subscribepush", [sub], { secretKeyHex: robin.secretKeyHex })).result).toBe(
      true,
    );

    const { members } = (await callManagement("listmembers")).result as {
      members: { pubkey: string; invitedBy: string; joinedAt: number; source: string }[];
    };
    expect(members).toEqual([
      {
        pubkey: robin.pubkeyHex,
        invitedBy: OWNER_PUBKEY_HEX,
        joinedAt: expect.any(Number),
        source: "request",
        role: "member",
      },
    ]);
  });

  it("decline is remembered, so asking again neither succeeds nor messages the owner", async () => {
    const robin = randomKeypair();
    await requestJoin(robin, { name: "Robin" });
    expect((await callManagement("declinejoin", [robin.pubkeyHex])).result).toBe(true);
    expect((await requestJoin(robin, { name: "Robin" })).result).toEqual({ status: "declined" });
    expect((await ownerInbox()).length).toBe(1);
    expect((await callManagement("approvejoin", [robin.pubkeyHex])).error).toContain(
      "no request from that pubkey",
    );
    expect((await callManagement("listjoinrequests")).result).toEqual([]);
  });

  it("refuses to answer a request nobody made, and points at allowpubkey", async () => {
    const reply = await callManagement("approvejoin", [randomKeypair().pubkeyHex]);
    expect(reply.error).toBe(
      "approvejoin: no request from that pubkey is waiting. To let someone in without one, use allowpubkey.",
    );
    expect((await callManagement("declinejoin", [randomKeypair().pubkeyHex])).error).toContain("no request");
  });

  it("expires after 30 days, answered or not", async () => {
    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      const a = "a".repeat(64);
      expect(recordJoinRequest(sql, a, null, null, 1_000, JOIN_REQUEST_TTL_SECONDS, 50).status).toBe(
        "created",
      );
      expect(listJoinRequests(sql, 1_000 + JOIN_REQUEST_TTL_SECONDS - 1).length).toBe(1);
      expect(listJoinRequests(sql, 1_000 + JOIN_REQUEST_TTL_SECONDS)).toEqual([]);
      sweepExpiredJoinRequests(sql, 1_000 + JOIN_REQUEST_TTL_SECONDS);
      expect(sql.exec(`SELECT 1 FROM join_requests`).toArray()).toEqual([]);
      // Expired, so asking again is a new request.
      expect(
        recordJoinRequest(sql, a, null, null, 1_000 + JOIN_REQUEST_TTL_SECONDS, JOIN_REQUEST_TTL_SECONDS, 50)
          .status,
      ).toBe("created");
    });
  });
});

describe("the member screen", () => {
  it("lists members with who let them in, and removed members with when their mail goes", async () => {
    const code = ((await callManagement("createinvite")).result as { code: string }).code;
    const viaInvite = randomKeypair();
    await callManagement("redeeminvite", [code], { secretKeyHex: viaInvite.secretKeyHex });
    const viaAllow = randomKeypair();
    await callManagement("allowpubkey", [viaAllow.pubkeyHex]);

    let screen = (await callManagement("listmembers")).result as {
      members: { pubkey: string; invitedBy: string; source: string }[];
      removed: { pubkey: string; removedAt: number; deletesAt: number }[];
    };
    expect(screen.members.map((m) => [m.pubkey, m.invitedBy, m.source]).sort()).toEqual(
      [
        [viaInvite.pubkeyHex, OWNER_PUBKEY_HEX, "member"],
        [viaAllow.pubkeyHex, OWNER_PUBKEY_HEX, "owner"],
      ].sort(),
    );
    expect(screen.removed).toEqual([]);

    await callManagement("unallowpubkey", [viaInvite.pubkeyHex]);
    screen = (await callManagement("listmembers")).result as typeof screen;
    expect(screen.members.map((m) => m.pubkey)).toEqual([viaAllow.pubkeyHex]);
    expect(screen.removed).toEqual([
      { pubkey: viaInvite.pubkeyHex, removedAt: expect.any(Number), deletesAt: expect.any(Number) },
    ]);
    expect(screen.removed[0]!.deletesAt - screen.removed[0]!.removedAt).toBe(MEMBER_REMOVAL_GRACE_SECONDS);

    // Letting them back in is allowpubkey, and stops the clock.
    await callManagement("allowpubkey", [viaInvite.pubkeyHex]);
    screen = (await callManagement("listmembers")).result as typeof screen;
    expect(screen.removed).toEqual([]);
    expect(screen.members.map((m) => m.pubkey).sort()).toEqual(
      [viaInvite.pubkeyHex, viaAllow.pubkeyHex].sort(),
    );
  });
});

describe("an invite shown as a QR code", () => {
  it("works once, for ten minutes", async () => {
    const reply = await callManagement("createinvite", [1, 600]);
    const invite = reply.result as { code: string; uses: number; expires_at: number };
    const now = Math.floor(Date.now() / 1000);
    expect(invite.uses).toBe(1);
    expect(invite.expires_at - now).toBeGreaterThanOrEqual(599);
    expect(invite.expires_at - now).toBeLessThanOrEqual(600);
    const first = randomKeypair();
    expect(
      (await callManagement("redeeminvite", [invite.code], { secretKeyHex: first.secretKeyHex })).result,
    ).toBe(true);
    const second = randomKeypair();
    expect(
      (await callManagement("redeeminvite", [invite.code], { secretKeyHex: second.secretKeyHex })).error,
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------
// The invite tree: who let whom in (allowed_pubkeys.invited_by), shown flat
// by listmembers and respected by removal.
// ---------------------------------------------------------------------

type Screen = {
  members: { pubkey: string; invitedBy: string; source: string }[];
  removed: { pubkey: string }[];
};

async function screen(): Promise<Screen> {
  return (await callManagement("listmembers")).result as Screen;
}

function parentOf(s: Screen, who: Keypair): string | undefined {
  return s.members.find((m) => m.pubkey === who.pubkeyHex)?.invitedBy;
}

// A code as a member would make one. Only the owner can call createinvite
// today, so the row is written directly: what is under test is that the
// creator is carried into the tree, which is the step that will not change
// when members can make codes.
async function codeMadeBy(creator: Keypair): Promise<string> {
  const code = crypto.randomUUID().replace(/-/g, "");
  await runInDurableObject(stub(), (_i: Relay, state) => {
    const now = Math.floor(Date.now() / 1000);
    state.storage.sql.exec(
      `INSERT INTO member_invites (code, created_at, expires_at, uses_allowed, uses, created_by)
         VALUES (?, ?, ?, 1, 0, ?)`,
      code,
      now,
      now + 600,
      creator.pubkeyHex,
    );
  });
  return code;
}

async function joinWith(code: string): Promise<Keypair> {
  const who = randomKeypair();
  expect((await callManagement("redeeminvite", [code], { secretKeyHex: who.secretKeyHex })).result).toBe(
    true,
  );
  return who;
}

// owner -> alice -> bob -> carol, and owner -> dave.
async function tree() {
  const alice = await joinWith(((await callManagement("createinvite")).result as { code: string }).code);
  const bob = await joinWith(await codeMadeBy(alice));
  const carol = await joinWith(await codeMadeBy(bob));
  const dave = await joinWith(((await callManagement("createinvite")).result as { code: string }).code);
  return { alice, bob, carol, dave };
}

describe("the invite tree", () => {
  it("records each code's creator as the inviter of whoever redeems it", async () => {
    const { alice, bob, carol, dave } = await tree();
    const s = await screen();
    expect(parentOf(s, alice)).toBe(OWNER_PUBKEY_HEX);
    expect(parentOf(s, bob)).toBe(alice.pubkeyHex);
    expect(parentOf(s, carol)).toBe(bob.pubkeyHex);
    expect(parentOf(s, dave)).toBe(OWNER_PUBKEY_HEX);
    const createdBy = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql
        .exec<{ created_by: string }>(`SELECT DISTINCT created_by FROM member_invites`)
        .toArray(),
    );
    expect(createdBy).toContainEqual({ created_by: OWNER_PUBKEY_HEX });
  });

  it("hangs an approved request from the member whose link it came through", async () => {
    const { alice } = await tree();
    const robin = randomKeypair();
    await requestJoin(robin, { name: "Robin", via: npubEncode(alice.pubkeyHex) });
    const listed = (await callManagement("listjoinrequests")).result as { pubkey: string; via: string }[];
    expect(listed.find((r) => r.pubkey === robin.pubkeyHex)?.via).toBe(alice.pubkeyHex);
    await callManagement("approvejoin", [robin.pubkeyHex]);
    expect(parentOf(await screen(), robin)).toBe(alice.pubkeyHex);
  });

  it("hangs it from the owner when the link names somebody who is not a member", async () => {
    const robin = randomKeypair();
    await requestJoin(robin, { via: randomKeypair().pubkeyHex });
    await callManagement("approvejoin", [robin.pubkeyHex]);
    expect(parentOf(await screen(), robin)).toBe(OWNER_PUBKEY_HEX);
    expect((await requestJoin(randomKeypair(), { via: "nope" })).error).toBe(
      "requestjoin: via must be a pubkey, as npub or 64-character hex",
    );
  });

  it("reports a row with no recorded inviter as the owner's", async () => {
    const legacy = randomKeypair();
    await runInDurableObject(stub(), (_i: Relay, state) => {
      state.storage.sql.exec(
        `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source) VALUES (?, NULL, 1, 'owner')`,
        legacy.pubkeyHex,
      );
    });
    expect(parentOf(await screen(), legacy)).toBe(OWNER_PUBKEY_HEX);
  });
});

describe("removing someone who invited others", () => {
  it("by default keeps the people they invited, now invited by the owner", async () => {
    const { alice, bob, carol } = await tree();
    const reply = await callManagement("unallowpubkey", [alice.pubkeyHex]);
    expect(reply.result).toBe(true);
    expect(reply.error).toBe("The 1 person they invited is still a member, now listed as invited by you.");
    const s = await screen();
    expect(parentOf(s, alice)).toBeUndefined();
    expect(parentOf(s, bob)).toBe(OWNER_PUBKEY_HEX);
    expect(parentOf(s, carol)).toBe(bob.pubkeyHex);
    expect(s.removed.map((r) => r.pubkey)).toEqual([alice.pubkeyHex]);
  });

  it('with {"invitees": "keep"} does the same, said explicitly', async () => {
    const { alice, bob } = await tree();
    await callManagement("unallowpubkey", [alice.pubkeyHex, { invitees: "keep" }]);
    expect(parentOf(await screen(), bob)).toBe(OWNER_PUBKEY_HEX);
  });

  it('with {"invitees": "remove"} removes everyone below them, each with the usual grace', async () => {
    const { alice, bob, carol, dave } = await tree();
    const reply = await callManagement("unallowpubkey", [alice.pubkeyHex, { invitees: "remove" }]);
    expect(reply.result).toBe(true);
    expect(reply.error).toBe("Also removed 2 people they invited, directly or through someone they invited.");
    const s = await screen();
    expect(s.members.map((m) => m.pubkey)).toEqual([dave.pubkeyHex]);
    expect(s.removed.map((r) => r.pubkey).sort()).toEqual(
      [alice.pubkeyHex, bob.pubkeyHex, carol.pubkeyHex].sort(),
    );
  });

  it("says nothing extra for someone who invited nobody, and refuses an unknown option", async () => {
    const { carol, bob } = await tree();
    const reply = await callManagement("unallowpubkey", [carol.pubkeyHex, { invitees: "remove" }]);
    expect(reply).toEqual({ status: 200, result: true });
    expect((await callManagement("unallowpubkey", [bob.pubkeyHex, { invitees: "all" }])).error).toBe(
      'unallowpubkey: the second parameter is optional, {"invitees": "keep"} or {"invitees": "remove"}',
    );
    expect(parentOf(await screen(), bob)).toBeDefined();
  });
});
