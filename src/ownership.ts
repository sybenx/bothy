// Kind-3 is NIP-01/NIP-02's contact list; its `p` tags are the follow set.
const CONTACT_LIST_KIND = 3;

// wrangler's generated Env type narrows ALLOW_FOLLOWS to the literal
// default from wrangler.jsonc's `vars` ("false"); widen to `string`
// before comparing, since a real deployment can override it to "true".
function allowFollowsEnabled(env: Env): boolean {
  const value: string = env.ALLOW_FOLLOWS;
  return value === "true";
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
export function claimOwner(sql: SqlStorage, pubkey: string): boolean {
  const existing = sql.exec(`SELECT 1 FROM owner LIMIT 1`).toArray();
  if (existing.length > 0) return false;
  sql.exec(`INSERT INTO owner (pubkey) VALUES (?)`, pubkey);
  return true;
}

// Owner writes are always allowed; ALLOW_FOLLOWS additionally allows
// pubkeys in the cached follow set (CLAUDE.md "Configuration":
// "also accept writes from the owner's kind-3 follow list").
export function isAllowedWriter(sql: SqlStorage, env: Env, pubkey: string): boolean {
  const owner = getOwnerPubkey(sql, env);
  if (owner === null) return false;
  if (pubkey === owner) return true;
  if (!allowFollowsEnabled(env)) return false;
  const row = sql.exec(`SELECT 1 FROM follows WHERE pubkey = ?`, pubkey).toArray();
  return row.length > 0;
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
