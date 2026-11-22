// Removal by members (nip86.ts unallowpubkey): "anyone higher on the tree
// can cut off lower invites". A member removes only people below them in
// the invite tree, and "keep" re-hangs the removed person's invitees under
// the member. The owner and admins keep whole-tree authority.
import { describe, expect, it } from "vitest";
import { NOT_A_MEMBER_REASON, REMOVE_OUTSIDE_SUBTREE_MESSAGE, REMOVE_SELF_MESSAGE } from "../src/nip86";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

let nextIp = 0;
function as(who: Keypair, method: string, params: unknown[] = []) {
  nextIp++;
  return callManagement(method, params, {
    secretKeyHex: who.secretKeyHex,
    ip: `172.18.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`,
  });
}

async function codeFrom(who: Keypair | null): Promise<string> {
  const reply = who === null ? await callManagement("createinvite") : await as(who, "createinvite");
  return (reply.result as { code: string }).code;
}

async function joinWith(code: string): Promise<Keypair> {
  const who = randomKeypair();
  expect((await as(who, "redeeminvite", [code])).result).toBe(true);
  return who;
}

async function tree(): Promise<Record<string, string>> {
  const { members } = (await callManagement("listmembers")).result as {
    members: { pubkey: string; invitedBy: string }[];
  };
  return Object.fromEntries(members.map((m) => [m.pubkey, m.invitedBy]));
}

// owner -> a -> b -> c, and owner -> x -> y
async function family() {
  const a = await joinWith(await codeFrom(null));
  const b = await joinWith(await codeFrom(a));
  const c = await joinWith(await codeFrom(b));
  const x = await joinWith(await codeFrom(null));
  const y = await joinWith(await codeFrom(x));
  return { a, b, c, x, y };
}

describe("a member removing someone below them", () => {
  it("removes a direct invitee, keeping theirs under the member", async () => {
    const { a, b, c } = await family();
    const reply = await as(a, "unallowpubkey", [b.pubkeyHex]);
    expect(reply.result).toBe(true);
    expect(reply.error).toBe("The 1 person they invited is still a member, now listed as invited by you.");
    const t = await tree();
    expect(t[b.pubkeyHex]).toBeUndefined();
    expect(t[c.pubkeyHex]).toBe(a.pubkeyHex);
  });

  it("removes someone further down, too", async () => {
    const { a, c } = await family();
    expect((await as(a, "unallowpubkey", [c.pubkeyHex])).result).toBe(true);
    expect((await tree())[c.pubkeyHex]).toBeUndefined();
  });

  it('removes the whole branch with {"invitees": "remove"}', async () => {
    const { a, b, c } = await family();
    const reply = await as(a, "unallowpubkey", [b.pubkeyHex, { invitees: "remove" }]);
    expect(reply.result).toBe(true);
    const t = await tree();
    expect([t[b.pubkeyHex], t[c.pubkeyHex], t[a.pubkeyHex]]).toEqual([
      undefined,
      undefined,
      OWNER_PUBKEY_HEX,
    ]);
  });

  it("drops what removal always drops: membership, and their list entry for storage", async () => {
    const service = randomKeypair();
    await callManagement("setstorage", ["https://storage.example/", service.pubkeyHex]);
    const { a, b } = await family();
    await as(a, "unallowpubkey", [b.pubkeyHex]);
    expect((await as(b, "myinvites")).error).toBe(NOT_A_MEMBER_REASON);
    const { removed } = (await as(service, "memberkeys")).result as {
      removed: { pubkey: string; reason: string }[];
    };
    expect(removed.find((r) => r.pubkey === b.pubkeyHex)?.reason).toBe("removed");
  });
});

describe("what a member cannot remove", () => {
  it("an ancestor, a sibling's invitee, someone in another branch, the owner, or a stranger", async () => {
    const { a, b, c, x, y } = await family();
    for (const target of [
      a.pubkeyHex,
      OWNER_PUBKEY_HEX,
      x.pubkeyHex,
      y.pubkeyHex,
      randomKeypair().pubkeyHex,
    ]) {
      expect((await as(b, "unallowpubkey", [target])).error).toBe(REMOVE_OUTSIDE_SUBTREE_MESSAGE);
    }
    // c is below b, not beside them: c cannot remove b either.
    expect((await as(c, "unallowpubkey", [b.pubkeyHex])).error).toBe(REMOVE_OUTSIDE_SUBTREE_MESSAGE);
    expect((await tree())[a.pubkeyHex]).toBe(OWNER_PUBKEY_HEX);
    expect(REMOVE_OUTSIDE_SUBTREE_MESSAGE).toBe(
      "unallowpubkey: you can remove only people you invited, or people they invited",
    );
  });

  it("themselves", async () => {
    const { a } = await family();
    expect((await as(a, "unallowpubkey", [a.pubkeyHex])).error).toBe(REMOVE_SELF_MESSAGE);
  });

  it("an admin, even one below them, directly or in a branch", async () => {
    const { a, b, c } = await family();
    await callManagement("addadmin", [c.pubkeyHex]);
    expect((await as(a, "unallowpubkey", [c.pubkeyHex])).error).toBe(
      "unallowpubkey: that member is an admin, and only the owner can remove an admin",
    );
    expect((await as(a, "unallowpubkey", [b.pubkeyHex, { invitees: "remove" }])).error).toBe(
      "unallowpubkey: someone they invited is an admin, and only the owner can remove an admin",
    );
  });
});

describe("the owner and admins", () => {
  it("still act on the whole tree, and keep re-hangs under the owner", async () => {
    const { a, b, c } = await family();
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    const reply = await as(admin, "unallowpubkey", [b.pubkeyHex]);
    expect(reply.error).toBe(
      "The 1 person they invited is still a member, now listed as invited by the owner.",
    );
    expect((await tree())[c.pubkeyHex]).toBe(OWNER_PUBKEY_HEX);
    expect((await callManagement("unallowpubkey", [a.pubkeyHex])).result).toBe(true);
  });
});
