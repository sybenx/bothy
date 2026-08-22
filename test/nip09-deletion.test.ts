// NIP-09 Event Deletion Request (nips/09.md): kind 5 with e/a tags marks
// referenced events for deletion. "Relays SHOULD delete or stop
// publishing any referenced events" (line 31); "SHOULD continue to
// publish/share the deletion request events indefinitely" (line 33);
// a-tag deletion removes replaceable/addressable versions up to the
// deletion's created_at (line 35); deleting a deletion request has no
// effect (line 53).
//
// Deletion requests here are always owner-authored, since only the owner
// can write (see test/ownership.test.ts) -- every event this relay ever
// stores necessarily shares the deletion request's pubkey, so the "same
// pubkey" requirement in NIP-09 is trivially satisfied and not
// separately testable through the wire protocol.
import { describe, expect, it } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { collectStored, connectRelay, publish } from "./helpers/socket";

isolateStorage();

describe("NIP-09 deletion", () => {
  it("an e-tag deletion request removes the referenced event from REQ results", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "posted by accident",
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subDeleted", [{ ids: [target.id] }]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("the deletion request event itself remains queryable", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "",
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subDeletionEvent", [{ ids: [deletion.id] }]);

    expect(events.map((e) => e.id)).toEqual([deletion.id]);
    conn.close();
  });

  it("an a-tag deletion removes replaceable event versions up to its created_at", async () => {
    const conn = await connectRelay();
    const replaceable = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 10002,
      content: "relay list",
      created_at: 100,
    });
    await publish(conn, replaceable);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["a", `10002:${OWNER_PUBKEY_HEX}:`], ["k", "10002"]],
      content: "",
      created_at: 200,
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subADeleteReplaceable", [
      { kinds: [10002], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("an a-tag deletion removes the matching addressable event by d-tag", async () => {
    const conn = await connectRelay();
    const article = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 30023,
      tags: [["d", "my-article"]],
      content: "draft",
      created_at: 100,
    });
    await publish(conn, article);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["a", `30023:${OWNER_PUBKEY_HEX}:my-article`], ["k", "30023"]],
      content: "",
      created_at: 200,
    });
    await publish(conn, deletion);

    const events = await collectStored(conn, "subADeleteAddressable", [
      { kinds: [30023], authors: [OWNER_PUBKEY_HEX] },
    ]);

    expect(events).toEqual([]);
    conn.close();
  });

  it("publishing a deletion request against a deletion request has no effect", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);
    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "",
    });
    await publish(conn, deletion);

    const undelete = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", deletion.id], ["k", "5"]],
      content: "undo",
    });
    await publish(conn, undelete);

    const events = await collectStored(conn, "subUndelete", [{ ids: [deletion.id] }]);

    expect(events.map((e) => e.id)).toEqual([deletion.id]);
    conn.close();
  });
});
