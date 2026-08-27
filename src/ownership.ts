import type { OwnerProfile } from "./nip11";
import type { Profile } from "./profile-lookup";
import { isPubkeyAllowed, isPubkeyBanned } from "./storage";

// Kind-3 is NIP-01/NIP-02's contact list; its `p` tags are the follow set.
// Exported so relay.ts can recognize an owner kind-3 write and refresh the
// follow cache immediately rather than waiting for the next cron tick.
export const CONTACT_LIST_KIND = 3;
// Kind-0 is NIP-01's profile metadata event.
const PROFILE_KIND = 0;

// Icon refresh cadence (see refreshProfile below) -- at most once/day
// regardless of how often the hourly cron fires.
const ICON_REFRESH_INTERVAL_SECONDS = 86400;

// ALLOW_FOLLOWS is not declared in wrangler.jsonc's `vars`, so it's
// undefined unless someone adds it in the Cloudflare dashboard -- it's
// an opt-OUT, per CLAUDE.md "Configuration": enabled
// unless explicitly set to the exact string "false". An unset, empty, or
// malformed value all resolve to enabled -- only "false" disables it.
export function allowFollowsEnabled(env: Env): boolean {
  return env.ALLOW_FOLLOWS !== "false";
}

export function getOwnerPubkey(sql: SqlStorage, env: Env): string | null {
  if (env.OWNER_PUBKEY) return env.OWNER_PUBKEY;
  const row = sql.exec<{ pubkey: string }>(`SELECT pubkey FROM owner LIMIT 1`).toArray()[0];
  return row?.pubkey ?? null;
}

// TOFU claim (CLAUDE.md "What it is"): "the claim handler is
// the only writer, and it refuses if a row already exists." The
// Durable Object is single-threaded per instance, so this
// check-then-write is atomic without locking -- no other code path may
// write this row. Returns false if a row already existed (already
// claimed by an earlier call).
// `profile` is the owner's kind-0 name/picture, looked up once by the
// Worker at claim time (CLAUDE.md "What it is"): the NIP-11
// name and icon are derived from the owner's kind-0 at claim time and
// written to DO storage there. Optional and best-effort --
// undefined fields are stored as null and nip11.ts falls back to
// hardcoded defaults.
export function claimOwner(sql: SqlStorage, pubkey: string, profile?: Profile): boolean {
  const existing = sql.exec(`SELECT 1 FROM owner LIMIT 1`).toArray();
  if (existing.length > 0) return false;
  sql.exec(
    `INSERT INTO owner (pubkey, name, picture, about, website) VALUES (?, ?, ?, ?, ?)`,
    pubkey,
    profile?.name ?? null,
    profile?.picture ?? null,
    profile?.about ?? null,
    profile?.website ?? null,
  );
  return true;
}

// Backs the NIP-11 document's name/icon (nip11.ts, via Relay.getProfile
// in relay.ts). Null when unclaimed, when OWNER_PUBKEY skips storage
// entirely (no row to read a profile from), or when the claim-time
// lookup found nothing -- the caller falls back to hardcoded defaults in
// all of those cases.
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

// Discriminated result for isAllowedWriter below, so callers (handleEvent
// in relay.ts) can surface a rejection reason instead of a bare boolean --
// an unclaimed relay and a non-follow under follows mode are different
// situations for the sender, even though they both end in "you may not
// write here".
// `isOwner` rides along on the allowed case so relay.ts's write path
// doesn't have to re-read the owner pubkey to answer "is this the owner?"
// -- isAllowedWriter has already resolved it, and the abuse caps in
// acceptEvent (limits.ts) exempt the owner from two of the three.
export type WriteAuthorization =
  | { allowed: true; isOwner: boolean }
  | { allowed: false; reason: "unclaimed" | "not-follow" | "owner-only" | "banned" };

// Owner writes are always allowed. NIP-86 banpubkey/allowpubkey (phase
// two, CLAUDE.md "The budget") add two lookups beyond the owner/follows check
// that shipped in phase one:
//
//   - banned_pubkeys is checked for every non-owner write, before the
//     follows lookup, so a banned pubkey is refused even if it is also a
//     follow -- src/nip86.ts also refuses to ever let the owner's own
//     pubkey be banned, so there's no owner-lockout case to guard against
//     here.
//   - allowed_pubkeys is checked only on the path already about to
//     reject a write (owner-only mode, or "not a follow"), so it costs
//     nothing on the common accept path.
export function isAllowedWriter(sql: SqlStorage, env: Env, pubkey: string): WriteAuthorization {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return { allowed: false, reason: "unclaimed" };
  if (pubkey === owner) return { allowed: true, isOwner: true };
  if (isPubkeyBanned(sql, pubkey)) return { allowed: false, reason: "banned" };
  if (!allowFollowsEnabled(env)) {
    return isPubkeyAllowed(sql, pubkey)
      ? { allowed: true, isOwner: false }
      : { allowed: false, reason: "owner-only" };
  }
  const row = sql.exec(`SELECT 1 FROM follows WHERE pubkey = ?`, pubkey).toArray();
  if (row.length > 0) return { allowed: true, isOwner: false };
  return isPubkeyAllowed(sql, pubkey)
    ? { allowed: true, isOwner: false }
    : { allowed: false, reason: "not-follow" };
}

// Re-derives the follow cache from the owner's own most recent kind-3
// event already stored on this relay -- not a fresh fetch from other
// relays. This relay is in the owner's relay list by construction (it's
// where they claimed it), so their client will have replicated their
// contact list here; reading it locally avoids an outbound connection
// (CLAUDE.md "The budget": an outbound connection keeps the DO in memory
// for up to 15 minutes). Called from the cron handler, and from
// relay.ts acceptEvent the moment the owner publishes a kind-3 here.
//
// Measures the property before writing, like refreshProfile below.
// This used to DELETE the table and re-INSERT every row on every call,
// unconditionally: 900 rows written per refresh at 300 follows (measured
// -- 300 for the delete, 600 for the inserts), 21,600/day on an hourly
// cron, 21.6% of the daily rows-written ceiling, spent to discover that a
// contact list nobody had touched still said what it said an hour ago.
// The cron path is the FALLBACK -- acceptEvent refreshes the instant the
// owner publishes a new kind-3 to this relay, and the tick exists only
// for a list that arrived some other way (backfill, or a client that
// published it elsewhere first) -- so a tick that finds nothing new is
// the normal case, not the exception, and it should cost nothing.
//
// `follows.fetched_at` is what makes the comparison possible, and it now
// holds the `created_at` of the kind-3 the rows were derived FROM rather
// than the wall clock at which they were written. That is the same
// watermark `owner.profile_synced_at` is for kind-0, kept in this table
// rather than on the `owner` row because there may not BE an owner row:
// OWNER_PUBKEY skips the claim flow that creates it (see refreshProfile),
// and a cache keyed to a row that does not exist is a cache that never
// compares. Every row carries the same value, so reading one answers for
// all of them -- one row read per call.
//
// Compared by equality rather than by "is the stored list newer". A
// replaceable event's created_at only moves forward (NIP-01, and
// MAX_CREATED_AT_FUTURE_SECONDS bounds the other end), so the two orderings
// agree on every real change; equality additionally forces exactly one
// rebuild on the first call after an upgrade, when the stored watermark
// is a wall-clock second left by the old code and cannot match any
// event's created_at. What neither form catches is a replacement
// published at the identical created_at as the event it replaces -- NIP-01
// resolves that tie by id, so the content can change while the timestamp
// does not. refreshProfile has carried exactly that exposure since it was
// written; noted here rather than defended against, since the cost of
// defending is the 900 rows this change exists to stop paying.
export function refreshFollows(sql: SqlStorage, env: Env): void {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null || !allowFollowsEnabled(env)) return;

  const latest = sql
    .exec<{ created_at: number; tags: string }>(
      `SELECT created_at, tags FROM events WHERE pubkey = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`,
      owner,
      CONTACT_LIST_KIND,
    )
    .toArray()[0];

  const cachedFrom = sql
    .exec<{ fetched_at: number }>(`SELECT fetched_at FROM follows LIMIT 1`)
    .toArray()[0]?.fetched_at;

  if (!latest) {
    // The contact list is gone -- deleted, vanished, or never stored.
    // Only pay for the DELETE if there is something to delete; an empty
    // cache on a relay with no kind-3 is already the right answer.
    if (cachedFrom !== undefined) sql.exec(`DELETE FROM follows`);
    return;
  }
  if (cachedFrom === latest.created_at) return;

  sql.exec(`DELETE FROM follows`);
  const tags = JSON.parse(latest.tags) as string[][];
  const follows = new Set(
    tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1] as string),
  );
  for (const pubkey of follows) {
    sql.exec(`INSERT INTO follows (pubkey, fetched_at) VALUES (?, ?)`, pubkey, latest.created_at);
  }
}

// Re-derives the cached name/picture (backing NIP-11's icon and
// /api/stats' favicon, nip11.ts resolveIcon) from the owner's own most
// recent locally-stored kind-0 -- never a fresh fetch. The owner's own
// client publishes kind 0 here like any other event, so profile changes
// arrive on their own; there is nothing to poll for. Called from the
// cron handler, gated to run at most once/day (icon_refreshed_at) even
// though the cron itself fires hourly, and to actually re-parse content
// only when a newer kind-0 has arrived since the last sync
// (profile_synced_at) -- both cheap reads compared against a fresh parse
// on every tick.
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
  // No `owner` row exists when OWNER_PUBKEY skips the claim flow
  // entirely (claimOwner above is the only writer) -- nothing to cache a
  // profile onto.
  if (!row) return;
  if (row.icon_refreshed_at !== null && nowSec - row.icon_refreshed_at < ICON_REFRESH_INTERVAL_SECONDS) return;

  const latest = sql
    .exec<{ content: string; created_at: number }>(
      `SELECT content, created_at FROM events WHERE pubkey = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`,
      owner,
      PROFILE_KIND,
    )
    .toArray()[0];

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
      // Backs NIP-11's `contact` -- see nip11.ts resolveContact for why
      // `website` and not `nip05` or `lud16`.
      website = typeof content.website === "string" ? content.website : null;
      syncedAt = latest.created_at;
    } catch {
      // Malformed kind-0 content -- leave the cached profile as-is, but
      // icon_refreshed_at is still bumped below so a bad kind 0 isn't
      // re-parsed every cron tick until the owner republishes a valid
      // one.
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
