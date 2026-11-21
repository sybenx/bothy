import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { OwnerProfile } from "./nip11";
import type { Profile } from "./profile-lookup";
import { acrossScopes } from "./groups";
import { normalizeHost } from "./host";
import { CLAIM_NONCE_TTL_SECONDS, MAX_OUTSTANDING_CLAIM_NONCES } from "./limits";
import { RELAY_LIST_KIND } from "./nostr";
import { normalizePubkey } from "./pubkey";
import { getStoredWritePolicy, isPubkeyAllowed, isPubkeyBanned, setFollowCount } from "./storage";
import {
  admitsAtLeast,
  exceedsMentionTagCap,
  mentionsPubkey,
  resolveWritePolicy,
  type WritePolicy,
} from "./write-policy";

// NIP-02 contact list; its `p` tags are the follow set. Exported so
// relay.ts can refresh the follow cache the moment the owner publishes one.
export const CONTACT_LIST_KIND = 3;
const PROFILE_KIND = 0;

// refreshProfile runs at most once a day, though the cron is hourly.
const ICON_REFRESH_INTERVAL_SECONDS = 86400;

// Memoised per isolate because getOwnerPubkey is on the write path and an
// `npub1...` value would otherwise cost a bech32 decode per event. Keyed
// on the raw value, so a changed variable is never served a stale answer.
let normalizedEnvOwner: { raw: string; hex: string | null } | undefined;

function envOwnerPubkey(raw: string): string | null {
  if (normalizedEnvOwner?.raw !== raw) {
    normalizedEnvOwner = { raw, hex: normalizePubkey(raw) };
  }
  return normalizedEnvOwner.hex;
}

// The owner's pubkey as lowercase hex, or null while unclaimed.
//
// OWNER_PUBKEY is normalized (pubkey.ts normalizePubkey), like every
// pubkey boundary: the result is compared against `event.pubkey`, which
// is always lowercase hex, so an npub or capitalised hex used verbatim
// would silently match nothing (the owner could not write or read their
// gift wraps).
//
// A malformed value yields null, so the relay reads as unclaimed. That
// does not reopen TOFU: index.ts gates the claim endpoints on
// `env.OWNER_PUBKEY` being SET, not on this resolving, so it fails closed.
export function getOwnerPubkey(sql: SqlStorage, env: Env): string | null {
  if (env.OWNER_PUBKEY) return envOwnerPubkey(env.OWNER_PUBKEY);
  const row = sql.exec<{ pubkey: string }>(`SELECT pubkey FROM owner LIMIT 1`).toArray()[0];
  return row?.pubkey ?? null;
}

// TOFU claim: binds the owner permanently, no signature required. This is
// the only INSERT into `owner`, and it refuses if a row exists; the
// Durable Object is single-threaded, so the check-then-write is atomic
// without locking. Returns false if already claimed.
//
// `profile` is the owner's kind-0, looked up by the Worker before the call
// (the DO opens no outbound connections). Best-effort: missing fields are
// stored as null and nip11.ts falls back to defaults.
//
// `nonce` is set only by a QR claim (claimWithNonce below): the code that
// won, so getClaimStatus can tell "this QR won" from "claimed some other
// way". NULL for a paste claim.
export function claimOwner(sql: SqlStorage, pubkey: string, profile?: Profile, nonce: string | null = null): boolean {
  const existing = sql.exec(`SELECT 1 FROM owner LIMIT 1`).toArray();
  if (existing.length > 0) return false;
  sql.exec(
    `INSERT INTO owner (pubkey, name, picture, about, website, claim_nonce) VALUES (?, ?, ?, ?, ?, ?)`,
    pubkey,
    profile?.name ?? null,
    profile?.picture ?? null,
    profile?.about ?? null,
    profile?.website ?? null,
    nonce,
  );
  return true;
}

// ---------------------------------------------------------------------
// QR claim (relay.ts issueClaimNonce/claim/claimSigned; index.ts
// /api/claim-nonce, /api/claim with a nonce, /api/claim-signed,
// /api/claim-status).
//
// The admin page shows a QR of its own URL with a one-time code in the
// fragment. The code authenticates nothing: the claim is the same unsigned
// first-come TOFU claim as pasting. It exists so the desktop page, polling
// /api/claim-status, can learn that its own QR landed.
// ---------------------------------------------------------------------

export type IssueClaimNonceResult = { nonce: string; expiresAt: number } | "capped";

// Mints a single-use, short-lived claim code. Minted only on a button
// press, never per page view (index.ts handleClaimNonce).
//
// Sweeps expired rows FIRST rather than merely excluding them from the
// count: anyone can mint on an unclaimed relay, so excluding alone would
// let a flood write MAX_OUTSTANDING_CLAIM_NONCES new rows every
// CLAIM_NONCE_TTL_SECONDS forever. With the sweep the table never exceeds
// that many rows. Costs 2 rows written per issue (row + PK index) plus the
// sweep's deletes.
export function issueClaimNonce(sql: SqlStorage, nowSec: number): IssueClaimNonceResult {
  sql.exec(`DELETE FROM claim_nonces WHERE expires_at < ?`, nowSec);
  const outstanding = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM claim_nonces`).toArray()[0]?.n ?? 0;
  if (outstanding >= MAX_OUTSTANDING_CLAIM_NONCES) return "capped";
  const nonce = crypto.randomUUID();
  const expiresAt = nowSec + CLAIM_NONCE_TTL_SECONDS;
  sql.exec(`INSERT INTO claim_nonces (nonce, created_at, expires_at) VALUES (?, ?, ?)`, nonce, nowSec, expiresAt);
  return { nonce, expiresAt };
}

// True if the code exists and has not expired, deleting it if so: single
// use by deletion rather than by a "used" flag.
export function consumeClaimNonce(sql: SqlStorage, nonce: string, nowSec: number): boolean {
  const row = sql
    .exec<{ expires_at: number }>(`SELECT expires_at FROM claim_nonces WHERE nonce = ?`, nonce)
    .toArray()[0];
  if (!row || row.expires_at < nowSec) return false;
  sql.exec(`DELETE FROM claim_nonces WHERE nonce = ?`, nonce);
  return true;
}

// Called once any claim succeeds, paste included: every remaining code is
// moot once the relay has an owner.
export function clearClaimNonces(sql: SqlStorage): void {
  sql.exec(`DELETE FROM claim_nonces`);
}

// A claim naming a QR code. Both relay.ts claim (with a nonce) and
// claimSigned end here. An unknown, used or expired code is refused rather
// than ignored, so a phone holding a stale page is told to get a new code
// instead of claiming as though it had scanned a live one.
export function claimWithNonce(
  sql: SqlStorage,
  pubkey: string,
  profile: Profile | undefined,
  nonce: string,
  nowSec: number,
): "invalid-nonce" | "conflict" | "claimed" {
  if (!consumeClaimNonce(sql, nonce, nowSec)) return "invalid-nonce";
  if (!claimOwner(sql, pubkey, profile, nonce)) return "conflict";
  clearClaimNonces(sql);
  return "claimed";
}

export type ClaimStatus = "pending" | "claimed" | "claimed-elsewhere";

// Backs GET /api/claim-status, from the `owner` row alone: no row ->
// "pending"; this code won -> "claimed"; otherwise (another code, or a
// paste claim with NULL) -> "claimed-elsewhere".
export function getClaimStatus(sql: SqlStorage, nonce: string): ClaimStatus {
  const row = sql.exec<{ claim_nonce: string | null }>(`SELECT claim_nonce FROM owner LIMIT 1`).toArray()[0];
  if (!row) return "pending";
  return row.claim_nonce === nonce ? "claimed" : "claimed-elsewhere";
}

// Whether the owner's newest locally stored kind-10002 names this relay;
// public/index.html hides the wss:// copy box when it does. Checked live
// rather than keyed to the claim path, because claiming does not publish a
// relay list. Both partitions, newest wins (see refreshFollows). Any `r`
// tag counts, read or write.
export function ownerListsThisRelay(sql: SqlStorage, env: Env, host: string): boolean {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return false;

  const latest = acrossScopes((scope) =>
    sql
      .exec<{ tags: string; created_at: number }>(
        `SELECT tags, created_at FROM events WHERE pubkey = ? AND kind = ? AND is_group = ?
         ORDER BY created_at DESC LIMIT 1`,
        owner,
        RELAY_LIST_KIND,
        scope,
      )
      .toArray(),
  ).sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest) return false;

  const relayHost = normalizeHost(host);
  const tags = JSON.parse(latest.tags) as string[][];
  return tags.some((t) => t[0] === "r" && t[1] && normalizeHost(t[1]) === relayHost);
}

// Backs the kind-0 rung of nip11.ts's identity chain. Null when unclaimed
// or under OWNER_PUBKEY (no `owner` row exists then).
export function getOwnerProfile(sql: SqlStorage, env: Env): OwnerProfile {
  if (env.OWNER_PUBKEY) return null;
  const row = sql
    .exec<{
      name: string | null;
      picture: string | null;
      about: string | null;
      website: string | null;
    }>(`SELECT name, picture, about, website FROM owner LIMIT 1`)
    .toArray()[0];
  return row ?? null;
}

// A reason rather than a bare boolean, so relay.ts can tell the sender why.
// `isOwner` rides along so the write path need not re-read the owner for
// the abuse caps that exempt the owner (relay.ts acceptEvent).
export type WriteRejection =
  | "unclaimed"
  | "not-follow"
  | "owner-only"
  | "banned"
  | "not-mention"
  | "too-many-tags";

export type WriteAuthorization =
  | { allowed: true; isOwner: boolean }
  | { allowed: false; reason: WriteRejection };

// `policy`: relay.ts caches the resolved policy per instance and passes it
// in, so the gate pays no row per event; omitted, it is resolved here at
// one row read.
//
// `tags`: the event's tags, consulted only under `mentions`. Omitted,
// `mentions` admits nobody `follows` would not, the safe direction.
export interface WriterContext {
  policy?: WritePolicy;
  tags?: string[][];
}

// The write policy (write-policy.ts), enforced. Gift wraps (the `inbox`
// level), NIP-62 vanish and NIP-29 join requests are dispatched above
// this gate in relay.ts and never reach it.
//
// The owner always passes. Under every policy NIP-86 allowpubkey admits
// and banpubkey refuses. Beyond that, `follows` and above consult the
// follow cache, `mentions` admits an event that p-tags the owner (within
// MAX_MENTION_EVENT_INDEXED_TAGS, see limits.ts), and `all` admits anyone
// not banned.
//
// Order:
//   - banned_pubkeys for every non-owner write, before the follows lookup,
//     so a banned follow is still refused (nip86.ts refuses to ban the
//     owner, so there is no lockout case).
//   - allowed_pubkeys only on the path already about to refuse, so the
//     common accept path does not pay for it.
//   - the mention test last; it reads only the event's tags.
//
// The refusal names the policy's own boundary ("not-follow",
// "not-mention"), so a refused writer learns what would have been
// accepted.
export function isAllowedWriter(
  sql: SqlStorage,
  env: Env,
  pubkey: string,
  context: WriterContext = {},
): WriteAuthorization {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return { allowed: false, reason: "unclaimed" };
  if (pubkey === owner) return { allowed: true, isOwner: true };
  if (isPubkeyBanned(sql, pubkey)) return { allowed: false, reason: "banned" };
  const policy = context.policy ?? resolveWritePolicy(env, getStoredWritePolicy(sql)).policy;
  if (policy === "all") return { allowed: true, isOwner: false };
  if (admitsAtLeast(policy, "follows")) {
    const row = sql.exec(`SELECT 1 FROM follows WHERE pubkey = ?`, pubkey).toArray();
    if (row.length > 0) return { allowed: true, isOwner: false };
  }
  if (isPubkeyAllowed(sql, pubkey)) return { allowed: true, isOwner: false };
  if (policy === "mentions" && context.tags !== undefined) {
    const event = { tags: context.tags };
    if (mentionsPubkey(event, owner)) {
      return exceedsMentionTagCap(event)
        ? { allowed: false, reason: "too-many-tags" }
        : { allowed: true, isOwner: false };
    }
    return { allowed: false, reason: "not-mention" };
  }
  return { allowed: false, reason: admitsAtLeast(policy, "follows") ? "not-follow" : "owner-only" };
}

// Fingerprint of a follow set: sorted and deduplicated, so tag order and
// repeated pubkeys do not change it, matching what the rebuild stores.
export function computeFollowsHash(follows: ReadonlySet<string>): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([...follows].sort()))));
}

// Re-derives the follow cache from the owner's newest kind-3 already
// stored here, never a fetch: the Durable Object must not open outbound
// connections (an outbound WebSocket pins it in memory for up to 15
// minutes and breaks hibernation). Called by relay.ts acceptEvent when the
// owner publishes a kind-3, and by the hourly cron as the fallback for a
// list that arrived another way (backfill). So a call that finds nothing
// new is the normal case and must cost nothing.
//
// "Nothing new" is decided by CONTENT: `relay_meta.follows_hash`
// (computeFollowsHash) of the set last rebuilt from. Not by created_at,
// because clients routinely re-sign an unchanged contact list (login,
// settings save), and a full rebuild costs ~3F rows written each time
// (measured: one owner's clients made this most of a day's writes); and
// a same-second replacement (NIP-01 breaks ties by lowest id) can change
// content without moving the timestamp. The check costs one row read and
// a sha256 over the event already fetched, flat in F on storage.
//
// The hash lives on `relay_meta`, not `owner`, because under OWNER_PUBKEY
// there is no owner row. It is written LAST, after the rebuild: a rebuild
// that throws leaves the old hash, so the next call retries rather than
// trusting a half-written table (the schema.ts initSchema pattern).
// `follows.fetched_at` is the created_at of the kind-3 whose set last
// differed; it is not advanced for an identical list, since that would
// cost F writes.
//
// A real change still rebuilds the whole table (3F + 2 rows to add one
// follow). Acceptable while changes are human-rate and F is hundreds. A
// delta rebuild would read F rows to write ~3 per change, but needs
// `fetched_at` moved off the per-row schema (dragging storage.ts
// followsListAt and auditMaintainedCounts along); worth it if F grows
// toward thousands.
//
// NOT gated on the write policy: maintaining the cache under `owner` or
// `inbox` costs one row and a sha256 per tick, and means a
// changewritepolicy to `follows` takes effect immediately rather than at
// the next cron tick.
export function refreshFollows(sql: SqlStorage, env: Env): void {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return;

  // Once per partition, newest wins: a lookup naming no `is_group` uses
  // neither half of the partial index pairs and scans the table
  // (measured: 51,500 rows against 1). Both partitions, because an
  // h-tagged kind-3 is still the owner's kind-3.
  const latest = acrossScopes((scope) =>
    sql
      .exec<{ created_at: number; tags: string }>(
        `SELECT created_at, tags FROM events WHERE pubkey = ? AND kind = ? AND is_group = ?
         ORDER BY created_at DESC LIMIT 1`,
        owner,
        CONTACT_LIST_KIND,
        scope,
      )
      .toArray(),
  ).sort((a, b) => b.created_at - a.created_at)[0];

  const storedHash =
    sql.exec<{ follows_hash: string | null }>(`SELECT follows_hash FROM relay_meta LIMIT 1`).toArray()[0]
      ?.follows_hash ?? null;

  if (!latest) {
    // No contact list stored. DELETE only if there is something to
    // delete; the table is checked directly because rows can exist with a
    // NULL hash.
    //
    // This branch and the rebuild below are the only writes to `follows`,
    // and each moves the maintained follow count itself (schema.ts
    // `maintained_counts`) rather than at the function's exit, where an
    // early return would skip it.
    const hasCache = sql.exec(`SELECT 1 FROM follows LIMIT 1`).toArray().length > 0;
    if (hasCache || storedHash !== null) {
      sql.exec(`DELETE FROM follows`);
      setFollowCount(sql, 0);
      sql.exec(`UPDATE relay_meta SET follows_hash = NULL`);
    }
    return;
  }

  const tags = JSON.parse(latest.tags) as string[][];
  const follows = new Set(
    tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1] as string),
  );
  // A NULL stored hash never matches, so a fresh relay rebuilds once.
  const hash = computeFollowsHash(follows);
  if (hash === storedHash) return;

  sql.exec(`DELETE FROM follows`);
  for (const pubkey of follows) {
    sql.exec(`INSERT INTO follows (pubkey, fetched_at) VALUES (?, ?)`, pubkey, latest.created_at);
  }
  // After the inserts, so a rebuild that threw partway leaves a count too
  // low rather than too high, for storage.ts auditMaintainedCounts to
  // catch. `follows.size`, the deduplicated set actually inserted.
  setFollowCount(sql, follows.size);
  // LAST, after every row it vouches for (see the header comment).
  // Written even for an empty set: NULL means "no cache", which belongs to
  // the clear branch above.
  sql.exec(`UPDATE relay_meta SET follows_hash = ?`, hash);
}

// Re-derives the cached kind-0 fields on the `owner` row (the kind-0 rung
// of nip11.ts's identity chain) from the owner's newest locally stored
// kind-0, never a fetch. Called from the hourly cron but runs at most once
// a day (icon_refreshed_at), and re-parses only when a newer kind-0 has
// arrived (profile_synced_at).
export function refreshProfile(sql: SqlStorage, env: Env, nowSec: number): void {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return;

  const row = sql
    .exec<{
      name: string | null;
      picture: string | null;
      about: string | null;
      website: string | null;
      profile_synced_at: number | null;
      icon_refreshed_at: number | null;
    }>(
      `SELECT name, picture, about, website, profile_synced_at, icon_refreshed_at FROM owner LIMIT 1`,
    )
    .toArray()[0];
  // No `owner` row under OWNER_PUBKEY: nothing to cache onto.
  if (!row) return;
  if (row.icon_refreshed_at !== null && nowSec - row.icon_refreshed_at < ICON_REFRESH_INTERVAL_SECONDS) return;

  // Both partitions, newest wins -- see refreshFollows above for why.
  const latest = acrossScopes((scope) =>
    sql
      .exec<{ content: string; created_at: number }>(
        `SELECT content, created_at FROM events WHERE pubkey = ? AND kind = ? AND is_group = ?
         ORDER BY created_at DESC LIMIT 1`,
        owner,
        PROFILE_KIND,
        scope,
      )
      .toArray(),
  ).sort((a, b) => b.created_at - a.created_at)[0];

  let name = row.name;
  let picture = row.picture;
  let about = row.about;
  let website = row.website;
  let syncedAt = row.profile_synced_at;
  if (latest && (row.profile_synced_at === null || latest.created_at > row.profile_synced_at)) {
    try {
      const content = JSON.parse(latest.content) as Record<string, unknown>;
      name = typeof content.name === "string" ? content.name : null;
      picture = typeof content.picture === "string" ? content.picture : null;
      about = typeof content.about === "string" ? content.about : null;
      // NIP-11 `contact` (nip11.ts resolveContact).
      website = typeof content.website === "string" ? content.website : null;
      syncedAt = latest.created_at;
    } catch {
      // Malformed content: keep the cached profile. icon_refreshed_at is
      // still bumped below, so it is not re-parsed every tick.
    }
  }

  sql.exec(
    `UPDATE owner SET name = ?, picture = ?, about = ?, website = ?, profile_synced_at = ?, icon_refreshed_at = ?`,
    name,
    picture,
    about,
    website,
    syncedAt,
    nowSec,
  );
}
