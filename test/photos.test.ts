// Profile photos (src/photos.ts): a Blossom server (BUD-01 GET/HEAD,
// BUD-02 PUT /upload and DELETE) for members' photos only, stored in the
// Durable Object, bounded per photo, per member, per day and in total.
import { env, exports } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEMBER_REMOVAL_GRACE_SECONDS,
  PHOTO_MAX_BYTES_DEFAULT,
  PHOTO_STORAGE_BYTES_DEFAULT,
  PHOTO_UPLOADS_PER_DAY,
} from "../src/limits";
import { sha256Hex, sniffPhotoType } from "../src/photos";
import type { Relay } from "../src/relay";
import { sweepFormerMembers } from "../src/storage";
import { signEvent } from "./helpers/event";
import { isolateStorage } from "./helpers/isolate";
import { callManagement } from "./helpers/management";
import { OWNER_PUBKEY_HEX, OWNER_SECRET_KEY_HEX, randomKeypair, type Keypair } from "./helpers/keys";

isolateStorage();

const mutableEnv = env as unknown as Record<string, unknown>;

afterEach(() => {
  delete mutableEnv.PHOTO_STORAGE_BYTES;
  delete mutableEnv.PHOTO_MAX_BYTES;
});

function stub() {
  return env.RELAY.get(env.RELAY.idFromName("relay"));
}

let nextIp = 0;
function freshIp(): string {
  nextIp++;
  return `172.31.${(nextIp >> 8) & 0xff}.${nextIp & 0xff}`;
}

// A JPEG as far as the signature goes, with random bytes after it so every
// call is a different photo.
function jpeg(size = 2000): Uint8Array {
  const bytes = new Uint8Array(size);
  // getRandomValues fills at most 64KB per call.
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)));
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
}

function authHeader(
  who: Keypair | { secretKeyHex: string },
  verb: string,
  sha256: string,
  overrides: { expiration?: number; kind?: number; x?: string } = {},
): string {
  const now = Math.floor(Date.now() / 1000);
  const event = signEvent(who.secretKeyHex, {
    kind: overrides.kind ?? 24242,
    content: `${verb} profile photo`,
    tags: [
      ["t", verb],
      ["expiration", String(overrides.expiration ?? now + 300)],
      ["x", overrides.x ?? sha256],
    ],
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

function fetchRelay(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("CF-Connecting-IP", freshIp());
  return exports.default.fetch(new Request(`https://example.com${path}`, { ...init, headers }));
}

async function upload(
  who: Keypair | { secretKeyHex: string },
  bytes: Uint8Array,
  options: { contentType?: string; auth?: string } = {},
): Promise<Response> {
  const sha256 = await sha256Hex(bytes);
  return fetchRelay("/upload", {
    method: "PUT",
    body: bytes,
    headers: {
      Authorization: options.auth ?? authHeader(who, "upload", sha256),
      "Content-Type": options.contentType ?? "image/jpeg",
    },
  });
}

async function member(): Promise<Keypair> {
  const who = randomKeypair();
  await callManagement("allowpubkey", [who.pubkeyHex]);
  return who;
}

const OWNER = { secretKeyHex: OWNER_SECRET_KEY_HEX };

describe("uploading and fetching a photo", () => {
  it("stores a member's photo and serves it to anyone by its hash", async () => {
    const alice = await member();
    const bytes = jpeg();
    const response = await upload(alice, bytes);
    expect(response.status).toBe(200);
    const sha256 = await sha256Hex(bytes);
    const descriptor = (await response.json()) as Record<string, unknown>;
    expect(descriptor).toEqual({
      url: `https://example.com/${sha256}.jpg`,
      sha256,
      size: bytes.byteLength,
      type: "image/jpeg",
      uploaded: expect.any(Number),
    });

    for (const path of [`/${sha256}`, `/${sha256}.jpg`]) {
      const got = await fetchRelay(path);
      expect(got.status).toBe(200);
      expect(got.headers.get("Content-Type")).toBe("image/jpeg");
      expect(got.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(bytes);
    }
    const head = await fetchRelay(`/${sha256}`, { method: "HEAD" });
    expect([head.status, head.headers.get("Content-Length")]).toEqual([200, String(bytes.byteLength)]);
    expect((await fetchRelay(`/${"0".repeat(64)}`)).status).toBe(404);
  });

  it("takes the owner's photo too", async () => {
    expect((await upload(OWNER, jpeg())).status).toBe(200);
  });

  it("takes an admin's photo, since an admin is a member", async () => {
    const admin = randomKeypair();
    expect((await callManagement("addadmin", [admin.pubkeyHex])).result).toBe(true);
    expect((await upload(admin, jpeg())).status).toBe(200);
  });

  it("refuses anyone who is not a member", async () => {
    const response = await upload(randomKeypair(), jpeg());
    expect(response.status).toBe(403);
    expect(response.headers.get("X-Reason")).toBe("only this relay's members can store a photo here");
  });

  it("keeps one photo per member: a new one replaces the last", async () => {
    const alice = await member();
    const first = jpeg();
    const second = jpeg();
    await upload(alice, first);
    await upload(alice, second);
    expect((await fetchRelay(`/${await sha256Hex(first)}`)).status).toBe(404);
    expect((await fetchRelay(`/${await sha256Hex(second)}`)).status).toBe(200);
  });

  it("does not list photos", async () => {
    const alice = await member();
    await upload(alice, jpeg());
    const list = await fetchRelay(`/list/${alice.pubkeyHex}`);
    expect(list.headers.get("Content-Type") ?? "").not.toContain("application/json");
  });
});

describe("what is refused", () => {
  it("anything larger than the cap, before reading it when the length is declared", async () => {
    const alice = await member();
    const response = await upload(alice, jpeg(PHOTO_MAX_BYTES_DEFAULT + 1));
    expect(response.status).toBe(413);
    expect(response.headers.get("X-Reason")).toBe(
      `a photo here can be at most ${PHOTO_MAX_BYTES_DEFAULT} bytes`,
    );
    expect((await upload(alice, jpeg(PHOTO_MAX_BYTES_DEFAULT))).status).toBe(200);
  });

  it("anything that is not JPEG, PNG or WebP, whatever it claims", async () => {
    const alice = await member();
    const gif = new TextEncoder().encode("GIF89a and then some pixels");
    expect((await upload(alice, gif, { contentType: "image/gif" })).status).toBe(415);
    const response = await upload(alice, jpeg(), { contentType: "image/png" });
    expect(response.status).toBe(415);
    expect(response.headers.get("X-Reason")).toBe("the bytes are image/jpeg, not image/png");
  });

  it("an upload whose authorization does not hold", async () => {
    const alice = await member();
    const bytes = jpeg();
    const sha256 = await sha256Hex(bytes);
    const now = Math.floor(Date.now() / 1000);
    const cases: [string | undefined, string][] = [
      [undefined, "missing Authorization: Nostr <base64 kind 24242 event>"],
      [authHeader(alice, "delete", sha256), 'the Authorization event\'s t tag must be "upload"'],
      [
        authHeader(alice, "upload", sha256, { x: "f".repeat(64) }),
        "the Authorization event's x tag must be the sha256 of this blob",
      ],
      [
        authHeader(alice, "upload", sha256, { expiration: now - 1 }),
        "the Authorization event needs an expiration tag in the future",
      ],
      [authHeader(alice, "upload", sha256, { kind: 27235 }), "the Authorization event must be kind 24242"],
    ];
    for (const [auth, reason] of cases) {
      const response = await fetchRelay("/upload", {
        method: "PUT",
        body: bytes,
        headers: auth === undefined ? {} : { Authorization: auth },
      });
      expect([response.status, response.headers.get("X-Reason")]).toEqual([401, reason]);
    }
    // A valid event with its signature broken.
    const good = JSON.parse(atob(authHeader(alice, "upload", sha256).slice(6))) as { sig: string };
    good.sig = (good.sig[0] === "0" ? "1" : "0") + good.sig.slice(1);
    const forged = await upload(alice, bytes, { auth: `Nostr ${btoa(JSON.stringify(good))}` });
    expect(forged.status).toBe(401);
  });

  it(`more than ${PHOTO_UPLOADS_PER_DAY} uploads a day, but not a repeat of the current photo`, async () => {
    const alice = await member();
    let last = jpeg();
    for (let i = 0; i < PHOTO_UPLOADS_PER_DAY; i++) {
      last = jpeg();
      expect((await upload(alice, last)).status).toBe(200);
    }
    expect((await upload(alice, last)).status).toBe(200);
    const response = await upload(alice, jpeg());
    expect(response.status).toBe(429);
  });

  it("an upload past the total cap, and nothing else", async () => {
    mutableEnv.PHOTO_STORAGE_BYTES = "3000";
    const alice = await member();
    const bob = await member();
    expect((await upload(alice, jpeg(2000))).status).toBe(200);
    const full = await upload(bob, jpeg(2000));
    expect([full.status, full.headers.get("X-Reason")]).toEqual([
      507,
      "this relay has no room for more photos",
    ]);
    // Replacing your own photo counts only the difference.
    expect((await upload(alice, jpeg(2500))).status).toBe(200);
    // The rest of the relay is unaffected.
    expect((await callManagement("listallowedpubkeys")).status).toBe(200);
  });
});

describe("deleting a photo", () => {
  it("is for whoever uploaded it, by its hash", async () => {
    const alice = await member();
    const bob = await member();
    const bytes = jpeg();
    await upload(alice, bytes);
    const sha256 = await sha256Hex(bytes);

    const byBob = await fetchRelay(`/${sha256}`, {
      method: "DELETE",
      headers: { Authorization: authHeader(bob, "delete", sha256) },
    });
    expect(byBob.status).toBe(404);
    const wrongVerb = await fetchRelay(`/${sha256}`, {
      method: "DELETE",
      headers: { Authorization: authHeader(alice, "upload", sha256) },
    });
    expect(wrongVerb.status).toBe(401);

    const byAlice = await fetchRelay(`/${sha256}`, {
      method: "DELETE",
      headers: { Authorization: authHeader(alice, "delete", sha256) },
    });
    expect(byAlice.status).toBe(204);
    expect((await fetchRelay(`/${sha256}`)).status).toBe(404);
  });
});

describe("a removed member's photo", () => {
  it("stays through the grace period, then goes with their mail", async () => {
    const alice = await member();
    const bytes = jpeg();
    await upload(alice, bytes);
    const sha256 = await sha256Hex(bytes);
    await callManagement("unallowpubkey", [alice.pubkeyHex]);
    expect((await upload(alice, jpeg())).status).toBe(403);
    expect((await fetchRelay(`/${sha256}`)).status).toBe(200);

    await runInDurableObject(stub(), (_i: Relay, state) => {
      const sql = state.storage.sql;
      const removedAt = sql
        .exec<{ removed_at: number }>(
          `SELECT removed_at FROM former_members WHERE pubkey = ?`,
          alice.pubkeyHex,
        )
        .toArray()[0]!.removed_at;
      sweepFormerMembers(
        sql,
        removedAt + MEMBER_REMOVAL_GRACE_SECONDS - 1,
        MEMBER_REMOVAL_GRACE_SECONDS,
        OWNER_PUBKEY_HEX,
        8,
        100,
      );
      expect(sql.exec(`SELECT 1 FROM photos WHERE pubkey = ?`, alice.pubkeyHex).toArray().length).toBe(1);
      sweepFormerMembers(
        sql,
        removedAt + MEMBER_REMOVAL_GRACE_SECONDS,
        MEMBER_REMOVAL_GRACE_SECONDS,
        OWNER_PUBKEY_HEX,
        8,
        100,
      );
      expect(sql.exec(`SELECT 1 FROM photos WHERE pubkey = ?`, alice.pubkeyHex).toArray()).toEqual([]);
    });
    expect((await fetchRelay(`/${sha256}`)).status).toBe(404);
  });
});

describe("what the relay says about photos", () => {
  it("advertises the server on NIP-11 and the usage on /api/stats", async () => {
    const alice = await member();
    const bytes = jpeg(1234);
    await upload(alice, bytes);
    const doc = (await (await fetchRelay("/", { headers: { Accept: "application/nostr+json" } })).json()) as {
      blossom: Record<string, unknown>;
    };
    expect(doc.blossom).toEqual({
      url: "https://example.com/",
      types: ["image/jpeg", "image/png", "image/webp"],
      max_blob_bytes: PHOTO_MAX_BYTES_DEFAULT,
      used_bytes: 1234,
      max_bytes: PHOTO_STORAGE_BYTES_DEFAULT,
    });
    const stats = (await (await fetchRelay("/api/stats")).json()) as Record<string, unknown>;
    expect([stats.photoBytes, stats.photoStorageLimit]).toEqual([1234, PHOTO_STORAGE_BYTES_DEFAULT]);
  });

  it("is all off with PHOTO_STORAGE_BYTES=off", async () => {
    const alice = await member();
    mutableEnv.PHOTO_STORAGE_BYTES = "off";
    expect((await upload(alice, jpeg())).status).toBe(404);
    expect((await fetchRelay(`/${"a".repeat(64)}`)).status).toBe(404);
    const doc = (await (
      await fetchRelay("/", { headers: { Accept: "application/nostr+json" } })
    ).json()) as Record<string, unknown>;
    expect(doc.blossom).toBeUndefined();
    const stats = (await (await fetchRelay("/api/stats")).json()) as Record<string, unknown>;
    expect(stats.photoStorageLimit).toBeNull();
  });

  it("answers a browser's preflight for the photo verbs", async () => {
    const response = await fetchRelay("/upload", { method: "OPTIONS" });
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("PUT");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
    expect(response.headers.get("Access-Control-Expose-Headers")).toBe("X-Reason");
  });
});

describe("recognising a photo", () => {
  it("reads the type from the bytes", () => {
    expect(sniffPhotoType(jpeg(8))).toBe("image/jpeg");
    expect(sniffPhotoType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      "image/png",
    );
    expect(sniffPhotoType(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffPhotoType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
  });
});
