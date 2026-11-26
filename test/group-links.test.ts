// A group's join link that also lets people new to the home in
// (home-groups.ts homeLinkFor, nip86.ts redeeminvite): one link pasted
// into a family text thread, and everyone who taps it ends up in the home
// and the group with nobody approving each person.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { GROUP_CHANGE_KIND, GROUP_LINK_MAX_SECONDS, LINK_REFUSAL } from "../src/home-groups";
import { INVITES_PER_MEMBER_DEFAULT } from "../src/limits";
import { REDEEM_REFUSAL_MESSAGE } from "../src/nip86";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const owner: Keypair = { secretKeyHex: OWNER_SECRET_KEY_HEX, pubkeyHex: OWNER_PUBKEY_HEX };
const mutableEnv = env as unknown as Record<string, unknown>;

afterEach(() => {
  delete mutableEnv.INVITES_PER_MEMBER;
});

let nextIp = 0;
function as(who: Keypair, method: string, params: unknown[] = []) {
  nextIp++;
  return callManagement(method, params, {
    secretKeyHex: who.secretKeyHex,
    ip: `172.31.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`,
  });
}

let gidCounter = 0;
const now = () => Math.floor(Date.now() / 1000);

function change(who: Keypair, gid: string, version: number, op: string, tags: string[][] = []) {
  return signEvent(who.secretKeyHex, {
    kind: GROUP_CHANGE_KIND,
    tags: [["h", gid], ["v", String(version)], ["op", op], ...tags],
    content: "",
  });
}

async function memberFromOwner(): Promise<Keypair> {
  const code = ((await callManagement("createinvite")).result as { code: string }).code;
  const who = randomKeypair();
  expect((await as(who, "redeeminvite", [code])).result).toBe(true);
  return who;
}

async function group(creator: Keypair): Promise<string> {
  gidCounter++;
  const gid = gidCounter.toString(16).padStart(32, "b");
  const reply = await as(creator, "groupcreate", [
    gid,
    change(creator, gid, 0, "create"),
    { epoch: 1, keys: [{ to: creator.pubkeyHex, blob: "sealed" }] },
  ]);
  expect(reply.error).toBeUndefined();
  return gid;
}

async function version(who: Keypair, gid: string): Promise<number> {
  return ((await as(who, "groupinfo", [gid])).result as { version: number }).version;
}

const codeHash = (code: string) => bytesToHex(sha256(new TextEncoder().encode(code)));
function newCode(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

// An admin's link: with `until` it also lets people new to the home in.
async function link(admin: Keypair, gid: string, until: number | null = now() + 7 * 86400): Promise<string> {
  const code = newCode();
  const v = await version(admin, gid);
  const tags = [["code-hash", codeHash(code)], ...(until === null ? [] : [["until", String(until)]])];
  const reply = await as(admin, "groupchange", [gid, v, change(admin, gid, v, "link", tags)]);
  expect(reply.error).toBeUndefined();
  return code;
}

// What a new person's app does with the link: into the home, then the group.
async function tap(code: string, gid: string, who: Keypair = randomKeypair()): Promise<Keypair> {
  expect((await as(who, "redeeminvite", [code])).result).toBe(true);
  const peek = (await as(who, "groupjoin", [gid, code])).result as { version: number };
  const joined = await as(who, "groupjoin", [gid, code, change(who, gid, peek.version, "join", [["code", code]])]);
  expect(joined.result).toMatchObject({ pendingKey: true });
  return who;
}

async function left(who: Keypair): Promise<number | null> {
  return ((await as(who, "myinvites")).result as { left: number | null }).left;
}

describe("a group's join link", () => {
  it("lets several people new to the home into the home and the group, with nobody approving each", async () => {
    const gid = await group(owner);
    const code = await link(owner, gid);
    const ana = await tap(code, gid);
    const ben = await tap(code, gid);
    const roster = ((await as(owner, "groupinfo", [gid])).result as { members: { pubkey: string }[] }).members;
    expect(roster.map((m) => m.pubkey)).toEqual([owner.pubkeyHex, ana.pubkeyHex, ben.pubkeyHex]);
    // In the home, hanging from whoever made the link.
    const { members } = (await callManagement("listmembers")).result as { members: { pubkey: string; invitedBy: string }[] };
    expect(members.find((m) => m.pubkey === ana.pubkeyHex)?.invitedBy).toBe(owner.pubkeyHex);
    expect((await as(ana, "myinvites")).error).toBeUndefined();
  });

  it("spends a plain member's places only for the people it let into the home", async () => {
    const mia = await memberFromOwner();
    const already = await memberFromOwner();
    const gid = await group(mia);
    expect(await left(mia)).toBe(INVITES_PER_MEMBER_DEFAULT);
    const code = await link(mia, gid);
    expect(await left(mia)).toBe(INVITES_PER_MEMBER_DEFAULT);
    const ana = await tap(code, gid);
    await tap(code, gid);
    expect(await left(mia)).toBe(INVITES_PER_MEMBER_DEFAULT - 2);
    // Someone already in the home just joins the group, and spends nothing.
    await tap(code, gid, already);
    expect(await left(mia)).toBe(INVITES_PER_MEMBER_DEFAULT - 2);
    // Turning the link off keeps what it spent; erasing one gives theirs back.
    const v = await version(mia, gid);
    expect((await as(mia, "groupchange", [gid, v, change(mia, gid, v, "unlink", [["code-hash", codeHash(code)]])])).error).toBeUndefined();
    expect(await left(mia)).toBe(INVITES_PER_MEMBER_DEFAULT - 2);
    expect((await as(ana, "eraseme")).error).toBeUndefined();
    expect(await left(mia)).toBe(INVITES_PER_MEMBER_DEFAULT - 1);
  });

  it("stops letting people into the home when its maker has no places left", async () => {
    mutableEnv.INVITES_PER_MEMBER = "1";
    const mia = await memberFromOwner();
    const gid = await group(mia);
    const code = await link(mia, gid);
    await tap(code, gid);
    expect((await as(randomKeypair(), "redeeminvite", [code])).error).toBe(REDEEM_REFUSAL_MESSAGE);
    // People already on DMs elsewhere can still join the group from it.
    const guest = randomKeypair();
    const peek = (await as(guest, "groupjoin", [gid, code])).result as { version: number };
    expect((await as(guest, "groupjoin", [gid, code, change(guest, gid, peek.version, "join", [["code", code]])])).result)
      .toMatchObject({ pendingKey: true });
  });

  it("does not let anyone into the home once turned off or past its time", async () => {
    const gid = await group(owner);
    const off = await link(owner, gid);
    const v = await version(owner, gid);
    await as(owner, "groupchange", [gid, v, change(owner, gid, v, "unlink", [["code-hash", codeHash(off)]])]);
    expect((await as(randomKeypair(), "redeeminvite", [off])).error).toBe(REDEEM_REFUSAL_MESSAGE);

    const lapsed = await link(owner, gid);
    await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) => {
      state.storage.sql.exec(`UPDATE home_group_links SET until = 1 WHERE hash = ?`, codeHash(lapsed));
    });
    expect((await as(randomKeypair(), "redeeminvite", [lapsed])).error).toBe(REDEEM_REFUSAL_MESSAGE);
    expect((await as(randomKeypair(), "groupjoin", [gid, lapsed])).error).toBe(LINK_REFUSAL);
    // An expired link can still be turned off.
    const v2 = await version(owner, gid);
    expect((await as(owner, "groupchange", [gid, v2, change(owner, gid, v2, "unlink", [["code-hash", codeHash(lapsed)]])])).error)
      .toBeUndefined();
  });

  it("lasts at most 30 days", async () => {
    const gid = await group(owner);
    const v = await version(owner, gid);
    const tooLong = change(owner, gid, v, "link", [["code-hash", codeHash(newCode())], ["until", String(now() + GROUP_LINK_MAX_SECONDS + 60)]]);
    expect((await as(owner, "groupchange", [gid, v, tooLong])).error).toBe("groupchange: a link's until tag must be a time within 30 days");
  });

  it("made without an until, admits to the group only, as before", async () => {
    const gid = await group(owner);
    const code = await link(owner, gid, null);
    expect((await as(randomKeypair(), "redeeminvite", [code])).error).toBe(REDEEM_REFUSAL_MESSAGE);
    expect((await as(randomKeypair(), "groupjoin", [gid, code])).result).toMatchObject({ members: 1 });
  });

  it("does not let back in someone cut off from the home", async () => {
    const gid = await group(owner);
    const code = await link(owner, gid);
    const cut = await tap(code, gid);
    expect((await callManagement("unallowpubkey", [cut.pubkeyHex])).error).toBeUndefined();
    expect((await as(cut, "redeeminvite", [code])).error).toBe(REDEEM_REFUSAL_MESSAGE);
  });

  it("is not made by a guest into a way into the home", async () => {
    const gid = await group(owner);
    const code = await link(owner, gid, null);
    const guest = randomKeypair();
    const peek = (await as(guest, "groupjoin", [gid, code])).result as { version: number };
    await as(guest, "groupjoin", [gid, code, change(guest, gid, peek.version, "join", [["code", code]])]);
    const v = await version(owner, gid);
    await as(owner, "groupchange", [gid, v, change(owner, gid, v, "admin", [["p", guest.pubkeyHex]])]);
    const guestCode = await link(guest, gid);
    expect((await as(randomKeypair(), "redeeminvite", [guestCode])).error).toBe(REDEEM_REFUSAL_MESSAGE);
  });
});
