// Two CPU/budget-relevant orderings on the write path (relay.ts
// acceptEvent, storage.ts storeEvent) that are invisible in normal
// testing -- both would still leave "ok" wire behavior unchanged if
// broken, and only show up as extra schnorr calls or extra rows written.
//
// 1. The tombstone check (storage.ts isDeleted) runs before signature
//    verification, for the same CPU reason the ownership check in
//    handleEvent runs before it (test/ownership.test.ts): a tombstoned
//    id can never legitimately be re-stored, so there's no reason to pay
//    for schnorr first. Proved with a deliberately bad signature -- if
//    verifySignature ran first, it would be called (and reject) before
//    the tombstone check ever got a chance to.
// 2. Ephemeral kinds (20000-29999, NIP-01) short-circuit in storeEvent
//    before any row is written -- proved by asserting the raw row count
//    directly against SqlStorage, not just that a later REQ returns
//    nothing (which test/nip01-kinds.test.ts already covers, but only
//    proves the *read* path agrees with storage, not that no write ever
//    happened).
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { signEvent, withCorruptSignature } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

vi.mock("../src/validate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validate")>();
  return { ...actual, verifySignature: vi.fn(actual.verifySignature) };
});

isolateStorage();

describe("write path: tombstone check precedes signature verification", () => {
  it("rejects a tombstoned id's replay without calling verifySignature, even with a bad signature", async () => {
    const conn = await connectRelay();
    const target = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "delete me" });
    await publish(conn, target);

    const deletion = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 5,
      tags: [["e", target.id], ["k", "1"]],
      content: "",
    });
    await publish(conn, deletion);

    const { verifySignature } = await import("../src/validate");
    vi.mocked(verifySignature).mockClear();

    const replay = withCorruptSignature(target);
    const [, id, ok, message] = await publish(conn, replay);

    expect(id).toBe(target.id);
    expect(ok).toBe(false);
    expect(message.startsWith("blocked:")).toBe(true);
    // If the tombstone check ran after signature verification, this bad
    // signature would have been rejected as "invalid:", not "blocked:",
    // and verifySignature would show a call here.
    expect(verifySignature).not.toHaveBeenCalled();
    conn.close();
  });
});

describe("write path: ephemeral kinds write zero rows", () => {
  it("does not insert a row for an ephemeral-kind event", async () => {
    const conn = await connectRelay();
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));

    const countBefore = await countEvents(stub);
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 20001, content: "ephemeral" });
    const [, , ok] = await publish(conn, event);
    const countAfter = await countEvents(stub);

    expect(ok).toBe(true);
    expect(countAfter).toBe(countBefore);
    conn.close();
  });
});

async function countEvents(stub: DurableObjectStub): Promise<number> {
  let count = -1;
  await runInDurableObject(stub, async (_instance, state) => {
    count = state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM events`).toArray()[0]?.n ?? -1;
  });
  return count;
}
