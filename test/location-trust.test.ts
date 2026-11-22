// Location trust (schema.ts allowed_pubkeys.close; nip86.ts setclose,
// areclose): who may see where each other's photos were taken. On for
// people the owner or an admin let in, off for people who came in on a
// member's code; only the owner and admins change it. Every member uses
// the box regardless.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { TOP_LEVEL_GROUP_ID } from "../src/groups";
import { adminOnlyReason, MAX_ARECLOSE_PUBKEYS, NOT_A_MEMBER_REASON } from "../src/nip86";
import { PUT_USER_KIND } from "../src/nip29";
import type { Relay } from "../src/relay";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.MEMBER_LIST;
});

let nextIp = 0;
function as(who: Keypair, method: string, params: unknown[] = []) {
  nextIp++;
  return callManagement(method, params, {
    secretKeyHex: who.secretKeyHex,
    ip: `172.19.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`,
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

async function closeOf(who: Keypair): Promise<boolean | undefined> {
  const { members } = (await callManagement("listmembers")).result as {
    members: { pubkey: string; close: boolean }[];
  };
  return members.find((m) => m.pubkey === who.pubkeyHex)?.close;
}

describe("who is close by default", () => {
  it("people the owner or an admin let in, and admins", async () => {
    const byOwner = await joinWith(await codeFrom(null));
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    const byAdmin = await joinWith(await codeFrom(admin));
    const allowed = randomKeypair();
    await callManagement("allowpubkey", [allowed.pubkeyHex]);
    const approved = randomKeypair();
    await as(approved, "requestjoin", [{ via: byOwner.pubkeyHex }]);
    await as(admin, "approvejoin", [approved.pubkeyHex]);
    for (const who of [byOwner, admin, byAdmin, allowed, approved]) expect(await closeOf(who)).toBe(true);
  });

  it("but not people who came in on a member's code", async () => {
    const member = await joinWith(await codeFrom(null));
    const further = await joinWith(await codeFrom(member));
    expect(await closeOf(further)).toBe(false);
    expect((await as(further, "myrole")).result).toEqual({ role: "member", close: false });
  });

  it("nor someone added by a NIP-29 group", async () => {
    const grouped = randomKeypair();
    const conn = await connectRelay(`172.19.250.${nextIp++ & 0xff}`);
    const [, , ok] = await publish(
      conn,
      signEvent(OWNER_SECRET_KEY_HEX, {
        kind: PUT_USER_KIND,
        tags: [
          ["h", TOP_LEVEL_GROUP_ID],
          ["p", grouped.pubkeyHex],
        ],
      }),
    );
    conn.close();
    expect(ok).toBe(true);
    expect(await closeOf(grouped)).toBe(false);
  });

  it("is every member already there when the column arrives", async () => {
    const legacy = randomKeypair().pubkeyHex;
    await runInDurableObject(env.RELAY.get(env.RELAY.idFromName("relay")), (_i: Relay, state) => {
      state.storage.sql.exec(
        `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source) VALUES (?, NULL, 1, 'owner')`,
        legacy,
      );
      expect(
        state.storage.sql.exec(`SELECT close FROM allowed_pubkeys WHERE pubkey = ?`, legacy).toArray(),
      ).toEqual([{ close: 1 }]);
    });
  });

  it("does not change when someone moves up the tree", async () => {
    const parent = await joinWith(await codeFrom(null));
    const child = await joinWith(await codeFrom(parent));
    await callManagement("unallowpubkey", [parent.pubkeyHex]);
    expect(await closeOf(child)).toBe(false);
  });
});

describe("setclose", () => {
  it("turns it on or off, for the owner or an admin", async () => {
    const member = await joinWith(await codeFrom(null));
    const further = await joinWith(await codeFrom(member));
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    expect((await as(admin, "setclose", [further.pubkeyHex, true])).result).toBe(true);
    expect(await closeOf(further)).toBe(true);
    expect((await callManagement("setclose", [further.pubkeyHex, false])).result).toBe(true);
    expect(await closeOf(further)).toBe(false);
  });

  it("is refused to members, and for the owner or a stranger as the target", async () => {
    const alice = await joinWith(await codeFrom(null));
    const reply = await as(alice, "setclose", [alice.pubkeyHex, true]);
    expect([reply.status, reply.error]).toEqual([401, adminOnlyReason("setclose")]);
    expect((await callManagement("setclose", [OWNER_PUBKEY_HEX, false])).error).toBe(
      "setclose: the owner always sees where photos were taken",
    );
    expect((await callManagement("setclose", [randomKeypair().pubkeyHex, true])).error).toBe(
      "setclose: that pubkey is not a member of this home",
    );
    expect((await callManagement("setclose", [alice.pubkeyHex, "yes"])).error).toBe(
      "setclose takes a pubkey, as npub or hex, and true or false",
    );
  });
});

describe("areclose", () => {
  it("answers true only when the caller and the pubkey are both close", async () => {
    const alice = await joinWith(await codeFrom(null));
    const bob = await joinWith(await codeFrom(null));
    const further = await joinWith(await codeFrom(bob));
    const stranger = randomKeypair().pubkeyHex;
    expect(
      (await as(alice, "areclose", [[bob.pubkeyHex, further.pubkeyHex, OWNER_PUBKEY_HEX, stranger]])).result,
    ).toEqual({
      [bob.pubkeyHex]: true,
      [further.pubkeyHex]: false,
      [OWNER_PUBKEY_HEX]: true,
      [stranger]: false,
    });
    // Without the flag, a caller learns nothing.
    expect((await as(further, "areclose", [[alice.pubkeyHex, OWNER_PUBKEY_HEX]])).result).toEqual({
      [alice.pubkeyHex]: false,
      [OWNER_PUBKEY_HEX]: false,
    });
  });

  it("works with the member list hidden", async () => {
    const alice = await joinWith(await codeFrom(null));
    const bob = await joinWith(await codeFrom(null));
    mutableEnv.MEMBER_LIST = "hidden";
    expect((await as(alice, "areclose", [[bob.pubkeyHex]])).result).toEqual({ [bob.pubkeyHex]: true });
  });

  it(`takes 1 to ${MAX_ARECLOSE_PUBKEYS} hex pubkeys, and is refused to non-members`, async () => {
    const alice = await joinWith(await codeFrom(null));
    const message = `areclose takes an array of 1 to ${MAX_ARECLOSE_PUBKEYS} pubkeys, as 64-character hex`;
    for (const params of [
      [[]],
      ["a".repeat(64)],
      [["npub1x"]],
      [Array(MAX_ARECLOSE_PUBKEYS + 1).fill("a".repeat(64))],
    ]) {
      expect((await as(alice, "areclose", params)).error).toBe(message);
    }
    const stranger = await as(randomKeypair(), "areclose", [[alice.pubkeyHex]]);
    expect([stranger.status, stranger.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });
});

describe("memberkeys", () => {
  it("is unchanged: every member may use the box", async () => {
    const service = randomKeypair();
    await callManagement("setstorage", ["https://storage.example/", service.pubkeyHex]);
    const result = (await as(service, "memberkeys")).result as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(["admins", "members", "owner", "removed"]);
  });
});
