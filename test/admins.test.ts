// Admins (nip86.ts addadmin/removeadmin/listadmins, ADMIN_CALLABLE_METHODS)
// and myrole. An admin is made for the owner's own second key, the
// messenger identity: it runs the member list, invites and join requests,
// and nothing relay-level.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_CALLABLE_METHODS, adminOnlyReason, NOT_A_MEMBER_REASON } from "../src/nip86";
import { conversationKey, nip44Decrypt } from "../src/nip44";
import { WRONG_SIGNER_REASON } from "../src/nip98";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { collectStored, connectRelay, publish, type RelayConn } from "./helpers/socket";

isolateStorage();

const VAPID_SECRET = "DhUcIyoxOD9GTVRbYmlwd36FjJOaoaivtr3Ey9LZ4Oc";
const mutableEnv = env as unknown as Record<string, unknown>;

beforeEach(() => {
  mutableEnv.VAPID_PRIVATE_KEY = VAPID_SECRET;
});
afterEach(() => {
  delete mutableEnv.VAPID_PRIVATE_KEY;
});

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.28.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function as(who: Keypair, method: string, params: unknown[] = []) {
  return callManagement(method, params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function newAdmin(): Promise<Keypair> {
  const admin = randomKeypair();
  expect((await callManagement("addadmin", [admin.pubkeyHex])).result).toBe(true);
  return admin;
}

async function newMember(): Promise<Keypair> {
  const member = randomKeypair();
  await callManagement("allowpubkey", [member.pubkeyHex]);
  return member;
}

async function authenticate(conn: RelayConn, secretKeyHex: string): Promise<void> {
  conn.send(["REQ", "challengeTrigger", { kinds: [1059] }]);
  const [, challenge] = await conn.nextMessage();
  await conn.nextMessage();
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
  const [, , ok] = await conn.nextMessage();
  expect(ok).toBe(true);
}

async function inboxOf(who: Keypair): Promise<NostrEvent[]> {
  const conn = await connectRelay(freshIp());
  await authenticate(conn, who.secretKeyHex);
  const events = await collectStored(conn, "inbox", [{ kinds: [1059], "#p": [who.pubkeyHex] }]);
  conn.close();
  return events;
}

describe("making and unmaking admins", () => {
  it("is the owner's alone, and an admin is listed and is a member", async () => {
    const admin = await newAdmin();
    expect((await callManagement("listadmins")).result).toEqual([
      { pubkey: admin.pubkeyHex, addedAt: expect.any(Number) },
    ]);
    const members = (await callManagement("listmembers")).result as {
      members: { pubkey: string; role: string; invitedBy: string }[];
    };
    expect(members.members).toEqual([
      expect.objectContaining({ pubkey: admin.pubkeyHex, role: "admin", invitedBy: OWNER_PUBKEY_HEX }),
    ]);

    // Neither an admin nor a member can make or list admins.
    const member = await newMember();
    for (const who of [admin, member]) {
      for (const method of ["addadmin", "removeadmin", "listadmins"]) {
        const reply = await as(who, method, [randomKeypair().pubkeyHex]);
        expect([reply.status, reply.error]).toEqual([401, WRONG_SIGNER_REASON]);
      }
    }
  });

  it("refuses the owner's own key", async () => {
    expect((await callManagement("addadmin", [OWNER_PUBKEY_HEX])).error).toContain("owner's own key");
  });

  it("removeadmin takes the role and leaves the membership", async () => {
    const admin = await newAdmin();
    expect((await callManagement("removeadmin", [admin.pubkeyHex])).result).toBe(true);
    expect((await as(admin, "myrole")).result).toEqual({ role: "member" });
    expect((await as(admin, "createinvite")).error).toBe(adminOnlyReason("createinvite"));
    expect((await callManagement("removeadmin", [admin.pubkeyHex])).error).toBe(
      "removeadmin: that pubkey is not an admin",
    );
  });

  it("removing the member removes the admin", async () => {
    const admin = await newAdmin();
    await callManagement("unallowpubkey", [admin.pubkeyHex]);
    expect((await callManagement("listadmins")).result).toEqual([]);
    expect((await as(admin, "myrole")).result).toEqual({ role: "none" });
  });

  it("keeps an existing member's membership as it was", async () => {
    const member = await newMember();
    await callManagement("addadmin", [member.pubkeyHex]);
    const { members } = (await callManagement("listmembers")).result as {
      members: { pubkey: string; source: string; role: string }[];
    };
    expect(members).toEqual([
      expect.objectContaining({ pubkey: member.pubkeyHex, source: "owner", role: "admin" }),
    ]);
  });
});

describe("what an admin may do", () => {
  it("runs invites, join requests and the member list", async () => {
    const admin = await newAdmin();

    const invite = (await as(admin, "createinvite", [1, 600])).result as { code: string };
    expect(invite.code).toMatch(/^[0-9a-f]{32}$/);
    const listed = (await as(admin, "listunusedinvites")).result as { code: string }[];
    expect(listed.map((i) => i.code)).toContain(invite.code);
    const joiner = randomKeypair();
    expect((await as(joiner, "redeeminvite", [invite.code])).result).toBe(true);

    const second = (await as(admin, "createinvite")).result as { code: string };
    expect((await as(admin, "revokeinvite", [second.code])).result).toBe(true);

    const robin = randomKeypair();
    await as(robin, "requestjoin", [{ name: "Robin" }]);
    expect(((await as(admin, "listjoinrequests")).result as unknown[]).length).toBe(1);
    expect((await as(admin, "approvejoin", [robin.pubkeyHex])).result).toBe(true);
    const sam = randomKeypair();
    await as(sam, "requestjoin", [{ name: "Sam" }]);
    expect((await as(admin, "declinejoin", [sam.pubkeyHex])).result).toBe(true);

    const added = randomKeypair();
    expect((await as(admin, "allowpubkey", [added.pubkeyHex])).result).toBe(true);

    // Whoever the admin let in hangs from the admin in the tree.
    const { members } = (await as(admin, "listmembers")).result as {
      members: { pubkey: string; invitedBy: string }[];
    };
    const parent = (who: Keypair) => members.find((m) => m.pubkey === who.pubkeyHex)?.invitedBy;
    expect([parent(joiner), parent(robin), parent(added)]).toEqual([
      admin.pubkeyHex,
      admin.pubkeyHex,
      admin.pubkeyHex,
    ]);

    expect((await as(admin, "unallowpubkey", [added.pubkeyHex])).result).toBe(true);
    const reply = await as(admin, "unallowpubkey", [joiner.pubkeyHex, { invitees: "remove" }]);
    expect(reply.result).toBe(true);
  });

  it("does nothing relay-level", async () => {
    const admin = await newAdmin();
    const relayLevel = [
      "banpubkey",
      "unbanpubkey",
      "listbannedpubkeys",
      "banevent",
      "allowevent",
      "listbannedevents",
      "blockip",
      "unblockip",
      "listblockedips",
      "changerelayname",
      "changerelaydescription",
      "changerelayicon",
      "changewritepolicy",
      "getwritepolicy",
      "listallowedpubkeys",
      "addadmin",
      "removeadmin",
      "listadmins",
    ];
    for (const method of relayLevel) {
      expect(ADMIN_CALLABLE_METHODS).not.toContain(method);
      const reply = await as(admin, method, ["x"]);
      expect([method, reply.status]).toEqual([method, 401]);
    }
  });

  it("cannot remove an admin, directly or in a subtree", async () => {
    const admin = await newAdmin();
    const other = await newAdmin();
    expect((await as(admin, "unallowpubkey", [other.pubkeyHex])).error).toBe(
      "unallowpubkey: that member is an admin, and only the owner can remove an admin",
    );
    // A member the admin let in, who in turn let in another admin.
    const child = randomKeypair();
    await as(admin, "allowpubkey", [child.pubkeyHex]);
    const grandchild = randomKeypair();
    await as(admin, "allowpubkey", [grandchild.pubkeyHex]);
    await callManagement("addadmin", [grandchild.pubkeyHex]);
    // Re-hang the grandchild under the child, as a member-made code would.
    await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i, state) => {
      state.storage.sql.exec(
        `UPDATE allowed_pubkeys SET invited_by = ? WHERE pubkey = ?`,
        child.pubkeyHex,
        grandchild.pubkeyHex,
      );
    });
    expect((await as(admin, "unallowpubkey", [child.pubkeyHex, { invitees: "remove" }])).error).toBe(
      "unallowpubkey: someone they invited is an admin, and only the owner can remove an admin",
    );
    // The owner can.
    expect((await callManagement("unallowpubkey", [child.pubkeyHex, { invitees: "remove" }])).result).toBe(
      true,
    );
  });

  it("is refused to members and strangers with a reason naming the role", async () => {
    const member = await newMember();
    for (const who of [member, randomKeypair()]) {
      const reply = await as(who, "listmembers");
      expect([reply.status, reply.error]).toEqual([401, adminOnlyReason("listmembers")]);
    }
  });

  it("has a member's inbox and push", async () => {
    const admin = await newAdmin();
    const wrap = signEvent(randomKeypair().secretKeyHex, {
      kind: 1059,
      tags: [["p", admin.pubkeyHex]],
      content: "sealed",
    });
    const conn = await connectRelay(freshIp());
    const [, , ok] = await publish(conn, wrap);
    conn.close();
    expect(ok).toBe(true);
    expect((await inboxOf(admin)).map((e) => e.id)).toEqual([wrap.id]);
    // An admin passes the member methods' gate; the push itself is the
    // member path, covered in members.test.ts.
    const reply = await as(admin, "unsubscribepush", ["https://push.example/admin"]);
    expect(reply.result).toBe(true);
  });

  it("gets its own message about each join request", async () => {
    const admin = await newAdmin();
    const robin = randomKeypair();
    await as(robin, "requestjoin", [{ name: "Robin" }]);
    const [wrap] = await inboxOf(admin);
    expect(wrap).toBeDefined();
    const seal = JSON.parse(
      nip44Decrypt(wrap!.content, conversationKey(admin.secretKeyHex, wrap!.pubkey)),
    ) as NostrEvent;
    const rumor = JSON.parse(
      nip44Decrypt(seal.content, conversationKey(admin.secretKeyHex, seal.pubkey)),
    ) as {
      tags: string[][];
      content: string;
    };
    expect(rumor.tags).toContainEqual(["bothy", "joinrequest", robin.pubkeyHex]);
    expect(rumor.tags).toContainEqual(["p", admin.pubkeyHex]);
    expect(rumor.content.startsWith("Robin wants to join your home.")).toBe(true);
  });
});

describe("myrole", () => {
  it("tells any signer what they are here", async () => {
    const admin = await newAdmin();
    const member = await newMember();
    expect((await callManagement("myrole")).result).toEqual({ role: "owner" });
    expect((await as(admin, "myrole")).result).toEqual({ role: "admin" });
    expect((await as(member, "myrole")).result).toEqual({ role: "member" });
    expect((await as(randomKeypair(), "myrole")).result).toEqual({ role: "none" });
  });

  it("does not change the member methods' refusal", async () => {
    const reply = await as(randomKeypair(), "unsubscribepush", ["https://push.example/x"]);
    expect([reply.status, reply.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });
});
