// Who is in the home (nip86.ts homemembers): every member sees the others
// and the owner, as pubkeys and nothing more, unless the owner keeps the
// list private (MEMBER_LIST=hidden).
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { MEMBER_LIST_HIDDEN_NOTE, NOT_A_MEMBER_REASON } from "../src/nip86";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

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
    ip: `172.21.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`,
  });
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

describe("homemembers", () => {
  it("shows any member every member and the owner, sorted, and nothing else", async () => {
    const alice = await member();
    const bob = await member();
    const reply = await as(alice, "homemembers");
    expect(reply.result).toEqual({
      members: [alice.pubkeyHex, bob.pubkeyHex, OWNER_PUBKEY_HEX].sort(),
    });
  });

  it("leaves out people who were removed", async () => {
    const alice = await member();
    const bob = await member();
    await callManagement("unallowpubkey", [bob.pubkeyHex]);
    const { members } = (await as(alice, "homemembers")).result as { members: string[] };
    expect(members).toEqual([alice.pubkeyHex, OWNER_PUBKEY_HEX].sort());
  });

  it("is refused to somebody who is not a member", async () => {
    const reply = await as(randomKeypair(), "homemembers");
    expect([reply.status, reply.error]).toEqual([401, NOT_A_MEMBER_REASON]);
  });

  it("with MEMBER_LIST=hidden, gives members an empty list and a note, and the owner and admins the list", async () => {
    const alice = await member();
    const admin = randomKeypair();
    await callManagement("addadmin", [admin.pubkeyHex]);
    mutableEnv.MEMBER_LIST = "hidden";

    expect((await as(alice, "homemembers")).result).toEqual({
      members: [],
      hidden: true,
      note: MEMBER_LIST_HIDDEN_NOTE,
    });
    expect(MEMBER_LIST_HIDDEN_NOTE).toBe("The owner keeps this home's member list private.");

    const all = [alice.pubkeyHex, admin.pubkeyHex, OWNER_PUBKEY_HEX].sort();
    expect((await as(admin, "homemembers")).result).toEqual({ members: all });
    expect((await callManagement("homemembers")).result).toEqual({ members: all });
  });

  it("reads anything but hidden as the default", async () => {
    const alice = await member();
    mutableEnv.MEMBER_LIST = "sometimes";
    expect(((await as(alice, "homemembers")).result as { members: string[] }).members.length).toBe(2);
  });
});
