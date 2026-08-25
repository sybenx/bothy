// The NIP-98 gate in front of the NIP-86 management API (src/nip98.ts,
// called from src/index.ts handleManagement). Every reject path is
// asserted as carefully as the accept path, because this gate is the only
// thing standing between a stranger and the relay's management surface --
// nips/98.md: "Failed validation should return a 401 Unauthorized
// response."
//
// The owner here is the OWNER_PUBKEY binding from vitest.config.ts (see
// test/helpers/keys.ts), so "the owner" and "a stranger" are just two
// keypairs.
import { describe, expect, it } from "vitest";
import { HTTP_AUTH_KIND, HTTP_AUTH_MAX_DRIFT_SECONDS } from "../src/nip98";
import { callManagement, MANAGEMENT_URL, nip98Header } from "./helpers/management";
import { isolateStorage } from "./helpers/isolate";
import { randomKeypair } from "./helpers/keys";

isolateStorage();

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

describe("NIP-98 authentication of management requests", () => {
  it("accepts a correctly signed request from the relay owner", async () => {
    const reply = await callManagement("supportedmethods");
    expect(reply.status).toBe(200);
    expect(Array.isArray(reply.result)).toBe(true);
  });

  it("rejects a valid signature from someone who is not the owner", async () => {
    // The event itself is perfectly well formed -- correct kind, fresh
    // timestamp, right tags, verifying signature. It is only the wrong
    // key, which is the entire point.
    const stranger = randomKeypair();
    const reply = await callManagement("supportedmethods", [], { secretKeyHex: stranger.secretKeyHex });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain("owner");
    expect(reply.result).toBeUndefined();
  });

  it("rejects a request with no Authorization header at all", async () => {
    const reply = await callManagement("supportedmethods", [], { omitAuthHeader: true });
    expect(reply.status).toBe(401);
  });

  it("rejects an Authorization header using a scheme other than Nostr", async () => {
    const reply = await callManagement("supportedmethods", [], { authHeader: "Bearer some-token" });
    expect(reply.status).toBe(401);
  });

  it("rejects an Authorization header whose base64 does not decode to an event", async () => {
    const reply = await callManagement("supportedmethods", [], { authHeader: `Nostr ${btoa("not-an-event")}` });
    expect(reply.status).toBe(401);
  });

  it("rejects an event of the wrong kind", async () => {
    const reply = await callManagement("supportedmethods", [], { kind: HTTP_AUTH_KIND + 1 });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain(String(HTTP_AUTH_KIND));
  });

  it("rejects an event whose created_at is older than the window", async () => {
    const reply = await callManagement("supportedmethods", [], {
      createdAt: nowSec() - HTTP_AUTH_MAX_DRIFT_SECONDS - 10,
    });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain("window");
  });

  it("rejects an event whose created_at is in the future beyond the window", async () => {
    // A signature from the future is no more trustworthy than a stale
    // one -- the window is checked in both directions.
    const reply = await callManagement("supportedmethods", [], {
      createdAt: nowSec() + HTTP_AUTH_MAX_DRIFT_SECONDS + 10,
    });
    expect(reply.status).toBe(401);
  });

  it("rejects an event whose 'u' tag names a different URL", async () => {
    const reply = await callManagement("supportedmethods", [], { u: "https://someone-elses-relay.example/" });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain("'u' tag");
  });

  it("rejects an event with no 'u' tag", async () => {
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    // Built by hand rather than through nip98Header, which always emits
    // a 'u' tag.
    const reply = await callManagement("supportedmethods", [], {
      authHeader: nip98Header(body, { u: "" }),
    });
    expect(reply.status).toBe(401);
  });

  it("accepts a 'u' tag that differs from the request URL only by canonicalization", async () => {
    // An operator signing the relay's own URL by hand writes
    // "https://example.com", not "https://example.com/". Those address
    // the same request, and the binding to host, path and query is still
    // exact -- see sameUrl in src/nip98.ts.
    const reply = await callManagement("supportedmethods", [], { u: "https://example.com" });
    expect(reply.status).toBe(200);
  });

  it("rejects an event whose 'method' tag does not match the HTTP method", async () => {
    const reply = await callManagement("supportedmethods", [], { methodTag: "GET" });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain("'method' tag");
  });

  it("rejects an event with no 'payload' tag, which NIP-86 requires even though NIP-98 does not", async () => {
    const reply = await callManagement("supportedmethods", [], { omitPayloadTag: true });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain("payload");
  });

  it("rejects a 'payload' tag that is not the SHA256 of the request body", async () => {
    // The signature is valid and the key is right; only the body binding
    // is wrong -- which is how a replayed authorization would look if it
    // were pointed at a different command.
    const reply = await callManagement("supportedmethods", [], { payload: "0".repeat(64) });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain("payload");
  });

  it("rejects an authorization signed over a different command's body", async () => {
    const otherBody = JSON.stringify({ method: "listbannedevents", params: [] });
    const reply = await callManagement("banevent", ["a".repeat(64)], {
      authHeader: nip98Header(otherBody),
    });
    expect(reply.status).toBe(401);
  });

  it("rejects an event whose signature does not verify", async () => {
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    const header = nip98Header(body);
    const event = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0)))) as {
      sig: string;
    };
    event.sig = (event.sig[0] === "0" ? "1" : "0") + event.sig.slice(1);
    const reply = await callManagement("supportedmethods", [], {
      authHeader: `Nostr ${btoa(JSON.stringify(event))}`,
    });
    expect(reply.status).toBe(401);
    expect(reply.error).toContain("signature");
  });

  it("does not route a management request to the NIP-11 document when it also carries an Accept header", async () => {
    // "application/nostr+json+rpc" contains "application/nostr+json", so
    // the content-type check has to run first -- see the ordering comment
    // in src/index.ts.
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    const { exports } = await import("cloudflare:workers");
    const response = await exports.default.fetch(
      new Request(MANAGEMENT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/nostr+json+rpc; charset=utf-8",
          Accept: "application/nostr+json",
          Authorization: nip98Header(body),
        },
        body,
      }),
    );
    expect(response.headers.get("Content-Type")).toBe("application/nostr+json+rpc");
    const parsed = (await response.json()) as { result?: unknown };
    expect(Array.isArray(parsed.result)).toBe(true);
  });
});
