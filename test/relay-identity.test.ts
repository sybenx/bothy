// The relay's own signing identity (src/relay-identity.ts) -- generated
// once at schema-init time, independent of the TOFU claim step, so it
// exists under OWNER_PUBKEY the same way it does for a freshly deployed,
// unclaimed relay. NIP-29 will need this to sign group metadata events
// "directly" as the relay; this chunk adds the identity only.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateRelayKeypair, getRelayPubkey, signAsRelay } from "../src/relay-identity";
import { forgetSchemaHash, initSchema } from "../src/schema";
import type { Relay } from "../src/relay";
import { isolateStorage } from "./helpers/isolate";

isolateStorage();

const HEX64 = /^[0-9a-f]{64}$/;
const stub = () => env.RELAY.get(env.RELAY.idFromName("relay"));

describe("generateRelayKeypair", () => {
  it("produces a 32-byte secret key and a matching x-only public key", () => {
    const { secretKeyHex, publicKeyHex } = generateRelayKeypair();
    expect(secretKeyHex).toMatch(HEX64);
    expect(publicKeyHex).toMatch(HEX64);
    expect(publicKeyHex).toBe(bytesToHex(schnorr.getPublicKey(hexToBytes(secretKeyHex))));
  });

  it("never repeats a keypair across calls", () => {
    const a = generateRelayKeypair();
    const b = generateRelayKeypair();
    expect(a.secretKeyHex).not.toBe(b.secretKeyHex);
    expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
  });
});

describe("schema-init seeding", () => {
  it("seeds exactly one relay_identity row on a fresh database", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const rows = state.storage.sql
        .exec<{ secret_key: string; public_key: string }>(`SELECT secret_key, public_key FROM relay_identity`)
        .toArray();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.secret_key).toMatch(HEX64);
      expect(rows[0]!.public_key).toMatch(HEX64);
    });
  });

  it("keeps the same keypair across a later schema reconcile", async () => {
    // Mirrors test/stats.test.ts "seeds once ... and never recounts":
    // a reconcile pass must not mint a second keypair underneath
    // whatever this relay has already published signed as itself.
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const before = getRelayPubkey(sql);
      forgetSchemaHash(sql);
      initSchema(sql);
      expect(getRelayPubkey(sql)).toBe(before);
      expect(sql.exec(`SELECT COUNT(*) AS n FROM relay_identity`).toArray()[0]).toEqual({ n: 1 });
    });
  });
});

describe("signAsRelay", () => {
  it("produces a signature that verifies against the relay's own pubkey", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      const pubkey = getRelayPubkey(sql);
      const messageHex = "ab".repeat(32);
      const sigHex = signAsRelay(sql, messageHex);
      expect(
        schnorr.verify(hexToBytes(sigHex), hexToBytes(messageHex), hexToBytes(pubkey)),
      ).toBe(true);
    });
  });
});

describe("exposure on /api/stats and NIP-11", () => {
  it("publishes a stable relay pubkey on /api/stats", async () => {
    const first = (await (await exports.default.fetch("https://example.com/api/stats")).json()) as {
      relayPubkey: string;
    };
    expect(first.relayPubkey).toMatch(HEX64);

    const second = (await (await exports.default.fetch("https://example.com/api/stats")).json()) as {
      relayPubkey: string;
    };
    expect(second.relayPubkey).toBe(first.relayPubkey);
  });

  it("publishes the same relay pubkey in the NIP-11 document", async () => {
    const stats = (await (await exports.default.fetch("https://example.com/api/stats")).json()) as {
      relayPubkey: string;
    };
    const info = (await (
      await exports.default.fetch("https://example.com/", { headers: { Accept: "application/nostr+json" } })
    ).json()) as { self: string };
    expect(info.self).toBe(stats.relayPubkey);
  });
});

// The property the task actually cares about: whatever this relay's
// secret key is, it appears in no response body -- not /api/stats, not
// NIP-11, not the NIP-86 management API. Mirrors test/stats.test.ts's
// "publishes a count and never the pubkeys of pending vanish requests",
// which asserts absence against the whole serialized body rather than
// one field, so a leak through a field nobody thought to name is still
// caught.
describe("the secret key never leaves the Durable Object", () => {
  it("is absent from /api/stats, the NIP-11 document, and NIP-86 responses", async () => {
    const secretKeyHex = await runInDurableObject(stub(), async (_instance, state) =>
      state.storage.sql.exec<{ secret_key: string }>(`SELECT secret_key FROM relay_identity`).toArray()[0]!
        .secret_key,
    );

    const stats = await exports.default.fetch("https://example.com/api/stats");
    expect(await stats.text()).not.toContain(secretKeyHex);

    const nip11 = await exports.default.fetch("https://example.com/", {
      headers: { Accept: "application/nostr+json" },
    });
    expect(await nip11.text()).not.toContain(secretKeyHex);

    const management = await exports.default.fetch("https://example.com/", {
      method: "POST",
      headers: { "Content-Type": "application/nostr+json+rpc" },
      body: JSON.stringify({ method: "supportedmethods", params: [] }),
    });
    expect(JSON.stringify(await management.json())).not.toContain(secretKeyHex);
  });

  it("is absent from the Relay.getIdentity and Relay.getStats RPC results", async () => {
    const secretKeyHex = await runInDurableObject(stub(), async (_instance, state) =>
      state.storage.sql.exec<{ secret_key: string }>(`SELECT secret_key FROM relay_identity`).toArray()[0]!
        .secret_key,
    );

    const identity = await runInDurableObject(stub(), (instance: Relay) => instance.getIdentity());
    expect(JSON.stringify(identity)).not.toContain(secretKeyHex);

    const stats = await runInDurableObject(stub(), (instance: Relay) => instance.getStats());
    expect(JSON.stringify(stats)).not.toContain(secretKeyHex);
  });
});
