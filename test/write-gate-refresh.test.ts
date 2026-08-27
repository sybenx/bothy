// Immediate follow cache refresh on an owner-authored kind-3
// (CLAUDE.md "The budget" "immediate write-gate refresh"; CLAUDE.md "Owner-only
// writes"). Before this, refreshFollows only ran on the hourly cron
// (Relay.runCron), so a follow added moments ago couldn't write for up to
// an hour, and a relay whose owner had never published a kind-3 here had a
// silently empty allowlist.
//
// isAllowedWriter is mocked to always accept so a non-owner kind-3 can
// reach relay.ts's acceptEvent path at all -- with the real gate,
// ALLOW_FOLLOWS would have to be on *and* the sender already a follow just
// to get this far, which would obscure the thing actually under test
// here: that relay.ts's own `event.pubkey === owner` check, not
// isAllowedWriter, is what decides whether a stored event triggers a
// refresh. refreshFollows is wrapped, not replaced, so the real
// cache-rebuild logic still runs and can be asserted on.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

// ALLOW_FOLLOWS is an opt-out (ownership.ts allowFollowsEnabled), so the
// global test env's unset value already means follows mode is on -- but
// refreshFollows is still wrapped to force ALLOW_FOLLOWS on explicitly
// (mirroring the custom FOLLOWS_ENV test/follows.test.ts builds), so the
// assertions below don't depend on the default staying what it is today.
vi.mock("../src/ownership", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ownership")>();
  return {
    ...actual,
    isAllowedWriter: vi.fn(() => ({ allowed: true }) as const),
    refreshFollows: vi.fn((sql: SqlStorage, env: Env) =>
      actual.refreshFollows(sql, { ...env, ALLOW_FOLLOWS: "true" }),
    ),
  };
});

isolateStorage();

describe("immediate follow refresh on owner writes", () => {
  it("a stored owner kind-3 updates the follow cache immediately", async () => {
    const { refreshFollows } = await import("../src/ownership");
    vi.mocked(refreshFollows).mockClear();

    const friend = randomKeypair();
    const contacts = signEvent(OWNER_SECRET_KEY_HEX, { kind: 3, tags: [["p", friend.pubkeyHex]] });
    const conn = await connectRelay();
    const [, , ok] = await publish(conn, contacts);
    conn.close();

    expect(ok).toBe(true);
    expect(refreshFollows).toHaveBeenCalledTimes(1);

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const rows = state.storage.sql.exec(`SELECT pubkey FROM follows`).toArray();
      expect(rows).toEqual([{ pubkey: friend.pubkeyHex }]);
    });
  });

  it("a stored non-owner kind-3 does not touch the follow cache", async () => {
    const { refreshFollows } = await import("../src/ownership");
    vi.mocked(refreshFollows).mockClear();

    const stranger = randomKeypair();
    const contacts = signEvent(stranger.secretKeyHex, { kind: 3, tags: [["p", randomKeypair().pubkeyHex]] });
    const conn = await connectRelay();
    const [, , ok] = await publish(conn, contacts);
    conn.close();

    // isAllowedWriter is mocked to always accept, so this stores fine --
    // it's relay.ts's own owner check, not authorization, being tested.
    expect(ok).toBe(true);
    expect(refreshFollows).not.toHaveBeenCalled();
  });
});
