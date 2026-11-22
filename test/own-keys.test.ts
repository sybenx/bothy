// A member's own keys (nip86.ts addmykey, src/own-keys.ts): another key of
// the same person joins under them with a proof both keys signed, spends
// no invite place, stands at their depth, and leaves with them. A key the
// owner or an admin removed stays out until they let it back in.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { MEMBER_REMOVAL_GRACE_SECONDS, OWN_KEYS_PER_MEMBER_DEFAULT } from "../src/limits";
import { NOT_A_MEMBER_REASON } from "../src/nip86";
import { OWN_KEY_PROOF_KIND } from "../src/own-keys";
import type { Relay } from "../src/relay";
import { markRemovedOnPurpose, sweepFormerMembers } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;
afterEach(() => {
  delete mutableEnv.OWN_KEYS_PER_MEMBER;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.30.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

function as(who: Keypair, method: string, params: unknown[] = []) {
  return callManagement(method, params, { secretKeyHex: who.secretKeyHex, ip: freshIp() });
}

async function join(code: string): Promise<Keypair> {
  const who = randomKeypair();
  expect((await as(who, "redeeminvite", [code])).result).toBe(true);
  return who;
}

async function inviteFrom(who: Keypair | null): Promise<string> {
  const reply = who === null ? await callManagement("createinvite") : await as(who, "createinvite");
  expect(reply.error).toBeUndefined();
  return (reply.result as { code: string }).code;
}

const newMember = async (by: Keypair | null = null) => join(await inviteFrom(by));

interface ProofOptions {
  kind?: number;
  p?: string;
  relay?: string;
  createdAt?: number;
  signer?: Keypair;
  content?: string;
}

function proof(child: Keypair, member: Keypair | string, opts: ProofOptions = {}) {
  const memberHex = typeof member === "string" ? member : member.pubkeyHex;
  return signEvent((opts.signer ?? child).secretKeyHex, {
    kind: opts.kind ?? OWN_KEY_PROOF_KIND,
    tags: [
      ["p", opts.p ?? memberHex],
      ["relay", opts.relay ?? "https://example.com/"],
    ],
    content: "",
    ...(opts.createdAt === undefined ? {} : { created_at: opts.createdAt }),
  });
}

async function addKey(member: Keypair, child = randomKeypair(), opts: ProofOptions = {}) {
  const reply = await as(member, "addmykey", [child.pubkeyHex, proof(child, member, opts)]);
  return { reply, child };
}

async function memberRows(): Promise<{ pubkey: string; invitedBy: string; source: string }[]> {
  const reply = await callManagement("listmembers");
  return (reply.result as { members: { pubkey: string; invitedBy: string; source: string }[] }).members;
}

async function role(who: Keypair): Promise<string> {
  return ((await as(who, "myrole")).result as { role: string }).role;
}

describe("addmykey", () => {
  it("lets a member's own key in under them, with no invite place and at their depth", async () => {
    const alice = await newMember();
    const bob = await newMember(alice);
    const before = (await as(bob, "myinvites")).result as { left: number; depth: number };

    const { reply, child } = await addKey(bob);
    expect(reply.error).toBeUndefined();
    expect(reply.result).toBe(true);
    expect(await role(child)).toBe("member");

    const row = (await memberRows()).find((r) => r.pubkey === child.pubkeyHex)!;
    expect(row).toMatchObject({ invitedBy: bob.pubkeyHex, source: "own" });
    const after = (await as(bob, "myinvites")).result as { left: number; depth: number };
    expect(after.left).toBe(before.left);
    const childStanding = (await as(child, "myinvites")).result as { depth: number };
    expect(childStanding.depth).toBe(before.depth);
  });

  it("checks the proof: kind, signer, p tag, relay tag, freshness and signature", async () => {
    const alice = await newMember();
    const child = randomKeypair();
    const now = Math.floor(Date.now() / 1000);
    const cases: [ProofOptions, string][] = [
      [{ kind: 1 }, `addmykey: the proof must be kind ${OWN_KEY_PROOF_KIND}`],
      [{ signer: randomKeypair() }, "addmykey: the proof must be signed by that key"],
      [{ p: OWNER_PUBKEY_HEX }, "addmykey: the proof's p tag must be your own key"],
      [{ relay: "https://another.example/" }, "addmykey: the proof's relay tag must be this home"],
      [{ createdAt: now - 120 }, "addmykey: the proof must be made within 60 seconds"],
    ];
    for (const [opts, error] of cases) {
      const reply = await as(alice, "addmykey", [child.pubkeyHex, proof(child, alice, opts)]);
      expect(reply.error).toBe(error);
    }
    const forged = { ...proof(child, alice), content: "changed" };
    expect((await as(alice, "addmykey", [child.pubkeyHex, forged])).error).toBe(
      "addmykey: the proof's signature is invalid",
    );
    // wss:// spelling of this home is fine.
    expect((await addKey(alice, child, { relay: "wss://example.com" })).reply.result).toBe(true);
  });

  it("refuses a stranger, a member already here, a banned key and your own key", async () => {
    const stranger = randomKeypair();
    const { reply } = await addKey(stranger);
    expect([reply.status, reply.error]).toEqual([401, NOT_A_MEMBER_REASON]);

    const alice = await newMember();
    const bob = await newMember();
    expect((await addKey(alice, bob)).reply.error).toBe("addmykey: that key is already a member here");
    const banned = randomKeypair();
    await callManagement("banpubkey", [banned.pubkeyHex]);
    expect((await addKey(alice, banned)).reply.error).toBe("addmykey: that key is banned here");
    expect((await addKey(alice, alice)).reply.error).toBe("addmykey: that is the key you are signing with");
  });

  it(`caps own keys per member (default ${OWN_KEYS_PER_MEMBER_DEFAULT}), and can be turned off`, async () => {
    mutableEnv.OWN_KEYS_PER_MEMBER = "2";
    const alice = await newMember();
    expect((await addKey(alice)).reply.result).toBe(true);
    expect((await addKey(alice)).reply.result).toBe(true);
    expect((await addKey(alice)).reply.error).toBe("addmykey: at most 2 own keys each");
    mutableEnv.OWN_KEYS_PER_MEMBER = "off";
    expect((await addKey(await newMember())).reply.error).toBe("addmykey: this home does not take own keys");
  });
});

describe("own keys leave with the member", () => {
  it("go when the owner removes the member, even with invitees kept", async () => {
    const alice = await newMember();
    const { child } = await addKey(alice);
    const invitee = await newMember(child);
    expect((await callManagement("unallowpubkey", [alice.pubkeyHex])).result).toBe(true);
    expect(await role(child)).toBe("none");
    expect(await role(invitee)).toBe("member");
    const row = (await memberRows()).find((r) => r.pubkey === invitee.pubkeyHex)!;
    expect(row.invitedBy).toBe(OWNER_PUBKEY_HEX);
  });

  it("go when a member higher up removes them, and the member can remove one of their own", async () => {
    const alice = await newMember();
    const bob = await newMember(alice);
    const { child } = await addKey(bob);
    const { child: second } = await addKey(bob);
    expect((await as(bob, "unallowpubkey", [second.pubkeyHex])).result).toBe(true);
    expect(await role(second)).toBe("none");
    expect((await as(alice, "unallowpubkey", [bob.pubkeyHex])).result).toBe(true);
    expect(await role(child)).toBe("none");
  });

  it("go with eraseme, and give back only the member's own invite place", async () => {
    const alice = await newMember();
    const before = ((await as(alice, "myinvites")).result as { left: number }).left;
    const bob = await newMember(alice);
    const { child } = await addKey(bob);
    expect((await as(bob, "eraseme")).error).toBeUndefined();
    expect(await role(child)).toBe("none");
    expect(((await as(alice, "myinvites")).result as { left: number }).left).toBe(before);
  });
});

describe("removed on purpose", () => {
  it("keeps a key the owner removed out, past the grace, until forgotten", async () => {
    const alice = await newMember();
    const { child } = await addKey(alice);
    await callManagement("unallowpubkey", [alice.pubkeyHex]);

    // Alice comes back on a new invite; her own key does not come with her.
    const code = await inviteFrom(null);
    expect((await as(alice, "redeeminvite", [code])).result).toBe(true);
    const refused = "addmykey: that account was removed from this home. Ask the owner or an admin to let it back in.";
    expect((await addKey(alice, child)).reply.error).toBe(refused);
    // Nor through another member.
    expect((await addKey(await newMember(), child)).reply.error).toBe(refused);

    // The grace sweep forgets the removal record, not the mark.
    await runInDurableObject(stub(), (_i: Relay, state) =>
      sweepFormerMembers(state.storage.sql, 2 ** 40, MEMBER_REMOVAL_GRACE_SECONDS, OWNER_PUBKEY_HEX, 8, 100),
    );
    expect((await addKey(alice, child)).reply.error).toBe(refused);

    expect((await callManagement("forgetremoval", [child.pubkeyHex])).result).toEqual({ forgotten: true });
    expect((await callManagement("forgetremoval", [child.pubkeyHex])).result).toEqual({ forgotten: false });
    expect((await addKey(alice, child)).reply.result).toBe(true);
  });

  it("holds only a hash and a time", async () => {
    const alice = await newMember();
    await callManagement("unallowpubkey", [alice.pubkeyHex]);
    const rows = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql.exec(`SELECT * FROM removal_marks`).toArray(),
    );
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["hash", "removed_at"]);
    expect(JSON.stringify(rows)).not.toContain(alice.pubkeyHex);
  });

  it("is cleared by letting the key back in", async () => {
    const alice = await newMember();
    const { child } = await addKey(alice);
    await callManagement("unallowpubkey", [child.pubkeyHex]);
    const marks = () =>
      runInDurableObject(stub(), (_i: Relay, state) => state.storage.sql.exec(`SELECT * FROM removal_marks`).toArray());
    expect(await marks()).toHaveLength(1);
    expect((await callManagement("allowpubkey", [child.pubkeyHex])).result).toBe(true);
    expect(await marks()).toEqual([]);
  });

  it("is not set when a member removes someone below them", async () => {
    const alice = await newMember();
    const bob = await newMember(alice);
    const { child } = await addKey(bob);
    await as(alice, "unallowpubkey", [bob.pubkeyHex]);
    expect((await addKey(alice, child)).reply.result).toBe(true);
  });

  it("is cleared by the person's own eraseme", async () => {
    const alice = await newMember();
    await runInDurableObject(stub(), (_i: Relay, state) =>
      markRemovedOnPurpose(state.storage.sql, [alice.pubkeyHex], 1),
    );
    await as(alice, "eraseme");
    const rows = await runInDurableObject(stub(), (_i: Relay, state) =>
      state.storage.sql.exec(`SELECT * FROM removal_marks`).toArray(),
    );
    expect(rows).toEqual([]);
  });

  it("forgetremoval is the owner's alone", async () => {
    const alice = await newMember();
    const reply = await as(alice, "forgetremoval", [alice.pubkeyHex]);
    expect(reply.status).toBe(401);
  });
});
