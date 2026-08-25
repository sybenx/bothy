import type { Profile } from "./profile-lookup";

// Kind-3 is NIP-01/NIP-02's contact list; its `p` tags are the follow set.
// Exported so relay.ts can recognize an owner kind-3 write and refresh the
// follow cache immediately rather than waiting for the next cron tick.
export const CONTACT_LIST_KIND = 3;
// Kind-0 is NIP-01's profile metadata event.
const PROFILE_KIND = 0;

// Icon refresh cadence (see refreshProfile below) -- at most once/day
// regardless of how often the hourly cron fires.
const ICON_REFRESH_INTERVAL_SECONDS = 86400;

// ALLOW_FOLLOWS is not declared in wrangler.jsonc's `vars` (ROADMAP.md
// chunk 5), so it's undefined unless someone adds it in the Cloudflare
// dashboard -- it's an opt-OUT, per CLAUDE.md "Configuration": enabled
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

// TOFU claim (CLAUDE.md "Claim implementation"): "the claim handler is
// the only writer, and it refuses if a row already exists." The
// Durable Object is single-threaded per instance, so this
// check-then-write is atomic without locking -- no other code path may
// write this row. Returns false if a row already existed (already
// claimed by an earlier call).
// `profile` is the owner's kind-0 name/picture, looked up once by the
// Worker at claim time (CLAUDE.md "Claim implementation"; ROADMAP.md
// chunk 5: "Derive NIP-11 name and icon from the owner's kind 0 at claim
// time... Write to DO storage at claim."). Optional and best-effort --
// undefined fields are stored as null and nip11.ts falls back to
// hardcoded defaults.
export function claimOwner(sql: SqlStorage, pubkey: string, profile?: Profile): boolean {
  const existing = sql.exec(`SELECT 1 FROM owner LIMIT 1`).toArray();
  if (existing.length > 0) return false;
  sql.exec(
    `INSERT INTO owner (pubkey, name, picture) VALUES (?, ?, ?)`,
    pubkey,
    profile?.name ?? null,
    profile?.picture ?? null,
  );
  return true;
}

// Backs the NIP-11 document's name/icon (nip11.ts, via Relay.getProfile
// in relay.ts). Null when unclaimed, when OWNER_PUBKEY skips storage
// entirely (no row to read a profile from), or when the claim-time
// lookup found nothing -- the caller falls back to hardcoded defaults in
// all of those cases.
export function getOwnerProfile(
  sql: SqlStorage,
  env: Env,
): { name: string | null; picture: string | null } | null {
  if (env.OWNER_PUBKEY) return null;
  const row = sql
    .exec<{ name: string | null; picture: string | null }>(`SELECT name, picture FROM owner LIMIT 1`)
    .toArray()[0];
  return row ?? null;
}

// Discriminated result for isAllowedWriter below, so callers (handleEvent
// in relay.ts) can surface a rejection reason instead of a bare boolean --
// an unclaimed relay and a non-follow under follows mode are different
// situations for the sender, even though they both end in "you may not
// write here".
export type WriteAuthorization =
  | { allowed: true }
  | { allowed: false; reason: "unclaimed" | "not-follow" | "owner-only" };

// Owner writes are always allowed.
export function isAllowedWriter(sql: SqlStorage, env: Env, pubkey: string): WriteAuthorization {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return { allowed: false, reason: "unclaimed" };
  if (pubkey === owner) return { allowed: true };
  if (!allowFollowsEnabled(env)) return { allowed: false, reason: "owner-only" };
  const row = sql.exec(`SELECT 1 FROM follows WHERE pubkey = ?`, pubkey).toArray();
  return row.length > 0 ? { allowed: true } : { allowed: false, reason: "not-follow" };
}

// Re-derives the follow cache from the owner's own most recent kind-3
// event already stored on this relay -- not a fresh fetch from other
// relays. This relay is in the owner's relay list by construction (it's
// where they claimed it), so their client will have replicated their
// contact list here; reading it locally avoids an outbound connection
// (CLAUDE.md "The budget": an outbound connection keeps the DO in memory
// for up to 15 minutes). Called from the cron handler, never per-event.
export function refreshFollows(sql: SqlStorage, env: Env, nowSec: number): void {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null || !allowFollowsEnabled(env)) return;

  const latest = sql
    .exec<{ tags: string }>(
      `SELECT tags FROM events WHERE pubkey = ? AND kind = ? ORDER BY created_at DESC LIMIT 1`,
      owner,
      CONTACT_LIST_KIND,
    )
    .toArray()[0];

  sql.exec(`DELETE FROM follows`);
  if (!latest) return;

  const tags = JSON.parse(latest.tags) as string[][];
  const follows = new Set(
    tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1] as string),
  );
  for (const pubkey of follows) {
    sql.exec(`INSERT INTO follows (pubkey, fetched_at) VALUES (?, ?)`, pubkey, nowSec);
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
      profile_synced_at: number | null;
      icon_refreshed_at: number | null;
    }>(`SELECT name, picture, profile_synced_at, icon_refreshed_at FROM owner LIMIT 1`)
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
  let syncedAt = row.profile_synced_at;
  if (latest && (row.profile_synced_at === null || latest.created_at > row.profile_synced_at)) {
    try {
      const content = JSON.parse(latest.content) as Record<string, unknown>;
      name = typeof content.name === "string" ? content.name : null;
      picture = typeof content.picture === "string" ? content.picture : null;
      syncedAt = latest.created_at;
    } catch {
      // Malformed kind-0 content -- leave the cached profile as-is, but
      // icon_refreshed_at is still bumped below so a bad kind 0 isn't
      // re-parsed every cron tick until the owner republishes a valid
      // one.
    }
  }

  sql.exec(
    `UPDATE owner SET name = ?, picture = ?, profile_synced_at = ?, icon_refreshed_at = ?`,
    name,
    picture,
    syncedAt,
    nowSec,
  );
}
