// The Fridge door's readable events and calendar links (src/door.ts):
// members write a group's events plainly, and each person's link serves
// the events of the groups they are in now, as a calendar file.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GROUP_CHANGE_KIND } from "../src/home-groups";
import { calendarFile, isRemoved, merge, parseIncoming, whenLines, zonedMs, type DoorEvent } from "../src/door";
import { DOOR_EVENTS_PER_CALL } from "../src/limits";
import type { Relay } from "../src/relay";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

let gidCounter = 0;
function newGid(): string {
  gidCounter++;
  return gidCounter.toString(16).padStart(32, "c");
}

async function newMember(): Promise<Keypair> {
  const member = randomKeypair();
  expect((await callManagement("allowpubkey", [member.pubkeyHex])).result).toBe(true);
  return member;
}

const as = (who: Keypair) => ({ secretKeyHex: who.secretKeyHex });

function change(who: Keypair, gid: string, version: number, op: string, targets: string[] = [], content = ""): NostrEvent {
  return signEvent(who.secretKeyHex, {
    kind: GROUP_CHANGE_KIND,
    tags: [["h", gid], ["v", String(version)], ["op", op], ...targets.map((p) => ["p", p])],
    content,
  });
}

async function create(creator: Keypair, others: Keypair[]): Promise<string> {
  const gid = newGid();
  const people = [creator, ...others];
  const reply = await callManagement(
    "groupcreate",
    [
      gid,
      change(creator, gid, 0, "create", others.map((o) => o.pubkeyHex)),
      { epoch: 1, keys: people.map((p) => ({ to: p.pubkeyHex, blob: `sealed-${p.pubkeyHex.slice(0, 8)}` })) },
    ],
    as(creator),
  );
  expect(reply.error).toBeUndefined();
  return gid;
}

const D1 = "a".repeat(32);
const D2 = "b".repeat(32);
const D3 = "c".repeat(32);

function put(who: Keypair, gid: string, events: unknown[]) {
  return callManagement("doorput", [gid, events], as(who));
}

async function linkOf(who: Keypair, method = "callink"): Promise<string> {
  const r = await callManagement(method, [], as(who));
  expect(r.error).toBeUndefined();
  return (r.result as { path: string }).path;
}

async function fetchCal(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(new Request(`https://example.com${path}`, { headers }));
}

async function calText(path: string): Promise<string> {
  const r = await fetchCal(path);
  expect(r.status).toBe(200);
  return r.text();
}

const hike = {
  d: D1,
  set: { title: "Hike at Mill Creek", start: { local: "2026-11-29T09:00", tz: "America/Denver" }, place: "Mill Creek" },
  at: { title: 10, start: 10, place: 10 },
};

describe("the door's readable events", () => {
  it("are advertised on NIP-11", async () => {
    const reply = await exports.default.fetch(new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }));
    const doc = (await reply.json()) as { calendar?: unknown };
    expect(doc.calendar).toEqual({ v: 1 });
  });

  it("are written only by people in the group", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    const stranger = await newMember();
    expect((await put(stranger, gid, [hike])).error).toBe("doorput: you are not in this group");
    expect((await callManagement("doorcount", [gid], as(stranger))).error).toBe("doorcount: you are not in this group");
    expect((await put(ben, gid, [hike])).result).toEqual({ stored: 1, refused: 0 });
    expect((await callManagement("doorcount", [gid], as(ana))).result).toEqual({ events: 1 });
  });

  it("refuses a bad event and too many in one call", async () => {
    const ana = await newMember();
    const gid = await create(ana, []);
    const bad = [
      { d: D2, set: { title: "x" }, at: {} },
      { d: D2, set: { start: { local: "tomorrow", tz: "UTC" } }, at: { start: 1 } },
      { d: "NOT-HEX", set: { title: "x" }, at: { title: 1 } },
    ];
    expect((await put(ana, gid, bad)).result).toEqual({ stored: 0, refused: 3 });
    const many = Array.from({ length: DOOR_EVENTS_PER_CALL + 1 }, () => hike);
    expect((await put(ana, gid, many)).error).toMatch(/at most/);
  });

  it("serve a calendar link with every group's events, moved and removed ones included", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const family = await create(ana, [ben]);
    const cousins = await create(ben, []);
    await put(ana, family, [
      hike,
      { d: D2, set: { title: "Thanksgiving", start: { date: "2026-11-26" }, end: { date: "2026-11-28" } }, at: { title: 5, start: 5, end: 5 } },
    ]);
    await put(ben, cousins, [{ d: D3, set: { title: "Game night", start: { local: "2026-12-04T19:00", tz: "America/Denver" } }, at: { title: 1, start: 1 } }]);

    const path = await linkOf(ben);
    expect(path).toMatch(/^\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
    expect(await linkOf(ben)).toBe(path);
    let ics = await calText(path);
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n");
    expect(ics).toContain("X-PUBLISHED-TTL:PT1H\r\n");
    expect(ics).toContain(`UID:${D1}@dms\r\n`);
    // 9:00 in Denver, after DST ended (UTC-7).
    expect(ics).toContain("DTSTART:20261129T160000Z\r\nDTEND:20261129T170000Z\r\n");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261126\r\nDTEND;VALUE=DATE:20261129\r\n");
    expect(ics).toContain("SUMMARY:Game night\r\n");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    // Ana sees only her group.
    expect((await calText(await linkOf(ana))).match(/BEGIN:VEVENT/g)).toHaveLength(2);

    // Moved: same UID, SEQUENCE up. A stale write (lower stamp) changes nothing.
    await put(ben, family, [{ d: D1, set: { start: { local: "2026-11-29T15:00", tz: "America/Denver" } }, at: { start: 20 } }]);
    await put(ana, family, [{ d: D1, set: { start: { local: "2026-11-29T08:00", tz: "America/Denver" } }, at: { start: 15 } }]);
    ics = await calText(path);
    expect(ics).toContain("SEQUENCE:1\r\nDTSTART:20261129T220000Z\r\n");

    // Removed: gone from the file.
    await put(ana, family, [{ d: D2, set: { removed: true }, at: { removed: 30 } }]);
    ics = await calText(path);
    expect(ics).not.toContain("Thanksgiving");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
  });

  it("answers 304 when nothing changed", async () => {
    const ana = await newMember();
    const gid = await create(ana, []);
    await put(ana, gid, [hike]);
    const path = await linkOf(ana);
    const first = await fetchCal(path);
    expect(first.headers.get("Content-Type")).toBe("text/calendar; charset=utf-8");
    expect(first.headers.get("Cache-Control")).toBe("private, max-age=300");
    const etag = first.headers.get("ETag")!;
    expect((await fetchCal(path, { "If-None-Match": etag })).status).toBe(304);
  });

  it("drop a group's events from the link when the person leaves it, and with the group", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    await put(ana, gid, [hike]);
    const path = await linkOf(ben);
    expect(await calText(path)).toContain("Hike at Mill Creek");
    expect((await callManagement("groupleave", [gid], as(ben))).error).toBeUndefined();
    // Still a calendar, now empty, so the phone's copy empties too.
    expect(await calText(path)).not.toContain("BEGIN:VEVENT");
    expect((await callManagement("groupleave", [gid], as(ana))).error).toBeUndefined();
    const left = await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), async (_: Relay, state) =>
      state.storage.sql.exec(`SELECT COUNT(*) AS n FROM door_events WHERE gid = ?`, gid).one().n,
    );
    expect(left).toBe(0);
  });

  it("drop a removed member's events", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    await put(ana, gid, [hike]);
    const path = await linkOf(ben);
    expect((await callManagement("unallowpubkey", [ben.pubkeyHex])).result).toBe(true);
    expect(await calText(path)).not.toContain("BEGIN:VEVENT");
  });

  it("a new link retires the old one; off deletes it", async () => {
    const ana = await newMember();
    await create(ana, []);
    const old = await linkOf(ana);
    const fresh = await linkOf(ana, "callinknew");
    expect(fresh).not.toBe(old);
    expect((await fetchCal(old)).status).toBe(404);
    expect((await fetchCal(fresh)).status).toBe(200);
    expect((await callManagement("callinkoff", [], as(ana))).result).toBe(true);
    expect((await fetchCal(fresh)).status).toBe(404);
  });

  it("are not for someone with nothing here", async () => {
    const stranger = randomKeypair();
    expect((await callManagement("callink", [], as(stranger))).error).toBe("callink: you are not in this group");
  });
});

describe("the calendar file", () => {
  const ev = (d: string, fields: Record<string, unknown>, seq = 0, updatedAt = 1_790_000_000): DoorEvent => ({
    d,
    fields,
    stamps: Object.fromEntries(Object.keys(fields).map((k) => [k, 1])),
    seq,
    updatedAt,
  });
  const now = Date.parse("2026-11-26T12:00:00Z");

  it("puts wall times across daylight saving at the right instant", () => {
    // Before and after the US change on 2026-11-01, and the EU one on 2026-10-25.
    expect(whenLines({ local: "2026-10-31T09:00", tz: "America/Denver" }, null).lines[0]).toBe("DTSTART:20261031T150000Z");
    expect(whenLines({ local: "2026-11-02T09:00", tz: "America/Denver" }, null).lines[0]).toBe("DTSTART:20261102T160000Z");
    expect(whenLines({ local: "2026-10-24T09:00", tz: "Europe/Berlin" }, null).lines[0]).toBe("DTSTART:20261024T070000Z");
    expect(whenLines({ local: "2026-10-26T09:00", tz: "Europe/Berlin" }, null).lines[0]).toBe("DTSTART:20261026T080000Z");
    // A wall time skipped in spring lands an hour on.
    expect(zonedMs("2027-03-14T02:30", "America/Denver")).toBe(Date.parse("2027-03-14T09:30:00Z"));
    // One that happens twice in autumn is the first.
    expect(zonedMs("2026-11-01T01:30", "America/Denver")).toBe(Date.parse("2026-11-01T07:30:00Z"));
  });

  it("writes all-day, multi-day and timed ends", () => {
    expect(whenLines({ date: "2026-12-24" }, null).lines).toEqual(["DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261225"]);
    // Across a month end, last day included.
    expect(whenLines({ date: "2026-12-30" }, { date: "2027-01-02" }).lines).toEqual([
      "DTSTART;VALUE=DATE:20261230",
      "DTEND;VALUE=DATE:20270103",
    ]);
    // A timed end in another zone; an end before the start falls back to an hour.
    expect(
      whenLines({ local: "2026-12-01T18:00", tz: "America/Denver" }, { local: "2026-12-01T21:00", tz: "America/New_York" }).lines,
    ).toEqual(["DTSTART:20261202T010000Z", "DTEND:20261202T020000Z"]);
    expect(whenLines({ local: "2026-12-01T18:00", tz: "UTC" }, { local: "2026-12-01T17:00", tz: "UTC" }).lines[1]).toBe(
      "DTEND:20261201T190000Z",
    );
  });

  it("matches a fixed file exactly", () => {
    const file = calendarFile(
      [
        ev("b1", { title: "Dinner, then games; bring pie", start: { local: "2026-11-27T18:00", tz: "America/Denver" }, place: "Mom's", note: "Line one\nLine two" }, 2),
        ev("a1", { title: "Thanksgiving", start: { date: "2026-11-26" }, end: { date: "2026-11-28" } }),
        ev("c1", { title: "Gone", start: { date: "2026-12-01" }, removed: true }),
        ev("d1", { title: "Long ago", start: { date: "2025-01-01" } }),
        ev("e1", { start: { date: "2026-12-01" } }),
      ],
      "Herbst family",
      now,
    );
    expect(file.body).toBe(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//bothy//calendar//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:Herbst family",
        "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
        "X-PUBLISHED-TTL:PT1H",
        "BEGIN:VEVENT",
        "UID:a1@dms",
        "DTSTAMP:20260921T141320Z",
        "LAST-MODIFIED:20260921T141320Z",
        "SEQUENCE:0",
        "DTSTART;VALUE=DATE:20261126",
        "DTEND;VALUE=DATE:20261129",
        "SUMMARY:Thanksgiving",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:b1@dms",
        "DTSTAMP:20260921T141320Z",
        "LAST-MODIFIED:20260921T141320Z",
        "SEQUENCE:2",
        "DTSTART:20261128T010000Z",
        "DTEND:20261128T020000Z",
        "SUMMARY:Dinner\\, then games\\; bring pie",
        "LOCATION:Mom's",
        "DESCRIPTION:Line one\\nLine two",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
    );
  });

  it("merges field by field and keeps an edit over an older removal", () => {
    const inc = parseIncoming({ d: "ab", set: { title: "A", removed: true }, at: { title: 5, removed: 5 } })!;
    let m = merge({}, {}, inc);
    expect(isRemoved(m.fields, m.stamps)).toBe(true);
    m = merge(m.fields, m.stamps, parseIncoming({ d: "ab", set: { title: "B" }, at: { title: 6 } })!);
    expect(m.fields.title).toBe("B");
    expect(isRemoved(m.fields, m.stamps)).toBe(false);
    // An equal stamp keeps what is stored.
    const same = merge(m.fields, m.stamps, parseIncoming({ d: "ab", set: { title: "C" }, at: { title: 6 } })!);
    expect(same.fields.title).toBe("B");
    expect(same.changed).toBe(false);
  });
});
