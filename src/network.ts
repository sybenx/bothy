// The `network` write policy's second ring: everyone the owner's follows
// follow ("the outer wall"). Built from the follows' own contact lists
// (kind 3), which the relay does not otherwise hold: the hourly tick
// fetches a few follows' lists at a time from limits.ts NETWORK_RELAYS
// (network-worker.ts, in the Worker, never here: an outbound socket pins a
// Durable Object in memory), and this file checks and stores them.
//
// What it keeps is a set of keys (schema.ts `network_keys`), never who
// brought a key in, and it never shows the set: only its size reaches
// /api/stats. Bans and allowpubkey work on top of it as on every policy
// (ownership.ts isAllowedWriter).
//
// Cost, all bounded in limits.ts: 2 rows written to add a key, 1 to keep
// it on each weekly rebuild, at most NETWORK_ROWS_PER_TICK an hour (a
// tenth of the day's writes) and at most NETWORK_MAX_KEYS keys. Nothing is
// fetched or written unless the policy in force is `network`.
//
// A rebuild walks the follows in pubkey order (`network_state.cursor`).
// Every key a list names is stamped with the rebuild's `gen`; when the
// walk ends, keys with an older `gen` are dropped, unless this rebuild
// found clearly fewer lists than the last trusted one (limits.ts
// NETWORK_MIN_COVERAGE), in which case they are kept until a better one. A tick that runs out of its row budget
// partway through a list stops before that follow, and the next tick
// takes the same list again: keys already stamped cost nothing.
import {
  NETWORK_AUTHORS_PER_TICK,
  NETWORK_MIN_COVERAGE,
  NETWORK_REFRESH_SECONDS,
  NETWORK_ROWS_PER_TICK,
  networkMaxKeys,
} from "./limits";
import type { NostrEvent } from "./nostr";
import { CONTACT_LIST_KIND } from "./ownership";
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";

interface NetworkState {
  gen: number;
  cursor: string | null;
  started_at: number | null;
  completed_at: number | null;
  found: number;
  seen: number;
  key_count: number;
  capped: number;
  last_found: number;
}

function readState(sql: SqlStorage): NetworkState {
  return sql
    .exec<{
      gen: number;
      cursor: string | null;
      started_at: number | null;
      completed_at: number | null;
      found: number;
      seen: number;
      key_count: number;
      capped: number;
      last_found: number;
    }>(
      `SELECT gen, cursor, started_at, completed_at, found, seen, key_count, capped, last_found
         FROM network_state WHERE id = 1`,
    )
    .toArray()[0]!;
}

export interface NetworkSummary {
  // Keys in the second ring now.
  count: number;
  // Whether the last additions stopped at limits.ts NETWORK_MAX_KEYS.
  capped: boolean;
  // When a rebuild last finished, or null before the first.
  updatedAt: number | null;
}

export function networkSummary(sql: SqlStorage): NetworkSummary {
  const s = readState(sql);
  return { count: s.key_count, capped: s.capped === 1, updatedAt: s.completed_at };
}

// What the Worker should fetch now: the next follows whose lists this
// rebuild still needs, or null when there is nothing to do. Starts a
// rebuild when one is due, and finishes one when the walk has passed the
// last follow (dropping stale keys, see the header). Called once per tick,
// only under the `network` policy.
export function networkWork(sql: SqlStorage, nowSec: number): { authors: string[] } | null {
  let s = readState(sql);
  if (s.cursor === null) {
    const due = s.completed_at === null || nowSec - s.completed_at >= NETWORK_REFRESH_SECONDS;
    if (!due) return null;
    sql.exec(
      `UPDATE network_state SET gen = gen + 1, cursor = '', started_at = ?, found = 0, seen = 0, capped = 0 WHERE id = 1`,
      nowSec,
    );
    s = readState(sql);
  }
  const authors = sql
    .exec<{ pubkey: string }>(
      `SELECT pubkey FROM follows WHERE pubkey > ? ORDER BY pubkey ASC LIMIT ?`,
      s.cursor,
      NETWORK_AUTHORS_PER_TICK,
    )
    .toArray()
    .map((r) => r.pubkey);
  if (authors.length > 0) return { authors };

  // The walk is done. Drop keys no list named this time, if this rebuild
  // found about as many lists as the last trusted one. The bar moves only
  // with a trusted rebuild, so a bad week cannot lower it.
  const trusted = s.found > 0 && s.found >= NETWORK_MIN_COVERAGE * s.last_found;
  if (trusted) sql.exec(`DELETE FROM network_keys WHERE gen < ?`, s.gen);
  const count = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM network_keys`).toArray()[0]?.n ?? 0;
  sql.exec(
    `UPDATE network_state SET cursor = NULL, completed_at = ?, key_count = ?, last_found = ? WHERE id = 1`,
    nowSec,
    count,
    trusted ? s.found : s.last_found,
  );
  return null;
}

// Takes in what the Worker fetched for `authors`: each one's newest kind 3
// that verifies and is signed by that follow, and stores every key it
// names, within the tick's row budget and the key cap. Lists from anyone
// not asked about, or not a follow, are ignored, as is anything that does
// not verify: a relay cannot add keys by serving a forged list.
export function ingestNetwork(
  sql: SqlStorage,
  env: Env,
  authors: string[],
  rawEvents: unknown[],
  rowBudget: number = NETWORK_ROWS_PER_TICK,
): { taken: number; rowsWritten: number } {
  const s = readState(sql);
  if (s.cursor === null) return { taken: 0, rowsWritten: 0 };
  const asked = new Set(authors);
  const follows = new Set(
    sql
      .exec<{ pubkey: string }>(
        `SELECT pubkey FROM follows WHERE pubkey IN (SELECT value FROM json_each(?))`,
        JSON.stringify(authors),
      )
      .toArray()
      .map((r) => r.pubkey),
  );
  const newest = new Map<string, NostrEvent>();
  for (const raw of rawEvents) {
    const event = parseEventShape(raw);
    if (event === null || event.kind !== CONTACT_LIST_KIND) continue;
    if (!asked.has(event.pubkey) || !follows.has(event.pubkey)) continue;
    const prior = newest.get(event.pubkey);
    if (prior && prior.created_at >= event.created_at) continue;
    if (!idMatchesContent(event) || !verifySignature(event)) continue;
    newest.set(event.pubkey, event);
  }

  const maxKeys = networkMaxKeys(env);
  let keyCount = s.key_count;
  let capped = s.capped === 1;
  let rows = 0;
  let taken = 0;
  let found = s.found;
  let seen = s.seen;
  let cursor = s.cursor;
  const ordered = [...authors].filter((a) => a > (s.cursor ?? "")).sort();
  for (const author of ordered) {
    const list = newest.get(author);
    const keys = list
      ? [
          ...new Set(
            list.tags.filter((t) => t[0] === "p" && /^[0-9a-f]{64}$/.test(t[1] ?? "")).map((t) => t[1]!),
          ),
        ]
      : [];
    const known = new Map(
      keys.length === 0
        ? []
        : sql
            .exec<{ pubkey: string; gen: number }>(
              `SELECT pubkey, gen FROM network_keys WHERE pubkey IN (SELECT value FROM json_each(?))`,
              JSON.stringify(keys),
            )
            .toArray()
            .map((r) => [r.pubkey, r.gen] as const),
    );
    let finished = true;
    for (const key of keys) {
      const gen = known.get(key);
      if (gen === s.gen) continue;
      const cost = gen === undefined ? 2 : 1;
      if (rows + cost > rowBudget) {
        finished = false;
        break;
      }
      if (gen === undefined) {
        if (keyCount >= maxKeys) {
          capped = true;
          continue;
        }
        sql.exec(`INSERT INTO network_keys (pubkey, gen) VALUES (?, ?)`, key, s.gen);
        keyCount++;
      } else {
        sql.exec(`UPDATE network_keys SET gen = ? WHERE pubkey = ?`, s.gen, key);
      }
      rows += cost;
    }
    if (!finished) break;
    cursor = author;
    seen++;
    if (list) found++;
    taken++;
  }
  sql.exec(
    `UPDATE network_state SET cursor = ?, found = ?, seen = ?, key_count = ?, capped = ? WHERE id = 1`,
    cursor,
    found,
    seen,
    keyCount,
    capped ? 1 : 0,
  );
  return { taken, rowsWritten: rows };
}
