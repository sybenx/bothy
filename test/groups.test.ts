// NIP-29 group events, and the four surfaces they have to be excluded
// from for an unauthenticated reader.
//
// An event belongs to THIS RELAY'S group when it carries an `h` tag naming
// TOP_LEVEL_GROUP_ID (src/groups.ts isGroupEvent) -- KIND-AGNOSTIC, so a
// kind-1 note, a kind-7 reaction and a kind-30023 long-form post are all
// group events if they name this relay's group, and none of the tests
// below lean on a kind range. An `h` tag naming some OTHER group is a
// different thing entirely -- see test/backfill.test.ts for that case,
// which this file does not cover.
//
// The four surfaces, each with its own describe block, because each one
// is reached by a different code path and an exclusion applied to one of
// them is not applied to the others:
//
//   1. REQ results          handleReqInner -> queryFilters
//   2. broadcast()          the push to subscriptions registered BEFORE
//                           the event arrived, which the REQ-time gate
//                           never re-examines
//   3. liveBroadcast()      the admin page's unauthenticated /live feed
//   4. /api/stats           maintained counters, which a poller can watch
//                           advance
//
// Plus the cost invariant the whole design rests on: excluding the group
// is a partition seek, not a post-filter, so an unauthenticated read costs
// what it costs on an empty relay however much group traffic there is.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { buildFilterQuery } from "../src/filters";
import { GROUP_SCOPE, isGroupEvent, PUBLIC_SCOPE, TOP_LEVEL_GROUP_ID } from "../src/groups";
import { PUT_USER_KIND } from "../src/nip29";
import type { Relay } from "../src/relay";
import { auditMaintainedCounts, fixMisclassifiedGroupEvents, readMaintainedCounts } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { type Keypair, OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectLiveFeed, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

// This relay hosts exactly one group, TOP_LEVEL_GROUP_ID -- isGroupEvent
// now scopes the partition to that id specifically (groups.ts), so these
// fixtures tag their notes with it directly rather than with an arbitrary
// id of the test's own choosing.
const GROUP_ID = TOP_LEVEL_GROUP_ID;

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

function groupNote(content: string, extra: string[][] = []) {
  return signEvent(OWNER_SECRET_KEY_HEX, {
    kind: 1,
    content,
    tags: [["h", GROUP_ID], ...extra],
  });
}

function publicNote(content: string, extra: string[][] = []) {
  return signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content, tags: extra });
}

// Authenticates a connection as the owner, using a kinds:[1059] REQ as the
// challenge trigger (gated by shape, so it works on an empty relay).
async function authenticateAsOwner(conn: RelayConn, secretKeyHex = OWNER_SECRET_KEY_HEX): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage(); // CLOSED, auth-required
  const authEvent = signEvent(secretKeyHex, {
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

// Puts a pubkey into the group through the path the owner actually uses:
// a kind-9000 put-user, which writes BOTH nested lists (src/nip29.ts).
// Tagged with TOP_LEVEL_GROUP_ID, same as GROUP_ID above -- this relay
// hosts exactly one group and moderation events are always checked
// against that id (nip29.ts authorizeGroupWrite), whatever id ordinary
// group traffic happens to carry.
// The put-user event itself is `h`-tagged into TOP_LEVEL_GROUP_ID, same as
// GROUP_ID now, so it is returned alongside the keypair: a test collecting
// `{"#h": [GROUP_ID]}` sees this moderation event in the results too, and
// needs its id to say so.
async function makeMember(): Promise<Keypair & { putUserId: string }> {
  const member = randomKeypair();
  const conn = await connectRelay();
  const putUser = signEvent(OWNER_SECRET_KEY_HEX, {
    kind: PUT_USER_KIND,
    tags: [
      ["h", TOP_LEVEL_GROUP_ID],
      ["p", member.pubkeyHex],
    ],
  });
  const [, , ok] = await publish(conn, putUser);
  expect(ok).toBe(true);
  conn.close();
  return { ...member, putUserId: putUser.id };
}

async function collect(conn: RelayConn, subId: string, filter: unknown): Promise<string[]> {
  conn.send(["REQ", subId, filter]);
  const ids: string[] = [];
  for (;;) {
    const frame = await conn.nextMessage();
    if (frame[0] === "EOSE") break;
    if (frame[0] === "EVENT") ids.push((frame[2] as { id: string }).id);
    if (frame[0] === "CLOSED") throw new Error(`CLOSED: ${String(frame[2])}`);
  }
  return ids;
}

describe("what makes an event a group event", () => {
  it("is the `h` tag and nothing else -- any kind may carry one", () => {
    for (const kind of [1, 7, 11, 1063, 10002, 30023]) {
      expect(isGroupEvent(signEvent(OWNER_SECRET_KEY_HEX, { kind, tags: [["h", GROUP_ID]] }))).toBe(true);
      expect(isGroupEvent(signEvent(OWNER_SECRET_KEY_HEX, { kind }))).toBe(false);
    }
  });

  it("does not count an `h` tag that names nothing", () => {
    // Otherwise an author could hide an event from public reads by tagging
    // it with an empty group.
    expect(isGroupEvent(signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, tags: [["h"]] }))).toBe(false);
    expect(isGroupEvent(signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, tags: [["h", ""]] }))).toBe(false);
  });

  // THE DEFECT THIS FIXES: isGroupEvent used to count ANY `h` tag as this
  // relay's group, which meant an event backfilled from the owner's own
  // history -- authored by them, but published to a DIFFERENT relay
  // hosting a DIFFERENT NIP-29 group -- got filed into this relay's group
  // partition anyway. That made a stranger's group content unreadable to
  // anyone who is not a member of the one group this relay actually
  // hosts. See test/backfill.test.ts for the same case exercised through
  // applyBackfillPage and the stored `is_group` column.
  it("does not count an `h` tag naming some OTHER relay's group", () => {
    for (const kind of [1, 7, 11, 1063, 10002, 30023]) {
      expect(
        isGroupEvent(
          signEvent(OWNER_SECRET_KEY_HEX, { kind, tags: [["h", "some-other-relays-group"]] }),
        ),
      ).toBe(false);
    }
  });

  it("stores the partition on the event row and on every one of its tag rows", async () => {
    const conn = await connectRelay();
    const group = groupNote("in the group", [["p", OWNER_PUBKEY_HEX]]);
    const plain = publicNote("out in the open", [["p", OWNER_PUBKEY_HEX]]);
    await publish(conn, group);
    await publish(conn, plain);
    conn.close();

    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const scopeOfRow = (id: string) =>
        sql.exec<{ is_group: number }>(`SELECT is_group FROM events WHERE id = ?`, id).toArray()[0]
          ?.is_group;
      expect(scopeOfRow(group.id)).toBe(GROUP_SCOPE);
      expect(scopeOfRow(plain.id)).toBe(PUBLIC_SCOPE);

      // The tag rows carry it too, which is what lets the tag subquery
      // exclude the group BEFORE its own LIMIT applies -- without that a
      // client asking for 20 events gets a short page instead of a
      // filtered one.
      const tagScopes = sql
        .exec<{ is_group: number }>(`SELECT is_group FROM event_tags WHERE event_id = ?`, group.id)
        .toArray()
        .map((r) => r.is_group);
      expect(tagScopes.length).toBeGreaterThan(0);
      expect(tagScopes.every((s) => s === GROUP_SCOPE)).toBe(true);
    });
  });
});

describe("fixMisclassifiedGroupEvents: the one-time partition correction", () => {
  // storeEvent can no longer produce a row shaped like this -- scopeOf
  // already uses the corrected isGroupEvent -- which is exactly why a
  // relay that stored one under the OLD, id-agnostic test needs a
  // migration rather than a guard on the write path. This inserts
  // straight into storage the way the pre-fix code would have, bypassing
  // storeEvent entirely, to stand in for that relay's existing data.
  it("clears is_group on a pre-existing row naming a foreign group, leaves a real one alone, and keeps the counters consistent", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const hour = Math.trunc(now / 3600);

      const foreign = signEvent(OWNER_SECRET_KEY_HEX, {
        kind: 1,
        content: "wrongly filed under the old id-agnostic test",
        tags: [["h", "someone-elses-group"]],
        created_at: now,
      });
      sql.exec(
        `INSERT INTO events
           (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost, is_group)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
        foreign.id,
        foreign.pubkey,
        foreign.created_at,
        foreign.kind,
        JSON.stringify(foreign.tags),
        foreign.content,
        foreign.sig,
        now,
        12,
      );
      sql.exec(
        `INSERT INTO event_tags (tag_name, tag_value, event_id, created_at, is_group)
         VALUES ('h', ?, ?, ?, 1)`,
        "someone-elses-group",
        foreign.id,
        now,
      );
      sql.exec(`UPDATE maintained_counts SET events = events + 1, group_events = group_events + 1`);
      sql.exec(
        `INSERT INTO event_hour_counts (hour, n, group_n) VALUES (?, 1, 1)
           ON CONFLICT(hour) DO UPDATE SET n = n + 1, group_n = group_n + 1`,
        hour,
      );
      sql.exec(
        `INSERT INTO ingest_hour_counts (hour, n, group_n, rows_written) VALUES (?, 1, 1, 21)
           ON CONFLICT(hour) DO UPDATE SET n = n + 1, group_n = group_n + 1, rows_written = rows_written + 21`,
        hour,
      );

      // A real member of this relay's own group, stored the same way --
      // the migration must not touch this one.
      const ours = groupNote("really ours");
      await (async () => {
        const conn = await connectRelay();
        await publish(conn, ours);
        conn.close();
      })();

      const before = readMaintainedCounts(sql);

      expect(fixMisclassifiedGroupEvents(sql, 100)).toBe(1);

      const foreignRow = sql
        .exec<{ is_group: number }>(`SELECT is_group FROM events WHERE id = ?`, foreign.id)
        .toArray()[0];
      expect(foreignRow?.is_group).toBe(PUBLIC_SCOPE);
      const foreignTag = sql
        .exec<{ is_group: number }>(`SELECT is_group FROM event_tags WHERE event_id = ?`, foreign.id)
        .toArray()[0];
      expect(foreignTag?.is_group).toBe(PUBLIC_SCOPE);

      const oursRow = sql
        .exec<{ is_group: number }>(`SELECT is_group FROM events WHERE id = ?`, ours.id)
        .toArray()[0];
      expect(oursRow?.is_group).toBe(GROUP_SCOPE);

      const after = readMaintainedCounts(sql);
      expect(after.events).toBe(before.events);
      expect(after.groupEvents).toBe(before.groupEvents - 1);

      // Idempotent: the guard flag is now set, so a second call finds
      // nothing (the row already dropped out of `is_group = 1`) and costs
      // one bounded, empty query rather than repeating the fix.
      expect(fixMisclassifiedGroupEvents(sql, 100)).toBe(0);

      // And the counters this migration touched stay internally
      // consistent with the table -- auditMaintainedCounts finds no drift.
      sql.exec(`UPDATE maintained_counts SET audited_at = NULL`);
      auditMaintainedCounts(sql, now);
      expect(readMaintainedCounts(sql).drift).toBeNull();
    });
  });

  // THE SPECIFIC MECHANISM, exercised rather than assumed: candidacy is
  // keyed to events.is_group, the same column the fix flips FIRST (a
  // single UPDATE, atomic on its own). This simulates a cron tick that
  // died immediately after that one statement -- the earliest point a
  // crash could leave anything behind -- by applying it by hand and
  // nothing else, then calling the migration again exactly as the next
  // cron tick would. If candidacy were keyed to the tag row's own
  // `is_group` copy instead (as an earlier version of this migration was),
  // this row would still match the tag-index seek and the second call
  // would decrement group_events a second time for an event it had
  // already (partially) fixed.
  it("does not double-decrement when a prior run flipped events.is_group but got no further", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const hour = Math.trunc(now / 3600);

      const foreign = signEvent(OWNER_SECRET_KEY_HEX, {
        kind: 1,
        content: "wrongly filed, then half-fixed",
        tags: [["h", "someone-elses-group"]],
        created_at: now,
      });
      sql.exec(
        `INSERT INTO events
           (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost, is_group)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 1)`,
        foreign.id,
        foreign.pubkey,
        foreign.created_at,
        foreign.kind,
        JSON.stringify(foreign.tags),
        foreign.content,
        foreign.sig,
        now,
        12,
      );
      sql.exec(
        `INSERT INTO event_tags (tag_name, tag_value, event_id, created_at, is_group)
         VALUES ('h', ?, ?, ?, 1)`,
        "someone-elses-group",
        foreign.id,
        now,
      );
      sql.exec(`UPDATE maintained_counts SET events = events + 1, group_events = group_events + 1`);
      sql.exec(
        `INSERT INTO event_hour_counts (hour, n, group_n) VALUES (?, 1, 1)
           ON CONFLICT(hour) DO UPDATE SET n = n + 1, group_n = group_n + 1`,
        hour,
      );
      sql.exec(
        `INSERT INTO ingest_hour_counts (hour, n, group_n, rows_written) VALUES (?, 1, 1, 21)
           ON CONFLICT(hour) DO UPDATE SET n = n + 1, group_n = group_n + 1, rows_written = rows_written + 21`,
        hour,
      );

      // The crash: only the very first statement the fix issues has run.
      // event_tags.is_group, and all three counters, are exactly as wrong
      // as they were before any fix was attempted.
      sql.exec(`UPDATE events SET is_group = 0 WHERE id = ?`, foreign.id);

      const stillPending = readMaintainedCounts(sql);
      expect(stillPending.groupEvents).toBe(1); // untouched by the "crash"

      // The next cron tick's call. It must find nothing for this row --
      // events.is_group is already 0 -- and so must not touch
      // group_events, its hour bucket, or its ingest bucket again.
      expect(fixMisclassifiedGroupEvents(sql, 100)).toBe(0);

      const after = readMaintainedCounts(sql);
      expect(after.groupEvents).toBe(stillPending.groupEvents);

      const bucket = sql
        .exec<{ group_n: number }>(`SELECT group_n FROM event_hour_counts WHERE hour = ?`, hour)
        .toArray()[0];
      expect(bucket?.group_n).toBe(1);

      // The one row this leaves behind: event_tags never caught up with
      // events for this specific id. Documented as the accepted, safe-
      // direction residue in fixMisclassifiedGroupEvents' own comment --
      // asserted here so a future change that claims to "fix" this
      // doesn't silently start double-decrementing instead.
      const tagRow = sql
        .exec<{ is_group: number }>(`SELECT is_group FROM event_tags WHERE event_id = ?`, foreign.id)
        .toArray()[0];
      expect(tagRow?.is_group).toBe(GROUP_SCOPE);
    });
  });
});

describe("surface 1: REQ results", () => {
  it("omits group events from an unauthenticated filter that does not name a group", async () => {
    const conn = await connectRelay();
    const group = groupNote("group only");
    const plain = publicNote("public");
    await publish(conn, group);
    await publish(conn, plain);

    // Omission, not refusal: the filter is answered normally, minus the
    // group's rows.
    expect(await collect(conn, "kindsOnly", { kinds: [1] })).toEqual([plain.id]);
    expect(await collect(conn, "authorsOnly", { authors: [OWNER_PUBKEY_HEX] })).toEqual([plain.id]);
    conn.close();
  });

  it("omits them from a tag filter too, where the subquery would otherwise return them", async () => {
    const conn = await connectRelay();
    const group = groupNote("group", [["p", OWNER_PUBKEY_HEX]]);
    const plain = publicNote("public", [["p", OWNER_PUBKEY_HEX]]);
    await publish(conn, group);
    await publish(conn, plain);

    expect(await collect(conn, "tagFilter", { "#p": [OWNER_PUBKEY_HEX], limit: 20 })).toEqual([plain.id]);
    conn.close();
  });

  it("refuses a filter that NAMES a group, with auth-required", async () => {
    // The other half of the omit-don't-refuse rule: this client has
    // already said what it wants, so telling it to authenticate discloses
    // nothing it did not already know -- and unlike omission, it is
    // decided from the filter alone, with no storage access at all.
    const conn = await connectRelay();
    conn.send(["REQ", "namesGroup", { "#h": [GROUP_ID] }]);

    const auth = await conn.nextMessage();
    expect(auth[0]).toBe("AUTH");
    const closed = await conn.nextMessage();
    expect(closed[0]).toBe("CLOSED");
    expect(closed[1]).toBe("namesGroup");
    expect((closed[2] as string).startsWith("auth-required:")).toBe(true);
    conn.close();
  });

  it("refuses it the same way whether or not the group holds anything", async () => {
    // The property the gift wrap storage probe did not have, and the whole
    // reason this gate reads the filter rather than the table: an answer
    // that depended on what was stored would BE the answer to the question
    // it refuses.
    const empty = await connectRelay();
    empty.send(["REQ", "emptyRelay", { "#h": [GROUP_ID] }]);
    const emptyAuth = await empty.nextMessage();
    const emptyClosed = await empty.nextMessage();
    empty.close();

    const writer = await connectRelay();
    await publish(writer, groupNote("now there is something"));
    writer.close();

    const full = await connectRelay();
    full.send(["REQ", "fullRelay", { "#h": [GROUP_ID] }]);
    const fullAuth = await full.nextMessage();
    const fullClosed = await full.nextMessage();
    full.close();

    expect(fullAuth[0]).toBe(emptyAuth[0]);
    expect(fullClosed[2]).toBe(emptyClosed[2]);
  });

  it("restricts, rather than challenges, a pubkey that authenticated but may not read the group", async () => {
    const stranger = randomKeypair();
    const conn = await connectRelay();
    await authenticateAsOwner(conn, stranger.secretKeyHex);

    conn.send(["REQ", "strangerGroup", { "#h": [GROUP_ID] }]);
    const frame = await conn.nextMessage();
    expect(frame[0]).toBe("CLOSED");
    expect((frame[2] as string).startsWith("restricted:")).toBe(true);
    conn.close();
  });

  it("serves both partitions to an authorised reader", async () => {
    const writer = await connectRelay();
    const group = groupNote("group");
    const plain = publicNote("public");
    await publish(writer, group);
    await publish(writer, plain);
    writer.close();

    const conn = await connectRelay();
    await authenticateAsOwner(conn);

    // Named directly...
    expect(await collect(conn, "authedGroup", { "#h": [GROUP_ID] })).toEqual([group.id]);
    // ...and merged into an ordinary filter, which is the two-partition
    // read: storage.ts runs the filter once per partition and re-slices.
    const both = await collect(conn, "authedKinds", { kinds: [1] });
    expect(both.sort()).toEqual([group.id, plain.id].sort());
    conn.close();
  });

  // The widening, and the whole point of it: a pubkey the group admitted
  // on the WRITE side reads the group back. Before this, membership was
  // enforced by nip29.ts authorizeGroupWrite and ignored by this gate, so
  // a member could publish into a group they could not see -- which made
  // the group unusable by anyone but the owner.
  it("serves them to a member, on the same membership the write gate uses", async () => {
    const member = await makeMember();

    const writer = await connectRelay();
    const group = groupNote("group");
    const plain = publicNote("public");
    await publish(writer, group);
    await publish(writer, plain);
    writer.close();

    const conn = await connectRelay();
    await authenticateAsOwner(conn, member.secretKeyHex);

    // Naming the group is answered rather than refused now -- the same
    // filter the "restricts, rather than challenges" test above sends
    // from a pubkey that authenticated and is not a member. The put-user
    // that admitted this member is itself `h`-tagged into GROUP_ID (now
    // the same id as TOP_LEVEL_GROUP_ID), so it is in this result too.
    expect((await collect(conn, "memberGroup", { "#h": [GROUP_ID] })).sort()).toEqual(
      [group.id, member.putUserId].sort(),
    );
    const both = await collect(conn, "memberKinds", { kinds: [1] });
    expect(both.sort()).toEqual([group.id, plain.id].sort());
    conn.close();
  });
});

describe("surface 2: broadcast() to an existing subscription", () => {
  it("does not push a group event to a subscription registered before it arrived", async () => {
    // The surface an exclusion applied only to REQ results would miss.
    // This subscription is registered while the relay holds nothing, so
    // the REQ-time gate has nothing to act on and (correctly) admits it;
    // the push path has to enforce the same rule by itself.
    const subscriber = await connectRelay();
    subscriber.send(["REQ", "standing", { kinds: [1] }]);
    expect((await subscriber.nextMessage())[0]).toBe("EOSE");

    const writer = await connectRelay();
    await publish(writer, groupNote("live group message"));

    await expect(subscriber.nextMessage(200)).rejects.toThrow();

    // ...and the same subscription still receives public events, so this
    // is an exclusion rather than a broken socket.
    const plain = publicNote("live public message");
    await publish(writer, plain);
    const frame = await subscriber.nextMessage();
    expect(frame[0]).toBe("EVENT");
    expect((frame[2] as { id: string }).id).toBe(plain.id);

    subscriber.close();
    writer.close();
  });

  it("pushes it to an authorised subscriber", async () => {
    const subscriber = await connectRelay();
    await authenticateAsOwner(subscriber);
    subscriber.send(["REQ", "authedStanding", { kinds: [1] }]);
    expect((await subscriber.nextMessage())[0]).toBe("EOSE");

    const writer = await connectRelay();
    const group = groupNote("live, authorised");
    await publish(writer, group);

    const frame = await subscriber.nextMessage();
    expect(frame[0]).toBe("EVENT");
    expect((frame[2] as { id: string }).id).toBe(group.id);
    subscriber.close();
    writer.close();
  });

  // The half of the widening that a REQ-time test cannot reach. This
  // subscription is registered while the relay holds no group event at
  // all, so nothing about it is re-examined when one arrives: if
  // broadcast() had kept the owner-only rule while handleReqInner widened,
  // a member would read the group's history and never see a live message
  // in it, and every stored-read assertion above would still pass.
  it("pushes it to a member's standing subscription", async () => {
    const member = await makeMember();

    const subscriber = await connectRelay();
    await authenticateAsOwner(subscriber, member.secretKeyHex);
    subscriber.send(["REQ", "memberStanding", { kinds: [1] }]);
    expect((await subscriber.nextMessage())[0]).toBe("EOSE");

    const writer = await connectRelay();
    const group = groupNote("live, to a member");
    await publish(writer, group);

    const frame = await subscriber.nextMessage();
    expect(frame[0]).toBe("EVENT");
    expect((frame[2] as { id: string }).id).toBe(group.id);
    subscriber.close();
    writer.close();
  });
});

describe("surface 3: the /live admin feed", () => {
  it("never announces a group event, and still announces public ones", async () => {
    const live = await connectLiveFeed();
    const conn = await connectRelay();

    await publish(conn, groupNote("silent"));
    // Nothing for the group event -- not even the redacted
    // kind/time/8-hex-characters notice, which would still time every
    // message in the group to the second.
    await expect(live.nextMessage(200)).rejects.toThrow();

    const plain = publicNote("announced");
    await publish(conn, plain);
    const notice = await live.nextMessage();
    expect(notice.id).toBe(plain.id.slice(0, 8));

    conn.close();
    live.close();
  });

  // What "mirror the widening here" comes to on a channel with no
  // identity: nothing. A /live socket cannot be a member because it
  // cannot be anybody -- there is no AUTH on that path and no connection
  // state to hold an authenticated pubkey -- so a group that now has
  // readers still has none here. Asserted with a real member watching the
  // event land on their own socket, so the silence is the live feed's and
  // not the relay's.
  it("stays silent even while a member is being pushed the same event", async () => {
    const member = await makeMember();

    const subscriber = await connectRelay();
    await authenticateAsOwner(subscriber, member.secretKeyHex);
    subscriber.send(["REQ", "memberLive", { kinds: [1] }]);
    expect((await subscriber.nextMessage())[0]).toBe("EOSE");

    const live = await connectLiveFeed();
    const conn = await connectRelay();
    const group = groupNote("read by a member, announced to nobody");
    await publish(conn, group);

    expect((await subscriber.nextMessage())[2]).toMatchObject({ id: group.id });
    await expect(live.nextMessage(200)).rejects.toThrow();

    subscriber.close();
    conn.close();
    live.close();
  });
});

describe("surface 4: the public counters on /api/stats", () => {
  it("excludes group events from every count on the document", async () => {
    const conn = await connectRelay();
    const before = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as { totalEvents: number; events24h: number; ingested24h: number; rowsWrittenToday: number };

    await publish(conn, groupNote("uncounted"));

    const afterGroup = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as { totalEvents: number; events24h: number; ingested24h: number; rowsWrittenToday: number };

    // Polling this document while holding a /live socket is how the
    // security review timed gift wrap arrivals to the second. A group
    // event must move none of these three.
    expect(afterGroup.totalEvents).toBe(before.totalEvents);
    expect(afterGroup.events24h).toBe(before.events24h);
    expect(afterGroup.ingested24h).toBe(before.ingested24h);

    // And a public event still does, so the counters are excluding rather
    // than stuck.
    await publish(conn, publicNote("counted"));
    const afterPublic = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as { totalEvents: number; events24h: number; ingested24h: number };
    expect(afterPublic.totalEvents).toBe(before.totalEvents + 1);
    expect(afterPublic.events24h).toBe(before.events24h + 1);
    expect(afterPublic.ingested24h).toBe(before.ingested24h + 1);
    conn.close();
  });

  // /api/stats is unauthenticated HTTP: it has no reader identity to
  // widen, so the widening cannot reach it. Asserted rather than reasoned
  // about, because the counters are what a poller watches advance, and a
  // member is now a second kind of writer whose events could plausibly
  // have been thought "readable, therefore countable".
  it("does not start counting group events once the group has members", async () => {
    const member = await makeMember();
    const before = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as { totalEvents: number; events24h: number; ingested24h: number };

    const conn = await connectRelay();
    await publish(
      conn,
      signEvent(member.secretKeyHex, {
        kind: 1,
        content: "written by a member, counted by nobody",
        tags: [["h", GROUP_ID]],
      }),
    );

    const after = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as { totalEvents: number; events24h: number; ingested24h: number };
    expect(after.totalEvents).toBe(before.totalEvents);
    expect(after.events24h).toBe(before.events24h);
    expect(after.ingested24h).toBe(before.ingested24h);
    conn.close();
  });

  it("still reports the group's writes in rowsWrittenToday, which is deliberate", async () => {
    // Documented rather than fixed: rowsWrittenToday is the owner's budget
    // meter, and a budget figure that under-reports the day's real spend
    // is worse than one that leaks the shape of the traffic producing it.
    // relay.ts collectStats says so beside the field, along with
    // storageBytes and the reads diagnostic, which move for the same
    // reason. If that trade is ever revisited, this test is the record of
    // what was chosen.
    const conn = await connectRelay();
    const before = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as { rowsWrittenToday: number };

    await publish(conn, groupNote("costs rows like anything else"));

    const after = (await (
      await exports.default.fetch("https://example.com/api/stats")
    ).json()) as { rowsWrittenToday: number };
    expect(after.rowsWrittenToday).toBeGreaterThan(before.rowsWrittenToday);
    conn.close();
  });

  it("keeps the split counters consistent with the table, through stores and deletions", async () => {
    // The counters are maintained in two halves now, and the group half is
    // what /api/stats SUBTRACTS -- so a group counter that drifted low
    // would put group events back on a public document one at a time,
    // while the total still matched. auditMaintainedCounts checks both
    // halves; this asserts it finds nothing to report.
    const conn = await connectRelay();
    const group = groupNote("stored then deleted");
    await publish(conn, group);
    await publish(conn, groupNote("stays"));
    await publish(conn, publicNote("public"));
    await publish(
      conn,
      signEvent(OWNER_SECRET_KEY_HEX, { kind: 5, tags: [["e", group.id]] }),
    );
    conn.close();

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await runInDurableObject(stub(), async (_instance: Relay, state) => {
        const sql = state.storage.sql;
        sql.exec(`UPDATE maintained_counts SET audited_at = NULL`);
        auditMaintainedCounts(sql, Math.floor(Date.now() / 1000));
        expect(readMaintainedCounts(sql).drift).toBeNull();
      });
    } finally {
      console.error = original;
    }
    expect(errors.join("\n")).not.toContain("DRIFT");
  });
});

describe("the cost invariant", () => {
  it("keeps an unauthenticated read flat in the size of the group", async () => {
    // The reason this is a partition rather than a column tested at query
    // time. A post-filter reads past every group row it skips -- measured
    // at 50,000 group events, 1,090 rows for a `{"kinds":[1],"limit":20}`
    // that costs 41 on a relay with no group at all, and 26,050 at limit
    // 500. A partial-index pair costs the same 41 whatever the group
    // holds, because the group's rows are in the other index.
    await runInDurableObject(stub(), async (_instance: Relay, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const query = buildFilterQuery({ kinds: [1], limit: 20 }, now);
      expect(query).not.toBeNull();
      const cost = () => {
        const cursor = sql.exec(query!.sql, ...query!.params);
        cursor.toArray();
        return cursor.rowsRead;
      };

      // 200 public events, then 5,000 group events interleaved through the
      // same window -- a 25:1 ratio, which is what a group replacing a
      // chat app looks like next to one person's own posting.
      sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost, is_group)
         WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < 200)
         SELECT printf('%064x', i), ?, ? + i * 60, 1, '[]', 'x', 'sig', NULL, ?, 24, 0 FROM seq`,
        OWNER_PUBKEY_HEX,
        now - 20_000,
        now,
      );
      const withoutGroup = cost();

      sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost, is_group)
         WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < 5000)
         SELECT printf('%064x', 1000000 + i), printf('%064x', 900000 + (i % 20)),
                ? + (i * 12000) / 5000, 1, '[]', 'x', 'sig', NULL, ?, 24, 1 FROM seq`,
        now - 20_000,
        now,
      );
      const withGroup = cost();

      expect(withoutGroup).toBe(41);
      expect(withGroup).toBe(withoutGroup);

      // And the same query pinned to the other partition is the mirror
      // image, so the group's rows really are indexed -- this is not
      // cheap because they are unreachable.
      const groupQuery = buildFilterQuery({ kinds: [1], limit: 20 }, now, { scope: GROUP_SCOPE });
      const groupCursor = sql.exec(groupQuery!.sql, ...groupQuery!.params);
      expect(groupCursor.toArray().length).toBe(20);
      expect(groupCursor.rowsRead).toBe(41);
    });
  });
});
