// One-shot backfill (ROADMAP.md chunk 7): "Fetch the owner's own events
// from the write relays in their kind 10002 and store them." This module
// is the DO-storage-facing half -- pure functions over SqlStorage, called
// from relay.ts's RPC methods, exactly like ownership.ts/storage.ts. The
// Worker-side half (outbound sockets, never here -- CLAUDE.md "The
// budget") lives in backfill-worker.ts.
import { getOwnHost, normalizeHost } from "./host";
import { BACKFILL_ROWS_SHARE_LIMIT } from "./limits";
import { isEphemeralKind } from "./nostr";
import { estimateRowsWritten24h, isDeleted, eventExists, storeEvent } from "./storage";
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";

export interface BackfillStatus {
  status: "pending" | "running" | "paused-budget" | "done";
  totalStored: number;
  relayCount: number;
  exhaustedCount: number;
  // Null unless status is "running" and a relay remains to pull from --
  // the Worker's cron tick uses these two fields directly rather than
  // re-deriving "what's next" itself, so orchestration logic doesn't
  // have to be duplicated on both sides of the RPC boundary.
  nextRelay: string | null;
  nextUntil: number | null;
  // Set by applyBackfillPage on every ingest call, successful or not (a
  // page that stores zero events, e.g. all-duplicates, still updates
  // this). Null until the first ingest ever runs. The diagnostic value
  // is in comparing this against "now": stale means ingest is never
  // being reached (a cron/RPC-level problem); current but totalStored
  // not moving means it runs but stores nothing (a storage/validation
  // problem) -- a distinction nothing else on this object can make.
  lastRunAt: number | null;
}

// getBackfillStatus is pure over SqlStorage, like the rest of this
// module -- it doesn't know the owner's pubkey (that's an env/storage
// concern, ownership.ts getOwnerPubkey). Relay.getBackfillState (relay.ts)
// merges that in before handing the result to the Worker, since
// backfill-worker.ts needs it for every outbound REQ filter and
// shouldn't have to make a second RPC call just to learn it.
// canIngestNow is deliberately not part of the persisted BackfillStatus
// state machine (pending/running/paused-budget/done) -- it's a
// moment-to-moment read of today's rows-written headroom (below), not a
// transition backfill itself makes, and it can flip from tick to tick
// purely because of how much the owner posted in between.
export type BackfillState = BackfillStatus & { ownerPubkey: string; canIngestNow: boolean };

// Backfill must yield to the owner's own live traffic, not compete with
// it for the shared 100,000 rows-written/day ceiling (ROADMAP.md chunk
// 7: "a relay that can't accept the owner's new note because it's busy
// importing 2023 has the priority backwards"). True once today's rolling
// rows-written estimate (storage.ts estimateRowsWritten24h, the same
// number /api/stats already displays) still leaves backfill its reserved
// share (BACKFILL_ROWS_SHARE_LIMIT, limits.ts) of the daily ceiling.
// Checked twice, for two different reasons: getBackfillState (relay.ts)
// checks it so the Worker's cron tick can skip opening an outbound
// socket at all on a day live traffic already dominates, and
// applyBackfillPage checks it again, authoritatively, immediately before
// writing -- live traffic can consume real quota during the outbound
// round-trip in between (backfill-worker.ts's fetch can take several
// seconds), so only the second check actually protects the reserved
// share; the first is purely to avoid wasted outbound connections on a
// day backfill isn't going to be allowed to write anyway.
export function hasBackfillHeadroom(sql: SqlStorage, nowSec: number): boolean {
  return estimateRowsWritten24h(sql, nowSec - 86400) < BACKFILL_ROWS_SHARE_LIMIT;
}

// Backs Relay.getBackfillState (relay.ts), read by the Worker's cron tick
// (backfill-worker.ts) once per invocation to decide whether to discover
// relays, fetch a page, or do nothing.
export function getBackfillStatus(sql: SqlStorage): BackfillStatus {
  const meta = sql
    .exec<{ status: string; total_stored: number; last_run_at: number | null }>(
      `SELECT status, total_stored, last_run_at FROM backfill_meta LIMIT 1`,
    )
    .toArray()[0] ?? { status: "pending", total_stored: 0, last_run_at: null };

  const relays = sql
    .exec<{ relay_url: string; until_cursor: number; exhausted: number }>(
      `SELECT relay_url, until_cursor, exhausted FROM backfill_relays ORDER BY relay_url`,
    )
    .toArray();
  const next = relays.find((r) => r.exhausted === 0);

  return {
    status: meta.status as BackfillStatus["status"],
    totalStored: meta.total_stored,
    relayCount: relays.length,
    exhaustedCount: relays.filter((r) => r.exhausted !== 0).length,
    nextRelay: next?.relay_url ?? null,
    nextUntil: next?.until_cursor ?? null,
    lastRunAt: meta.last_run_at,
  };
}

// Backs Relay.discoverBackfillRelays (relay.ts), called once the Worker
// has resolved the owner's kind-10002 write relays from well-known
// relays. A no-op if backfill_relays is already seeded -- the Worker only
// calls this while status is still "pending" (getBackfillStatus), but
// guarding here too means a stray duplicate call can't reset progress.
// An empty `relayUrls` (lookup found nothing) deliberately leaves status
// at "pending" so the next cron tick retries discovery, rather than
// giving up after one failed lookup.
export function seedBackfillRelays(sql: SqlStorage, relayUrls: string[], nowSec: number): void {
  const alreadySeeded = sql.exec(`SELECT 1 FROM backfill_relays LIMIT 1`).toArray().length > 0;
  if (alreadySeeded || relayUrls.length === 0) return;

  // The owner's kind-10002 write-relay list legitimately includes this
  // relay itself -- pulling "history" from itself would seed a relay row
  // that never exhausts (there is nothing there this relay doesn't
  // already have) and leave /api/stats' nextRelay permanently pointing
  // at the relay's own URL (src/host.ts's header comment has the full
  // story). Detected by comparing the actual request host this
  // deployment has seen traffic on, not by string-matching a project
  // name -- the deployer can name their Worker anything.
  const ownHost = getOwnHost(sql);
  const relays = ownHost === null ? relayUrls : relayUrls.filter((url) => normalizeHost(url) !== ownHost);

  if (relays.length === 0) {
    // Every listed write relay was this relay itself -- there is no
    // external history to import. Mark done rather than leaving status
    // at "pending", which would otherwise retry discovery forever: the
    // "pending" retry path (relayUrls.length === 0 above) is for a
    // failed *lookup*, not a lookup that only found this relay.
    sql.exec(`UPDATE backfill_meta SET status = 'done'`);
    return;
  }

  for (const url of relays) {
    sql.exec(`INSERT OR IGNORE INTO backfill_relays (relay_url, until_cursor) VALUES (?, ?)`, url, nowSec);
  }
  sql.exec(`UPDATE backfill_meta SET status = 'running'`);
}

interface IngestResult {
  stored: number;
  exhausted: boolean;
}

// Backs Relay.ingestBackfillPage (relay.ts): the Worker has already
// fetched one page of raw EVENT payloads from `relayUrl` (authors:
// [ownerPubkey], until: this relay's current cursor, limit: pageSize) and
// hands them here to be validated and stored. Nothing in this function
// opens a connection -- see backfill-worker.ts for the outbound half.
//
// Ordering mirrors relay.ts's own accept path (acceptEvent) and its
// stated reasoning: cheapest/most-certain rejections first, schnorr
// verification (the expensive step, docs/baselines.json) last and only
// once nothing cheaper has already ruled the event out.
//   1. author mismatch -- a relay returning events under a pubkey other
//      than the one asked for is either buggy or hostile; free to check,
//      and "owner's events only" is the roadmap's own scope for this
//      feature, not just an artifact of the REQ filter.
//   2. exact-id duplicate (eventExists) -- the same event will come back
//      from every relay that has it, and re-verifying + re-storing an id
//      this relay already has wastes the write budget this whole feature
//      exists to protect. Same reasoning as the tombstone/ownership
//      checks in relay.ts: check before paying for a schnorr verification
//      whose result can't change the outcome.
//   3. tombstoned id (isDeleted) -- a NIP-09/NIP-62 deletion made on this
//      relay must stay deleted even though the event still lives on
//      whatever relay backfill just pulled it from; without this check,
//      backfill would resurrect exactly what those NIPs say must not be
//      re-broadcastable.
//   4. id/signature validity.
//   5. storeEvent -- the same function relay.ts's live write path calls,
//      so replaceable/addressable/ephemeral semantics are identical by
//      construction: a page containing several old versions of the
//      owner's kind 0 collapses to one row (storeEvent's replaceable-kind
//      branch), and ephemeral kinds are dropped rather than stored
//      (storeEvent's ephemeral-kind branch) -- backfill does not
//      reimplement any of this.
//
// Cursor/exhaustion bookkeeping happens over every event in the raw page
// that at least has a parseable created_at, regardless of whether it was
// ultimately stored -- a duplicate or tombstoned id still represents real
// progress through this relay's history, and skipping it in the cursor
// walk would make backfill re-fetch it forever.
// If storeEvent throws mid-page -- the real shape a Cloudflare
// rows-written-quota failure takes (CLAUDE.md "Free-tier limits reset at
// 00:00 UTC. Exceeding them fails operations rather than billing the
// user") -- the loop stops immediately rather than continuing to attempt
// (and fail) the rest of the page.
export function applyBackfillPage(
  sql: SqlStorage,
  ownerPubkey: string,
  relayUrl: string,
  rawEvents: unknown[],
  eose: boolean,
  nowSec: number,
): IngestResult {
  // Authoritative yield-to-live-traffic check (see hasBackfillHeadroom's
  // comment) -- the fetched page is discarded unstored and the cursor is
  // left untouched, so the Worker will simply fetch this same page again
  // once headroom reopens. In the common case backfill-worker.ts already
  // skipped the outbound fetch entirely (its own check of the same
  // condition, from getBackfillState), so this only fires on the race
  // between that check and this one.
  if (!hasBackfillHeadroom(sql, nowSec)) {
    return { stored: 0, exhausted: false };
  }

  let stored = 0;
  // Only advances past an event once it's been fully handled (stored, or
  // legitimately skipped as a duplicate/tombstone/invalid) -- an event
  // that threw partway through storeEvent must NOT be folded into the
  // cursor, or a budget failure would silently skip it forever instead of
  // retrying it once the daily quota resets.
  let oldestProcessed: number | null = null;
  let budgetExceeded = false;

  for (const raw of rawEvents) {
    const event = parseEventShape(raw);
    if (!event) continue;

    if (event.pubkey === ownerPubkey && !eventExists(sql, event.id) && !isDeleted(sql, event.id)) {
      if (idMatchesContent(event) && verifySignature(event)) {
        try {
          const result = storeEvent(sql, event);
          // storeEvent's `stored` field means "broadcast-worthy," not
          // "a row now exists" -- for ephemeral kinds those diverge on
          // purpose (storage.ts: a row is never written, but the event is
          // still returned so relay.ts's live path can broadcast it).
          // Backfill never broadcasts, so counting an ephemeral kind here
          // would report progress that doesn't correspond to anything in
          // `events` -- ROADMAP.md/CLAUDE.md's storage-semantics
          // requirement is "dropped rather than stored," and that has to
          // hold for the counter too, not just the row.
          if (result.stored && !isEphemeralKind(event.kind)) stored++;
        } catch {
          budgetExceeded = true;
          break;
        }
      }
    }
    if (oldestProcessed === null || event.created_at < oldestProcessed) oldestProcessed = event.created_at;
  }

  // Exhaustion means "the relay told us, via a real EOSE, that it has
  // nothing older" -- NOT "the page came back short." A short-but-nonempty
  // page is normal: relays apply their own per-REQ limit caps, so asking
  // for BACKFILL_PAGE_SIZE and receiving fewer is routine, not a signal of
  // exhaustion. And backfill-worker.ts's fetchPage calls the same done()
  // for EOSE, a fetch timeout, a socket error, and a socket close, all
  // resolving with whatever partial page had been collected so far -- a
  // timed-out or failed fetch looks exactly like a short page and must not
  // be mistaken for one, or a transient failure permanently retires a
  // relay that still has history left. `eose` disambiguates: only a page
  // that both terminated on a genuine EOSE AND has nothing in it is
  // "nothing older" -- standard nostr history pagination walks `until`
  // backwards until a page comes back empty, not until one comes back
  // short. A budget failure ends the loop early for reasons that have
  // nothing to do with this relay's remaining history, so it must never be
  // mistaken for exhaustion either.
  const exhausted = !budgetExceeded && eose && rawEvents.length === 0;

  // Two separate updates rather than one: an empty page has no events to
  // derive a cursor from (oldestProcessed stays null) but must still be
  // able to record exhaustion -- folding both into one statement gated on
  // oldestProcessed would silently skip the exhausted flag for exactly
  // the page shape (zero events) that most commonly signals real
  // exhaustion.
  sql.exec(`UPDATE backfill_relays SET exhausted = ? WHERE relay_url = ?`, exhausted ? 1 : 0, relayUrl);
  if (oldestProcessed !== null) {
    sql.exec(`UPDATE backfill_relays SET until_cursor = ? WHERE relay_url = ?`, oldestProcessed - 1, relayUrl);
  }

  const allExhausted =
    sql.exec(`SELECT 1 FROM backfill_relays WHERE exhausted = 0 LIMIT 1`).toArray().length === 0;
  const nextStatus = budgetExceeded ? "paused-budget" : allExhausted ? "done" : "running";
  sql.exec(
    `UPDATE backfill_meta SET total_stored = total_stored + ?, last_run_at = ?, status = ?`,
    stored,
    nowSec,
    nextStatus,
  );

  return { stored, exhausted };
}

// One-time reset for relays wrongly marked exhausted by the pre-fix
// short-page heuristic (a relay's own per-REQ cap, or a fetchPage
// timeout/connection error, could each produce a short page that old
// applyBackfillPage mistook for "no more history" -- see this function's
// caller, Relay.runCron). Gated by backfill_meta.exhaust_reset_applied so
// it runs at most once per deployment; checked before any write, so a
// duplicate cron invocation racing this one just no-ops on its second
// call. Deliberately leaves until_cursor untouched -- each relay's cursor
// already points at exactly where it stopped, and rewinding it would
// re-fetch history already stored. Safe even for a relay that really was
// exhausted: clearing its flag costs exactly one wasted page fetch, which
// comes back empty with a genuine EOSE and is immediately re-flagged
// exhausted under the fixed rule above (applyBackfillPage).
export function resetWronglyExhaustedRelays(sql: SqlStorage): void {
  const applied =
    sql
      .exec<{ exhaust_reset_applied: number }>(`SELECT exhaust_reset_applied FROM backfill_meta LIMIT 1`)
      .toArray()[0]?.exhaust_reset_applied ?? 1;
  if (applied) return;

  sql.exec(`UPDATE backfill_relays SET exhausted = 0`);
  sql.exec(`UPDATE backfill_meta SET status = 'running' WHERE status = 'done'`);
  sql.exec(`UPDATE backfill_meta SET exhaust_reset_applied = 1`);
}
