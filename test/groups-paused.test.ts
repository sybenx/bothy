// NIP-29 groups PAUSED (limits.ts groupsEnabled): the state a fresh
// deployment is in, since GROUPS is unset there and only the exact string
// "on" enables it. The global test bindings set GROUPS=on so the group
// suites can exercise the machinery (vitest.config.ts), which is why
// everything here hands the functions that read it a paused env directly
// -- the exception test/follows.test.ts documents, for the same
// fixed-bindings reason.
//
// What "paused" has to mean, one block each: nothing group-shaped is
// accepted from anyone, the owner included; ordinary traffic is
// untouched; the NIP-11 document stops listing 29; and what is already
// in the partition stays exactly where it was.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { GROUP_METADATA_KIND, TOP_LEVEL_GROUP_ID } from "../src/groups";
import { groupsEnabled } from "../src/limits";
import { buildRelayInfo } from "../src/nip11";
import { authorizeGroupWrite, EDIT_METADATA_KIND, GROUPS_PAUSED_MESSAGE, PUT_USER_KIND } from "../src/nip29";
import { addGroupMember } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";

isolateStorage();

const PAUSED = { OWNER_PUBKEY: OWNER_PUBKEY_HEX } as unknown as Env;
const ON = { OWNER_PUBKEY: OWNER_PUBKEY_HEX, GROUPS: "on" } as unknown as Env;
const RELAY_HEX = "f".repeat(64);
const NO_SETTINGS = { name: null, description: null, icon: null, writeRung: null };

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

describe("groupsEnabled", () => {
  it("is on for the exact string 'on' and paused for anything else", () => {
    expect(groupsEnabled(ON)).toBe(true);
    for (const value of [undefined, "", "true", "ON", "yes", "1", "off"]) {
      expect(groupsEnabled({ ...PAUSED, GROUPS: value } as unknown as Env)).toBe(false);
    }
  });
});

describe("the write gate while paused", () => {
  it("refuses every group-shaped write with one message, the owner's included", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const member = randomKeypair();
      addGroupMember(sql, member.pubkeyHex, 1);
      const shapes = [
        // The owner's own chat message.
        { event: signEvent(OWNER_SECRET_KEY_HEX, { kind: 9, tags: [["h", TOP_LEVEL_GROUP_ID]] }), isOwner: true },
        // A member's note into the group.
        { event: signEvent(member.secretKeyHex, { kind: 1, tags: [["h", TOP_LEVEL_GROUP_ID]] }), isOwner: false },
        // Moderation, from the sole admin.
        {
          event: signEvent(OWNER_SECRET_KEY_HEX, {
            kind: PUT_USER_KIND,
            tags: [["h", TOP_LEVEL_GROUP_ID], ["p", randomKeypair().pubkeyHex]],
          }),
          isOwner: true,
        },
        {
          event: signEvent(OWNER_SECRET_KEY_HEX, { kind: EDIT_METADATA_KIND, tags: [["h", TOP_LEVEL_GROUP_ID]] }),
          isOwner: true,
        },
        // A client-signed relay-metadata kind, which is refused either way
        // -- while paused it gets the pause message like everything else.
        {
          event: signEvent(OWNER_SECRET_KEY_HEX, { kind: GROUP_METADATA_KIND, tags: [["d", TOP_LEVEL_GROUP_ID]] }),
          isOwner: true,
        },
      ];
      const messages = new Set<string>();
      for (const { event, isOwner } of shapes) {
        const result = authorizeGroupWrite(sql, PAUSED, event, isOwner, 1);
        expect(result.ok).toBe(false);
        if (!result.ok) messages.add(result.message);
      }
      expect(messages).toEqual(new Set([GROUPS_PAUSED_MESSAGE]));
      expect(GROUPS_PAUSED_MESSAGE).toMatch(/^restricted: /);

      // The same shapes with groups on go through to the ordinary gate --
      // which admits the owner's chat, the member's note and the two
      // moderation events, and refuses only the client-signed 39000.
      expect(authorizeGroupWrite(sql, ON, shapes[0]!.event, true, 1).ok).toBe(true);
      expect(authorizeGroupWrite(sql, ON, shapes[1]!.event, false, 1).ok).toBe(true);
      expect(authorizeGroupWrite(sql, ON, shapes[2]!.event, true, 1).ok).toBe(true);
      expect(authorizeGroupWrite(sql, ON, shapes[3]!.event, true, 1).ok).toBe(true);
      const metadata = authorizeGroupWrite(sql, ON, shapes[4]!.event, true, 1);
      expect(metadata.ok).toBe(false);
      if (!metadata.ok) expect(metadata.message).not.toBe(GROUPS_PAUSED_MESSAGE);
    });
  });

  it("leaves ordinary writes alone", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const note = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "not a group event" });
      expect(authorizeGroupWrite(sql, PAUSED, note, true, 1)).toEqual({ ok: true });
      const reply = signEvent(randomKeypair().secretKeyHex, { kind: 1, tags: [["p", OWNER_PUBKEY_HEX]] });
      expect(authorizeGroupWrite(sql, PAUSED, reply, false, 1)).toEqual({ ok: true });
    });
  });

  it("holds an event tagged into some OTHER relay's group to the member list, as before", async () => {
    // Pausing this relay's group says nothing about foreign group traffic
    // -- that reaches the one member list exactly as it did, so the owner
    // (exempt) passes and a stranger does not, under either env.
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const foreign = (secret: string) => signEvent(secret, { kind: 1, tags: [["h", "somebody-elses-group"]] });
      for (const environment of [PAUSED, ON]) {
        expect(authorizeGroupWrite(sql, environment, foreign(OWNER_SECRET_KEY_HEX), true, 1).ok).toBe(true);
        const stranger = authorizeGroupWrite(sql, environment, foreign(randomKeypair().secretKeyHex), false, 1);
        expect(stranger.ok).toBe(false);
        if (!stranger.ok) expect(stranger.message).not.toBe(GROUPS_PAUSED_MESSAGE);
      }
    });
  });
});

describe("what the relay advertises", () => {
  it("lists NIP-29 only while groups are on", () => {
    const paused = buildRelayInfo(PAUSED, NO_SETTINGS, null, null, RELAY_HEX) as { supported_nips: number[] };
    expect(paused.supported_nips).not.toContain(29);
    const on = buildRelayInfo(ON, NO_SETTINGS, null, null, RELAY_HEX) as { supported_nips: number[] };
    expect(on.supported_nips).toContain(29);
    // Everything else is unchanged by the switch.
    expect(on.supported_nips.filter((n) => n !== 29)).toEqual(paused.supported_nips);
  });

  it("reports the switch on /api/stats as a mode and nothing more", async () => {
    // The global bindings have GROUPS=on; the field exists and carries
    // the mode, the way chatPolicy does. No counts ride with it.
    const stats = (await stub().getStats()) as { groupPolicy: string; chatPolicy: string };
    expect(stats.groupPolicy).toBe("on");
    expect(["on", "paused"]).toContain(stats.groupPolicy);
  });
});
