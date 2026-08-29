// NIP-29 group events, and the four surfaces they have to be excluded
// from for an unauthenticated reader.
//
// An event belongs to a group when it carries an `h` tag (src/groups.ts) --
// KIND-AGNOSTIC, so a kind-1 note, a kind-7 reaction and a kind-30023
// long-form post are all group events if they name a group, and none of
// the tests below lean on a kind range.
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
import { GROUP_SCOPE, isGroupEvent, PUBLIC_SCOPE } from "../src/groups";
import type { Relay } from "../src/relay";
import { auditMaintainedCounts, readMaintainedCounts } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectLiveFeed, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const GROUP_ID = "bothy-test-group";

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
