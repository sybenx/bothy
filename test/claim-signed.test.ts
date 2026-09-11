// The QR/signed claim path (CLAUDE.md "What it is"): proof of possession
// via a signed NIP-42 AUTH event, additive to the paste-based TOFU flow
// test/claim.test.ts covers.
//
// Same harness limitation as claim.test.ts, and for the same reason: the
// global test env injects a fixed OWNER_PUBKEY binding (vitest.config.ts),
// so every DO instance in this run is already claimed and there is no way
// to exercise the *unclaimed* relay's three new endpoints over HTTP beyond
// their "disabled" branch. So:
//   - the "OWNER_PUBKEY set" path (all three endpoints disabled) is tested
//     end-to-end over HTTP, matching the actual test environment;
//   - the actual nonce/claim logic (ownership.ts issueClaimNonce,
//     consumeClaimNonce, clearClaimNonces, getClaimStatus, claimOwner's
//     nonce param) is tested directly against real SqlStorage via
//     runInDurableObject, passing a hand-built env with OWNER_PUBKEY
//     unset -- the same exception claim.test.ts documents for itself;
//   - nip42.ts's verifyClaimAuthEvent needs no storage at all and is
//     tested as a pure function against fabricated events;
//   - ownerListsThisRelay runs fine under the normal (claimed) harness,
//     since it only cares whether an owner exists, so it's tested by
//     publishing a real kind-10002 over the wire as the fixed owner key.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CLAIM_NONCE_TTL_SECONDS, MAX_OUTSTANDING_CLAIM_NONCES } from "../src/limits";
import { AUTH_KIND, verifyClaimAuthEvent } from "../src/nip42";
import {
  claimOwner,
  clearClaimNonces,
  consumeClaimNonce,
  getClaimStatus,
  issueClaimNonce,
  ownerListsThisRelay,
} from "../src/ownership";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { connectRelay, publish } from "./helpers/socket";

isolateStorage();

const HOST = "example.com";

describe("QR/signed claim endpoints (OWNER_PUBKEY set in env)", () => {
  it("POST /api/claim-nonce returns 404 -- the env override disables the whole claim flow", async () => {
    const response = await exports.default.fetch("https://example.com/api/claim-nonce", { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("POST /api/claim-nonce rejects non-POST methods before touching the relay", async () => {
    const response = await exports.default.fetch("https://example.com/api/claim-nonce", { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("POST /api/claim-signed returns 404", async () => {
    const response = await exports.default.fetch("https://example.com/api/claim-signed", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(404);
  });

  it("GET /api/claim-status returns 404", async () => {
    const response = await exports.default.fetch("https://example.com/api/claim-status?nonce=x");
    expect(response.status).toBe(404);
  });
});

describe("claim nonce storage (env.OWNER_PUBKEY unset)", () => {
  it("issues a nonce with a ten-minute expiry", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const nowSec = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const result = issueClaimNonce(state.storage.sql, nowSec);
      expect(result).not.toBe("capped");
      if (result === "capped") return;
      expect(result.nonce).toMatch(/^[0-9a-f-]{36}$/);
      expect(result.expiresAt).toBe(nowSec + CLAIM_NONCE_TTL_SECONDS);
    });
  });

  it("refuses once MAX_OUTSTANDING_CLAIM_NONCES unexpired nonces exist", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const nowSec = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      for (let i = 0; i < MAX_OUTSTANDING_CLAIM_NONCES; i++) {
        expect(issueClaimNonce(state.storage.sql, nowSec)).not.toBe("capped");
      }
      expect(issueClaimNonce(state.storage.sql, nowSec)).toBe("capped");
    });
  });

  it("sweeps expired nonces on issuance, so an expired one does not count toward the cap", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const nowSec = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Fill the cap with nonces that are already expired.
      for (let i = 0; i < MAX_OUTSTANDING_CLAIM_NONCES; i++) {
        expect(issueClaimNonce(sql, nowSec - CLAIM_NONCE_TTL_SECONDS - 1)).not.toBe("capped");
      }
      // A fresh issuance sweeps them first, so this succeeds rather than
      // reading "capped" against eight rows that no longer matter.
      const result = issueClaimNonce(sql, nowSec);
      expect(result).not.toBe("capped");
      const remaining = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM claim_nonces`).toArray()[0]?.n;
      expect(remaining).toBe(1);
    });
  });

  it("consumeClaimNonce accepts a live nonce once and refuses it the second time", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const nowSec = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const issued = issueClaimNonce(sql, nowSec);
      if (issued === "capped") throw new Error("unreachable");
      expect(consumeClaimNonce(sql, issued.nonce, nowSec)).toBe(true);
      expect(consumeClaimNonce(sql, issued.nonce, nowSec)).toBe(false);
    });
  });

  it("consumeClaimNonce refuses an expired nonce", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const nowSec = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const issued = issueClaimNonce(sql, nowSec);
      if (issued === "capped") throw new Error("unreachable");
      expect(consumeClaimNonce(sql, issued.nonce, nowSec + CLAIM_NONCE_TTL_SECONDS + 1)).toBe(false);
    });
  });

  it("consumeClaimNonce refuses an unknown nonce", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(consumeClaimNonce(state.storage.sql, "never-issued", Math.floor(Date.now() / 1000))).toBe(false);
    });
  });

  it("clearClaimNonces wipes every outstanding nonce, not just the winning one", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const nowSec = Math.floor(Date.now() / 1000);

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      issueClaimNonce(sql, nowSec);
      issueClaimNonce(sql, nowSec);
      issueClaimNonce(sql, nowSec);
      clearClaimNonces(sql);
      const remaining = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM claim_nonces`).toArray()[0]?.n;
      expect(remaining).toBe(0);
    });
  });
});

describe("claim_nonce on the owner row / getClaimStatus (env.OWNER_PUBKEY unset)", () => {
  it("answers pending before any claim", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(getClaimStatus(state.storage.sql, "whatever")).toBe("pending");
    });
  });

  it("answers claimed for the nonce that won", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const claimant = randomKeypair().pubkeyHex;

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const issued = issueClaimNonce(sql, Math.floor(Date.now() / 1000));
      if (issued === "capped") throw new Error("unreachable");
      expect(claimOwner(sql, claimant, undefined, issued.nonce)).toBe(true);
      expect(getClaimStatus(sql, issued.nonce)).toBe("claimed");
    });
  });

  it("answers claimed-elsewhere for a nonce that did not win", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const claimant = randomKeypair().pubkeyHex;

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const winner = issueClaimNonce(sql, Math.floor(Date.now() / 1000));
      const loser = issueClaimNonce(sql, Math.floor(Date.now() / 1000));
      if (winner === "capped" || loser === "capped") throw new Error("unreachable");
      expect(claimOwner(sql, claimant, undefined, winner.nonce)).toBe(true);
      expect(getClaimStatus(sql, loser.nonce)).toBe("claimed-elsewhere");
    });
  });

  it("answers claimed-elsewhere for any nonce against a relay claimed by paste (claim_nonce is NULL)", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const claimant = randomKeypair().pubkeyHex;

    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // No nonce param -- the plain paste path.
      expect(claimOwner(sql, claimant)).toBe(true);
      expect(getClaimStatus(sql, "any-nonce-at-all")).toBe("claimed-elsewhere");
    });
  });
});

describe("nip42.ts verifyClaimAuthEvent", () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const relayTag = `wss://${HOST}/`;

  function claimEvent(overrides: Partial<Parameters<typeof signEvent>[1]> = {}) {
    return signEvent(OWNER_SECRET_KEY_HEX, {
      kind: AUTH_KIND,
      tags: [
        ["relay", relayTag],
        ["challenge", "a-nonce"],
      ],
      ...overrides,
    });
  }

  it("accepts a well-formed, correctly-signed claim event", () => {
    const result = verifyClaimAuthEvent(claimEvent(), HOST, nowSec);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pubkey).toBe(OWNER_PUBKEY_HEX);
    expect(result.challenge).toBe("a-nonce");
  });

  it("rejects the wrong kind", () => {
    const result = verifyClaimAuthEvent(claimEvent({ kind: 1 }), HOST, nowSec);
    expect(result.ok).toBe(false);
  });

  it("rejects a stale created_at", () => {
    const result = verifyClaimAuthEvent(claimEvent({ created_at: nowSec - 3600 }), HOST, nowSec);
    expect(result.ok).toBe(false);
  });

  it("rejects a relay tag that does not name this host", () => {
    const result = verifyClaimAuthEvent(
      signEvent(OWNER_SECRET_KEY_HEX, {
        kind: AUTH_KIND,
        tags: [
          ["relay", "wss://a-totally-different-relay.example"],
          ["challenge", "a-nonce"],
        ],
      }),
      HOST,
      nowSec,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an event with no challenge tag", () => {
    const result = verifyClaimAuthEvent(
      signEvent(OWNER_SECRET_KEY_HEX, { kind: AUTH_KIND, tags: [["relay", relayTag]] }),
      HOST,
      nowSec,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a corrupted signature", () => {
    const event = claimEvent();
    const corrupted = { ...event, sig: (event.sig[0] === "0" ? "1" : "0") + event.sig.slice(1) };
    const result = verifyClaimAuthEvent(corrupted, HOST, nowSec);
    expect(result.ok).toBe(false);
  });

  it("rejects a malformed body", () => {
    const result = verifyClaimAuthEvent({ not: "an event" }, HOST, nowSec);
    expect(result.ok).toBe(false);
  });
});

describe("ownerListsThisRelay", () => {
  it("is false with no kind-10002 stored", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);

    await runInDurableObject(stub, async (_instance, state) => {
      expect(ownerListsThisRelay(state.storage.sql, env as unknown as Env, HOST)).toBe(false);
    });
  });

  it("is true once the owner's stored kind-10002 names this host", async () => {
    const conn = await connectRelay();
    const relayList = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 10002,
      tags: [["r", `wss://${HOST}/`]],
    });
    const [, , ok] = await publish(conn, relayList);
    expect(ok).toBe(true);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(ownerListsThisRelay(state.storage.sql, env as unknown as Env, HOST)).toBe(true);
    });
  });

  it("is false when the stored kind-10002 names a different host", async () => {
    const conn = await connectRelay();
    const relayList = signEvent(OWNER_SECRET_KEY_HEX, {
      kind: 10002,
      tags: [["r", "wss://a-different-relay.example/"]],
    });
    const [, , ok] = await publish(conn, relayList);
    expect(ok).toBe(true);
    conn.close();

    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(ownerListsThisRelay(state.storage.sql, env as unknown as Env, HOST)).toBe(false);
    });
  });
});
