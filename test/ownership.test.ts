// Owner-only writes (ROADMAP.md chunk 2; CLAUDE.md "Threat model": "Writes
// are owner-only and signature-verified"). "restricted: not allowed to
// write." is one of NIP-01's own worked examples for the `restricted`
// prefix (nips/01.md line 173).
//
// The OWNER_PUBKEY fixture here is injected as a miniflare binding in
// vitest.config.ts, matching CLAUDE.md's documented env-override path:
// "If OWNER_PUBKEY is set in env, skip storage entirely, use the env
// value." The TOFU claim flow itself is chunk 4's job, not this suite's.
import { describe, expect, it, vi } from "vitest";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_SECRET_KEY_HEX, randomKeypair } from "./helpers/keys";
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
    expect(message).toBe("restricted: not allowed to write.");
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
    expect(message).toBe("restricted: not allowed to write.");
    // Schnorr verification is the most expensive per-event operation
    // (CLAUDE.md "The budget") -- a non-owner write is rejected on the
    // pubkey check alone, before it's ever paid for.
    expect(verifySignature).not.toHaveBeenCalled();
    conn.close();
  });
});
