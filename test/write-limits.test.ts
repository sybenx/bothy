// Write-path abuse caps (src/limits.ts) -- what an author who IS allowed
// to write can cost. Distinct from test/ownership.test.ts and
// test/follows.test.ts, which cover who may write at all, and from
// test/read-limits.test.ts, which bounds the public read path.
//
// The gap these close: ALLOW_FOLLOWS became an opt-out in v0.2.0, so the
// write path went from one trusted author to hundreds of followed
// pubkeys while every abuse cap in the project was still scoped to
// kind-1059 gift wraps. Each scenario below is named for the abuse it
// refuses, not for the constant it reads.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EVENT_BYTES, MAX_EVENTS_PER_PUBKEY_PER_WINDOW } from "../src/limits";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { type Keypair, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

// relay.ts calls verifySignature through this module, so spying on it is
// what proves the size check runs BEFORE schnorr rather than after --
// same technique as test/write-path-ordering.test.ts.
vi.mock("../src/validate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validate")>();
  return { ...actual, verifySignature: vi.fn(actual.verifySignature) };
});

isolateStorage();

// Publishing the owner's kind-3 over the wire refreshes the follow cache
// immediately (relay.ts acceptEvent), so the returned keypair may write
// from that point on.
async function addFollow(conn: RelayConn): Promise<Keypair> {
  const friend = randomKeypair();
  await publishFollowList(conn, [friend]);
  return friend;
}

// Every follow in one kind-3. A kind-3 is replaceable, so a test wanting
// two follows has to name both in a single contact list -- publishing a
// second one would drop the first friend rather than add to them.
async function publishFollowList(conn: RelayConn, friends: Keypair[]): Promise<void> {
  const contacts = signEvent(OWNER_SECRET_KEY_HEX, {
    kind: 3,
    tags: friends.map((f) => ["p", f.pubkeyHex]),
  });
  const [, , ok] = await publish(conn, contacts);
  expect(ok).toBe(true);
}

// Publishes `count` distinct notes from one key and returns each reply's
// [ok, message]. Distinct content per event so none is ever refused as a
// duplicate.
async function publishBurst(
  conn: RelayConn,
  key: { secretKeyHex: string },
  count: number,
  label: string,
): Promise<Array<[boolean, string]>> {
  const replies: Array<[boolean, string]> = [];
  for (let i = 0; i < count; i++) {
    const note = signEvent(key.secretKeyHex, { kind: 1, content: `${label} ${i}` });
    const [, , ok, message] = await publish(conn, note);
    replies.push([ok, message]);
  }
  return replies;
}

// Comfortably past the cap once JSON-serialized, without being so large
// that signing it dominates the test's runtime.
const OVERSIZED_CONTENT = "x".repeat(MAX_EVENT_BYTES + 8_000);

describe("event size cap", () => {
  it("refuses an oversized event from a follow, before paying for signature verification", async () => {
    const conn = await connectRelay();
    const friend = await addFollow(conn);

    const { verifySignature } = await import("../src/validate");
    vi.mocked(verifySignature).mockClear();

    const huge = signEvent(friend.secretKeyHex, { kind: 1, content: OVERSIZED_CONTENT });
    const [, id, ok, message] = await publish(conn, huge);

    expect(id).toBe(huge.id);
    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    // The signature on this event is genuinely valid -- if the size check
    // ran after schnorr, verifySignature would show a call here. It is the
    // whole point of putting the cheapest check first (CLAUDE.md "The budget").
    expect(verifySignature).not.toHaveBeenCalled();
    conn.close();
  });

  it("refuses an oversized event from the OWNER too", async () => {
    // A cap the owner can exceed does not bound stored bytes at all --
    // the owner is the one author guaranteed to be writing here.
    const conn = await connectRelay();
    const huge = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: OVERSIZED_CONTENT });

    const [, , ok, message] = await publish(conn, huge);

    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("accepts an event comfortably under the cap from a follow", async () => {
    const conn = await connectRelay();
    const friend = await addFollow(conn);

    const long = signEvent(friend.secretKeyHex, {
      kind: 1,
      content: "x".repeat(MAX_EVENT_BYTES - 2_000),
    });
    const [, , ok] = await publish(conn, long);

    expect(ok).toBe(true);
    conn.close();
  });
});

describe("per-pubkey write throttle", () => {
  it("throttles a follow past the per-pubkey rate without touching a different follow on the same IP", async () => {
    // Both follows share one connection, and therefore one IP. If the
    // limit were keyed by address -- as every throttle in this project was
    // before this one -- the second friend would inherit the first's
    // exhausted budget. Their pubkeys are different, so their budgets are.
    const conn = await connectRelay("203.0.113.10");
    const noisy = randomKeypair();
    const quiet = randomKeypair();
    await publishFollowList(conn, [noisy, quiet]);

    const replies = await publishBurst(conn, noisy, MAX_EVENTS_PER_PUBKEY_PER_WINDOW + 1, "noisy");

    const refused = replies.filter(([ok]) => !ok);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every(([, message]) => message.startsWith("rate-limited:"))).toBe(true);

    const quietNote = signEvent(quiet.secretKeyHex, { kind: 1, content: "still allowed" });
    const [, , quietOk] = await publish(conn, quietNote);
    expect(quietOk).toBe(true);
    conn.close();
  });

  it("keeps throttling the same pubkey across two different IPs", async () => {
    // The bypass the per-IP limit has and this one closes: a phone on
    // cellular and a laptop on wifi are two addresses and one author.
    const cellular = await connectRelay("203.0.113.20");
    const friend = await addFollow(cellular);
    const wifi = await connectRelay("198.51.100.30");

    const half = Math.ceil((MAX_EVENTS_PER_PUBKEY_PER_WINDOW + 1) / 2);
    const first = await publishBurst(cellular, friend, half, "cellular");
    const second = await publishBurst(wifi, friend, half, "wifi");

    // Neither burst alone exceeds the cap; together they do, and the
    // change of address buys nothing.
    expect(first.every(([ok]) => ok)).toBe(true);
    const refused = second.filter(([ok]) => !ok);
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every(([, message]) => message.startsWith("rate-limited:"))).toBe(true);
    cellular.close();
    wifi.close();
  });

  it("exempts the owner", async () => {
    // A client catching up after being offline republishes a backlog in
    // one burst; that is normal for the owner and abnormal for a follow.
    const conn = await connectRelay("203.0.113.40");

    const replies = await publishBurst(
      conn,
      { secretKeyHex: OWNER_SECRET_KEY_HEX },
      MAX_EVENTS_PER_PUBKEY_PER_WINDOW + 5,
      "owner",
    );

    expect(replies.every(([ok]) => ok)).toBe(true);
    conn.close();
  });
});

// The reserved-share threshold is 2.5GB by default, which no test is
// going to reach by writing events. It is exercised through its own env
// override instead -- lowering the threshold and raising the database
// past it are the same condition from the check's point of view, and the
// override is a documented, supported configuration rather than a test
// hook. The DO reads `this.env` from the same object the test mutates.
const mutableEnv = env as unknown as Record<string, string | undefined>;

describe("non-owner storage headroom", () => {
  afterEach(() => {
    delete mutableEnv.NON_OWNER_STORAGE_BYTES;
  });

  it("refuses a follow's write once storage passes the reserved share, while the owner still writes", async () => {
    const conn = await connectRelay("203.0.113.50");
    const friend = await addFollow(conn);

    // One byte of headroom, so any real database is already past it.
    mutableEnv.NON_OWNER_STORAGE_BYTES = "1";

    const fromFriend = signEvent(friend.secretKeyHex, { kind: 1, content: "no room" });
    const [, , friendOk, message] = await publish(conn, fromFriend);
    expect(friendOk).toBe(false);
    expect(message.startsWith("blocked:")).toBe(true);

    // Same relay, same instant, same storage level: the whole point of
    // reserving the remaining share is that the owner keeps writing.
    const fromOwner = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "still mine" });
    const [, , ownerOk] = await publish(conn, fromOwner);
    expect(ownerOk).toBe(true);
    conn.close();
  });

  it("lets the follow write again once the cap is raised", async () => {
    // Proves the refusal above is the storage check and not some other
    // rejection the follow happened to trip on.
    const conn = await connectRelay("203.0.113.51");
    const friend = await addFollow(conn);

    mutableEnv.NON_OWNER_STORAGE_BYTES = "1";
    const blocked = signEvent(friend.secretKeyHex, { kind: 1, content: "blocked" });
    expect((await publish(conn, blocked))[2]).toBe(false);

    delete mutableEnv.NON_OWNER_STORAGE_BYTES;
    const allowed = signEvent(friend.secretKeyHex, { kind: 1, content: "allowed" });
    expect((await publish(conn, allowed))[2]).toBe(true);
    conn.close();
  });

  it("stops refusing when the cap is disabled outright", async () => {
    const conn = await connectRelay("203.0.113.52");
    const friend = await addFollow(conn);

    mutableEnv.NON_OWNER_STORAGE_BYTES = "off";
    const note = signEvent(friend.secretKeyHex, { kind: 1, content: "uncapped" });

    expect((await publish(conn, note))[2]).toBe(true);
    conn.close();
  });
});
