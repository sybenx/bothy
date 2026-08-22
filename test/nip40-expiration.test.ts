// NIP-40 Expiration Timestamp (nips/40.md): the `expiration` tag marks
// when an event SHOULD be deleted. Two independent relay behaviors are
// specified (lines 43-49):
//   1. "Relays SHOULD drop any events that are published to them if they
//      are expired" -- checked at write time, against "now".
//   2. "Relays SHOULD NOT send expired events to clients, even if they
//      are stored" -- checked at read time, independent of (1) since a
//      relay MAY persist expired events (line 46).
//
// (1) is tested through the wire protocol like everything else in this
// suite. (2) cannot be: an event that is expired *at write time* is
// already covered by (1), and there is no wire-protocol way to store an
// event that is expired only *by the time it's queried* without
// controlling wall-clock time. So (2) seeds the row directly into the
// `events` table (schema.ts, chunk 1's frozen schema) to simulate "stored
// while valid, expired by query time" -- the one deliberate exception to
// this suite's black-box-over-the-wire rule.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { collectStored, connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-40 expiration", () => {
  it("stores and returns an event carrying a not-yet-passed expiration tag", async () => {
    const conn = await connectRelay();
    const farFuture = 4102444800; // 2100-01-01T00:00:00Z
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "expires eventually",
      tags: [["expiration", String(farFuture)]],
    });

    const [, , ok] = await publish(conn, event);
    expect(ok).toBe(true);

    const events = await collectStored(conn, "subNotExpired", [{ ids: [event.id] }]);
    expect(events.map((e) => e.id)).toEqual([event.id]);
    conn.close();
  });

  it("drops an incoming event whose expiration has already passed", async () => {
    const conn = await connectRelay();
    const alreadyPast = 1700000000; // 2023-11-14T22:13:20Z
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "already expired",
      tags: [["expiration", String(alreadyPast)]],
    });

    const [, id, ok, message] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(false);
    expect(message.startsWith("invalid:")).toBe(true);
    conn.close();
  });

  it("does not return a stored event whose expiration has since passed", async () => {
    const alreadyPast = 1700000000; // 2023-11-14T22:13:20Z
    const event = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 1,
      content: "stale",
      created_at: alreadyPast - 100,
      tags: [["expiration", String(alreadyPast)]],
    });

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        alreadyPast,
      );
    });

    const conn = await connectRelay();
    const events = await collectStored(conn, "subExpiredRead", [{ ids: [event.id] }]);

    expect(events).toEqual([]);
    conn.close();
  });
});
