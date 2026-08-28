// Owner-gated writes (CLAUDE.md "Threat model": "Writes
// are owner-only and signature-verified" for anyone not the owner or,
// under the ALLOW_FOLLOWS default, one of the owner's follows).
//
// The global test env leaves ALLOW_FOLLOWS unset (vitest.config.ts), which
// under the opt-out default (ownership.ts allowFollowsEnabled) means
// follows mode is ON -- a non-owner stranger here is rejected for not
// being a follow, not for a blanket owner-only rule. See
// test/follows.test.ts for the ALLOW_FOLLOWS=false owner-only case.
//
// The OWNER_PUBKEY fixture here is injected as a miniflare binding in
// vitest.config.ts, matching CLAUDE.md's documented env-override path:
// "If OWNER_PUBKEY is set in env, skip storage entirely, use the env
// value." The TOFU claim flow itself is test/claim.test.ts's job, not
// this suite's.
import { describe, expect, it, vi } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
import { getOwnerPubkey } from "../src/ownership";
import { connectRelay, publish } from "./helpers/socket";

// Partial mock: keep every real export of validate.ts except wrap
// verifySignature in a spy, so tests below can assert it was (or wasn't)
// called without changing its behavior.
vi.mock("../src/validate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/validate")>();
  return { ...actual, verifySignature: vi.fn(actual.verifySignature) };
});

isolateStorage();

describe("ownership write gate", () => {
  it("accepts a well-formed event from the owner pubkey", async () => {
    const conn = await connectRelay();
    const event = signEvent(OWNER_SECRET_KEY_HEX, { kind: 1, content: "mine" });

    const [, , ok] = await publish(conn, event);

    expect(ok).toBe(true);
    conn.close();
  });

  it("rejects a well-formed, validly signed event from a non-owner pubkey", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const event = signEvent(stranger.secretKeyHex, { kind: 1, content: "not mine" });

    const [, id, ok, message] = await publish(conn, event);

    expect(id).toBe(event.id);
    expect(ok).toBe(false);
    expect(message).toBe(
      "restricted: only the owner and people they follow can publish here",
    );
    conn.close();
  });

  it("rejects non-owner writes regardless of kind", async () => {
    const conn = await connectRelay();
    const stranger = randomKeypair();
    const deletion = signEvent(stranger.secretKeyHex, {
      kind: 5,
      tags: [["e", "0".repeat(64)]],
    });

    const [, , ok, message] = await publish(conn, deletion);

    expect(ok).toBe(false);
    expect(message.startsWith("restricted:")).toBe(true);
    conn.close();
  });

  it("rejects a non-owner event without calling signature verification", async () => {
    const { verifySignature } = await import("../src/validate");
    vi.mocked(verifySignature).mockClear();

    const conn = await connectRelay();
    const stranger = randomKeypair();
    const event = signEvent(stranger.secretKeyHex, { kind: 1, content: "not mine" });

    const [, , ok, message] = await publish(conn, event);

    expect(ok).toBe(false);
    expect(message).toBe(
      "restricted: only the owner and people they follow can publish here",
    );
    // Schnorr verification is the most expensive per-event operation
    // (CLAUDE.md "The budget") -- a non-owner write is rejected on the
    // pubkey check alone, before it's ever paid for.
    expect(verifySignature).not.toHaveBeenCalled();
    conn.close();
  });
});

// OWNER_PUBKEY was the one pubkey boundary in this project that did not
// normalize (pubkey.ts normalizePubkey covers /api/claim, NIP-86's
// banpubkey, and every bech32 form a client can paste). The value it
// returns is compared against `event.pubkey`, which is always lowercase
// hex, so an operator who set an npub -- the form every nostr client
// shows them -- got a relay where the owner could not write, could not
// read their own gift wraps, and could not be addressed by one, with
// nothing anywhere saying why.
describe("OWNER_PUBKEY normalization", () => {
  // NIP-19's own test vector (nips/19.md), so the pair below is the
  // spec's rather than this suite's -- an operator pasting an npub is
  // pasting exactly this shape.
  const OWNER_NPUB = "npub1sn0wdenkukak0d9dfczzeacvhkrgz92ak56egt7vdgzn8pv2wfqqhrjdv9";
  const OWNER_NPUB_HEX = "84dee6e676e5bb67b4ad4e042cf70cbd8681155db535942fcc6a0533858a7240";
  // Never reached: every case here sets OWNER_PUBKEY, which short-circuits
  // the storage lookup entirely.
  const sql = null as unknown as SqlStorage;
  const withEnv = (value: string) => ({ OWNER_PUBKEY: value }) as unknown as Env;

  it("normalizes an npub to the lowercase hex every comparison uses", () => {
    expect(getOwnerPubkey(sql, withEnv(OWNER_NPUB))).toBe(OWNER_NPUB_HEX);
  });

  it("refuses uppercase hex, the same as every other pubkey boundary", () => {
    // pubkey.ts normalizePubkey takes lowercase hex or bech32 and nothing
    // else, so /api/claim and NIP-86's banpubkey refuse this form too.
    // One rule at every boundary is the point of routing this one through
    // it: refusing here leaves the relay reading as unclaimed, which is
    // visible on the admin page and in the NIP-11 document, where
    // accepting the string verbatim left it claimed by a value that
    // matched no event this relay could ever receive.
    expect(getOwnerPubkey(sql, withEnv(OWNER_PUBKEY_HEX.toUpperCase()))).toBeNull();
  });

  it("passes lowercase hex through unchanged", () => {
    expect(getOwnerPubkey(sql, withEnv(OWNER_PUBKEY_HEX))).toBe(OWNER_PUBKEY_HEX);
  });

  it("resolves a malformed value to null rather than to a string nothing can match", () => {
    // Fails closed, not open: index.ts gates /api/claim on OWNER_PUBKEY
    // being SET rather than on this resolving, so a broken value leaves
    // the relay inert instead of quietly reopening TOFU to a stranger.
    expect(getOwnerPubkey(sql, withEnv("not-a-pubkey"))).toBeNull();
  });

  it("does not serve a memoised answer to a changed value", () => {
    // The lookup is memoised per isolate because it runs on the write
    // path; the memo is keyed on the raw string for this reason.
    expect(getOwnerPubkey(sql, withEnv(OWNER_NPUB))).toBe(OWNER_NPUB_HEX);
    expect(getOwnerPubkey(sql, withEnv("f".repeat(64)))).toBe("f".repeat(64));
    expect(getOwnerPubkey(sql, withEnv(OWNER_NPUB))).toBe(OWNER_NPUB_HEX);
  });
});
