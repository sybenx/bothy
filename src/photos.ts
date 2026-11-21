// Profile photos: a Blossom server (BUD-01 retrieval, BUD-02 upload and
// delete) that stores exactly one thing, each member's current photo.
//
// What it is for and what it is not, because a media server grows: the
// apps always also put the photo on a public Blossom server, so this one
// may refuse, fill up or lose a photo without anything breaking. It exists
// so a home's own members load each other's faces from their own home.
// The rules (docs/principles.md "Restraint"):
//
//   - members and the owner upload; anyone may fetch a stored photo by
//     its sha256, and nothing lists them (no BUD-02 /list);
//   - JPEG, PNG or WebP only, checked from the bytes, at most
//     limits.ts photoMaxBytes (100KB by default);
//   - one photo per pubkey: an upload replaces the last;
//   - all photos together under limits.ts photoStorageBytes (250MB),
//     refused at the cap with nothing else affected;
//   - a few uploads a day per pubkey (limits.ts PHOTO_UPLOADS_PER_DAY);
//   - a removed member's photo goes when their grace period ends.
//
// Storage is behind PhotoStore so it could move (to R2, opt-in) without
// touching the routes. It is never required: a deploy needs no binding,
// and PHOTO_STORAGE_BYTES=off turns the whole thing off.
//
// No BUD-04 mirror: it would have the relay fetch arbitrary URLs on a
// member's say-so, which is outbound traffic for a copy the apps already
// make themselves.
import { PHOTO_AUTH_MAX_FUTURE_SECONDS } from "./limits";
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";

// Blossom's authorization event (BUD-01).
export const BLOSSOM_AUTH_KIND = 24242;

export type PhotoType = "image/jpeg" | "image/png" | "image/webp";
export const PHOTO_TYPES: readonly PhotoType[] = ["image/jpeg", "image/png", "image/webp"];

const EXTENSIONS: Record<PhotoType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export function extensionFor(type: PhotoType): string {
  return EXTENSIONS[type];
}

// The type the bytes say they are, from their signature, or null. The
// Content-Type header is a claim; this is the check.
export function sniffPhotoType(bytes: Uint8Array): PhotoType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= 8 && png.every((b, i) => bytes[i] === b)) return "image/png";
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type BlossomVerb = "upload" | "delete";

export type BlossomAuth = { ok: true; pubkey: string } | { ok: false; reason: string };

// BUD-01 authorization: `Authorization: Nostr <base64 kind-24242 event>`,
// whose `t` tag names the verb, whose `expiration` is still ahead, and,
// for both verbs here, whose `x` tag names the blob's sha256. `x` is
// required on upload too (BUD-02 makes it optional): it ties the
// signature to these exact bytes, so a captured header cannot upload
// anything else before it expires.
export function verifyBlossomAuth(
  header: string | null,
  verb: BlossomVerb,
  sha256: string,
  nowSec: number,
): BlossomAuth {
  const match = header === null ? null : /^Nostr\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return { ok: false, reason: "missing Authorization: Nostr <base64 kind 24242 event>" };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0))));
  } catch {
    return { ok: false, reason: "the Authorization event is not base64 JSON" };
  }
  const event = parseEventShape(raw);
  if (event === null) return { ok: false, reason: "the Authorization event is not a nostr event" };
  if (event.kind !== BLOSSOM_AUTH_KIND)
    return { ok: false, reason: `the Authorization event must be kind ${BLOSSOM_AUTH_KIND}` };
  if (event.created_at > nowSec + PHOTO_AUTH_MAX_FUTURE_SECONDS) {
    return { ok: false, reason: "the Authorization event is dated in the future" };
  }
  const tag = (name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const expiration = Number(tag("expiration")[0]);
  if (!Number.isFinite(expiration) || expiration <= nowSec) {
    return { ok: false, reason: "the Authorization event needs an expiration tag in the future" };
  }
  if (!tag("t").includes(verb))
    return { ok: false, reason: `the Authorization event's t tag must be "${verb}"` };
  if (!tag("x").includes(sha256)) {
    return { ok: false, reason: "the Authorization event's x tag must be the sha256 of this blob" };
  }
  // Signature last: it is the expensive check (validate.ts).
  if (!idMatchesContent(event)) return { ok: false, reason: "the Authorization event id is wrong" };
  if (!verifySignature(event)) return { ok: false, reason: "the Authorization event signature is invalid" };
  return { ok: true, pubkey: event.pubkey };
}

// ---------------------------------------------------------------------
// The store. One implementation today, over this Durable Object's SQLite
// (schema.ts `photos`, `photo_uploads`).
// ---------------------------------------------------------------------

export interface StoredPhoto {
  sha256: string;
  type: PhotoType;
  size: number;
  uploadedAt: number;
}

export interface PhotoStore {
  get(sha256: string): (StoredPhoto & { data: ArrayBuffer }) | null;
  // The pubkey's current photo, if any.
  currentFor(pubkey: string): StoredPhoto | null;
  // Replaces the pubkey's photo.
  put(pubkey: string, photo: StoredPhoto, data: Uint8Array): void;
  // Deletes the pubkey's photo if it is this one. False otherwise.
  deleteIfCurrent(pubkey: string, sha256: string): boolean;
  usedBytes(): number;
}

export function sqlitePhotoStore(sql: SqlStorage): PhotoStore {
  return {
    get(sha256) {
      const row = sql
        .exec<{ sha256: string; type: string; size: number; data: ArrayBuffer; uploaded_at: number }>(
          `SELECT sha256, type, size, data, uploaded_at FROM photos WHERE sha256 = ? LIMIT 1`,
          sha256,
        )
        .toArray()[0];
      if (!row) return null;
      return {
        sha256: row.sha256,
        type: row.type as PhotoType,
        size: row.size,
        uploadedAt: row.uploaded_at,
        data: row.data,
      };
    },
    currentFor(pubkey) {
      const row = sql
        .exec<{ sha256: string; type: string; size: number; uploaded_at: number }>(
          `SELECT sha256, type, size, uploaded_at FROM photos WHERE pubkey = ?`,
          pubkey,
        )
        .toArray()[0];
      return row
        ? { sha256: row.sha256, type: row.type as PhotoType, size: row.size, uploadedAt: row.uploaded_at }
        : null;
    },
    put(pubkey, photo, data) {
      sql.exec(
        `INSERT INTO photos (pubkey, sha256, type, size, data, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(pubkey) DO UPDATE SET sha256 = excluded.sha256, type = excluded.type,
             size = excluded.size, data = excluded.data, uploaded_at = excluded.uploaded_at`,
        pubkey,
        photo.sha256,
        photo.type,
        photo.size,
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
        photo.uploadedAt,
      );
    },
    deleteIfCurrent(pubkey, sha256) {
      const current = this.currentFor(pubkey);
      if (current === null || current.sha256 !== sha256) return false;
      sql.exec(`DELETE FROM photos WHERE pubkey = ?`, pubkey);
      return true;
    },
    usedBytes() {
      return sql.exec<{ n: number }>(`SELECT COALESCE(SUM(size), 0) AS n FROM photos`).toArray()[0]?.n ?? 0;
    },
  };
}

// Counts one upload against today's allowance and says whether it fits.
// One row read and one written. `day` is the UTC day number.
export function takeUploadAllowance(sql: SqlStorage, pubkey: string, day: number, perDay: number): boolean {
  const row = sql
    .exec<{ day: number; count: number }>(`SELECT day, count FROM photo_uploads WHERE pubkey = ?`, pubkey)
    .toArray()[0];
  const used = row !== undefined && row.day === day ? row.count : 0;
  if (used >= perDay) return false;
  sql.exec(
    `INSERT INTO photo_uploads (pubkey, day, count) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET day = excluded.day, count = excluded.count`,
    pubkey,
    day,
    used + 1,
  );
  return true;
}
