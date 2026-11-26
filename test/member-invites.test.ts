// Members making their own invites (nip86.ts createinvite from a member,
// myinvites): INVITES_PER_MEMBER_DEFAULT people each, three steps from the owner, the owner and
// admins unlimited.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { INVITE_DEPTH_DEFAULT, INVITES_PER_MEMBER_DEFAULT } from "../src/limits";
import {
  inviteDepthMessage,
  INVITES_OFF_MESSAGE,
  invitesUsedUpMessage,
  NOT_A_MEMBER_REASON,
} from "../src/nip86";
import type { Relay } from "../src/relay";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;

afterEach(() => {
  delete mutableEnv.INVITES_PER_MEMBER;
  delete mutableEnv.INVITE_DEPTH;
});

let nextIp = 0;
function as(who: Keypair, method: string, params: unknown[] = []) {
  nextIp++;
  return callManagement(method, params, {
    secretKeyHex: who.secretKeyHex,
    ip: `172.29.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`,
  });
}

async function codeFrom(who: Keypair | null, params: unknown[] = []): Promise<string> {
  const reply =
    who === null ? await callManagement("createinvite", params) : await as(who, "createinvite", params);
  expect(reply.error).toBeUndefined();
  return (reply.result as { code: string }).code;
}

async function joinWith(code: string): Promise<Keypair> {
  const who = randomKeypair();
  expect((await as(who, "redeeminvite", [code])).result).toBe(true);
  return who;
}

// owner -> a (1) -> b (2) -> c (3)
async function chain() {
  const a = await joinWith(await codeFrom(null));
  const b = await joinWith(await codeFrom(a));
  const c = await joinWith(await codeFrom(b));
  return { a, b, c };
}

async function myinvites(who: Keypair) {
  return (await as(who, "myinvites")).result as {
    left: number | null;
    limit: number | null;
    depth: number;
    canInvite: boolean;
    reason?: string;
  };
}

describe("a member's allowance", () => {
  it(`is ${INVITES_PER_MEMBER_DEFAULT} people, counted whether the code was used or not`, async () => {
    const { a } = await chain();
    // a has spent one slot on b already.
    const n = INVITES_PER_MEMBER_DEFAULT;
    expect(await myinvites(a)).toEqual({ left: n - 1, limit: n, depth: 1, canInvite: true });
    for (let i = 0; i < n - 1; i++) await codeFrom(a);
    expect(await myinvites(a)).toEqual({
      left: 0,
      limit: n,
      depth: 1,
      canInvite: false,
      reason: invitesUsedUpMessage(n),
    });
    expect((await as(a, "createinvite")).error).toBe(`createinvite: you have used all ${n} of your invites`);
  });

  it("gets a slot back for a revoked code, but not for a used one", async () => {
    const { a } = await chain();
    const spare = await codeFrom(a);
    expect((await myinvites(a)).left).toBe(INVITES_PER_MEMBER_DEFAULT - 2);
    expect((await as(a, "revokeinvite", [spare])).result).toBe(true);
    expect((await myinvites(a)).left).toBe(INVITES_PER_MEMBER_DEFAULT - 1);
  });

  it("gets a slot back when an unused code expires", async () => {
    const { a } = await chain();
    const lapsed = await codeFrom(a);
    await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) => {
      state.storage.sql.exec(`UPDATE member_invites SET expires_at = 1 WHERE code = ?`, lapsed);
    });
    expect((await myinvites(a)).left).toBe(INVITES_PER_MEMBER_DEFAULT - 1);
  });

  it("counts every person a code may admit, and says how many are left", async () => {
    const a = await joinWith(await codeFrom(null));
    await codeFrom(a, [3]);
    const left = INVITES_PER_MEMBER_DEFAULT - 3;
    expect((await myinvites(a)).left).toBe(left);
    expect((await as(a, "createinvite", [left + 1])).error).toBe(
      `createinvite: you have ${left} invites left, so a code can admit at most ${left} people`,
    );
    expect((await as(a, "createinvite", [left])).result).toBeDefined();
  });

  it("is not spent by a join request that came through their link", async () => {
    const a = await joinWith(await codeFrom(null));
    const robin = randomKeypair();
    await as(robin, "requestjoin", [{ name: "Robin", via: a.pubkeyHex }]);
    await callManagement("approvejoin", [robin.pubkeyHex]);
    expect((await myinvites(a)).left).toBe(INVITES_PER_MEMBER_DEFAULT);
    const { members } = (await callManagement("listmembers")).result as {
      members: { pubkey: string; invitedBy: string }[];
    };
    expect(members.find((m) => m.pubkey === robin.pubkeyHex)?.invitedBy).toBe(a.pubkeyHex);
  });
});

describe(`depth ${INVITE_DEPTH_DEFAULT}`, () => {
  it("lets each step invite until the third, and hangs each invitee from its inviter", async () => {
    const { a, b, c } = await chain();
    expect((await myinvites(b)).depth).toBe(2);
    expect(await myinvites(c)).toEqual({
      left: INVITES_PER_MEMBER_DEFAULT,
      limit: INVITES_PER_MEMBER_DEFAULT,
      depth: 3,
      canInvite: false,
      reason: inviteDepthMessage(3),
    });
    expect((await as(c, "createinvite")).error).toBe(
      "createinvite: invites go 3 steps from the owner, and the people you invite would be one step further, so invites stop here",
    );
    const { members } = (await callManagement("listmembers")).result as {
      members: { pubkey: string; invitedBy: string }[];
    };
    const parent = (who: Keypair) => members.find((m) => m.pubkey === who.pubkeyHex)?.invitedBy;
    expect([parent(a), parent(b), parent(c)]).toEqual([OWNER_PUBKEY_HEX, a.pubkeyHex, b.pubkeyHex]);
  });

  it("moves up when an inviter is removed and their invitees kept", async () => {
    const { a, c } = await chain();
    await callManagement("unallowpubkey", [a.pubkeyHex]);
    // b now hangs from the owner, so c is two steps away and may invite.
    expect(await myinvites(c)).toEqual({ left: INVITES_PER_MEMBER_DEFAULT, limit: INVITES_PER_MEMBER_DEFAULT, depth: 2, canInvite: true });
  });
});

describe("a member's own codes", () => {
  it("are all a member sees and all a member can revoke", async () => {
    const a = await joinWith(await codeFrom(null));
    const b = await joinWith(await codeFrom(null));
    const aCode = await codeFrom(a);
    const bCode = await codeFrom(b);
    const ownerCode = await codeFrom(null);

    const seen = ((await as(a, "listunusedinvites")).result as { code: string }[]).map((i) => i.code);
    expect(seen).toEqual([aCode]);
    const all = ((await callManagement("listunusedinvites")).result as { code: string }[]).map((i) => i.code);
    expect(all.sort()).toEqual([aCode, bCode, ownerCode].sort());

    for (const code of [bCode, ownerCode, "nonsense"]) {
      expect((await as(a, "revokeinvite", [code])).error).toBe(
        "revokeinvite: you have no invite with that code",
      );
    }
    expect((await as(a, "revokeinvite", [aCode])).result).toBe(true);
  });
});

describe("the owner and admins", () => {
  it("are unlimited", async () => {
    expect((await callManagement("myinvites")).result).toEqual({
      left: null,
      limit: null,
      depth: 0,
      canInvite: true,
    });
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    expect(await myinvites(admin)).toEqual({ left: null, limit: null, depth: 1, canInvite: true });
    for (let i = 0; i < 7; i++) await codeFrom(admin);
  });

  it("are the only ones who can invite with INVITES_PER_MEMBER=off", async () => {
    const a = await joinWith(await codeFrom(null));
    mutableEnv.INVITES_PER_MEMBER = "off";
    expect((await as(a, "createinvite")).error).toBe(INVITES_OFF_MESSAGE);
    expect((await myinvites(a)).canInvite).toBe(false);
    await codeFrom(null);
  });

  it("set the limits with INVITES_PER_MEMBER and INVITE_DEPTH", async () => {
    mutableEnv.INVITES_PER_MEMBER = "2";
    mutableEnv.INVITE_DEPTH = "2";
    const a = await joinWith(await codeFrom(null));
    const b = await joinWith(await codeFrom(a));
    expect((await myinvites(a)).left).toBe(1);
    expect(await myinvites(b)).toEqual({
      left: 2,
      limit: 2,
      depth: 2,
      canInvite: false,
      reason: inviteDepthMessage(2),
    });
  });
});

describe("myinvites", () => {
  it("is refused to somebody who is not a member", async () => {
    const reply = await as(randomKeypair(), "myinvites");
    expect([reply.status, reply.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });
});
