// NIP-37 drafts (kind 31234, src/nostr.ts DRAFT_KIND): stored like any
// event, served only to their author authenticated (NIP-42). Nobody else
// gets one -- not an unauthenticated socket, another member, a stranger, or
// the owner reading someone else's -- from a stored read, a kinds-less
// read, live fan-out or the live feed. The `mentions` policy does not admit
// a stranger's draft for p-tagging the owner.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { applyBackfillPage, seedBackfillRelays } from "../src/backfill";
import { afterEach, describe, expect, it } from "vitest";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { collectStored, connectLiveFeed, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.WRITE_POLICY;
});

const OWNER: Keypair = { secretKeyHex: OWNER_SECRET_KEY_HEX, pubkeyHex: OWNER_PUBKEY_HEX } as Keypair;

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.29.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

async function newMember(): Promise<Keypair> {
  const who = randomKeypair();
  expect((await callManagement("allowpubkey", [who.pubkeyHex])).result).toBe(true);
  return who;
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

async function connectAs(who: Keypair | null): Promise<RelayConn> {
  const conn = await connectRelay(freshIp());
  if (who !== null) await authenticate(conn, who);
  return conn;
}

function draft(who: Keypair, d: string, tags: string[][] = []): NostrEvent {
  return signEvent(who.secretKeyHex, {
    kind: 31234,
    tags: [["d", d], ["k", "1"], ...tags],
    content: "nip44-ciphertext-to-self",
  });
}

async function publishDraft(who: Keypair, d: string): Promise<NostrEvent> {
  const conn = await connectAs(who);
  const event = draft(who, d);
  const [, , ok, message] = await publish(conn, event);
  expect([ok, message]).toEqual([true, ""]);
  conn.close();
  return event;
}

// Every read shape that could reach a draft: by kind, by author, by id, by
// `d` tag; the last three name no kinds at all.
async function readable(reader: Keypair | null, event: NostrEvent): Promise<boolean[]> {
  const conn = await connectAs(reader);
  const shapes: Record<string, unknown>[] = [
    { kinds: [31234] },
    { authors: [event.pubkey] },
    { ids: [event.id] },
    { "#d": [event.tags[0]![1]] },
    { "#k": ["1"] },
  ];
  const seen: boolean[] = [];
  for (const [i, f] of shapes.entries()) {
    const events = await collectStored(conn, `s${i}`, [f]);
    seen.push(events.some((e) => e.id === event.id));
  }
  conn.close();
  return seen;
}

const ALL = [true, true, true, true, true];
const NONE = [false, false, false, false, false];

describe("NIP-37 draft read gate", () => {
  it("serves the owner's draft to the owner, authenticated, on every read shape", async () => {
    const event = await publishDraft(OWNER, "owner-draft");
    expect(await readable(OWNER, event)).toEqual(ALL);
  });

  it("serves a member's draft to that member, authenticated", async () => {
    const member = await newMember();
    const event = await publishDraft(member, "member-draft");
    expect(await readable(member, event)).toEqual(ALL);
  });

  it("withholds a draft from its own author when unauthenticated", async () => {
    const event = await publishDraft(OWNER, "unauthed");
    expect(await readable(null, event)).toEqual(NONE);
  });

  it("withholds a member's draft from another member", async () => {
    const event = await publishDraft(await newMember(), "a");
    expect(await readable(await newMember(), event)).toEqual(NONE);
  });

  it("withholds a member's draft from the owner", async () => {
    const event = await publishDraft(await newMember(), "not-yours");
    expect(await readable(OWNER, event)).toEqual(NONE);
  });

  it("withholds the owner's draft from a stranger", async () => {
    const event = await publishDraft(OWNER, "stranger");
    expect(await readable(randomKeypair(), event)).toEqual(NONE);
  });

  it("fans a new draft out live only to its author's authenticated sockets", async () => {
    const member = await newMember();
    const author = await connectAs(OWNER);
    const anon = await connectAs(null);
    const other = await connectAs(member);
    const feed = await connectLiveFeed();
    for (const conn of [author, anon, other]) {
      expect(await collectStored(conn, "live", [{ kinds: [31234] }, { authors: [OWNER_PUBKEY_HEX] }])).toEqual([]);
    }
    // Plus an unrelated event after the draft, so a socket that would have
    // received the draft has had the chance before we assert it did not.
    const event = await publishDraft(OWNER, "live");
    const marker = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "marker" });
    const pub = await connectAs(OWNER);
    expect((await publish(pub, marker))[2]).toBe(true);

    expect(await author.nextMessage()).toEqual(["EVENT", "live", event]);
    expect(await author.nextMessage()).toEqual(["EVENT", "live", marker]);
    for (const conn of [anon, other]) {
      expect(await conn.nextMessage()).toEqual(["EVENT", "live", marker]);
    }
    // The live feed never hears of the draft: its first notice is the marker.
    expect((await feed.nextMessage()).kind).toBe(1);
    for (const conn of [author, anon, other, pub]) conn.close();
    feed.close();
  });
});

describe("NIP-37 drafts stored by the owner backfill", () => {
  // backfill-worker.ts asks the owner's write relays for `authors: [owner]`
  // with no kind restriction, so their public relays' copies of their
  // drafts arrive this way, not over a socket. The gate is on the read,
  // so they get exactly the same treatment.
  it("serves a backfilled draft only to the owner, signed in", async () => {
    const event = draft(OWNER, "backfilled");
    const now = Math.floor(Date.now() / 1000);
    await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), async (_i, state) => {
      const sql = state.storage.sql;
      seedBackfillRelays(sql, ["wss://relay-a"], now);
      expect(applyBackfillPage(sql, OWNER_PUBKEY_HEX, "wss://relay-a", [event], true, now).stored).toBe(1);
    });
    expect(await readable(OWNER, event)).toEqual(ALL);
    expect(await readable(null, event)).toEqual(NONE);
    expect(await readable(await newMember(), event)).toEqual(NONE);
    expect(await readable(randomKeypair(), event)).toEqual(NONE);
  });
});

describe("NIP-37 draft write side", () => {
  it("refuses a stranger's draft under follows", async () => {
    const stranger = randomKeypair();
    const conn = await connectAs(null);
    const [, , ok] = await publish(conn, draft(stranger, "x"));
    expect(ok).toBe(false);
    conn.close();
  });

  it("refuses a stranger's draft under mentions even when it p-tags the owner", async () => {
    mutableEnv.WRITE_POLICY = "mentions";
    const stranger = randomKeypair();
    const conn = await connectAs(null);
    const [, , ok, message] = await publish(conn, draft(stranger, "x", [["p", OWNER_PUBKEY_HEX]]));
    expect(ok).toBe(false);
    expect(message.startsWith("restricted:")).toBe(true);
    // A stranger's ordinary mention is still admitted.
    const reply = signEvent(stranger.secretKeyHex, { kind: 1, tags: [["p", OWNER_PUBKEY_HEX]], content: "hi" });
    expect((await publish(conn, reply))[2]).toBe(true);
    conn.close();
  });
});
