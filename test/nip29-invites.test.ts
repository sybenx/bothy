// NIP-29 invites: kind-9009 create-invite, kind-9021 join request, and
// the four things that make a bearer token safe to hand a stranger.
//
//   1. SINGLE USE. One code admits one pubkey. Whoever presents it first
//      gets in -- which is the whole reason an invite link works for
//      somebody whose npub does not exist until they click it.
//   2. MANDATORY EXPIRY. Seven days by default, thirty at most; there is
//      no never-expiring invite (limits.ts).
//   3. REDEEMING WRITES BOTH NESTED LISTS, so a kind-9001 remove-user can
//      reclaim what the invite gave (schema.ts `allowed_pubkeys.source`).
//   4. ONE REFUSAL MESSAGE for spent, expired, revoked and unknown. The
//      admin gets the distinction through the NIP-86 methods and the log;
//      the stranger gets a message that reveals nothing about whether the
//      group exists or is active. Refusals that differ ARE the answer --
//      the same defect the gift wrap read gate had while it decided by
//      probing storage.
//
// The join path is also the third write path dispatched above both gates,
// so it is asserted here to store no event at all -- see
// test/nip29-groups.test.ts for the gift wrap hole that made that rule.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GROUP_MEMBERS_KIND, GROUP_SCOPE, TOP_LEVEL_GROUP_ID } from "../src/groups";
import {
  INVITE_DEFAULT_TTL_SECONDS,
  INVITE_MAX_TTL_SECONDS,
  MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW,
  MAX_OUTSTANDING_INVITES,
  MIN_INVITE_CODE_LENGTH,
} from "../src/limits";
import {
  applyModeration,
  CREATE_INVITE_KIND,
  handleJoinRequest,
  JOIN_REQUEST_KIND,
  PUT_USER_KIND,
  REMOVE_USER_KIND,
} from "../src/nip29";
import type { Relay } from "../src/relay";
import { createInvite, type GroupInvite, storeEvent } from "../src/storage";

import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { type Keypair, OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { collectStored, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

// Long enough to satisfy MIN_INVITE_CODE_LENGTH, which is the only
// guessing defence a relay can enforce over a code it did not generate.
const CODE = "invite-code-aaaaaaaaaa";

// This file's own address for the management endpoint. Cloudflare's
// per-IP HTTP allowance is shared across the whole test run, and a
// management call with no CF-Connecting-IP header lands in the same
// bucket as every other file's -- so these declare one rather than
// crowding it.
const ADMIN_IP = "203.0.113.90";

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function createInviteEvent(code = CODE, extraTags: string[][] = []): NostrEvent {
  return signEvent(OWNER_SECRET_KEY_HEX, {
    kind: CREATE_INVITE_KIND,
    tags: [["h", TOP_LEVEL_GROUP_ID], ["code", code], ...extraTags],
  });
}

function joinRequest(secretKeyHex: string, tags: string[][]): NostrEvent {
  return signEvent(secretKeyHex, { kind: JOIN_REQUEST_KIND, tags });
}

function join(secretKeyHex: string, code: string | null = CODE): NostrEvent {
  return joinRequest(secretKeyHex, [["h", TOP_LEVEL_GROUP_ID], ...(code === null ? [] : [["code", code]])]);
}

// Drops below the wire protocol deliberately (docs/test-notes.md): an
// invite's state is a row, and the reject paths worth asserting -- expired,
// already spent by somebody else -- are states no sequence of client
// frames can reach inside one test run without a clock to advance.
async function invites(): Promise<GroupInvite[]> {
  return runInDurableObject(stub(), async (_instance: Relay, state) =>
    state.storage.sql
      .exec<{
        code: string;
        created_at: number;
        expires_at: number;
        redeemed_at: number | null;
        redeemed_by: string | null;
        revoked_at: number | null;
      }>(`SELECT * FROM group_invites ORDER BY created_at ASC`)
      .toArray(),
  );
}

async function seedInvite(code: string, expiresAt: number): Promise<void> {
  await runInDurableObject(stub(), async (_instance: Relay, state) => {
    createInvite(state.storage.sql, code, nowSec(), expiresAt);
  });
}

async function lists(): Promise<{
  members: string[];
  allowed: { pubkey: string; source: string }[];
}> {
  return runInDurableObject(stub(), async (_instance: Relay, state) => {
    const sql = state.storage.sql;
    return {
      members: sql
        .exec<{ pubkey: string }>(`SELECT pubkey FROM group_members`)
        .toArray()
        .map((r) => r.pubkey),
      allowed: sql
        .exec<{ pubkey: string; source: string }>(`SELECT pubkey, source FROM allowed_pubkeys`)
        .toArray(),
    };
  });
}

// Completes a NIP-42 handshake as whoever holds `secretKeyHex`. Takes a
// key rather than assuming the owner, because the member-read block below
// turns on the difference between three identities the relay now tells
// apart: a stranger who has authenticated (reads nothing of the group), a
// member (reads the group), and the owner (reads the invite codes in it
// as well).
async function authenticateAs(conn: RelayConn, secretKeyHex: string): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage(); // CLOSED, auth-required
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
  expect((await conn.nextMessage())[2]).toBe(true);
}

describe("kind-9009 create-invite", () => {
  it("creates an invite that expires in seven days by default", async () => {
    const conn = await connectRelay();
    const before = nowSec();
    expect((await publish(conn, createInviteEvent()))[2]).toBe(true);
    conn.close();

    const rows = await invites();
    expect(rows.length).toBe(1);
    const invite = rows[0]!;
    expect(invite.code).toBe(CODE);
    expect(invite.redeemed_at).toBeNull();
    expect(invite.revoked_at).toBeNull();
    // The default, and there is no third possibility: an invite with no
    // expiration tag gets one rather than living forever.
    expect(invite.expires_at).toBeGreaterThanOrEqual(before + INVITE_DEFAULT_TTL_SECONDS);
    expect(invite.expires_at).toBeLessThanOrEqual(nowSec() + INVITE_DEFAULT_TTL_SECONDS);
  });

  it("honours an expiration tag inside the maximum", async () => {
    const conn = await connectRelay();
    const expiry = nowSec() + 3600;
    expect((await publish(conn, createInviteEvent(CODE, [["expiration", String(expiry)]])))[2]).toBe(true);
    conn.close();
    expect((await invites())[0]!.expires_at).toBe(expiry);
  });

  // Refused rather than clamped. Clamping is a silent disagreement: the
  // client would be told true and would go on describing the link it just
  // generated as lasting a year.
  it("refuses an expiry past the maximum, and one already in the past", async () => {
    const conn = await connectRelay();
    const tooLong = createInviteEvent(CODE, [
      ["expiration", String(nowSec() + INVITE_MAX_TTL_SECONDS + 3600)],
    ]);
    const [, , longOk, longMessage] = await publish(conn, tooLong);
    expect(longOk).toBe(false);
    expect(longMessage).toContain("at most");

    const past = createInviteEvent("invite-code-bbbbbbbbbb", [["expiration", String(nowSec() - 1)]]);
    expect((await publish(conn, past))[2]).toBe(false);
    conn.close();
    expect(await invites()).toEqual([]);
  });

  it("refuses a create-invite with no code tag, and one that is too short", async () => {
    const conn = await connectRelay();
    const noCode = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: CREATE_INVITE_KIND,
      tags: [["h", TOP_LEVEL_GROUP_ID]],
    });
    const [, , noCodeOk, noCodeMessage] = await publish(conn, noCode);
    expect(noCodeOk).toBe(false);
    expect(noCodeMessage).toContain("code");

    const [, , shortOk, shortMessage] = await publish(conn, createInviteEvent("short"));
    expect(shortOk).toBe(false);
    expect(shortMessage).toContain(String(MIN_INVITE_CODE_LENGTH));
    conn.close();
    expect(await invites()).toEqual([]);
  });

  // Reissuing a spent code would hand its original redeemer a second
  // admission and overwrite the only record of who the code let in.
  it("never reissues a code it has already seen", async () => {
    const conn = await connectRelay();
    expect((await publish(conn, createInviteEvent()))[2]).toBe(true);
    // A different event -- different created_at, different id -- naming
    // the same code.
    const again = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: CREATE_INVITE_KIND,
      created_at: nowSec() + 1,
      tags: [
        ["h", TOP_LEVEL_GROUP_ID],
        ["code", CODE],
      ],
    });
    const [, , accepted, message] = await publish(conn, again);
    expect(accepted).toBe(false);
    expect(message).toContain("already issued");
    conn.close();
    expect((await invites()).length).toBe(1);
  });

  it("caps how many invites may be outstanding at once", async () => {
    for (let i = 0; i < MAX_OUTSTANDING_INVITES; i++) {
      await seedInvite(`seeded-invite-code-${String(i).padStart(4, "0")}`, nowSec() + 3600);
    }
    const conn = await connectRelay();
    const [, , accepted, message] = await publish(conn, createInviteEvent());
    expect(accepted).toBe(false);
    expect(message.startsWith("blocked:")).toBe(true);
    expect(message).toContain("revokeinvite");
    conn.close();
  });

  it("refuses a create-invite from anyone but the owner", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const [, , accepted, message] = await publish(
      conn,
      signEvent(stranger.secretKeyHex, {
        kind: CREATE_INVITE_KIND,
        tags: [
          ["h", TOP_LEVEL_GROUP_ID],
          ["code", CODE],
        ],
      }),
    );
    expect(accepted).toBe(false);
    expect(message.startsWith("restricted:")).toBe(true);
    conn.close();
    expect(await invites()).toEqual([]);
  });

  // The code lives in the stored event as well as in the row, so where
  // that event lands matters: `code` is a multi-character tag name, never
  // indexed in `event_tags`, and the event itself carries an `h` tag and
  // so sits in the group partition behind the read gate.
  it("keeps the created invite event out of unauthenticated reads", async () => {
    const conn = await connectRelay();
    await publish(conn, createInviteEvent());

    expect(await collectStored(conn, "public", [{ kinds: [CREATE_INVITE_KIND] }])).toEqual([]);
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const row = state.storage.sql
        .exec<{ is_group: number }>(`SELECT is_group FROM events WHERE kind = ?`, CREATE_INVITE_KIND)
        .toArray()[0];
      expect(row?.is_group).toBe(GROUP_SCOPE);
      // The code is not a filterable tag; nothing can be pointed at it.
      const tagged = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM event_tags WHERE tag_name = 'code'`)
        .toArray()[0];
      expect(tagged?.n).toBe(0);
    });
    conn.close();
  });
});

describe("kind-9021 join request", () => {
  it("admits the holder of a live code to both nested lists", async () => {
    const conn = await connectRelay();
    const invitee = randomKeypair();
    await publish(conn, createInviteEvent());

    const [, , accepted, message] = await publish(conn, join(invitee.secretKeyHex));
    expect(accepted).toBe(true);
    expect(message).toBe("");

    const { members, allowed } = await lists();
    expect(members).toEqual([invitee.pubkeyHex]);
    // `source = 'invite'` is what lets a kind-9001 remove-user take this
    // back later without touching a grant the owner made by hand.
    expect(allowed).toEqual([{ pubkey: invitee.pubkeyHex, source: "invite" }]);

    // The outer list is the one that decides whether they may write here
    // at all, so the real proof is a group event going through.
    const note = signEvent(invitee.secretKeyHex, {
      kind: 1,
      tags: [["h", TOP_LEVEL_GROUP_ID]],
      content: "hello, group",
    });
    expect((await publish(conn, note))[2]).toBe(true);
    conn.close();
  });

  // A join request is an action, not content -- the same call handleVanish
  // makes -- and here it is also what keeps a stranger's `h`-tagged event
  // out of the group partition on a path no group gate covers.
  it("stores no event, and regenerates the member list instead", async () => {
    const conn = await connectRelay();
    const invitee = randomKeypair();
    await publish(conn, createInviteEvent());
    const request = join(invitee.secretKeyHex);
    await publish(conn, request);
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const stored = state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM events WHERE id = ? OR kind = ?`,
          request.id,
          JOIN_REQUEST_KIND,
        )
        .toArray()[0];
      expect(stored?.n).toBe(0);
    });

    // What DID get written is the relay's own member list, which is the
    // canonical record of the membership anyway.
    const owner = await connectRelay();
    await authenticateAs(owner, OWNER_SECRET_KEY_HEX);
    const state = await collectStored(owner, "members", [{ kinds: [GROUP_MEMBERS_KIND] }]);
    expect(state.length).toBe(1);
    expect(state[0]!.tags.filter((t) => t[0] === "p").map((t) => t[1])).toEqual([
      OWNER_PUBKEY_HEX,
      invitee.pubkeyHex,
    ]);
    owner.close();
  });

  it("spends the code, so the second holder of the same link is refused", async () => {
    const conn = await connectRelay();
    const first = randomKeypair();
    const second = randomKeypair();
    await publish(conn, createInviteEvent());

    expect((await publish(conn, join(first.secretKeyHex)))[2]).toBe(true);
    const [, , accepted] = await publish(conn, join(second.secretKeyHex));
    expect(accepted).toBe(false);

    expect((await lists()).members).toEqual([first.pubkeyHex]);
    conn.close();

    const rows = await invites();
    expect(rows[0]!.redeemed_by).toBe(first.pubkeyHex);
    expect(rows[0]!.redeemed_at).not.toBeNull();
  });

  // THE POINT OF ITEM 4. Four different states, one message. A refusal
  // that said "spent" or "expired" would confirm the code was real, which
  // confirms this relay hosts a group somebody was invited to; "unknown"
  // against a guess would confirm the opposite. Either way the refusal
  // becomes an oracle, tested one guess at a time.
  it("refuses spent, expired, revoked and unknown codes identically", async () => {
    const conn = await connectRelay();
    await publish(conn, createInviteEvent());
    await publish(conn, join(randomKeypair().secretKeyHex)); // spends CODE

    await seedInvite("expired-invite-code-aaaa", nowSec() - 1);
    await seedInvite("revoked-invite-code-aaaa", nowSec() + 3600);
    expect(
      (
        await callManagement("revokeinvite", ["revoked-invite-code-aaaa"], {
          ip: ADMIN_IP,
        })
      ).result,
    ).toBe(true);

    // A connection per attempt, each from its own address: the per-IP
    // join throttle is what bounds guessing (limits.ts
    // MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW), and it would otherwise answer
    // the last few of these itself -- which is a different refusal and
    // would hide the one being asserted.
    const refusalFor = async (event: NostrEvent, ip: string): Promise<string> => {
      const attempt = await connectRelay(ip);
      const [, , accepted, message] = await publish(attempt, event);
      attempt.close();
      expect(accepted).toBe(false);
      return message;
    };

    const messages = new Set<string>();
    const cases: [string, NostrEvent][] = [
      ["198.51.100.1", join(randomKeypair().secretKeyHex, CODE)], // spent
      ["198.51.100.2", join(randomKeypair().secretKeyHex, "expired-invite-code-aaaa")],
      ["198.51.100.3", join(randomKeypair().secretKeyHex, "revoked-invite-code-aaaa")],
      ["198.51.100.4", join(randomKeypair().secretKeyHex, "no-such-invite-code-aaaa")], // unknown
      // No code at all, and a request naming a group this relay does not
      // host -- both answered with the same string, because "wrong group
      // id" would confirm which id it does host.
      ["198.51.100.5", join(randomKeypair().secretKeyHex, null)],
      [
        "198.51.100.6",
        joinRequest(randomKeypair().secretKeyHex, [
          ["h", "some-other-relays-group"],
          ["code", CODE],
        ]),
      ],
    ].map(([ip, event]) => [ip as string, event as NostrEvent]);

    for (const [ip, event] of cases) messages.add(await refusalFor(event, ip));
    expect(messages.size).toBe(1);
    expect([...messages][0]!.startsWith("restricted:")).toBe(true);
    conn.close();

    // Nobody was admitted by any of them.
    expect((await lists()).members.length).toBe(1);
  });

  // A client retrying, or a second device: neither should consume an
  // invite that could still admit somebody else.
  it("does not spend a code for somebody who is already a member", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    await publish(conn, createInviteEvent());
    await publish(conn, join(member.secretKeyHex));

    await publish(conn, createInviteEvent("second-invite-code-aaaa"));
    const [, , accepted, message] = await publish(conn, join(member.secretKeyHex, "second-invite-code-aaaa"));
    expect(accepted).toBe(true);
    expect(message).toContain("already a member");
    conn.close();

    const second = (await invites()).find((i) => i.code === "second-invite-code-aaaa")!;
    expect(second.redeemed_at).toBeNull();
  });

  it("refuses a banned pubkey without spending the code", async () => {
    const conn = await connectRelay();
    const banned = randomKeypair();
    await publish(conn, createInviteEvent());
    expect((await callManagement("banpubkey", [banned.pubkeyHex], { ip: ADMIN_IP })).result).toBe(true);

    expect((await publish(conn, join(banned.secretKeyHex)))[2]).toBe(false);
    conn.close();

    expect((await invites())[0]!.redeemed_at).toBeNull();
    expect((await lists()).members).toEqual([]);
  });

  it("refuses a join request whose signature does not verify", async () => {
    const conn = await connectRelay();
    await publish(conn, createInviteEvent());
    const forged = {
      ...join(randomKeypair().secretKeyHex),
      sig: "00".repeat(64),
    };

    const [, , accepted, message] = await publish(conn, forged);
    expect(accepted).toBe(false);
    expect(message).toContain("signature");
    conn.close();
    // And the code it carried was never looked at, which is the whole
    // reason schnorr runs first on this path.
    expect((await invites())[0]!.redeemed_at).toBeNull();
  });

  it("throttles join requests per IP", async () => {
    const conn = await connectRelay("203.0.113.77");
    const messages: string[] = [];
    for (let i = 0; i <= MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW; i++) {
      messages.push((await publish(conn, join(randomKeypair().secretKeyHex, "unknown-code-aaaaaa")))[3]);
    }
    conn.close();
    expect(messages[messages.length - 1]!.startsWith("rate-limited:")).toBe(true);
  });

  // The invite created the `allowed_pubkeys` row as 'invite', so the
  // group can take it back -- which is the whole point of that column.
  it("lets a remove-user reclaim what the invite granted", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    await publish(conn, createInviteEvent());
    await publish(conn, join(member.secretKeyHex));

    const remove = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: REMOVE_USER_KIND,
      tags: [
        ["h", TOP_LEVEL_GROUP_ID],
        ["p", member.pubkeyHex],
      ],
    });
    expect((await publish(conn, remove))[2]).toBe(true);
    conn.close();

    const { members, allowed } = await lists();
    expect(members).toEqual([]);
    expect(allowed).toEqual([]);
  });
});

describe("the NIP-86 invite methods", () => {
  it("lists only invites that are still redeemable", async () => {
    const conn = await connectRelay();
    await publish(conn, createInviteEvent());
    await publish(conn, createInviteEvent("spent-invite-code-aaaaa"));
    await publish(conn, join(randomKeypair().secretKeyHex, "spent-invite-code-aaaaa"));
    conn.close();
    await seedInvite("expired-invite-code-aaaa", nowSec() - 1);

    const reply = await callManagement("listunusedinvites", [], {
      ip: ADMIN_IP,
    });
    const codes = (reply.result as { code: string; expires_at: number }[]).map((i) => i.code);
    expect(codes).toEqual([CODE]);
    // `expires_at` is on every row: it is what decides whether to re-send
    // a link or reissue it.
    expect((reply.result as { expires_at: number }[])[0]!.expires_at).toBeGreaterThan(nowSec());

    expect((await callManagement("supportedmethods", [], { ip: ADMIN_IP })).result).toContain(
      "listunusedinvites",
    );
  });

  it("revokes a live invite, and says exactly why a revoke did nothing", async () => {
    const conn = await connectRelay();
    await publish(conn, createInviteEvent());
    await publish(conn, createInviteEvent("spent-invite-code-aaaaa"));
    const redeemer = randomKeypair();
    await publish(conn, join(redeemer.secretKeyHex, "spent-invite-code-aaaaa"));

    expect((await callManagement("revokeinvite", [CODE], { ip: ADMIN_IP })).result).toBe(true);
    // The link stops working immediately.
    expect((await publish(conn, join(randomKeypair().secretKeyHex)))[2]).toBe(false);
    conn.close();

    // Here the caller IS the owner, authenticated by a NIP-98 signature,
    // so these say what the wire refuses to -- the opposite of the join
    // path's rule, and for the opposite reason.
    expect((await callManagement("revokeinvite", [CODE], { ip: ADMIN_IP })).error).toContain(
      "already revoked",
    );
    expect(
      (
        await callManagement("revokeinvite", ["spent-invite-code-aaaaa"], {
          ip: ADMIN_IP,
        })
      ).error,
    ).toContain("already been redeemed");
    expect(
      (
        await callManagement("revokeinvite", ["never-issued-code-aaaa"], {
          ip: ADMIN_IP,
        })
      ).error,
    ).toContain("never issued");

    // A revoke never erases who a spent code let in.
    const spent = (await invites()).find((i) => i.code === "spent-invite-code-aaaaa")!;
    expect(spent.redeemed_by).toBe(redeemer.pubkeyHex);
    expect(spent.revoked_at).toBeNull();
  });

  it("refuses a revoke from anyone but the owner", async () => {
    const conn = await connectRelay();
    await publish(conn, createInviteEvent());
    conn.close();

    const stranger = randomKeypair();
    const reply = await callManagement("revokeinvite", [CODE], {
      secretKeyHex: stranger.secretKeyHex,
      ip: ADMIN_IP,
    });
    expect(reply.result).toBeUndefined();
    expect((await invites())[0]!.revoked_at).toBeNull();
  });
});

describe("rows written", () => {
  // The same proxy test/nip29-groups.test.ts and test/hibernation.test.ts
  // use: sum SqlStorageCursor.rowsWritten across every statement `fn`
  // issues. Driven at the storage layer rather than over the wire,
  // because runInDurableObject cannot drive a WebSocket belonging to
  // another Durable Object context -- these calls are exactly what
  // relay.ts does once its gate has admitted the event.
  function measureRowsWritten(sql: SqlStorage, fn: (sql: SqlStorage) => void): number {
    let total = 0;
    const proxy = new Proxy(sql, {
      get(target, property) {
        if (property === "exec") {
          return (query: string, ...bindings: unknown[]) => {
            const cursor = target.exec(query, ...bindings);
            total += cursor.rowsWritten;
            return cursor;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as SqlStorage;
    fn(proxy);
    return total;
  }

  it("costs a bounded, measured amount per invite and per join", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = nowSec();
      const environment = env as unknown as Env;

      // Seed a group of twenty, so the join below is measured against a
      // member list of real size rather than an empty one -- the same
      // baseline test/nip29-groups.test.ts measures a put-user against.
      for (let i = 0; i < 20; i++) {
        const event = signEvent(OWNER_SECRET_KEY_HEX, {
          kind: PUT_USER_KIND,
          tags: [
            ["h", TOP_LEVEL_GROUP_ID],
            ["p", randomKeypair().pubkeyHex],
          ],
        });
        storeEvent(sql, event, now);
        applyModeration(sql, environment, event, now);
      }

      // Creating an invite. The kind-9009 is stored like any other
      // moderation event, and `code` is a multi-character tag name, so it
      // costs no `event_tags` row -- only the `h` does:
      //
      //   the kind-9009 itself   9 + 3 x 1 indexed tag (`h`)   = 12
      //   the group_invites row  1 base + 1 PK index           =  2
      //   regeneration           nothing changed               =  0
      //                                                          ---
      //                                                           14
      const inviteCost = measureRowsWritten(sql, (metered) => {
        const event = createInviteEvent();
        storeEvent(metered, event, now);
        applyModeration(metered, environment, event, now);
      });
      expect(inviteCost).toBe(14);

      // Redeeming one, at a 21-member list going to 22. Cheaper than the
      // put-user it replaces (123, test/nip29-groups.test.ts) because the
      // request itself is never stored -- the 15 rows a kind-9000 spends
      // on its own event row and tags become the 1 row the invite's UPDATE
      // spends marking itself spent:
      //
      //   the kind-9021 itself   not stored                    =  0
      //   spending the invite    1 row updated in place        =  1
      //   group_members row      1 base + 1 PK index           =  2
      //   allowed_pubkeys row    1 base + 1 PK index           =  2
      //   removing the old 39002 22 tag rows + 1 event row + 3
      //                          counters                      = 26
      //   storing the new 39002  9 + 3 x 23 tags               = 78
      //                                                          ---
      //                                                          109
      //
      // The member list dominates exactly as it does for a put-user, so
      // the ~4 rows per member per membership change hold here too. What
      // is new is WHO chooses the rate: an invite makes a membership
      // change something a stranger performs, so this is the figure the
      // outstanding-invite cap (limits.ts MAX_OUTSTANDING_INVITES) bounds
      // the burst of -- 64 live invites is at most ~7,000 rows if every
      // one of them is redeemed at once, against a 100,000/day ceiling.
      const joinCost = measureRowsWritten(sql, (metered) =>
        handleJoinRequest(metered, environment, join(randomKeypair().secretKeyHex), now),
      );
      expect(joinCost).toBe(109);
    });
  });

  // The membership did not change, so the member list is not rewritten --
  // the same measure-before-writing rule regenerateGroupState applies to a
  // repeated put-user.
  it("costs nothing but the refusal for a join that is refused", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const cost = measureRowsWritten(sql, (metered) =>
        handleJoinRequest(
          metered,
          env as unknown as Env,
          join(randomKeypair().secretKeyHex, "no-such-invite-code-aaaa"),
          nowSec(),
        ),
      );
      expect(cost).toBe(0);
    });
  });
});

// THE TRIPWIRE UNDER THE READ GATE -- and it fired, which is why this
// block reads differently now.
//
// A kind-9009 is a stored, served group event carrying its code in a
// `code` tag, so it lives in the partition the read gate guards. That
// gate used to admit the OWNER alone, because NIP-29 membership was not
// modelled on the read side at all, and the assertions here were that a
// member -- who could already write to the group -- got nothing back from
// any filter that could reach a 9009. They were written to FAIL the day
// member-side reads landed, on the reasoning that an invite code is a
// BEARER TOKEN: reading one is as good as being handed it, so a member
// who could read the group could mint memberships at will and owner-only
// invites would stop being owner-only with no line of the write path
// changing.
//
// They failed exactly there, on exactly that assertion, and the answer
// was to keep kind-9009 owner-only INSIDE a partition members now read
// (groups.ts CREATE_INVITE_KIND). So the shape of this block has moved by
// one step and its subject has not: it no longer asserts that a member
// reads nothing of the group, it asserts that a member reads the group
// and never reads a code. The absence assertions are held down by two
// controls, because an absence passes just as well when the feature is
// broken -- one below proving the member really does read the group, one
// at the end proving the owner really does read the code in full.
describe("what a member can read", () => {
  // A member in the fullest sense the relay has: in `group_members`, in
  // `allowed_pubkeys`, writing to the group successfully, and holding a
  // live NIP-42 session.
  async function seedMemberAndInvite(): Promise<{ member: Keypair; conn: RelayConn }> {
    const setup = await connectRelay();
    const member = randomKeypair();
    expect(
      (
        await publish(
          setup,
          signEvent(OWNER_SECRET_KEY_HEX, {
            kind: PUT_USER_KIND,
            tags: [
              ["h", TOP_LEVEL_GROUP_ID],
              ["p", member.pubkeyHex],
            ],
          }),
        )
      )[2],
    ).toBe(true);
    expect((await publish(setup, createInviteEvent()))[2]).toBe(true);
    setup.close();

    const conn = await connectRelay();
    // Proof the membership is real rather than asserted: a non-member's
    // `h`-tagged write is refused, so this succeeding is what makes the
    // reads below a statement about members and not about strangers.
    expect(
      (
        await publish(
          conn,
          signEvent(member.secretKeyHex, {
            kind: 1,
            tags: [["h", TOP_LEVEL_GROUP_ID]],
            content: "written by a real member",
          }),
        )
      )[2],
    ).toBe(true);
    await authenticateAs(conn, member.secretKeyHex);
    return { member, conn };
  }

  it("gets no invite code back from any filter it is allowed to send", async () => {
    const { member, conn } = await seedMemberAndInvite();

    // Every shape that could reach a kind-9009: by its kind, by its
    // author, by the member's own p tag, by an `authors` sweep of the
    // owner's events, and -- since members read the group now -- by
    // naming the group outright. The last one is served rather than
    // refused, which is the widening; the others were served before it
    // and are served after it. Not one of them may carry a code.
    for (const filter of [
      { kinds: [CREATE_INVITE_KIND] },
      { authors: [OWNER_PUBKEY_HEX], limit: 50 },
      { "#p": [member.pubkeyHex], limit: 50 },
      { kinds: [CREATE_INVITE_KIND], authors: [OWNER_PUBKEY_HEX] },
      { "#h": [TOP_LEVEL_GROUP_ID], limit: 50 },
    ]) {
      // collectStored throws on a CLOSED frame, so reaching the
      // assertions at all is the proof that every one of these was
      // answered by OMISSION rather than by refusal -- including the two
      // that name kind 9009 in as many words. A refusal there would be a
      // new signal on the unauthenticated path, where the same filter is
      // answered with a plain EOSE.
      const events = await collectStored(conn, `m${JSON.stringify(filter)}`, [filter]);
      // Stated twice on purpose, and the two fail for different reasons.
      // The kind scan is what fails if the invite event itself starts
      // being served; the tag scan is what fails if some future change
      // serves a redacted or re-shaped one that still carries its code.
      expect(events.map((e) => e.kind)).not.toContain(CREATE_INVITE_KIND);
      expect(events.flatMap((e) => e.tags).filter((t) => t[0] === "code")).toEqual([]);
    }

    // Naming the kind alone still returns nothing at all, which is the
    // strongest form the assertion takes: the member cannot even count
    // the group's outstanding invites.
    expect(await collectStored(conn, "byKind", [{ kinds: [CREATE_INVITE_KIND] }])).toEqual([]);
    conn.close();
  });

  // The control for the control. Every assertion above is about what a
  // member does NOT get back, and all of them would pass just as well if
  // the read gate had never widened at all -- which is exactly the state
  // this block used to pin. This is the one that fails if a member stops
  // being able to read the group.
  it("while reading the rest of the group it is a member of", async () => {
    const { conn } = await seedMemberAndInvite();

    const events = await collectStored(conn, "group", [{ "#h": [TOP_LEVEL_GROUP_ID], limit: 50 }]);
    // Its own note and the owner's put-user, both `h`-tagged into a
    // partition an unauthenticated client is not served from at all.
    expect(events.map((e) => e.content)).toContain("written by a real member");
    expect(events.map((e) => e.kind)).toContain(PUT_USER_KIND);
    // The relay-generated member list, which names the group in `d`
    // rather than in `h`, reached by its kind.
    const state = await collectStored(conn, "state", [{ kinds: [GROUP_MEMBERS_KIND] }]);
    expect(state.length).toBe(1);
    conn.close();
  });

  // A stranger who authenticates as themselves is not a member, and gets
  // the refusal the member no longer gets. Without this, "members may
  // read the group" could be implemented as "anyone who has completed
  // AUTH may read the group" and every other test here would still pass.
  it("but a signed-in stranger is still refused", async () => {
    await seedMemberAndInvite();

    const conn = await connectRelay();
    await authenticateAs(conn, randomKeypair().secretKeyHex);
    conn.send(["REQ", "named", { "#h": [TOP_LEVEL_GROUP_ID] }]);
    const [frameType, , reason] = await conn.nextMessage();
    expect(frameType).toBe("CLOSED");
    expect(String(reason)).toContain("restricted:");
    // And the omission half: a filter that does not name the group is
    // answered normally, with the group's rows simply absent.
    expect(await collectStored(conn, "byP", [{ "#p": [OWNER_PUBKEY_HEX], limit: 50 }])).toEqual([]);
    conn.close();
  });

  // The other surface, and the one a REQ-time gate cannot cover: a
  // subscription registered BEFORE the event exists is never re-examined
  // by handleReqInner, so broadcast() has its own copy of the same check.
  // Widening one and not the other would push live codes at members while
  // this file's stored-read assertions above still passed.
  it("is not pushed one over a subscription it opened first", async () => {
    const { conn } = await seedMemberAndInvite();
    conn.send(["REQ", "live", { kinds: [CREATE_INVITE_KIND] }]);
    expect((await conn.nextMessage())[0]).toBe("EOSE");

    const owner = await connectRelay();
    expect((await publish(owner, createInviteEvent("second-invite-code-aaaa")))[2]).toBe(true);
    owner.close();

    const pushed = await conn.nextMessage(600).catch(() => null);
    expect(pushed).toBeNull();
    conn.close();
  });

  // The control, and it is not optional: every assertion above is an
  // absence, and an absence passes just as well when the feature is
  // broken, when nothing was stored, or when the filters were wrong. This
  // is the one that fails if the invite stopped existing rather than
  // stopping being readable -- so the block as a whole can only pass when
  // the code is genuinely there and genuinely withheld.
  it("while the owner reads the same code in full", async () => {
    const { conn } = await seedMemberAndInvite();
    conn.close();

    const owner = await connectRelay();
    await authenticateAs(owner, OWNER_SECRET_KEY_HEX);
    const events = await collectStored(owner, "ownersees", [{ kinds: [CREATE_INVITE_KIND] }]);
    expect(events.length).toBe(1);
    expect(events[0]!.tags).toContainEqual(["code", CODE]);
    owner.close();
  });
});
