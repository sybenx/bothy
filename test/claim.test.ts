// TOFU claim flow (CLAUDE.md "What it is" / "Claim implementation").
//
// The global test env injects a fixed OWNER_PUBKEY binding (see
// DECISIONS.md's "Test-only OWNER_PUBKEY" entry and
// test/ownership.test.ts) so the write-gate tests have a deterministic
// owner without depending on this chunk's claim endpoint. That same
// binding means every DO instance in this test run already has
// env.OWNER_PUBKEY set -- there is no way, under the current global
// vitest config, to exercise the *unclaimed* relay over the wire or
// over HTTP. So:
//   - the "OWNER_PUBKEY set" path (claim endpoint disabled) is tested
//     end-to-end over HTTP, matching the actual test environment;
//   - the TOFU storage path itself (claimOwner/getOwnerPubkey/atomicity)
//     is tested directly against real SqlStorage via
//     runInDurableObject, passing a hand-built env with OWNER_PUBKEY
//     unset -- the same one deliberate exception to "test over the
//     wire" that test/nip40-expiration.test.ts documents for its own
//     reason.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normalizePubkey } from "../src/pubkey";
import { claimOwner, getOwnerPubkey, getOwnerProfile } from "../src/ownership";
import { profileCacheSize, resetProfileCache } from "../src/profile-lookup";
import type { Relay } from "../src/relay";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, randomKeypair } from "./helpers/keys";

isolateStorage();

const UNCLAIMED_ENV = { OWNER_PUBKEY: undefined } as unknown as Env;

describe("POST /api/claim (OWNER_PUBKEY set in env)", () => {
  it("returns 404 -- the env override disables the claim endpoint entirely", async () => {
    const response = await exports.default.fetch("https://example.com/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: OWNER_PUBKEY_HEX }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects non-POST methods before touching the relay", async () => {
    const response = await exports.default.fetch("https://example.com/api/claim", { method: "GET" });
    expect(response.status).toBe(405);
  });

  it("rejects a malformed JSON body with 400", async () => {
    const response = await exports.default.fetch("https://example.com/api/claim", {
      method: "POST",
      body: "not json",
    });
    expect(response.status).toBe(400);
  });

  it("refuses without reaching the network", async () => {
    // /api/claim had the same shape /api/profile did: it opened two
    // outbound WebSockets to well-known relays to resolve the pubkey's
    // kind-0 *before* anything had established the claim could succeed,
    // and it stayed open to anyone long after the one claim it exists for
    // had happened. A relay that answers "already claimed" -- or 404,
    // here -- must not make two connections on somebody else's behalf to
    // say so.
    //
    // As in test/stats.test.ts, the status code cannot show this and a
    // cache entry is the only trace a lookup leaves.
    resetProfileCache();
    const response = await exports.default.fetch("https://example.com/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: OWNER_PUBKEY_HEX }),
    });

    expect(response.status).toBe(404);
    expect(profileCacheSize()).toBe(0);
  });

  it("answers a malformed pubkey the same way claim() would, not the way the checks are cheapest", async () => {
    // The Worker's three pre-checks are in claim()'s order --
    // disabled, then invalid, then conflict -- and not in cost order,
    // which would have put the free format check first. That matters: an
    // env-disabled relay must look identical whatever you send it, and
    // answering 400 here would tell a caller their pubkey was the problem
    // on a relay that was never going to accept any pubkey at all. Same
    // status, either side of the RPC boundary.
    const response = await exports.default.fetch("https://example.com/api/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pubkey: "not-a-pubkey" }),
    });
    expect(response.status).toBe(404);

    const direct = await runInDurableObject(
      env.RELAY.get(env.RELAY.idFromName("relay")) as DurableObjectStub<Relay>,
      async (instance) => instance.claim("not-a-pubkey"),
    );
    expect(direct.status).toBe("disabled");
  });
});

describe("TOFU claim storage (env.OWNER_PUBKEY unset)", () => {
  it("is unclaimed until a claim is written", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(getOwnerPubkey(state.storage.sql, UNCLAIMED_ENV)).toBeNull();
    });
  });

  it("accepts the first claim and binds the pubkey permanently", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const claimant = randomKeypair().pubkeyHex;

    await runInDurableObject(stub, async (_instance, state) => {
      const accepted = claimOwner(state.storage.sql, claimant);
      expect(accepted).toBe(true);
      expect(getOwnerPubkey(state.storage.sql, UNCLAIMED_ENV)).toBe(claimant);
    });
  });

  it("refuses a second claim even from a different pubkey (409-equivalent: returns false)", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const first = randomKeypair().pubkeyHex;
    const second = randomKeypair().pubkeyHex;

    await runInDurableObject(stub, async (_instance, state) => {
      expect(claimOwner(state.storage.sql, first)).toBe(true);
      expect(claimOwner(state.storage.sql, second)).toBe(false);
      // The first claim wins -- ownership does not move.
      expect(getOwnerPubkey(state.storage.sql, UNCLAIMED_ENV)).toBe(first);
    });
  });
});

describe("claim-time profile storage", () => {
  it("stores the owner's kind-0 name/picture/about/website passed at claim time", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const claimant = randomKeypair().pubkeyHex;

    await runInDurableObject(stub, async (_instance, state) => {
      expect(
        claimOwner(state.storage.sql, claimant, {
          name: "alice",
          picture: "https://example.com/a.png",
          // Backs the kind-0 rung of the NIP-11 description -- see
          // nip11.ts resolveDescription.
          about: "notes and other stuff",
          // Backs NIP-11's `contact` -- see nip11.ts resolveContact.
          website: "https://alice.example",
        }),
      ).toBe(true);
      expect(getOwnerProfile(state.storage.sql, UNCLAIMED_ENV)).toEqual({
        name: "alice",
        picture: "https://example.com/a.png",
        about: "notes and other stuff",
        website: "https://alice.example",
      });
    });
  });

  it("stores null profile fields when no profile is given -- lookup failure is not blocking", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    const claimant = randomKeypair().pubkeyHex;

    await runInDurableObject(stub, async (_instance, state) => {
      expect(claimOwner(state.storage.sql, claimant)).toBe(true);
      expect(getOwnerProfile(state.storage.sql, UNCLAIMED_ENV)).toEqual({
        name: null,
        picture: null,
        about: null,
        website: null,
      });
    });
  });

  it("returns null when OWNER_PUBKEY is set in env -- no storage row to read a profile from", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(getOwnerProfile(state.storage.sql, { OWNER_PUBKEY: OWNER_PUBKEY_HEX } as unknown as Env)).toBeNull();
    });
  });
});

describe("pubkey normalization", () => {
  it("accepts 64-char lowercase hex unchanged", () => {
    expect(normalizePubkey(OWNER_PUBKEY_HEX)).toBe(OWNER_PUBKEY_HEX);
  });

  it("decodes a valid npub to its hex pubkey", () => {
    // bech32("npub", OWNER_PUBKEY_HEX) -- see CLAUDE.md "Accept npub1...
    // and hex, normalize to hex at the boundary".
    const npub = "npub17vjpx0uj7gp4xlxhl8z0rncs0qpqzkg3rgvy27qfec7pr9gdsl4suwp7ea";
    expect(normalizePubkey(npub)).toBe(OWNER_PUBKEY_HEX);
  });

  it("rejects a string that is neither hex nor npub", () => {
    expect(normalizePubkey("not-a-key")).toBeNull();
  });

  it("rejects an npub with a bad checksum", () => {
    expect(normalizePubkey("npub1invalidchecksumvalue0000000000000000000000000000000")).toBeNull();
  });
});
