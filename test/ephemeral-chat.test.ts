// Ephemeral group chat: the group's talk exists for the conversation it
// was part of and is then deleted -- not hidden, not archived.
//
// Four rules, and this file is organised as one describe block per rule
// plus the two things that make them safe to ship:
//
//   1. A conversation ends when the room has been empty for
//      CONVERSATION_IDLE_SECONDS, and everything said during it goes.
//   2. A message sent while somebody else was present belongs to that
//      conversation.
//   3. A message sent to an empty room is a NOTE. It waits for the next
//      conversation, for as long as that takes -- there is no ceiling,
//      and the sender takes it back with a NIP-09 kind-5 if they want to.
//   4. Somebody arriving partway through sees the last few minutes.
//
//   + the scope: this touches the group's chat and nothing else on the
//     relay, which is the assertion with the most ways to go wrong.
//   + the cost: what a conversation of a few hundred messages spends
//     against the 100,000 rows-written/day ceiling, measured on a real
//     SqlStorageCursor like every other figure in CLAUDE.md "The budget".
//
// Driven at the storage layer rather than over the wire, for the reason
// test/nip29-groups.test.ts gives: these are assertions about what got
// stored and what stopped being stored, and the sweep runs from the cron
// tick rather than from a client frame.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  GROUP_CHAT_KIND,
  GROUP_MEMBERS_KIND,
  GROUP_SCOPE,
  PUBLIC_SCOPE,
  TOP_LEVEL_GROUP_ID,
} from "../src/groups";
import {
  CHAT_BACKLOG_SECONDS,
  CHAT_SWEEP_BATCH_SIZE,
  chatMode,
  CONVERSATION_IDLE_SECONDS,
} from "../src/limits";
import { authorizeGroupWrite } from "../src/nip29";
import type { Relay } from "../src/relay";
import {
  type ChatState,
  chatHorizon,
  chatSweepCutoff,
  noteRoomOccupied,
  queryFilter,
  readChatState,
  storeEvent,
  sweepChat,
} from "../src/storage";
import { signEvent, type NostrEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";

isolateStorage();

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

// A kind-9 in this relay's one group, at a given second. `h` is what puts
// it in the group partition; the `n` in the content is only so two
// messages in the same second get different ids.
function chat(at: number, n = 0, secretKeyHex = OWNER_SECRET_KEY_HEX): NostrEvent {
  return signEvent(secretKeyHex, {
    kind: GROUP_CHAT_KIND,
    created_at: at,
    content: `message ${n}`,
    tags: [["h", TOP_LEVEL_GROUP_ID]],
  });
}

function chatIdsInStorage(sql: SqlStorage): string[] {
  return sql
    .exec<{ id: string }>(
      `SELECT id FROM events WHERE kind = ? AND is_group = ? ORDER BY created_at ASC`,
      GROUP_CHAT_KIND,
      GROUP_SCOPE,
    )
    .toArray()
    .map((r) => r.id);
}

// Puts the room's watermark at a chosen second, which is what every test
// below varies. relay.ts writes this from a live socket count; here it is
// set directly, because what is under test is what the sweep DOES with
// the watermark and not how it comes to hold that value.
function setRoomOccupiedAt(sql: SqlStorage, at: number): ChatState {
  noteRoomOccupied(sql, at);
  return readChatState(sql);
}

describe("rule 1: a conversation ends when the room has been empty long enough", () => {
  it("sweeps nothing while the room is still in use", () => {
    const now = 1_800_000_000;
    // The room emptied one hour ago, which is inside the idle window: the
    // conversation is not over, so there is no cutoff at all.
    const state: ChatState = {
      lastOccupiedAt: now - 3600,
      sweptThrough: 0,
      sweptTotal: 0,
      reportedAt: 0,
      reportedPending: 0,
    };
    expect(CONVERSATION_IDLE_SECONDS).toBeGreaterThan(3600);
    expect(chatSweepCutoff(state, now)).toBe(0);
  });

  it("takes the whole conversation once the idle window has passed", () => {
    const now = 1_800_000_000;
    const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
    const state: ChatState = {
      lastOccupiedAt: emptiedAt,
      sweptThrough: 0,
      sweptTotal: 0,
      reportedAt: 0,
      reportedPending: 0,
    };
    // The cutoff IS the watermark, which is what makes rule 2 arithmetic
    // rather than per-message bookkeeping -- see below.
    expect(chatSweepCutoff(state, now)).toBe(emptiedAt);
  });

  it("removes an evening's talk and leaves the room empty of it", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;

      // An evening: ten messages, all said before the room emptied.
      for (let i = 0; i < 10; i++) storeEvent(sql, chat(emptiedAt - 600 + i, i), now);
      expect(chatIdsInStorage(sql)).toHaveLength(10);

      const state = setRoomOccupiedAt(sql, emptiedAt);
      const result = sweepChat(sql, state, now, CHAT_SWEEP_BATCH_SIZE, true);

      expect(result.pending).toBe(10);
      expect(result.removed).toBe(10);
      expect(result.done).toBe(true);
      expect(chatIdsInStorage(sql)).toHaveLength(0);
    });
  });

  it("checkpoints a conversation too large for one tick, and finishes it on the next", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;

      for (let i = 0; i < 5; i++) storeEvent(sql, chat(emptiedAt - 100 + i, i), now);
      const state = setRoomOccupiedAt(sql, emptiedAt);

      // A batch of two, standing in for CHAT_SWEEP_BATCH_SIZE, so the
      // checkpoint is exercised without storing hundreds of events.
      const first = sweepChat(sql, state, now, 2, true);
      expect(first.removed).toBe(2);
      expect(first.done).toBe(false);
      // `swept_through` does NOT advance on a partial sweep: a watermark
      // ahead of the deletion would refuse a replay of a message still
      // sitting in the table.
      expect(readChatState(sql).sweptThrough).toBe(0);

      let guard = 0;
      let done = first.done;
      while (!done && guard++ < 10) {
        done = sweepChat(sql, readChatState(sql), now, 2, true).done;
      }
      expect(chatIdsInStorage(sql)).toHaveLength(0);
      expect(readChatState(sql).sweptThrough).toBe(emptiedAt);
      expect(readChatState(sql).sweptTotal).toBe(5);
    });
  });
});

describe("rule 2 and rule 3: speech goes, a note waits", () => {
  it("keeps a message sent to an empty room and removes the one sent before it", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;

      // Said while somebody else was there -- speech.
      const spoken = chat(emptiedAt - 60, 1);
      // Said after the room emptied -- a note.
      const note = chat(emptiedAt + 60, 2);
      storeEvent(sql, spoken, now);
      storeEvent(sql, note, now);

      const state = setRoomOccupiedAt(sql, emptiedAt);
      sweepChat(sql, state, now, CHAT_SWEEP_BATCH_SIZE, true);

      // The whole speech/note distinction, and it needed no per-message
      // column to make: one is at or before the watermark and one is
      // after it.
      expect(chatIdsInStorage(sql)).toEqual([note.id]);
    });
  });

  it("never expires a note, however long nobody comes", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
      const note = chat(emptiedAt + 60, 1);
      storeEvent(sql, note, now);
      setRoomOccupiedAt(sql, emptiedAt);
      sweepChat(sql, readChatState(sql), now, CHAT_SWEEP_BATCH_SIZE, true);

      // A year of nobody coming back. Mail does not vanish because the
      // person it was addressed to is away: the cutoff cannot move past
      // the watermark, and the watermark only moves when somebody is
      // actually in the room.
      const muchLater = now + 365 * 24 * 60 * 60;
      const state = readChatState(sql);
      expect(chatSweepCutoff(state, muchLater)).toBe(emptiedAt);
      const result = sweepChat(sql, state, muchLater, CHAT_SWEEP_BATCH_SIZE, true);
      expect(result.removed).toBe(0);
      expect(chatIdsInStorage(sql)).toEqual([note.id]);
    });
  });

  it("costs nothing but the state read once an unread note is all that is left", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
      storeEvent(sql, chat(emptiedAt - 60, 1), now);
      storeEvent(sql, chat(emptiedAt + 60, 2), now);
      setRoomOccupiedAt(sql, emptiedAt);
      sweepChat(sql, readChatState(sql), now, CHAT_SWEEP_BATCH_SIZE, true);

      // Every later tick finds a cutoff it has already drained and returns
      // before the COUNT and before any write. Without that early return
      // a room standing empty with a note in it would write a row an hour
      // forever -- and with no ceiling on a note, forever is the point.
      const state = readChatState(sql);
      let written = 0;
      const proxy = new Proxy(sql, {
        get(target, property) {
          if (property === "exec") {
            return (query: string, ...bindings: unknown[]) => {
              const cursor = target.exec(query, ...bindings);
              written += cursor.rowsWritten;
              return cursor;
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function"
            ? (value as (...a: unknown[]) => unknown).bind(target)
            : value;
        },
      }) as SqlStorage;
      sweepChat(proxy, state, now + 7200, CHAT_SWEEP_BATCH_SIZE, true);
      expect(written).toBe(0);
    });
  });

  it("delivers a waiting note into the next conversation, and it dies with that one", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);

      // A note left at T, nobody there.
      const noteAt = now - 3 * CONVERSATION_IDLE_SECONDS;
      const note = chat(noteAt, 1);
      storeEvent(sql, note, now);

      // People come back later and talk. The room is occupied, so the
      // watermark moves past the note: it has been delivered.
      const talkedUntil = now - CONVERSATION_IDLE_SECONDS;
      const said = chat(talkedUntil - 30, 2);
      storeEvent(sql, said, now);
      const state = setRoomOccupiedAt(sql, talkedUntil);

      sweepChat(sql, state, now, CHAT_SWEEP_BATCH_SIZE, true);
      // Both gone: "once people are talking it has been delivered, and it
      // lives and dies with that conversation."
      expect(chatIdsInStorage(sql)).toHaveLength(0);
    });
  });
});

describe("rule 4: arriving partway through", () => {
  it("shows the last few minutes while the room is in use", () => {
    const now = 1_800_000_000;
    const state: ChatState = {
      lastOccupiedAt: now,
      sweptThrough: 0,
      sweptTotal: 0,
      reportedAt: 0,
      reportedPending: 0,
    };
    expect(chatHorizon(state, now)).toBe(now - CHAT_BACKLOG_SECONDS);
  });

  it("shows exactly the waiting notes and none of the talk before them, once the room is empty", () => {
    const now = 1_800_000_000;
    const emptiedAt = now - 3600;
    const state: ChatState = {
      lastOccupiedAt: emptiedAt,
      sweptThrough: 0,
      sweptTotal: 0,
      reportedAt: 0,
      reportedPending: 0,
    };
    // The watermark is older than the backlog window, so it wins the MIN:
    // what a reader sees begins where the conversation ended.
    expect(chatHorizon(state, now)).toBe(emptiedAt);
  });

  it("clamps a read of the chat kind without clamping anything else", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const horizon = now - CHAT_BACKLOG_SECONDS;

      const old = chat(horizon - 600, 1);
      const recent = chat(horizon + 60, 2);
      // A reaction in the same partition, as old as the old message. Not
      // chat, so the horizon must not touch it.
      const reaction = signEvent(OWNER_SECRET_KEY_HEX, {
        kind: 7,
        created_at: horizon - 600,
        content: "+",
        tags: [["h", TOP_LEVEL_GROUP_ID]],
      });
      for (const event of [old, recent, reaction]) storeEvent(sql, event, now);

      const read = (filter: Record<string, unknown>) =>
        queryFilter(sql, filter, now, { scopes: [GROUP_SCOPE], chatHorizon: horizon }).map(
          (e) => e.id,
        );

      // Pinned to the chat kind -- the horizon folds into `since` and
      // becomes a bound on the index range.
      expect(read({ kinds: [GROUP_CHAT_KIND], limit: 50 })).toEqual([recent.id]);
      // Naming no kinds -- the residual form. The old chat is withheld
      // and the equally old reaction is not.
      expect(read({ limit: 50 }).sort()).toEqual([reaction.id, recent.id].sort());
      // And the other kind on its own is untouched.
      expect(read({ kinds: [7], limit: 50 })).toEqual([reaction.id]);
    });
  });
});

describe("the scope: the group's chat and nothing else", () => {
  it("leaves every other kind, and the public partition, exactly where they were", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
      const at = emptiedAt - 600;

      const talk = chat(at, 1);
      // Everything else this relay holds, all older than the cutoff, so
      // only the KIND and the partition keep them alive.
      const reaction = signEvent(OWNER_SECRET_KEY_HEX, {
        kind: 7,
        created_at: at,
        tags: [["h", TOP_LEVEL_GROUP_ID]],
      });
      const ownerNote = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, created_at: at });
      // A kind-9 with no `h` tag: chat somewhere else, in the public
      // partition, and none of this relay's business.
      const foreignChat = signEvent(OWNER_SECRET_KEY_HEX, {
        kind: GROUP_CHAT_KIND,
        created_at: at,
        content: "elsewhere",
      });
      const giftWrap = signEvent(randomKeypair().secretKeyHex, {
        kind: 1059,
        created_at: at,
        tags: [["p", OWNER_PUBKEY_HEX]],
      });
      for (const event of [talk, reaction, ownerNote, foreignChat, giftWrap]) {
        storeEvent(sql, event, now);
      }

      const state = setRoomOccupiedAt(sql, emptiedAt);
      const result = sweepChat(sql, state, now, CHAT_SWEEP_BATCH_SIZE, true);
      expect(result.removed).toBe(1);

      const surviving = sql
        .exec<{ id: string }>(`SELECT id FROM events`)
        .toArray()
        .map((r) => r.id);
      expect(surviving).not.toContain(talk.id);
      for (const kept of [reaction, ownerNote, foreignChat, giftWrap]) {
        expect(surviving).toContain(kept.id);
      }
    });
  });

  it("writes no tombstone, so a swept conversation leaves nothing behind at all", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
      storeEvent(sql, chat(emptiedAt - 60, 1), now);
      sweepChat(sql, setRoomOccupiedAt(sql, emptiedAt), now, CHAT_SWEEP_BATCH_SIZE, true);

      // Every other removal in this codebase tombstones the id. This one
      // must not: a `deleted_ids` row per message is a permanent record of
      // the conversation outliving the conversation. `swept_through`
      // refuses the replay instead -- asserted directly below.
      const tombstones = sql
        .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM deleted_ids`)
        .toArray()[0];
      expect(tombstones?.n).toBe(0);
    });
  });
});

describe("replaying a conversation that is over", () => {
  it("refuses a chat message at or before the swept watermark, and admits one after it", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
      const replayed = chat(emptiedAt - 60, 1);
      storeEvent(sql, replayed, now);
      sweepChat(sql, setRoomOccupiedAt(sql, emptiedAt), now, CHAT_SWEEP_BATCH_SIZE, true);
      expect(readChatState(sql).sweptThrough).toBe(emptiedAt);

      // The relay's own env has no EPHEMERAL_CHAT set, so the gate is
      // inert there; the refusal is what happens once an owner turns it
      // on, which is what this asserts.
      const acting = { ...env, EPHEMERAL_CHAT: "on" } as unknown as Env;
      expect(chatMode(acting)).toBe("deleting");

      const refused = authorizeGroupWrite(sql, acting, replayed, true, now);
      expect(refused.ok).toBe(false);
      expect(refused.ok === false && refused.message).toContain("that conversation is over");

      // A message from after the watermark is ordinary traffic.
      const fresh = chat(now, 2);
      expect(authorizeGroupWrite(sql, acting, fresh, true, now).ok).toBe(true);

      // And in reporting mode nothing is refused at all -- that mode
      // changes no behaviour a client can see.
      const watching = { ...env, EPHEMERAL_CHAT: undefined } as unknown as Env;
      expect(chatMode(watching)).toBe("reporting");
      expect(authorizeGroupWrite(sql, watching, replayed, true, now).ok).toBe(true);
    });
  });
});

describe("reporting mode", () => {
  it("counts exactly what deleting mode would remove, and removes none of it", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
      for (let i = 0; i < 7; i++) storeEvent(sql, chat(emptiedAt - 300 + i, i), now);
      // One note after the watermark, which neither mode touches.
      storeEvent(sql, chat(emptiedAt + 300, 99), now);
      const state = setRoomOccupiedAt(sql, emptiedAt);

      const reported = sweepChat(sql, state, now, CHAT_SWEEP_BATCH_SIZE, false);
      expect(reported.pending).toBe(7);
      expect(reported.removed).toBe(0);
      expect(chatIdsInStorage(sql)).toHaveLength(8);
      // The report is stored as well as returned, so "watch it be right
      // for a few days" has state to read back and not only a log line
      // somebody had to be watching for.
      const after = readChatState(sql);
      expect(after.reportedPending).toBe(7);
      expect(after.reportedAt).toBe(now);
      expect(after.sweptThrough).toBe(0);

      // The same call with `remove` set acts on the same number.
      const acted = sweepChat(sql, readChatState(sql), now, CHAT_SWEEP_BATCH_SIZE, true);
      expect(acted.pending).toBe(7);
      expect(acted.removed).toBe(7);
      expect(chatIdsInStorage(sql)).toHaveLength(1);
    });
  });

  it("defaults to reporting, takes 'on' to act and 'off' to do nothing", () => {
    expect(chatMode({} as unknown as Env)).toBe("reporting");
    expect(chatMode({ EPHEMERAL_CHAT: "on" } as unknown as Env)).toBe("deleting");
    expect(chatMode({ EPHEMERAL_CHAT: "off" } as unknown as Env)).toBe("off");
    // Only those two exact strings mean anything. Anything else -- a typo
    // in the dashboard most of all -- lands on the cautious default
    // rather than on either of the two states that change behaviour.
    expect(chatMode({ EPHEMERAL_CHAT: "ON" } as unknown as Env)).toBe("reporting");
    expect(chatMode({ EPHEMERAL_CHAT: "true" } as unknown as Env)).toBe("reporting");
    expect(chatMode({ EPHEMERAL_CHAT: "" } as unknown as Env)).toBe("reporting");
  });
});

// What this costs against the 100,000 rows-written/day ceiling
// (CLAUDE.md "The budget"). Measured on a real SqlStorageCursor, so a
// change that moves it fails here rather than drifting.
describe("rows written per swept message", () => {
  function measureRowsWritten(sql: SqlStorage, fn: (sql: SqlStorage) => void): number {
    let total = 0;
    const proxy = new Proxy(sql, {
      get(target, property) {
        if (property === "exec") {
          return (query: string, ...bindings: unknown[]) => {
            const cursor = target.exec(query, ...bindings);
            total += cursor.rowsWritten;
            return cursor;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as SqlStorage;
    fn(proxy);
    return total;
  }

  it("costs five rows to remove a one-tag chat message, against twelve to store it", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const emptiedAt = now - CONVERSATION_IDLE_SECONDS;
      const message = chat(emptiedAt - 60, 1);

      const stored = measureRowsWritten(sql, (metered) => storeEvent(metered, message, now));
      // 9 base + 3 for the one `h` tag -- CLAUDE.md "The budget", the
      // measured figure.
      expect(stored).toBe(12);

      const state = setRoomOccupiedAt(sql, emptiedAt);
      const removed = measureRowsWritten(sql, (metered) =>
        sweepChat(metered, state, now, CHAT_SWEEP_BATCH_SIZE, true),
      );

      // What that is made of, for one message with one indexed tag:
      //
      //   the `h` tag row                                 1
      //   the event row                                   1
      //   the three maintained counters                   3
      //   a tombstone                                     0  <- deliberately
      //   the chat_state checkpoint (once per sweep)      1
      //                                                 ---
      //                                                   6
      //
      // So five rows per message plus one per sweep, against twelve to
      // store the message in the first place. A conversation of three
      // hundred messages costs ~1,500 rows to remove -- 1.5% of the day's
      // ceiling, and less than half what storing it cost. That asymmetry
      // is the whole reason limits.ts gives this path no daily share:
      // a day's sweeping cannot exceed a day's chat, and a day's chat is
      // the more expensive half.
      expect(removed).toBe(6);
    });
  });

  it("charges nothing at all to a relay with no chat in it", async () => {
    await runInDurableObject(stub(), async (_instance: Relay, durable) => {
      const sql = durable.storage.sql;
      const now = Math.floor(Date.now() / 1000);
      const state = readChatState(sql);
      // A relay that has never had a conversation: the watermark is 0, so
      // the cutoff is 0, so the sweep returns before the COUNT. Every
      // cron tick on a relay with no group costs one row read and this.
      const written = measureRowsWritten(sql, (metered) =>
        sweepChat(metered, state, now, CHAT_SWEEP_BATCH_SIZE, true),
      );
      expect(written).toBe(0);
    });
  });
});

// The one figure a reader of CLAUDE.md "The budget" will want to check
// against the constant rather than against the prose.
describe("the derived constants", () => {
  it("sizes one tick's sweep at five percent of the day's rows-written ceiling", () => {
    // 100,000 / 20 = 5,000 rows a tick, at the charged cost of a two-tag
    // message (20), which is 250 messages: an ordinary evening in one or
    // two ticks, a backlog at 6,000 a day.
    expect(CHAT_SWEEP_BATCH_SIZE).toBe(250);
  });

  it("keeps the backlog window well inside the idle window", () => {
    // If these ever crossed, chatHorizon's MIN would stop distinguishing
    // "in use" from "empty" and rule 4 would collapse into rule 3.
    expect(CHAT_BACKLOG_SECONDS).toBeLessThan(CONVERSATION_IDLE_SECONDS);
  });

  it("names the one kind that expires, and it is not the member list", () => {
    expect(GROUP_CHAT_KIND).toBe(9);
    expect(GROUP_MEMBERS_KIND).not.toBe(GROUP_CHAT_KIND);
    expect(PUBLIC_SCOPE).not.toBe(GROUP_SCOPE);
  });
});
