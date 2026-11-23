// Home groups (src/home-groups.ts): the DMs app's groups with a group key.
// Roster as a chain of signed changes, one sealed message per send in the
// home's running order, envelopes per member, guests, removal hooks.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GROUP_CHANGE_KIND, GROUP_DECISIONS, GROUP_MESSAGE_KIND } from "../src/home-groups";
import { verifySignature } from "../src/validate";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { Relay } from "../src/relay";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_SECRET_KEY_HEX, OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { makeDevice } from "./helpers/push";
import { connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const owner: Keypair = { secretKeyHex: OWNER_SECRET_KEY_HEX, pubkeyHex: OWNER_PUBKEY_HEX };

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.30.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

let gidCounter = 0;
function newGid(): string {
  gidCounter++;
  return gidCounter.toString(16).padStart(32, "a");
}

async function newMember(): Promise<Keypair> {
  const member = randomKeypair();
  expect((await callManagement("allowpubkey", [member.pubkeyHex])).result).toBe(true);
  return member;
}

function as(who: Keypair) {
  return { secretKeyHex: who.secretKeyHex };
}

function change(who: Keypair, gid: string, version: number, op: string, targets: string[] = [], content = ""): NostrEvent {
  return signEvent(who.secretKeyHex, {
    kind: GROUP_CHANGE_KIND,
    tags: [["h", gid], ["v", String(version)], ["op", op], ...targets.map((p) => ["p", p])],
    content,
  });
}

function envelopes(epoch: number, people: Keypair[]): { epoch: number; keys: { to: string; blob: string }[] } {
  return { epoch, keys: people.map((p) => ({ to: p.pubkeyHex, blob: `sealed-${epoch}-${p.pubkeyHex.slice(0, 8)}` })) };
}

async function create(creator: Keypair, others: Keypair[], settings: Record<string, unknown> = {}): Promise<string> {
  const gid = newGid();
  const reply = await callManagement(
    "groupcreate",
    [gid, change(creator, gid, 0, "create", others.map((o) => o.pubkeyHex), JSON.stringify(settings)), envelopes(1, [creator, ...others])],
    as(creator),
  );
  expect(reply.error).toBeUndefined();
  expect(reply.result).toMatchObject({ version: 1, epoch: 1 });
  return gid;
}

async function info(who: Keypair, gid: string): Promise<{
  version: number;
  epoch: number;
  needsKey: boolean;
  settings: { onlyAdminsAdd: boolean; history: boolean };
  members: { pubkey: string; role: string; fromSeq: number; pendingKey?: boolean }[];
  chain: { version: number; seq: number; event: NostrEvent }[];
}> {
  const reply = await callManagement("groupinfo", [gid], as(who));
  expect(reply.error).toBeUndefined();
  return reply.result as never;
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

function message(gid: string, epoch = 1, content = "sealed"): NostrEvent {
  return signEvent(randomKeypair().secretKeyHex, {
    kind: GROUP_MESSAGE_KIND,
    tags: [
      ["h", gid],
      ["epoch", String(epoch)],
    ],
    content,
  });
}

async function since(who: Keypair, gid: string, after = 0): Promise<{ seq: number; event: NostrEvent }[]> {
  const reply = await callManagement("groupsince", [gid, after, 500], as(who));
  expect(reply.error).toBeUndefined();
  return reply.result as never;
}

describe("home groups", () => {
  it("are advertised on NIP-11 with no keeper yet", async () => {
    const reply = await exports.default.fetch(
      new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }),
    );
    const doc = (await reply.json()) as { groups?: unknown };
    expect(doc.groups).toEqual({ v: 1, keeper: null });
  });

  it("are created by a home member, with the creator as the only admin", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const guest = randomKeypair();
    const gid = await create(ana, [ben, guest]);
    const roster = await info(ben, gid);
    expect(roster.version).toBe(1);
    expect(roster.epoch).toBe(1);
    expect(roster.settings).toEqual({ onlyAdminsAdd: false, history: true });
    expect(Object.fromEntries(roster.members.map((m) => [m.pubkey, m.role]))).toEqual({
      [ana.pubkeyHex]: "admin",
      [ben.pubkeyHex]: "member",
      [guest.pubkeyHex]: "member",
    });
    expect(roster.chain).toHaveLength(1);
    expect(roster.chain[0]!.event.pubkey).toBe(ana.pubkeyHex);
    // Each gets their own envelope, nobody else's.
    const keys = await callManagement("groupkeys", [gid, 0], as(guest));
    expect(keys.result).toEqual([{ epoch: 1, from: ana.pubkeyHex, blob: `sealed-1-${guest.pubkeyHex.slice(0, 8)}` }]);
    const mine = await callManagement("mygroups", [], as(guest));
    expect(mine.result).toEqual([{ gid, version: 1, epoch: 1, lastSeq: expect.any(Number), role: "member", needsKey: false }]);
  });

  it("refuse a creator from outside the home, a wrong envelope set, and a reused id", async () => {
    const stranger = randomKeypair();
    const gid = newGid();
    const outsider = await callManagement(
      "groupcreate",
      [gid, change(stranger, gid, 0, "create"), envelopes(1, [stranger])],
      as(stranger),
    );
    expect(outsider.status).toBe(401);
    const ana = await newMember();
    const ben = await newMember();
    const missing = await callManagement(
      "groupcreate",
      [gid, change(ana, gid, 0, "create", [ben.pubkeyHex]), envelopes(1, [ana])],
      as(ana),
    );
    expect(missing.error).toBe("groupcreate: envelopes must be epoch 1, one for each person in the group");
    const made = await create(ana, [ben]);
    const again = await callManagement(
      "groupcreate",
      [made, change(ana, made, 0, "create", [ben.pubkeyHex]), envelopes(1, [ana, ben])],
      as(ana),
    );
    expect(again.error).toBe("groupcreate: a group with that id already exists");
  });

  it("carry one sealed message to the roster in the home's order, live and from groupsince", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben]);
    const benConn = await connectAs(ben);
    const carolConn = await connectAs(carol);
    benConn.send(["REQ", "g", { kinds: [GROUP_MESSAGE_KIND, GROUP_CHANGE_KIND], "#h": [gid] }]);
    expect(await benConn.nextMessage()).toEqual(["EOSE", "g"]);
    // Carol is not in it: refused by name, and nothing reaches a broad filter.
    carolConn.send(["REQ", "peek", { kinds: [GROUP_MESSAGE_KIND], "#h": [gid] }]);
    expect(await carolConn.nextMessage()).toEqual(["CLOSED", "peek", "restricted: not allowed to read group events"]);
    carolConn.send(["REQ", "broad", { kinds: [GROUP_MESSAGE_KIND] }]);
    expect(await carolConn.nextMessage()).toEqual(["EOSE", "broad"]);

    const anaConn = await connectAs(ana);
    const sent = [message(gid, 1, "one"), message(gid, 1, "two"), message(gid, 1, "three")];
    for (const event of sent) expect(await publish(anaConn, event)).toEqual(["OK", event.id, true, ""]);
    for (const event of sent) expect(await benConn.nextMessage()).toEqual(["EVENT", "g", event]);
    await expect(carolConn.nextMessage(300)).rejects.toThrow(/no message/);

    const rows = await since(ben, gid);
    expect(rows.map((r) => r.event.kind)).toEqual([GROUP_CHANGE_KIND, GROUP_MESSAGE_KIND, GROUP_MESSAGE_KIND, GROUP_MESSAGE_KIND]);
    expect(rows.slice(1).map((r) => r.event.id)).toEqual(sent.map((e) => e.id));
    const seqs = rows.map((r) => r.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(new Set(seqs).size).toBe(seqs.length);
    // A duplicate is acknowledged, not stored twice.
    expect((await publish(anaConn, sent[0]!))[3]).toMatch(/^duplicate:/);
    // Never in `events`, so no public read can find one.
    const stored = await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) =>
      state.storage.sql.exec(`SELECT id FROM events WHERE id = ?`, sent[0]!.id).toArray(),
    );
    expect(stored).toEqual([]);
    expect((await callManagement("groupsince", [gid, 0, 10], as(carol))).error).toBe("groupsince: you are not in this group");
    for (const conn of [anaConn, benConn, carolConn]) conn.close();
  });

  it("refuse a message from outside the roster, unauthenticated, or under a key the group does not have", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben]);
    const anonymous = await connectAs(null);
    const a = message(gid);
    anonymous.send(["EVENT", a]);
    expect((await anonymous.nextMessage())[0]).toBe("AUTH");
    expect((await anonymous.nextMessage())[3]).toBe(
      "auth-required: group messages are for the group's members; authenticate first",
    );
    const carolConn = await connectAs(carol);
    const b = message(gid);
    expect(await publish(carolConn, b)).toEqual(["OK", b.id, false, "restricted: you are not in this group"]);
    const anaConn = await connectAs(ana);
    const c = message(gid, 2);
    expect((await publish(anaConn, c))[3]).toBe("invalid: that key is newer than the group's; fetch the group again");
    for (const conn of [anonymous, carolConn, anaConn]) conn.close();
  });

  it("apply changes in order: a stale version gets the current one back", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const dev = await newMember();
    const gid = await create(ana, [ben, carol, dev]);
    // Ana makes Ben an admin.
    expect((await callManagement("groupchange", [gid, 1, change(ana, gid, 1, "admin", [ben.pubkeyHex])], as(ana))).result)
      .toMatchObject({ version: 2, epoch: 1 });
    // Ana removes Carol with a new key; Ben, built on version 2 too, loses the race.
    const removeCarol = await callManagement(
      "groupchange",
      [gid, 2, change(ana, gid, 2, "remove", [carol.pubkeyHex]), envelopes(2, [ana, ben, dev])],
      as(ana),
    );
    expect(removeCarol.result).toMatchObject({ version: 3, epoch: 2, needsKey: false });
    const stale = await callManagement(
      "groupchange",
      [gid, 2, change(ben, gid, 2, "remove", [dev.pubkeyHex]), envelopes(3, [ana, ben])],
      as(ben),
    );
    expect(stale.error).toBe("groupchange: the group changed while you were changing it");
    expect((stale as { version?: number }).version).toBe(3);
    // Rebuilt on 3, it lands.
    const retry = await callManagement(
      "groupchange",
      [gid, 3, change(ben, gid, 3, "remove", [dev.pubkeyHex]), envelopes(3, [ana, ben])],
      as(ben),
    );
    expect(retry.result).toMatchObject({ version: 4, epoch: 3 });
    // Making Carol an admin now finds her gone.
    const late = await callManagement("groupchange", [gid, 4, change(ana, gid, 4, "admin", [carol.pubkeyHex])], as(ana));
    expect(late.error).toBe("groupchange: someone you are making an admin is no longer in the group");
    const roster = await info(ana, gid);
    expect(roster.chain.map((c) => c.version)).toEqual([1, 2, 3, 4]);
    expect(roster.members.map((m) => m.pubkey).sort()).toEqual([ana.pubkeyHex, ben.pubkeyHex].sort());
    // Carol is told who removed her, and reads nothing new.
    const carolGroups = await callManagement("mygroups", [], as(carol));
    expect(carolGroups.result).toEqual([{ gid, removed: { by: ana.pubkeyHex, op: "remove", version: 3, at: expect.any(Number) } }]);
    expect((await callManagement("groupkeys", [gid, 0], as(carol))).error).toBe("groupkeys: you are not in this group");
  });

  it("send the change that removes someone to their own open socket", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben, carol]);
    const carolConn = await connectAs(carol);
    carolConn.send(["REQ", "g", { kinds: [GROUP_MESSAGE_KIND, GROUP_CHANGE_KIND], "#h": [gid] }]);
    expect(await carolConn.nextMessage()).toEqual(["EOSE", "g"]);
    const remove = change(ana, gid, 1, "remove", [carol.pubkeyHex]);
    expect((await callManagement("groupchange", [gid, 1, remove, envelopes(2, [ana, ben])], as(ana))).result).toMatchObject({ version: 2 });
    expect(await carolConn.nextMessage()).toEqual(["EVENT", "g", remove]);
    // Out now: the next message does not reach her.
    const anaConn = await connectAs(ana);
    expect((await publish(anaConn, message(gid, 2, "after")))[2]).toBe(true);
    await expect(carolConn.nextMessage(300)).rejects.toThrow(/no message/);
    for (const c of [carolConn, anaConn]) c.close();
  });

  it("enforce who may do what, and the settings", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben]);
    // Any member adds people (Messenger), with a new key here.
    const add = await callManagement(
      "groupchange",
      [gid, 1, change(ben, gid, 1, "add", [carol.pubkeyHex]), envelopes(2, [ana, ben, carol])],
      as(ben),
    );
    expect(add.result).toMatchObject({ version: 2, epoch: 2 });
    // Only admins remove, make admins, change settings.
    expect((await callManagement("groupchange", [gid, 2, change(ben, gid, 2, "remove", [carol.pubkeyHex])], as(ben))).error)
      .toBe("groupchange: only admins can remove people");
    expect((await callManagement("groupchange", [gid, 2, change(ben, gid, 2, "settings", [], '{"onlyAdminsAdd":true}')], as(ben))).error)
      .toBe("groupchange: only admins can change the group's settings");
    expect(
      (await callManagement("groupchange", [gid, 2, change(ana, gid, 2, "settings", [], '{"onlyAdminsAdd":true,"history":false}')], as(ana)))
        .result,
    ).toMatchObject({ version: 3 });
    const dev = await newMember();
    expect(
      (await callManagement("groupchange", [gid, 3, change(ben, gid, 3, "add", [dev.pubkeyHex]), envelopes(4, [ana, ben, carol, dev])], as(ben)))
        .error,
    ).toBe("groupchange: only admins can add people to this group");
    // With the switch off, an add must change the key.
    expect(
      (await callManagement("groupchange", [gid, 3, change(ana, gid, 3, "add", [dev.pubkeyHex]), envelopes(2, [dev])], as(ana))).error,
    ).toBe("groupchange: envelopes must be for epoch 3");
    // The last admin cannot step down.
    expect((await callManagement("groupchange", [gid, 3, change(ana, gid, 3, "unadmin", [ana.pubkeyHex])], as(ana))).error)
      .toBe("groupchange: a group needs at least one admin");
    // A change signed by someone else, or for another version tag, is refused.
    expect((await callManagement("groupchange", [gid, 3, change(ben, gid, 3, "key"), envelopes(3, [ana, ben, carol])], as(ana))).error)
      .toBe("groupchange: the change must be signed by you");
  });

  it("start a new member from the change that added them", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben]);
    const anaConn = await connectAs(ana);
    const before = message(gid);
    expect((await publish(anaConn, before))[2]).toBe(true);
    await callManagement(
      "groupchange",
      [gid, 1, change(ana, gid, 1, "add", [carol.pubkeyHex]), envelopes(2, [ana, ben, carol])],
      as(ana),
    );
    const after = message(gid, 2);
    expect((await publish(anaConn, after))[2]).toBe(true);
    const rows = await since(carol, gid);
    expect(rows.map((r) => r.event.id)).not.toContain(before.id);
    expect(rows[0]!.event.kind).toBe(GROUP_CHANGE_KIND);
    expect(rows.map((r) => r.event.id)).toContain(after.id);
    // Ben, there from the start, sees both.
    expect((await since(ben, gid)).map((r) => r.event.id)).toEqual(expect.arrayContaining([before.id, after.id]));
    anaConn.close();
  });

  it("leave for real: needsKey, the last admin's place goes to the longest-standing, the last one out ends it", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben, carol]);
    expect((await callManagement("groupleave", [gid], as(ana))).result).toEqual({ left: true });
    const roster = await info(ben, gid);
    expect(roster.needsKey).toBe(true);
    const tail = roster.chain.slice(-2).map((c) => c.event);
    expect(tail.map((e) => e.tags.find((t) => t[0] === "op")?.[1])).toEqual(["leave", "admin"]);
    for (const e of tail) expect(verifySignature(e as never)).toBe(true);
    expect(roster.members.find((m) => m.role === "admin")?.pubkey).toBe([ben.pubkeyHex, carol.pubkeyHex].sort()[0]);
    // A key change by any member clears needsKey.
    const keyed = await callManagement(
      "groupchange",
      [gid, roster.version, change(carol, gid, roster.version, "key"), envelopes(2, [ben, carol])],
      as(carol),
    );
    expect(keyed.result).toMatchObject({ epoch: 2, needsKey: false });
    await callManagement("groupleave", [gid], as(ben));
    await callManagement("groupleave", [gid], as(carol));
    const left = await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) =>
      state.storage.sql.exec(`SELECT COUNT(*) AS n FROM home_group_events WHERE gid = ?`, gid).toArray(),
    );
    expect(left).toEqual([{ n: 0 }]);
  });

  it("take out someone cut off from the home, and refuse adding them back", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const carol = await newMember();
    const gid = await create(ana, [ben, carol]);
    expect((await callManagement("unallowpubkey", [carol.pubkeyHex])).result).toBe(true);
    const roster = await info(ana, gid);
    expect(roster.members.map((m) => m.pubkey)).not.toContain(carol.pubkeyHex);
    expect(roster.needsKey).toBe(true);
    const removal = roster.chain.at(-1)!.event;
    expect(removal.tags).toContainEqual(["reason", "cutoff"]);
    const back = await callManagement(
      "groupchange",
      [gid, roster.version, change(ana, gid, roster.version, "add", [carol.pubkeyHex]), envelopes(2, [ana, ben, carol])],
      as(ana),
    );
    expect(back.error).toBe("groupchange: that person was cut off from this home and cannot be added");
  });

  it("take out someone who erases their account, keeping what they said", async () => {
    const ana = await newMember();
    const ben = await newMember();
    const gid = await create(ana, [ben]);
    const benConn = await connectAs(ben);
    const said = message(gid);
    expect((await publish(benConn, said))[2]).toBe(true);
    benConn.close();
    expect((await callManagement("eraseme", [], as(ben))).result).toMatchObject({ erased: true });
    const roster = await info(ana, gid);
    expect(roster.members.map((m) => m.pubkey)).toEqual([ana.pubkeyHex]);
    expect(roster.chain.at(-1)!.event.tags).toContainEqual(["reason", "erased"]);
    expect((await since(ana, gid)).map((r) => r.event.id)).toContain(said.id);
  });

  it(`cap a group at ${GROUP_DECISIONS.maxMembers} people`, async () => {
    const ana = await newMember();
    const guests = Array.from({ length: GROUP_DECISIONS.maxMembers }, () => randomKeypair());
    const gid = newGid();
    const reply = await callManagement(
      "groupcreate",
      [gid, change(ana, gid, 0, "create", guests.map((g) => g.pubkeyHex)), envelopes(1, [ana, ...guests])],
      as(ana),
    );
    expect(reply.error).toBe(`groupcreate: a group can have at most ${GROUP_DECISIONS.maxMembers} people`);
  });

  describe("with push", () => {
    const mutableEnv = env as unknown as Record<string, unknown>;
    beforeEach(() => {
      mutableEnv.VAPID_PRIVATE_KEY = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
    });
    afterEach(() => {
      delete mutableEnv.VAPID_PRIVATE_KEY;
    });

    it("lets a guest register a device and wakes every member but the sender", async () => {
      const ana = await newMember();
      const guest = randomKeypair();
      const device = await makeDevice("https://push.example/guest");
      // Before any group: a stranger.
      const early = await callManagement("subscribepush", [{ endpoint: device.endpoint, keys: device.keys }], as(guest));
      expect(early.status).toBe(401);
      const gid = await create(ana, [guest]);
      const ok = await callManagement("subscribepush", [{ endpoint: device.endpoint, keys: device.keys }], as(guest));
      expect(ok.result).toBe(true);
      const anaConn = await connectAs(ana);
      expect((await publish(anaConn, message(gid)))[2]).toBe(true);
      anaConn.close();
      const queued = await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) =>
        state.storage.sql.exec(`SELECT pubkey FROM inbox_push`).toArray(),
      );
      expect(queued).toEqual([{ pubkey: guest.pubkeyHex }]);
      // Leaving their last group here drops their devices.
      await callManagement("groupleave", [gid], as(guest));
      const devices = await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) =>
        state.storage.sql.exec(`SELECT 1 FROM push_subscriptions WHERE pubkey = ?`, guest.pubkeyHex).toArray(),
      );
      expect(devices).toEqual([]);
    });
  });

  it("let the owner start one too", async () => {
    const ben = await newMember();
    const gid = await create(owner, [ben]);
    expect((await info(ben, gid)).members.find((m) => m.role === "admin")?.pubkey).toBe(OWNER_PUBKEY_HEX);
  });

  describe("with a box keeping the keys", () => {
    const box = randomKeypair();
    beforeEach(async () => {
      expect((await callManagement("setstorage", ["https://box.example", box.pubkeyHex])).result).toBe(true);
    });
    afterEach(async () => {
      await callManagement("setstorage", [""]);
    });

    function keyed(epoch: number, people: Keypair[]) {
      return { epoch, keys: [...people, box].map((p) => ({ to: p.pubkeyHex, blob: `sealed-${epoch}-${p.pubkeyHex.slice(0, 8)}` })) };
    }

    it("wakes the box's own socket for every group's messages and changes, and nobody else's", async () => {
      const ana = await newMember();
      const ben = await newMember();
      const gid = newGid();
      const boxConn = await connectAs(box);
      boxConn.send(["REQ", "keeper", { kinds: [GROUP_MESSAGE_KIND, GROUP_CHANGE_KIND] }]);
      expect(await boxConn.nextMessage()).toEqual(["EOSE", "keeper"]);
      const stranger = randomKeypair();
      const strangerConn = await connectAs(stranger);
      strangerConn.send(["REQ", "peek", { kinds: [GROUP_MESSAGE_KIND, GROUP_CHANGE_KIND] }]);
      expect(await strangerConn.nextMessage()).toEqual(["EOSE", "peek"]);
      const create = change(ana, gid, 0, "create", [ben.pubkeyHex]);
      await callManagement("groupcreate", [gid, create, keyed(1, [ana, ben])], as(ana));
      expect(await boxConn.nextMessage()).toEqual(["EVENT", "keeper", create]);
      const anaConn = await connectAs(ana);
      const m = message(gid);
      expect((await publish(anaConn, m))[2]).toBe(true);
      expect(await boxConn.nextMessage()).toEqual(["EVENT", "keeper", m]);
      await expect(strangerConn.nextMessage(300)).rejects.toThrow(/no message/);
      for (const c of [boxConn, strangerConn, anaConn]) c.close();
    });

    it("names the box as keeper, and every key change must include it", async () => {
      const doc = (await (
        await exports.default.fetch(new Request("https://example.com/", { headers: { Accept: "application/nostr+json" } }))
      ).json()) as { groups?: unknown };
      expect(doc.groups).toEqual({ v: 1, keeper: box.pubkeyHex });
      const ana = await newMember();
      const ben = await newMember();
      const gid = newGid();
      const without = await callManagement(
        "groupcreate",
        [gid, change(ana, gid, 0, "create", [ben.pubkeyHex]), envelopes(1, [ana, ben])],
        as(ana),
      );
      expect(without.error).toBe("groupcreate: envelopes must be epoch 1, one for each person in the group");
      const made = await callManagement("groupcreate", [gid, change(ana, gid, 0, "create", [ben.pubkeyHex]), keyed(1, [ana, ben])], as(ana));
      expect(made.result).toMatchObject({ version: 1, epoch: 1 });
      expect((await callManagement("groupkeys", [gid, 0], as(box))).result).toEqual([
        { epoch: 1, from: ana.pubkeyHex, blob: `sealed-1-${box.pubkeyHex.slice(0, 8)}` },
      ]);
    });

    it("lets new members read everything, and the box seal them the earlier keys", async () => {
      const ana = await newMember();
      const ben = await newMember();
      const carol = await newMember();
      const gid = newGid();
      await callManagement("groupcreate", [gid, change(ana, gid, 0, "create", [ben.pubkeyHex]), keyed(1, [ana, ben])], as(ana));
      const anaConn = await connectAs(ana);
      const early = message(gid);
      expect((await publish(anaConn, early))[2]).toBe(true);
      anaConn.close();
      await callManagement("groupchange", [gid, 1, change(ana, gid, 1, "add", [carol.pubkeyHex]), keyed(2, [ana, ben, carol])], as(ana));
      expect((await since(carol, gid)).map((r) => r.event.id)).toContain(early.id);
      const owed = (await callManagement("keepergroups", [], as(box))).result as { gid: string; owed: { pubkey: string; epochs: number[] }[] }[];
      expect(owed.find((g) => g.gid === gid)?.owed).toEqual([{ pubkey: carol.pubkeyHex, epochs: [1] }]);
      const sealed = await callManagement("groupseal", [gid, [{ to: carol.pubkeyHex, epoch: 1, blob: "from-box" }]], as(box));
      expect(sealed.result).toEqual({ sealed: 1 });
      expect(((await callManagement("groupkeys", [gid, 0], as(carol))).result as { epoch: number; from: string }[]).map((k) => [k.epoch, k.from]))
        .toEqual([[1, box.pubkeyHex], [2, ana.pubkeyHex]]);
      // Only the box asks keepergroups or reports what it kept.
      expect((await callManagement("keepergroups", [], as(ana))).status).toBe(401);
      expect((await callManagement("groupkept", [gid, 5], as(box))).result).toMatchObject({ kept: 5 });
    });

    it("rotates the key after a leave, signed by the box", async () => {
      const ana = await newMember();
      const ben = await newMember();
      const carol = await newMember();
      const gid = newGid();
      await callManagement("groupcreate", [gid, change(ana, gid, 0, "create", [ben.pubkeyHex, carol.pubkeyHex]), keyed(1, [ana, ben, carol])], as(ana));
      await callManagement("groupleave", [gid], as(carol));
      const v = (await info(ana, gid)).version;
      expect((await callManagement("groupchange", [gid, v, change(box, gid, v, "remove", [ben.pubkeyHex])], as(box))).error)
        .toBe("groupchange: the box may only change the key");
      const keyedNow = await callManagement("groupchange", [gid, v, change(box, gid, v, "key"), keyed(2, [ana, ben])], as(box));
      expect(keyedNow.result).toMatchObject({ epoch: 2, needsKey: false });
    });

    it("joins someone from an admin's link, waiting for their key until it is sealed", async () => {
      const ana = await newMember();
      const ben = await newMember();
      const joiner = randomKeypair();
      const gid = newGid();
      await callManagement("groupcreate", [gid, change(ana, gid, 0, "create", [ben.pubkeyHex]), keyed(1, [ana, ben])], as(ana));
      const code = "c0de".repeat(8);
      const hash = bytesToHex(sha256(new TextEncoder().encode(code)));
      expect((await callManagement("groupchange", [gid, 1, signEvent(ben.secretKeyHex, { kind: GROUP_CHANGE_KIND, tags: [["h", gid], ["v", "1"], ["op", "link"], ["code-hash", hash]] })], as(ben))).error)
        .toBe("groupchange: only admins can make or stop join links");
      const link = signEvent(ana.secretKeyHex, { kind: GROUP_CHANGE_KIND, tags: [["h", gid], ["v", "1"], ["op", "link"], ["code-hash", hash]] });
      expect((await callManagement("groupchange", [gid, 1, link], as(ana))).result).toMatchObject({ version: 2 });
      expect((await callManagement("groupjoin", [gid, "f".repeat(32)], as(joiner))).error).toBe("groupjoin: this link cannot be used. Ask whoever sent it for a new one.");
      expect((await callManagement("groupjoin", [gid, code], as(joiner))).result).toEqual({ version: 2, members: 2 });
      const join = signEvent(joiner.secretKeyHex, { kind: GROUP_CHANGE_KIND, tags: [["h", gid], ["v", "2"], ["op", "join"], ["code", code]] });
      expect((await callManagement("groupjoin", [gid, code, join], as(joiner))).result).toMatchObject({ version: 3, pendingKey: true });
      expect((await info(ana, gid)).members.find((m) => m.pubkey === joiner.pubkeyHex)).toMatchObject({ pendingKey: true });
      await callManagement("groupseal", [gid, [{ to: joiner.pubkeyHex, epoch: 1, blob: "for-you" }]], as(box));
      expect((await info(ana, gid)).members.find((m) => m.pubkey === joiner.pubkeyHex)).toMatchObject({ pendingKey: false });
      // Stopping the link stops joins.
      const unlink = signEvent(ana.secretKeyHex, { kind: GROUP_CHANGE_KIND, tags: [["h", gid], ["v", "3"], ["op", "unlink"], ["code-hash", hash]] });
      expect((await callManagement("groupchange", [gid, 3, unlink], as(ana))).result).toMatchObject({ version: 4 });
      expect((await callManagement("groupjoin", [gid, code], as(randomKeypair()))).error).toBe("groupjoin: this link cannot be used. Ask whoever sent it for a new one.");
    });
  });
});
