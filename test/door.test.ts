// The Fridge door (src/door.ts): every item on a home group's door kept
// here as the only copy (events, birthdays, notes, and kinds later apps
// add), read back with doorlist, announced to open apps and phones, and
// served to each person's calendar link.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GROUP_CHANGE_KIND, GROUP_MESSAGE_KIND } from "../src/home-groups";
import {
  birthdayLines,
  calendarFile,
  changeMatters,
  cleanSet,
  DOOR_NOTICE_KIND,
  isRemoved,
  merge,
  parseIncoming,
  whenLines,
  zonedMs,
  type DoorItem,
  type LinkItem,
} from "../src/door";
import { DOOR_ITEMS_PER_CALL } from "../src/limits";
import { forgetSchemaHash, initSchema } from "../src/schema";
import { getRelayPubkey } from "../src/relay-identity";
import { verifySignature } from "../src/validate";
import type { Relay } from "../src/relay";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { randomKeypair, type Keypair } from "./helpers/keys";
import { decryptPush, makeDevice } from "./helpers/push";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const stub = () => env.RELAY.get(env.RELAY.idFromName("relay"));

let gidCounter = 0;
function newGid(): string {
  gidCounter++;
  return gidCounter.toString(16).padStart(32, "c");
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.31.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
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
const D4 = "d".repeat(32);

function put(who: Keypair, gid: string, items: unknown[]) {
  return callManagement("doorput", [gid, items], as(who));
}

type Listed = { seq: number; items: (DoorItem & Record<string, unknown>)[] };

async function list(who: Keypair, gid: string, since = 0): Promise<Listed> {
  const r = await callManagement("doorlist", [gid, since], as(who));
  expect(r.error).toBeUndefined();
  return r.result as Listed;
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

function sql<T>(fn: (sql: SqlStorage) => T): Promise<T> {
  return runInDurableObject(stub(), (_: Relay, state) => fn(state.storage.sql));
}

// Far enough ahead that "already over" never applies.
const hike = {
  d: D1,
  kind: "event",
  set: { title: "Hike at Mill Creek", start: { local: "2030-11-29T09:00", tz: "America/Denver" }, place: "Mill Creek" },
  at: { title: 10, start: 10, place: 10 },
};

describe("the door's items", () => {
  it("are advertised on NIP-11", async () => {
    const reply = await exports.default.fetch(new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }));
    const doc = (await reply.json()) as { calendar?: unknown; door?: unknown };
    expect(doc.calendar).toEqual({ v: 1 });
    expect(doc.door).toEqual({ v: 1 });
  });

  it("are written and read only by people in the group", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    const stranger = await newMember();
    expect((await put(stranger, gid, [hike])).error).toBe("doorput: you are not in this group");
    expect((await callManagement("doorlist", [gid, 0], as(stranger))).error).toBe("doorlist: you are not in this group");
    expect((await callManagement("doorcount", [gid], as(stranger))).error).toBe("doorcount: you are not in this group");
    expect((await put(ben, gid, [hike])).result).toEqual({ seq: 1, refused: 0 });
    expect((await callManagement("doorcount", [gid], as(ana))).result).toEqual({ events: 1 });
    const { seq, items } = await list(ana, gid);
    expect(seq).toBe(1);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      d: D1,
      kind: "event",
      fields: hike.set,
      stamps: hike.at,
      seq: 1,
      updatedAt: expect.any(Number),
      updatedBy: ben.pubkeyHex,
      createdBy: ben.pubkeyHex,
      createdAt: expect.any(Number),
    });
  });

  it("stop being readable the moment someone leaves or is removed", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const cy = await newMember();
    const gid = await create(ana, [ben, cy]);
    await put(ana, gid, [hike]);
    expect((await list(ben, gid)).items).toHaveLength(1);
    expect((await callManagement("groupleave", [gid], as(ben))).error).toBeUndefined();
    expect((await callManagement("doorlist", [gid, 0], as(ben))).error).toBe("doorlist: you are not in this group");
    expect((await put(ben, gid, [hike])).error).toBe("doorput: you are not in this group");
    expect((await callManagement("unallowpubkey", [cy.pubkeyHex])).result).toBe(true);
    expect((await callManagement("doorlist", [gid, 0], as(cy))).error).toBe("doorlist: you are not in this group");
  });

  it("refuse a bad item and too many in one call", async () => {
    const ana = await newMember();
    const gid = await create(ana, []);
    const bad = [
      { d: D2, set: { title: "x" }, at: {} },
      { d: D2, kind: "event", set: { start: { local: "tomorrow", tz: "UTC" } }, at: { start: 1 } },
      { d: "NOT-HEX", set: { title: "x" }, at: { title: 1 } },
      { d: D2, kind: "Event!", set: { title: "x" }, at: { title: 1 } },
      { d: D2, kind: "event", set: { link: "javascript:alert(1)" }, at: { link: 1 } },
      { d: D2, kind: "birthday", set: { month: 2, day: 30 }, at: { month: 1, day: 1 } },
      { d: D2, kind: "birthday", set: { who: "ana" }, at: { who: 1 } },
      { d: D2, kind: "note", set: { text: "   " }, at: { text: 1 } },
      { d: D2, kind: "note", set: { removed: "yes" }, at: { removed: 1 } },
      { d: D2, kind: "wish", set: { "bad key": 1 }, at: { "bad key": 1 } },
    ];
    expect((await put(ana, gid, bad)).result).toEqual({ seq: 0, refused: bad.length });
    expect((await list(ana, gid)).items).toEqual([]);
    const many = Array.from({ length: DOOR_ITEMS_PER_CALL + 1 }, () => hike);
    expect((await put(ana, gid, many)).error).toMatch(/at most/);
  });

  it("keep each kind's fields, and unknown kinds and fields exactly as written", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    const wish = { d: D4, kind: "wish", set: { what: { item: "Lego", sizes: [1, 2] }, title: 7, removed: false }, at: { what: 1, title: 1, removed: 1 } };
    const r = await put(ana, gid, [
      { ...hike, set: { ...hike.set, link: "https://example.com/stream?game=1", note: "  bring snacks  ", zoom: "x" }, at: { ...hike.at, link: 10, note: 10, zoom: 10 } },
      { d: D2, kind: "birthday", set: { who: ben.pubkeyHex, name: null, month: 2, day: 29, year: null }, at: { who: 1, name: 1, month: 1, day: 1, year: 1 } },
      { d: D3, kind: "note", set: { text: "Dentist moved to Friday", constructor: "fine" }, at: { text: 3, constructor: 3 } },
      wish,
    ]);
    expect(r.result).toEqual({ seq: 4, refused: 0 });
    const byD = Object.fromEntries((await list(ben, gid)).items.map((i) => [i.d, i]));
    expect(byD[D1]!.fields).toEqual({ ...hike.set, link: "https://example.com/stream?game=1", note: "bring snacks", zoom: "x" });
    expect(byD[D2]!.kind).toBe("birthday");
    expect(byD[D2]!.fields).toEqual({ who: ben.pubkeyHex, name: null, month: 2, day: 29, year: null });
    expect(byD[D3]!.fields).toEqual({ text: "Dentist moved to Friday", constructor: "fine" });
    expect(byD[D4]!.kind).toBe("wish");
    expect(byD[D4]!.fields).toEqual(wish.set);
    expect(byD[D4]!.stamps).toEqual(wish.at);
    // Kind is fixed at the first write: naming another is refused, leaving it out is fine.
    expect((await put(ben, gid, [{ d: D3, kind: "event", set: { text: "x" }, at: { text: 9 } }])).result).toEqual({ seq: 4, refused: 1 });
    expect((await put(ben, gid, [{ d: D3, set: { text: "Dentist on Friday at 3" }, at: { text: 9 } }])).result).toEqual({ seq: 5, refused: 0 });
    // No kind on a first write is an event.
    await put(ben, gid, [{ d: "e1", set: { title: "Old style" }, at: { title: 1 } }]);
    expect((await list(ben, gid, 5)).items.map((i) => [i.d, i.kind])).toEqual([["e1", "event"]]);
  });

  it("merge field by field, raise seq only on a stored change, and list what is new", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    expect((await put(ana, gid, [hike])).result).toEqual({ seq: 1, refused: 0 });
    // A replay changes nothing and keeps the number.
    expect((await put(ben, gid, [hike])).result).toEqual({ seq: 1, refused: 0 });
    // An older stamp loses; a newer one wins.
    await put(ben, gid, [{ d: D1, set: { place: "Somewhere else" }, at: { place: 5 } }]);
    expect((await list(ana, gid)).items[0]!.fields.place).toBe("Mill Creek");
    expect((await put(ben, gid, [{ d: D1, set: { place: "Trailhead lot" }, at: { place: 20 } }])).result).toEqual({ seq: 2, refused: 0 });
    expect((await put(ana, gid, [{ d: D2, kind: "note", set: { text: "Hi" }, at: { text: 1 } }])).result).toEqual({ seq: 3, refused: 0 });

    let l = await list(ana, gid, 1);
    expect(l.seq).toBe(3);
    expect(l.items.map((i) => [i.d, i.seq])).toEqual([
      [D1, 2],
      [D2, 3],
    ]);
    expect(l.items[0]!.updatedBy).toBe(ben.pubkeyHex);
    expect(l.items[0]!.createdBy).toBe(ana.pubkeyHex);
    expect((await list(ana, gid, 3)).items).toEqual([]);

    // Removed items come back from doorlist, so readers can drop them.
    await put(ben, gid, [{ d: D1, set: { removed: true }, at: { removed: 30 } }]);
    l = await list(ana, gid, 3);
    expect(l.items.map((i) => i.d)).toEqual([D1]);
    expect(isRemoved(l.items[0]!.fields, l.items[0]!.stamps)).toBe(true);
    // A since above the door's number answers everything.
    expect((await list(ana, gid, 999)).items).toHaveLength(2);
    // Bad since.
    expect((await callManagement("doorlist", [gid, -1], as(ana))).error).toMatch(/^doorlist: /);
  });

  it("go with the group", async () => {
    const ana = await newMember();
    const gid = await create(ana, []);
    await put(ana, gid, [hike]);
    expect((await callManagement("groupleave", [gid], as(ana))).error).toBeUndefined();
    const left = await sql((s) => s.exec(`SELECT COUNT(*) AS n FROM door_events WHERE gid = ?`, gid).one().n);
    expect(left).toBe(0);
  });
});

describe("telling people about a door change", () => {
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

  async function connectAs(who: Keypair): Promise<RelayConn> {
    const conn = await connectRelay(freshIp());
    await authenticate(conn, who);
    return conn;
  }

  it("sends open apps a signed, content-free notice with the door's number", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben]);
    const benConn = await connectAs(ben);
    benConn.send(["REQ", "g", { kinds: [GROUP_MESSAGE_KIND, GROUP_CHANGE_KIND, DOOR_NOTICE_KIND], "#h": [gid] }]);
    expect(await benConn.nextMessage()).toEqual(["EOSE", "g"]);
    // The writer's other device hears it too.
    const anaConn = await connectAs(ana);
    anaConn.send(["REQ", "d", { kinds: [DOOR_NOTICE_KIND], "#h": [gid] }]);
    expect(await anaConn.nextMessage()).toEqual(["EOSE", "d"]);
    // Someone outside the group: refused by name, nothing on a broad filter.
    const carolConn = await connectAs(carol);
    carolConn.send(["REQ", "peek", { kinds: [DOOR_NOTICE_KIND], "#h": [gid] }]);
    expect(await carolConn.nextMessage()).toEqual(["CLOSED", "peek", "restricted: not allowed to read group events"]);
    carolConn.send(["REQ", "broad", { kinds: [DOOR_NOTICE_KIND] }]);
    expect(await carolConn.nextMessage()).toEqual(["EOSE", "broad"]);

    // Any stored change, birthdays included.
    await put(ana, gid, [{ d: D2, kind: "birthday", set: { name: "Grandpa", month: 5, day: 3 }, at: { name: 1, month: 1, day: 1 } }]);
    const [type, sub, notice] = (await benConn.nextMessage()) as [string, string, NostrEvent];
    expect([type, sub]).toEqual(["EVENT", "g"]);
    expect(notice.kind).toBe(DOOR_NOTICE_KIND);
    expect(notice.tags).toEqual([
      ["h", gid],
      ["seq", "1"],
    ]);
    expect(notice.content).toBe("");
    expect(notice.pubkey).toBe(await sql((s) => getRelayPubkey(s)));
    expect(verifySignature(notice)).toBe(true);
    expect(await anaConn.nextMessage()).toEqual(["EVENT", "d", notice]);
    await expect(carolConn.nextMessage(300)).rejects.toThrow(/no message/);
    // A write that stores nothing sends nothing.
    await put(ana, gid, [{ d: D2, set: { name: "Grandpa" }, at: { name: 1 } }]);
    await expect(benConn.nextMessage(300)).rejects.toThrow(/no message/);
    // Nobody else may send one.
    const forged = signEvent(carol.secretKeyHex, { kind: DOOR_NOTICE_KIND, tags: [["h", gid], ["seq", "9"]] });
    expect(await publish(carolConn, forged)).toEqual(["OK", forged.id, false, "invalid: door notices come from the home itself"]);
    for (const c of [anaConn, benConn, carolConn]) c.close();
  });

  describe("with push", () => {
    const mutableEnv = env as unknown as Record<string, unknown>;
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
      mutableEnv.VAPID_PRIVATE_KEY = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      delete mutableEnv.VAPID_PRIVATE_KEY;
    });

    const queued = () => sql((s) => s.exec<{ pubkey: string }>(`SELECT pubkey FROM door_push ORDER BY pubkey`).toArray().map((r) => r.pubkey));
    const clear = () => sql((s) => s.exec(`DELETE FROM door_push`));

    it("wakes the other members' phones for a change that matters, once per burst, and not for the rest", async () => {
      const ana = await newMember();
      const ben = await newMember();
      const cy = await newMember();
      const gid = await create(ana, [ben, cy]);
      const benPhone = await makeDevice("https://push.example/ben");
      const anaPhone = await makeDevice("https://push.example/ana");
      expect((await callManagement("subscribepush", [{ endpoint: benPhone.endpoint, keys: benPhone.keys }], as(ben))).result).toBe(true);
      expect((await callManagement("subscribepush", [{ endpoint: anaPhone.endpoint, keys: anaPhone.keys }], as(ana))).result).toBe(true);

      // A new event: Ben (Cy has no phone registered), not Ana who wrote it.
      await put(ana, gid, [hike]);
      // A second change before the alarm folds into the same push.
      await put(ana, gid, [{ d: D3, kind: "note", set: { text: "Bring boots" }, at: { text: 1 } }]);
      expect(await queued()).toEqual([ben.pubkeyHex]);
      await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
      expect(captured.map((c) => c.url)).toEqual([benPhone.endpoint]);
      expect(JSON.parse(await decryptPush(benPhone, captured[0]!.body))).toEqual({ room: expect.any(String), kind: "door" });
      expect(await queued()).toEqual([]);

      // Not: a title edit, a birthday, a kind this home does not know.
      await put(ben, gid, [
        { d: D1, set: { title: "Hike at Mill Creek (easy)" }, at: { title: 11 } },
        { d: D2, kind: "birthday", set: { name: "Grandpa", month: 5, day: 3 }, at: { name: 1, month: 1, day: 1 } },
        { d: D4, kind: "wish", set: { what: "Lego" }, at: { what: 1 } },
      ]);
      expect(await queued()).toEqual([]);
      // The place moving does; the writer is left out.
      await put(ben, gid, [{ d: D1, set: { place: "Trailhead lot" }, at: { place: 12 } }]);
      expect(await queued()).toEqual([ana.pubkeyHex]);
      await clear();
      // Removed does.
      await put(cy, gid, [{ d: D1, set: { removed: true }, at: { removed: 50 } }]);
      expect(await queued()).toEqual([ana.pubkeyHex, ben.pubkeyHex].sort());
      await clear();
      // An event already over is no news (an app bringing old events over).
      await put(ana, gid, [{ d: "e9", kind: "event", set: { title: "Last year", start: { date: "2020-01-01" } }, at: { title: 1, start: 1 } }]);
      expect(await queued()).toEqual([]);
    });

    it("skips a phone whose app is listening for the notice, and pushes one that only keeps chats live", async () => {
      const ana = await newMember();
      const ben = await newMember();
      const gid = await create(ana, [ben]);
      const benPhone = await makeDevice("https://push.example/ben-live");
      await callManagement("subscribepush", [{ endpoint: benPhone.endpoint, keys: benPhone.keys }], as(ben));
      const benConn = await connectAs(ben);
      benConn.send(["REQ", "chat", { kinds: [GROUP_MESSAGE_KIND], "#h": [gid] }]);
      expect(await benConn.nextMessage()).toEqual(["EOSE", "chat"]);
      await put(ana, gid, [hike]);
      await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
      expect(captured.map((c) => c.url)).toEqual([benPhone.endpoint]);

      captured = [];
      benConn.send(["REQ", "door", { kinds: [DOOR_NOTICE_KIND], "#h": [gid] }]);
      expect(await benConn.nextMessage()).toEqual(["EOSE", "door"]);
      await put(ana, gid, [{ d: D2, kind: "note", set: { text: "Snow tonight" }, at: { text: 1 } }]);
      expect((await benConn.nextMessage())[0]).toBe("EVENT");
      await runInDurableObject(stub(), (instance: Relay) => instance.alarm());
      expect(captured).toEqual([]);
      expect(await queued()).toEqual([]);
      benConn.close();
    });
  });

  it("decides what matters by the contract", () => {
    const now = Date.parse("2026-11-26T12:00:00Z");
    const ev = (fields: Record<string, unknown>) => ({ fields, stamps: Object.fromEntries(Object.keys(fields).map((k) => [k, 1])) });
    const soon = { title: "Game", start: { date: "2026-12-01" }, place: "Gym" };
    const past = { title: "Game", start: { date: "2026-11-01" }, place: "Gym" };
    const m = (kind: string, before: ReturnType<typeof ev> | null, after: ReturnType<typeof ev>, changed: string[]) =>
      changeMatters(kind, before, after, new Set(changed), now);
    expect(m("event", null, ev(soon), ["title", "start", "place"])).toBe(true);
    expect(m("event", null, ev({ title: "No time yet" }), ["title"])).toBe(false);
    expect(m("event", ev({ title: "No time yet" }), ev(soon), ["start"])).toBe(true);
    expect(m("event", null, ev(past), ["title", "start"])).toBe(false);
    expect(m("event", ev(soon), ev({ ...soon, start: { date: "2026-12-02" } }), ["start"])).toBe(true);
    expect(m("event", ev(past), ev({ ...soon }), ["start"])).toBe(true);
    expect(m("event", ev(soon), ev({ ...soon, place: "Park" }), ["place"])).toBe(true);
    expect(m("event", ev(soon), ev({ ...soon, title: "Big game" }), ["title"])).toBe(false);
    expect(m("event", ev(soon), { fields: { ...soon, removed: true }, stamps: { title: 1, start: 1, place: 1, removed: 2 } }, ["removed"])).toBe(true);
    expect(m("note", null, ev({ text: "hi" }), ["text"])).toBe(true);
    expect(m("note", ev({ text: "hi" }), ev({ text: "hello" }), ["text"])).toBe(false);
    expect(m("birthday", null, ev({ name: "Ana", month: 1, day: 2 }), ["name"])).toBe(false);
    expect(m("wish", null, ev({ what: "Lego" }), ["what"])).toBe(false);
  });
});

describe("calendar links", () => {
  it("serve every group's events and birthdays, moved and removed ones included", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const family = await create(ana, [ben]);
    const cousins = await create(ben, []);
    await put(ana, family, [
      hike,
      { d: D2, set: { title: "Thanksgiving", start: { date: "2030-11-26" }, end: { date: "2030-11-28" } }, at: { title: 5, start: 5, end: 5 } },
      { d: "b1", kind: "birthday", set: { name: "Grandpa", month: 5, day: 3, year: 1948 }, at: { name: 1, month: 1, day: 1, year: 1 } },
      { d: "fe1", kind: "note", set: { text: "Not on a calendar" }, at: { text: 1 } },
    ]);
    await put(ben, cousins, [{ d: D3, set: { title: "Game night", start: { local: "2030-12-04T19:00", tz: "America/Denver" }, link: "https://example.com/watch" }, at: { title: 1, start: 1, link: 1 } }]);

    const path = await linkOf(ben);
    expect(path).toMatch(/^\/cal\/[A-Za-z0-9_-]{43}\.ics$/);
    expect(await linkOf(ben)).toBe(path);
    let ics = await calText(path);
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H\r\n");
    expect(ics).toContain("X-PUBLISHED-TTL:PT1H\r\n");
    expect(ics).toContain(`UID:${D1}@dms\r\n`);
    // 9:00 in Denver, after DST ended (UTC-7).
    expect(ics).toContain("DTSTART:20301129T160000Z\r\nDTEND:20301129T170000Z\r\n");
    expect(ics).toContain("DTSTART;VALUE=DATE:20301126\r\nDTEND;VALUE=DATE:20301129\r\n");
    expect(ics).toContain("SUMMARY:Game night\r\nDESCRIPTION:https://example.com/watch\r\nURL:https://example.com/watch\r\n");
    expect(ics).toContain("DTSTART;VALUE=DATE:19480503\r\nDTEND;VALUE=DATE:19480504\r\nRRULE:FREQ=YEARLY\r\nSUMMARY:Grandpa's birthday\r\n");
    expect(ics).not.toContain("Not on a calendar");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(4);
    // Ana sees only her group.
    expect((await calText(await linkOf(ana))).match(/BEGIN:VEVENT/g)).toHaveLength(3);

    // Moved: same UID, SEQUENCE up. A stale write (lower stamp) changes nothing.
    await put(ben, family, [{ d: D1, set: { start: { local: "2030-11-29T15:00", tz: "America/Denver" } }, at: { start: 20 } }]);
    await put(ana, family, [{ d: D1, set: { start: { local: "2030-11-29T08:00", tz: "America/Denver" } }, at: { start: 15 } }]);
    ics = await calText(path);
    expect(ics).toContain("SEQUENCE:5\r\nDTSTART:20301129T220000Z\r\n");
    expect((await list(ana, family)).seq).toBe(5);

    // Removed: gone from the file.
    await put(ana, family, [{ d: D2, set: { removed: true }, at: { removed: 30 } }]);
    ics = await calText(path);
    expect(ics).not.toContain("Thanksgiving");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
  });

  it("name a member's birthday from their profile, only for someone in that group", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const outsider = await newMember();
    const gid = await create(ana, [ben]);
    for (const who of [ben, outsider]) {
      const conn = await connectRelay(freshIp());
      const profile = signEvent(who.secretKeyHex, { kind: 0, content: JSON.stringify({ name: who === ben ? "Ben" : "Secret" }) });
      expect((await publish(conn, profile))[2]).toBe(true);
      conn.close();
    }
    await put(ana, gid, [
      { d: "b1", kind: "birthday", set: { who: ben.pubkeyHex, month: 7, day: 4 }, at: { who: 1, month: 1, day: 1 } },
      { d: "b2", kind: "birthday", set: { who: outsider.pubkeyHex, name: "Someone", month: 8, day: 1 }, at: { who: 1, name: 1, month: 1, day: 1 } },
    ]);
    const ics = await calText(await linkOf(ana));
    expect(ics).toContain("SUMMARY:Ben's birthday\r\n");
    expect(ics).toContain("SUMMARY:Someone's birthday\r\n");
    expect(ics).not.toContain("Secret");
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

  it("drop a group's items from the link when the person leaves it", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    await put(ana, gid, [hike]);
    const path = await linkOf(ben);
    expect(await calText(path)).toContain("Hike at Mill Creek");
    expect((await callManagement("groupleave", [gid], as(ben))).error).toBeUndefined();
    // Still a calendar, now empty, so the phone's copy empties too.
    expect(await calText(path)).not.toContain("BEGIN:VEVENT");
  });

  it("drop a removed member's items", async () => {
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
  const ev = (d: string, fields: Record<string, unknown>, seq = 0, updatedAt = 1_790_000_000, kind = "event"): DoorItem => ({
    d,
    kind,
    fields,
    stamps: Object.fromEntries(Object.keys(fields).map((k) => [k, 1])),
    seq,
    updatedAt,
    updatedBy: "",
    createdBy: "",
    createdAt: updatedAt,
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

  it("writes birthdays as yearly all-day entries, a leap day on February's last day", () => {
    expect(birthdayLines({ month: 3, day: 14 })).toEqual(["DTSTART;VALUE=DATE:20000314", "DTEND;VALUE=DATE:20000315", "RRULE:FREQ=YEARLY"]);
    expect(birthdayLines({ month: 12, day: 31, year: 1990 })).toEqual([
      "DTSTART;VALUE=DATE:19901231",
      "DTEND;VALUE=DATE:19910101",
      "RRULE:FREQ=YEARLY",
    ]);
    expect(birthdayLines({ month: 2, day: 29, year: 1988 })).toEqual([
      "DTSTART;VALUE=DATE:19880229",
      "DTEND;VALUE=DATE:19880301",
      "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1",
    ]);
    // No year, or one that was not a leap year: a leap year to start from.
    expect(birthdayLines({ month: 2, day: 29 })![0]).toBe("DTSTART;VALUE=DATE:20000229");
    expect(birthdayLines({ month: 2, day: 29, year: 1990 })![0]).toBe("DTSTART;VALUE=DATE:20000229");
    expect(birthdayLines({ month: 4, day: 31 })).toBeNull();
    expect(birthdayLines({ month: 4 })).toBeNull();
  });

  it("matches a fixed file exactly", () => {
    const items: (DoorItem | LinkItem)[] = [
      ev("b1", { title: "Dinner, then games; bring pie", start: { local: "2026-11-27T18:00", tz: "America/Denver" }, place: "Mom's", note: "Line one\nLine two" }, 2),
      ev("a1", { title: "Thanksgiving", start: { date: "2026-11-26" }, end: { date: "2026-11-28" } }),
      ev("c1", { title: "Gone", start: { date: "2026-12-01" }, removed: true }),
      ev("d1", { title: "Long ago", start: { date: "2025-01-01" } }),
      ev("e1", { start: { date: "2026-12-01" } }),
      ev("f1", { title: "Stream", start: { date: "2026-12-05" }, note: "Bring a blanket", link: "https://example.com/live" }, 4),
      { ...ev("g1", { who: "ab".repeat(32), name: null, month: 2, day: 29 }, 3, 1_790_000_000, "birthday"), gid: "g" },
      ev("h1", { text: "a note" }, 5, 1_790_000_000, "note"),
    ];
    const file = calendarFile(items, "Herbst family", now, (gid, who) => (gid === "g" && who === "ab".repeat(32) ? "Ana" : null));
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
        "BEGIN:VEVENT",
        "UID:f1@dms",
        "DTSTAMP:20260921T141320Z",
        "LAST-MODIFIED:20260921T141320Z",
        "SEQUENCE:4",
        "DTSTART;VALUE=DATE:20261205",
        "DTEND;VALUE=DATE:20261206",
        "SUMMARY:Stream",
        "DESCRIPTION:Bring a blanket\\n\\nhttps://example.com/live",
        "URL:https://example.com/live",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:g1@dms",
        "DTSTAMP:20260921T141320Z",
        "LAST-MODIFIED:20260921T141320Z",
        "SEQUENCE:3",
        "DTSTART;VALUE=DATE:20000229",
        "DTEND;VALUE=DATE:20000301",
        "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1",
        "SUMMARY:Ana's birthday",
        "TRANSP:TRANSPARENT",
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
    expect(same.changed.size).toBe(0);
    // A field named like an Object method is a field like any other.
    const odd = merge({}, {}, parseIncoming({ d: "ab", set: { toString: 1 }, at: { toString: 1 } })!);
    expect(odd.stamps).toEqual({ toString: 1 });
  });

  it("checks known fields per kind and leaves the rest alone", () => {
    expect(cleanSet("event", { title: "  Hi  ", custom: { a: [1] } })).toEqual({ title: "Hi", custom: { a: [1] } });
    expect(cleanSet("note", { text: "x".repeat(1200) })!.text).toHaveLength(1000);
    expect(cleanSet("note", { title: 5 })).toEqual({ title: 5 });
    expect(cleanSet("birthday", { month: 13 })).toBeNull();
    expect(cleanSet("wish", { removed: 1 })).toBeNull();
  });
});

describe("the door from before kinds (bc4fe83)", () => {
  it("becomes events numbered on the group's counter, with their last writer as creator", async () => {
    const ana = await newMember();
    const gid = await create(ana, []);
    await sql((s) => {
      s.exec(`DROP TABLE door_events`);
      s.exec(
        `CREATE TABLE door_events (gid TEXT NOT NULL, d TEXT NOT NULL, fields TEXT NOT NULL, stamps TEXT NOT NULL,
           seq INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, PRIMARY KEY (gid, d))`,
      );
      // `seq` then counted visible changes per event.
      for (const [d, seq, at] of [
        ["e2", 3, 200],
        ["e1", 0, 100],
      ] as const) {
        s.exec(
          `INSERT INTO door_events VALUES (?, ?, ?, ?, ?, ?, ?)`,
          gid,
          d,
          JSON.stringify({ title: d, start: { date: "2030-01-01" } }),
          JSON.stringify({ title: 1, start: 1 }),
          seq,
          at,
          ana.pubkeyHex,
        );
      }
      forgetSchemaHash(s);
      initSchema(s);
      // A second pass finds nothing left to do.
      forgetSchemaHash(s);
      initSchema(s);
    });
    const l = await list(ana, gid);
    expect(l.seq).toBe(2);
    expect(l.items.map((i) => [i.d, i.kind, i.seq, i.createdBy, i.createdAt])).toEqual([
      ["e1", "event", 1, ana.pubkeyHex, 100],
      ["e2", "event", 2, ana.pubkeyHex, 200],
    ]);
    expect((await put(ana, gid, [{ d: "e1", set: { title: "First" }, at: { title: 2 } }])).result).toEqual({ seq: 3, refused: 0 });
  });
});
