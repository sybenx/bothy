// NIP-29 group WRITES: the moderation events a client may send, the group
// state this relay generates and signs in response, and the three things
// that had to be got right before any of it was safe.
//
//   1. The relay writing its own events bypasses the write GATE and not
//      the storage BOOKKEEPING -- one insert path, not two.
//   2. The relay-generated 39000-series carries a `d` tag and no `h`, so
//      the group partition did not catch it at all: kind-39001 and
//      kind-39002 ARE the admin and member lists, and they were public.
//   3. kind-39002 is addressable, so a membership change replaces it in
//      place rather than accumulating -- measured here, not assumed.
//
// The read-side exclusion those events now fall under is asserted in
// test/groups.test.ts, which covers all four surfaces for `h`-tagged
// events; this file asserts that the relay-generated kinds reach the same
// exclusion, and that the write path in front of them holds.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  GROUP_ADMINS_KIND,
  GROUP_MEMBERS_KIND,
  GROUP_METADATA_KIND,
  GROUP_SCOPE,
  isGroupEvent,
  PUBLIC_SCOPE,
  TOP_LEVEL_GROUP_ID,
} from "../src/groups";
import { applyModeration, EDIT_METADATA_KIND, PUT_USER_KIND, REMOVE_USER_KIND } from "../src/nip29";
import type { Relay } from "../src/relay";
import { auditMaintainedCounts, readMaintainedCounts, storeEvent } from "../src/storage";
import { computeEventId } from "../src/validate";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { collectStored, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

function moderation(kind: number, tags: string[][], secretKeyHex = OWNER_SECRET_KEY_HEX): NostrEvent {
  return signEvent(secretKeyHex, { kind, tags: [["h", TOP_LEVEL_GROUP_ID], ...tags] });
}

function putUser(pubkey: string): NostrEvent {
  return moderation(PUT_USER_KIND, [["p", pubkey]]);
}

function removeUser(pubkey: string): NostrEvent {
  return moderation(REMOVE_USER_KIND, [["p", pubkey]]);
}

// Authenticates a connection as the owner. Uses a `kinds:[1059]` REQ as
// the challenge trigger, which is gated by shape alone and so works on an
// empty relay -- same helper shape as test/groups.test.ts.
async function authenticateAsOwner(conn: RelayConn): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage(); // CLOSED, auth-required
  const authEvent = signEvent(OWNER_SECRET_KEY_HEX, {
    kind: 22242,
    tags: [
      ["relay", "wss://example.com"],
      ["challenge", challenge as string],
    ],
  });
  conn.send(["AUTH", authEvent]);
  const [, , ok] = await conn.nextMessage();
  expect(ok).toBe(true);
}

// The relay's own group state, read straight out of storage -- the read
// path refuses it to anyone but an authenticated owner, and most of these
// assertions are about what got STORED rather than what gets served.
async function storedGroupState(): Promise<Map<number, NostrEvent>> {
  return runInDurableObject(stub(), async (_instance: Relay, state) => {
    const rows = state.storage.sql
      .exec<{
        id: string;
        pubkey: string;
        created_at: number;
        kind: number;
        tags: string;
        content: string;
        sig: string;
      }>(`SELECT id, pubkey, created_at, kind, tags, content, sig FROM events WHERE kind >= 39000`)
      .toArray();
    return new Map(
      rows.map((row) => [
        row.kind,
        { ...row, tags: JSON.parse(row.tags) as string[][] } satisfies NostrEvent,
      ]),
    );
  });
}

function pTags(event: NostrEvent): string[] {
  return event.tags.filter((t) => t[0] === "p").map((t) => t[1] as string);
}

describe("the 39000-series and the group partition", () => {
  // THE DEFECT THIS FIXES, stated as the thing that was true before.
  //
  // groups.ts decided group membership from the `h` tag alone, and NIP-29
  // puts the group id of the relay-generated events in a `d` tag "instead
  // of the `h` tag". So kind-39001 (the admin list) and kind-39002 (the
  // member list) -- the two events that literally enumerate who is in the
  // group, in `p` tags -- carried no `h`, landed in the PUBLIC partition,
  // and were served to any unauthenticated client that asked for them. The
  // exclusion covered every event in the group except the list of who was
  // in it.
  it("counts the relay-generated kinds as group events, by kind and not by tag", () => {
    for (const kind of [39000, 39001, 39002, 39003, 39004, 39005]) {
      const event = signEvent(OWNER_SECRET_KEY_HEX, { kind, tags: [["d", TOP_LEVEL_GROUP_ID]] });
      expect(isGroupEvent(event)).toBe(true);
      // The `h` rule would have said no -- there is no `h` tag here.
      expect(event.tags.some((t) => t[0] === "h")).toBe(false);
    }
    // A malformed one -- naming no group at all -- is NOT group state by
    // this test any more. It used to be, on the reasoning that the safe
    // reading of a member list with no `d` is "hide it" -- which protected
    // against disclosure but not against AMBIGUITY: a bare
    // `{"kinds":[39002]}` still could not tell a malformed row apart from
    // this relay's own genuine member list, both landing in the same
    // partition. The disclosure risk is now closed a different way --
    // storage.ts storeEvent refuses to store ANY 39000-series event not
    // signed by this relay's own identity, regardless of its `d` tag, so a
    // malformed one (like this one, signed by the owner rather than the
    // relay) never reaches storage to need hiding. See test/backfill.test.ts
    // for that refusal exercised through storeEvent directly.
    expect(isGroupEvent(signEvent(OWNER_SECRET_KEY_HEX, { kind: 39002 }))).toBe(false);
    // Neighbouring addressable kinds are untouched -- `d` identifies every
    // addressable event there is, so this cannot be a `d`-tag rule.
    expect(isGroupEvent(signEvent(OWNER_SECRET_KEY_HEX, { kind: 30023, tags: [["d", "post"]] }))).toBe(
      false,
    );
    expect(isGroupEvent(signEvent(OWNER_SECRET_KEY_HEX, { kind: 39006, tags: [["d", "_"]] }))).toBe(false);
  });

  it("stores generated group state in the group partition", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    expect((await publish(conn, putUser(member.pubkeyHex)))[2]).toBe(true);
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const rows = state.storage.sql
        .exec<{ kind: number; is_group: number }>(
          `SELECT kind, is_group FROM events WHERE kind >= 39000 OR kind = ?`,
          PUT_USER_KIND,
        )
        .toArray();
      expect(rows.length).toBe(4); // the 9000, plus 39000/39001/39002
      for (const row of rows) expect(row.is_group).toBe(GROUP_SCOPE);
      // Nothing at all landed in the public partition.
      const publicRows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE is_group = ?`, PUBLIC_SCOPE)
        .toArray()[0];
      expect(publicRows?.n).toBe(0);
    });
  });

  it("does not serve the member list to an unauthenticated client", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    await publish(conn, putUser(member.pubkeyHex));

    // A filter NAMING the member list is refused from `kinds` alone -- the
    // client already said what it wanted, so refusing tells it nothing.
    conn.send(["REQ", "named", { kinds: [GROUP_MEMBERS_KIND] }]);
    const [frameType, , reason] = await conn.nextMessage();
    expect(frameType).toBe("AUTH");
    const [closedType, , closedReason] = await conn.nextMessage();
    expect(closedType).toBe("CLOSED");
    expect(String(closedReason)).toContain("auth-required");
    void reason;

    // A filter that does NOT name it is answered normally, with the rows
    // omitted -- refusing here would make the refusal itself the answer,
    // which is the leak the gift wrap storage probe turned out to be.
    // `#d` alone does not count as naming a group: `d` identifies every
    // addressable event there is.
    expect(await collectStored(conn, "byD", [{ "#d": [TOP_LEVEL_GROUP_ID] }])).toEqual([]);
    expect(await collectStored(conn, "byP", [{ "#p": [member.pubkeyHex] }])).toEqual([]);
    conn.close();
  });

  it("serves it to the authenticated owner", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    await publish(conn, putUser(member.pubkeyHex));
    await authenticateAsOwner(conn);

    const events = await collectStored(conn, "state", [{ kinds: [GROUP_MEMBERS_KIND] }]);
    expect(events.length).toBe(1);
    expect(pTags(events[0]!)).toEqual([OWNER_PUBKEY_HEX, member.pubkeyHex]);
    conn.close();
  });

  it("keeps the generated events off the public /api/stats counters", async () => {
    const conn = await connectRelay();
    await publish(conn, putUser(randomKeypair().pubkeyHex));
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const counts = readMaintainedCounts(state.storage.sql);
      // Four stored events -- the 9000 and the three generated -- and all
      // four counted as group events, so `events - group_events` (what
      // /api/stats publishes) is zero.
      expect(counts.events).toBe(4);
      expect(counts.groupEvents).toBe(4);
    });
  });
});

describe("the relay writing its own events", () => {
  it("signs them with the relay identity, not the owner's key", async () => {
    const conn = await connectRelay();
    await publish(conn, putUser(randomKeypair().pubkeyHex));
    conn.close();

    const relayPubkey = await runInDurableObject(stub(), async (instance: Relay) => {
      const identity = await instance.getIdentity();
      return identity.relayPubkey;
    });

    // The key a NIP-29 client actually looks for: the group state events
    // "MUST be created by the relay master key only (as stated by the
    // NIP-11 `self` pubkey)". Publishing this key under a name of our own
    // invention would have left a spec-following client with nothing to
    // verify these against.
    const info = (await (
      await exports.default.fetch(
        new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
      )
    ).json()) as { self: string; supported_nips: number[] };
    expect(info.self).toBe(relayPubkey);
    expect(info.supported_nips).toContain(29);

    const state = await storedGroupState();
    expect([...state.keys()].sort()).toEqual([
      GROUP_METADATA_KIND,
      GROUP_ADMINS_KIND,
      GROUP_MEMBERS_KIND,
    ]);
    for (const event of state.values()) {
      expect(event.pubkey).toBe(relayPubkey);
      expect(event.pubkey).not.toBe(OWNER_PUBKEY_HEX);
      // Verifiable exactly as any other event is -- there is no
      // relay-specific signing rule in NIP-29 beyond which key does it.
      expect(computeEventId(event)).toBe(event.id);
      expect(event.tags[0]).toEqual(["d", TOP_LEVEL_GROUP_ID]);
    }
  });

  // THE POINT OF ITEM 1. The gate is bypassed; the bookkeeping is not.
  // Every consumer of the write budget -- backfill's headroom guard, the
  // vanish drain's pacing, the admin page's meter -- reads figures that
  // insertEventRow maintains, so a second insert path that skipped any of
  // them would be invisible until one of those guards silently stopped
  // guarding.
  it("pays the full storage bookkeeping despite skipping the write gate", async () => {
    const conn = await connectRelay();
    await publish(conn, putUser(randomKeypair().pubkeyHex));
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const generated = sql
        .exec<{ id: string; ingested_at: number | null; row_cost: number | null; is_group: number }>(
          `SELECT id, ingested_at, row_cost, is_group FROM events WHERE kind >= 39000`,
        )
        .toArray();
      expect(generated.length).toBe(3);
      for (const row of generated) {
        expect(row.ingested_at).not.toBeNull();
        expect(row.row_cost).not.toBeNull();
        expect(row.is_group).toBe(GROUP_SCOPE);
        // Tag rows exist and carry the partition, which is what lets the
        // tag subquery exclude them before its own LIMIT applies.
        const tagRows = sql
          .exec<{ n: number; g: number }>(
            `SELECT COUNT(*) AS n, COALESCE(SUM(is_group), 0) AS g FROM event_tags WHERE event_id = ?`,
            row.id,
          )
          .toArray()[0]!;
        expect(tagRows.n).toBeGreaterThan(0);
        expect(tagRows.g).toBe(tagRows.n);
      }

      // The counters moved for them, and the daily audit -- which recounts
      // the table rather than trusting the counters -- finds no drift.
      // That is the assertion that would fail if a second insert path
      // existed: a hand-rolled INSERT would store the rows and leave every
      // counter behind.
      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        auditMaintainedCounts(sql, Math.floor(Date.now() / 1000));
      } finally {
        console.error = original;
      }
      expect(errors.join("\n")).not.toContain("DRIFT");
    });
  });
});

// The two write paths dispatched ABOVE both gates, and what each of them
// owes the group partition. relay.ts sends NIP-59 gift wraps and NIP-62
// vanish requests straight past isAllowedWriter and authorizeGroupWrite,
// each on its own source of authority -- so neither can be gated by
// nip29.ts and each has to answer for the partition itself.
describe("the paths that skip both write gates", () => {
  // THE DEFECT THIS FIXES. storeEvent partitions by groups.ts
  // isGroupEvent, which asks only whether the event carries an `h` tag --
  // not who sent it and not which path it arrived on. A kind-1059 is
  // accepted from ANY pubkey, so any stranger could put an `h` tag on one
  // and land an event in the group partition without passing a single
  // group check. It was documented as harmless on the grounds that it
  // wrote into the partition rather than out of it, which described the
  // wrong audience: everyone entitled to read that partition receives the
  // injected event.
  it("refuses an h-tagged gift wrap outright", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const wrap = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [
        ["p", OWNER_PUBKEY_HEX],
        ["h", TOP_LEVEL_GROUP_ID],
      ],
      content: "encrypted seal goes here",
    });

    const [, , accepted, message] = await publish(conn, wrap);
    expect(accepted).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    expect(message).toContain("group tag");

    // Refused, not merely repartitioned: nothing at all was stored.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const rows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events`)
        .toArray()[0];
      expect(rows?.n).toBe(0);
    });
    conn.close();
  });

  // Any `h` at all, not just this relay's group id -- the refusal is
  // isGroupEvent, so it is exactly what the partition would have caught.
  it("refuses one naming any other group id too, and still accepts an ordinary wrap", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const elsewhere = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [
        ["p", OWNER_PUBKEY_HEX],
        ["h", "some-other-relays-group"],
      ],
    });
    expect((await publish(conn, elsewhere))[2]).toBe(false);

    // And the path still works for the mail it exists for.
    const ordinary = signEvent(stranger.secretKeyHex, {
      kind: 1059,
      tags: [["p", OWNER_PUBKEY_HEX]],
    });
    expect((await publish(conn, ordinary))[2]).toBe(true);
    conn.close();
  });

  // The equivalent question asked of the other path, and the answer is
  // that it has no equivalent hole: handleVanish stores no row for the
  // request, so there is nothing for a partition to receive. Its side
  // effect deletes only the signer's OWN rows, across both partitions --
  // a member erasing their own group history, which is what NIP-62
  // obliges this relay to honour.
  it("stores no event for a vanish request, so it cannot reach a partition at all", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    await publish(conn, putUser(member.pubkeyHex));
    const note = signEvent(member.secretKeyHex, {
      kind: 1,
      tags: [["h", TOP_LEVEL_GROUP_ID]],
      content: "a member's group note",
    });
    expect((await publish(conn, note))[2]).toBe(true);

    const vanish = signEvent(member.secretKeyHex, {
      kind: 62,
      // An `h` tag on the vanish itself, which is the shape the gift wrap
      // hole took. It changes nothing here, because nothing is stored.
      tags: [
        ["relay", "wss://example.com"],
        ["h", TOP_LEVEL_GROUP_ID],
      ],
    });
    expect((await publish(conn, vanish))[2]).toBe(true);
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      expect(
        sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE kind = 62`).toArray()[0]?.n,
      ).toBe(0);
      // And the member's group note went with them: the drain runs
      // acrossScopes, so the group partition is not a place to hide from
      // a vanish.
      expect(
        sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE id = ?`, note.id).toArray()[0]
          ?.n,
      ).toBe(0);
    });
  });
});

describe("membership", () => {
  it("writes both nested lists on put-user and takes back only its own on remove-user", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    await publish(conn, putUser(member.pubkeyHex));

    const lists = async () =>
      runInDurableObject(stub(), async (_instance: Relay, state) => {
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

    expect(await lists()).toEqual({
      members: [member.pubkeyHex],
      allowed: [{ pubkey: member.pubkeyHex, source: "invite" }],
    });

    await publish(conn, removeUser(member.pubkeyHex));
    expect(await lists()).toEqual({ members: [], allowed: [] });
    conn.close();
  });

  it("never revokes a write grant the owner made by hand", async () => {
    const member = randomKeypair();
    // An explicit NIP-86 act first: this pubkey may write here for reasons
    // that have nothing to do with the group.
    expect((await callManagement("allowpubkey", [member.pubkeyHex, "a friend"])).result).toBe(true);

    const conn = await connectRelay();
    await publish(conn, putUser(member.pubkeyHex));
    await publish(conn, removeUser(member.pubkeyHex));
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const rows = state.storage.sql
        .exec<{ pubkey: string; source: string; reason: string | null }>(
          `SELECT pubkey, source, reason FROM allowed_pubkeys`,
        )
        .toArray();
      // Out of the group, still allowed to write to the relay -- and still
      // owner-owned, because put-user must not demote a deliberate grant
      // into one remove-user can reclaim.
      expect(rows).toEqual([{ pubkey: member.pubkeyHex, source: "owner", reason: "a friend" }]);
      expect(state.storage.sql.exec(`SELECT 1 FROM group_members`).toArray()).toEqual([]);
    });
  });

  it("promotes an invite-owned row when the owner allows it by hand", async () => {
    const member = randomKeypair();
    const conn = await connectRelay();
    await publish(conn, putUser(member.pubkeyHex));
    conn.close();
    expect((await callManagement("allowpubkey", [member.pubkeyHex, "explicit"])).result).toBe(true);

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const row = state.storage.sql
        .exec<{ source: string }>(`SELECT source FROM allowed_pubkeys WHERE pubkey = ?`, member.pubkeyHex)
        .toArray()[0];
      expect(row?.source).toBe("owner");
    });
  });

  it("lets a member write to the group and refuses a non-member", async () => {
    const member = randomKeypair();
    const stranger = randomKeypair();
    const owner = await connectRelay();
    await publish(owner, putUser(member.pubkeyHex));
    // The stranger may write to the relay but not to the group -- the two
    // nested lists, separated.
    expect((await callManagement("allowpubkey", [stranger.pubkeyHex])).result).toBe(true);
    owner.close();

    const conn = await connectRelay();
    const groupNote = (secretKeyHex: string) =>
      signEvent(secretKeyHex, { kind: 1, content: "hi", tags: [["h", TOP_LEVEL_GROUP_ID]] });

    expect((await publish(conn, groupNote(member.secretKeyHex)))[2]).toBe(true);

    const [, , accepted, message] = await publish(conn, groupNote(stranger.secretKeyHex));
    expect(accepted).toBe(false);
    expect(message).toContain("restricted:");
    expect(message).toContain("members");

    // And the stranger's ordinary, ungrouped write still works, so this is
    // the group gate and not the relay gate.
    expect(
      (await publish(conn, signEvent(stranger.secretKeyHex, { kind: 1, content: "public" })))[2],
    ).toBe(true);
    conn.close();
  });

  it("refuses moderation from anyone but the owner", async () => {
    const member = randomKeypair();
    const owner = await connectRelay();
    await publish(owner, putUser(member.pubkeyHex));
    owner.close();

    const conn = await connectRelay();
    const [, , accepted, message] = await publish(
      conn,
      moderation(PUT_USER_KIND, [["p", randomKeypair().pubkeyHex]], member.secretKeyHex),
    );
    expect(accepted).toBe(false);
    expect(message).toContain("restricted:");
    expect(message).toContain("moderate");
    conn.close();
  });

  it("refuses a moderation event naming another group, an unimplemented action, or the owner", async () => {
    const conn = await connectRelay();

    const wrongGroup = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: PUT_USER_KIND,
      tags: [["h", "some-other-group"], ["p", randomKeypair().pubkeyHex]],
    });
    expect((await publish(conn, wrongGroup))[3]).toContain(`["h", "${TOP_LEVEL_GROUP_ID}"]`);

    // kind 9005 delete-event: in NIP-29's moderation range, not implemented
    // here. Refused by name rather than stored as an inert group note that
    // would have been answered `["OK", id, true]` and deleted nothing.
    const unimplemented = moderation(9005, [["e", "a".repeat(64)]]);
    const [, , accepted, message] = await publish(conn, unimplemented);
    expect(accepted).toBe(false);
    expect(message).toContain("not implemented");

    expect((await publish(conn, removeUser(OWNER_PUBKEY_HEX)))[3]).toContain("owner cannot be removed");
    conn.close();
  });

  it("refuses a client-signed 39000-series event", async () => {
    const conn = await connectRelay();
    for (const kind of [GROUP_METADATA_KIND, GROUP_ADMINS_KIND, GROUP_MEMBERS_KIND]) {
      const forged = signEvent(OWNER_SECRET_KEY_HEX, {
        kind,
        tags: [["d", TOP_LEVEL_GROUP_ID], ["p", randomKeypair().pubkeyHex]],
      });
      const [, , accepted, message] = await publish(conn, forged);
      expect(accepted).toBe(false);
      expect(message).toContain("signed by this relay itself");
    }
    conn.close();
  });
});

describe("metadata", () => {
  it("carries the operator's fields through a 9002 and states the relay's own policy", async () => {
    const conn = await connectRelay();
    await publish(
      conn,
      moderation(EDIT_METADATA_KIND, [
        ["name", "Pizza Lovers"],
        ["about", "a group for people who love pizza"],
      ]),
    );
    conn.close();

    const metadata = (await storedGroupState()).get(GROUP_METADATA_KIND)!;
    expect(metadata.tags).toEqual([
      ["d", TOP_LEVEL_GROUP_ID],
      ["name", "Pizza Lovers"],
      ["about", "a group for people who love pizza"],
      // Facts about what this relay enforces, not preferences the 9002
      // expressed -- emitted whether or not it asked for them.
      ["private"],
      ["restricted"],
      ["hidden"],
      ["closed"],
    ]);
  });

  it("does not blank the group's name when an unrelated change regenerates state", async () => {
    const conn = await connectRelay();
    await publish(conn, moderation(EDIT_METADATA_KIND, [["name", "Pizza Lovers"]]));
    await publish(conn, putUser(randomKeypair().pubkeyHex));
    conn.close();

    const metadata = (await storedGroupState()).get(GROUP_METADATA_KIND)!;
    expect(metadata.tags).toContainEqual(["name", "Pizza Lovers"]);
  });
});

describe("regeneration", () => {
  // ITEM 3, first half: replaceable in place, not accumulating. kind-39002
  // is in the addressable range (30000-39999), so storeEvent's addressable
  // branch removes the previous version keyed by (pubkey, kind, d).
  it("replaces the member list in place rather than accumulating versions", async () => {
    const conn = await connectRelay();
    const members = [randomKeypair(), randomKeypair(), randomKeypair()];
    for (const member of members) await publish(conn, putUser(member.pubkeyHex));
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const rows = state.storage.sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events WHERE kind = ?`, GROUP_MEMBERS_KIND)
        .toArray()[0];
      // Three membership changes, one member list.
      expect(rows?.n).toBe(1);
    });

    // The owner first (NIP-29's own example lists the admin at the head),
    // then the members ordered by pubkey -- storage.ts listGroupMembers
    // orders by pubkey so the list is a function of the member SET and not
    // of the sequence that produced it.
    const list = (await storedGroupState()).get(GROUP_MEMBERS_KIND)!;
    expect(pTags(list)).toEqual([OWNER_PUBKEY_HEX, ...members.map((m) => m.pubkeyHex).sort()]);
  });

  it("regenerates only what changed", async () => {
    const conn = await connectRelay();
    await publish(conn, putUser(randomKeypair().pubkeyHex));
    const first = await storedGroupState();
    await publish(conn, putUser(randomKeypair().pubkeyHex));
    const second = await storedGroupState();
    conn.close();

    // Membership moved, so the member list is a new event.
    expect(second.get(GROUP_MEMBERS_KIND)!.id).not.toBe(first.get(GROUP_MEMBERS_KIND)!.id);
    // The admin list and the metadata did not, so they were not rewritten
    // -- the same measure-before-writing rule refreshFollows applies to the
    // follow cache, and the reason a membership change costs what it does
    // below rather than three times that.
    expect(second.get(GROUP_ADMINS_KIND)!.id).toBe(first.get(GROUP_ADMINS_KIND)!.id);
    expect(second.get(GROUP_METADATA_KIND)!.id).toBe(first.get(GROUP_METADATA_KIND)!.id);
  });

  // Two membership changes inside one wall-clock second. NIP-01 breaks a
  // created_at tie on an addressable event by LOWEST id, so a regenerated
  // list stamped with the same second as the one it replaces loses about
  // half the time -- and loses silently, since storeEvent reports success
  // with `stored: null`. The bump is what stops the group's membership
  // quietly ceasing to track its own moderation events.
  it("stamps each regeneration strictly newer than the one it replaces", async () => {
    const conn = await connectRelay();
    const members = [randomKeypair(), randomKeypair(), randomKeypair(), randomKeypair()];
    const stamps: number[] = [];
    for (const member of members) {
      await publish(conn, putUser(member.pubkeyHex));
      stamps.push((await storedGroupState()).get(GROUP_MEMBERS_KIND)!.created_at);
    }
    conn.close();

    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]!).toBeGreaterThan(stamps[i - 1]!);
    }
    // And the list that survived is the last one written, which is the
    // property the bump exists to guarantee.
    expect(pTags((await storedGroupState()).get(GROUP_MEMBERS_KIND)!)).toEqual([
      OWNER_PUBKEY_HEX,
      ...members.map((m) => m.pubkeyHex).sort(),
    ]);
  });
});

// ITEM 3, second half: what a membership change actually costs against the
// 100,000 rows-written/day ceiling (CLAUDE.md "The budget"). Measured on a
// real SqlStorageCursor, like every other figure in that section, so a
// change that moves it fails here rather than drifting.
describe("rows written per membership change", () => {
  // Sums SqlStorageCursor.rowsWritten across every statement `fn` issues --
  // the same proxy test/hibernation.test.ts uses, for the same reason.
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

  // Called at the storage layer rather than over the wire, because
  // runInDurableObject cannot drive a WebSocket belonging to another
  // Durable Object context. These two calls ARE what relay.ts acceptEvent
  // does for a moderation event once the gate has admitted it -- store the
  // event, then apply it -- so this measures the whole write, minus the
  // gate checks, which are reads.
  function applyPutUser(sql: SqlStorage, pubkey: string, nowSec: number): void {
    const event = putUser(pubkey);
    storeEvent(sql, event, nowSec);
    applyModeration(sql, env as unknown as Env, event, nowSec);
  }

  it("costs a bounded, measured amount that grows with the member list", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);

      // Seed a group of twenty, so the marginal change below is measured
      // against a member list of real size rather than an empty one.
      for (let i = 0; i < 20; i++) applyPutUser(sql, randomKeypair().pubkeyHex, now);
      const before = sql
        .exec<{ tags: string }>(`SELECT tags FROM events WHERE kind = ?`, GROUP_MEMBERS_KIND)
        .toArray()[0];
      expect((JSON.parse(before!.tags) as string[][]).filter((t) => t[0] === "p").length).toBe(21);

      const cost = measureRowsWritten(sql, (metered) =>
        applyPutUser(metered, randomKeypair().pubkeyHex, now),
      );

      // What that number is made of, at a 21-member list going to 22:
      //
      //   the kind-9000 itself      9 + 3 x 2 tags (`h`, `p`)      = 15
      //   group_members row         1 base + 1 PK index            =  2
      //   allowed_pubkeys row       1 base + 1 PK index            =  2
      //   removing the old 39002    22 tag rows + 1 event row + 3
      //                             counters (no tombstone -- a
      //                             replacement is not a deletion)  = 26
      //   storing the new 39002     9 + 3 x 23 tags                = 78
      //                                                             ----
      //                                                              123
      //
      // The 39002 dominates, and it grows at 3 rows per member on the
      // insert and 1 on the removal -- so ~4 rows per member per membership
      // change, on top of a fixed ~45. A twenty-person group churns ~123
      // rows per change; a two-hundred-person one would churn ~845. Against
      // 100,000 rows/day that is roughly 800 membership changes a day at
      // twenty members, or 118 at two hundred, which is the number to look
      // at before this grows a self-service join path.
      //
      // The kind-39000 metadata and kind-39001 admin list are NOT in it:
      // neither changed, so neither was rewritten. Rewriting all three on
      // every membership change would have added ~60 rows to this figure
      // for no change in content.
      expect(cost).toBe(123);
    });
  });

  it("costs nothing to re-add a member who is already in the group", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const member = randomKeypair().pubkeyHex;
      applyPutUser(sql, member, now);

      // The moderation event is stored again (a new id -- it is a regular
      // kind and part of the group's canonical history), but the membership
      // tables do not move and the member list is byte-identical, so no
      // kind-39002 is written at all.
      const cost = measureRowsWritten(sql, (metered) => {
        // A second later, so this is a genuinely different kind-9000 rather
        // than a byte-identical resend (which the wire path answers
        // `duplicate:` from `eventExists`, before storage).
        const event = signEvent(OWNER_SECRET_KEY_HEX, {
          kind: PUT_USER_KIND,
          created_at: now + 1,
          tags: [["h", TOP_LEVEL_GROUP_ID], ["p", member]],
        });
        storeEvent(metered, event, now);
        applyModeration(metered, env as unknown as Env, event, now);
      });
      expect(cost).toBe(15); // the kind-9000 and nothing else
    });
  });
});

describe("the daily audit", () => {
  // Two tables written together by one function, so they can only come
  // apart through a bug or a hand-edit -- which is exactly what a daily
  // check is for. A member missing from `allowed_pubkeys` is a member
  // whose events the relay-wide gate refuses with a message about follows
  // that names no group at all: cause and effect with nothing connecting
  // them.
  it("logs a group member with no allowed_pubkeys row, and does not repair it", async () => {
    const conn = await connectRelay();
    const member = randomKeypair();
    await publish(conn, putUser(member.pubkeyHex));
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      // Break the containment the way a bug or a hand-edit would.
      sql.exec(`DELETE FROM allowed_pubkeys WHERE pubkey = ?`, member.pubkeyHex);

      const errors: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
      try {
        auditMaintainedCounts(sql, Math.floor(Date.now() / 1000));
      } finally {
        console.error = original;
      }

      const logged = errors.join("\n");
      expect(logged).toContain("DRIFT");
      expect(logged).toContain("no allowed_pubkeys row");
      // The log names the pubkey, because that is what makes it actionable.
      expect(logged).toContain(member.pubkeyHex);

      // NOT repaired: the row stays missing. A repair here would mean this
      // function granting relay write access on the strength of a row it
      // has just decided it cannot trust.
      expect(sql.exec(`SELECT 1 FROM allowed_pubkeys`).toArray()).toEqual([]);
      expect(sql.exec(`SELECT 1 FROM group_members`).toArray().length).toBe(1);

      // And what gets STORED for /api/stats to read back counts rather than
      // names -- that endpoint is public and unauthenticated, so putting
      // member pubkeys in `last_drift` would publish part of this group's
      // membership to anybody who asked for the page.
      const stored = sql
        .exec<{ last_drift: string | null }>(`SELECT last_drift FROM maintained_counts`)
        .toArray()[0]?.last_drift;
      expect(stored).toContain("no allowed_pubkeys row");
      expect(stored).not.toContain(member.pubkeyHex);
    });
  });
});
