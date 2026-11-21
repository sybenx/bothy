// One-shot backfill: fetch the owner's own events from the write relays
// in their kind 10002 and store them. This is the DO-side half, pure
// functions over SqlStorage called from relay.ts's RPC methods. It opens
// no connections; the outbound half is backfill-worker.ts.
import { getOwnHost, normalizeHost } from "./host";
import { BACKFILL_PAGE_SIZE, BACKFILL_ROWS_SHARE_LIMIT, utcDayStartSeconds } from "./limits";
import { isEphemeralKind } from "./nostr";
import { estimateRowsWrittenSince, isDeleted, eventExists, storeEvent } from "./storage";
import { idMatchesContent, isCreatedAtTooFarInFuture, parseEventShape, verifySignature } from "./validate";

export interface BackfillStatus {
  status: "pending" | "running" | "paused-budget" | "done";
  totalStored: number;
  relayCount: number;
  exhaustedCount: number;
  // Null unless status is "running" and a relay remains. The Worker uses
  // these directly so "what's next" is decided on one side of the RPC.
  nextRelay: string | null;
  nextUntil: number | null;
  // Set on every ingest call, even one that stores nothing. Stale against
  // "now" means ingest is never reached (a cron/RPC problem); current
  // while totalStored stays flat means it runs and stores nothing (a
  // storage/validation problem).
  lastRunAt: number | null;
  // limits.ts BACKFILL_PAGE_SIZE, reported rather than copied into the
  // admin page: it is derived from the declared index set, so it moves
  // when an index is added. A constant, not persisted state: it describes
  // the next run, not past ones.
  pageSize: number;
  // What `nextRelay` last sent instead of history (its CLOSED, NOTICE or
  // AUTH frames, truncated; backfill-worker.ts fetchPage). Null when the
  // last page carried events or the relay said nothing, so "stalled" and
  // "stalled because the relay wants AUTH" stay distinguishable.
  nextRefusal: string | null;
}

// Relay.getBackfillState merges in the owner pubkey (which this module
// does not know) so the Worker needs one RPC, not two. canIngestNow is
// not part of the persisted state machine: it is a moment-to-moment read
// of today's headroom (hasBackfillHeadroom) and can flip between ticks.
export type BackfillState = BackfillStatus & { ownerPubkey: string; canIngestNow: boolean };

// Backfill yields to the owner's live traffic rather than competing for
// the 100,000 rows-written/day ceiling. True while rows written since the
// last 00:00 UTC (storage.ts estimateRowsWrittenSince) leave backfill its
// reserved share (limits.ts BACKFILL_ROWS_SHARE_LIMIT).
//
// Since midnight, not a rolling 24h: the ceiling resets at 00:00 UTC, and
// a rolling window would keep backfill paused for up to a day against a
// budget already restored (limits.ts utcDayStartSeconds).
//
// Checked twice: getBackfillState checks it so the Worker can skip the
// outbound fetch on a day with no headroom, and applyBackfillPage checks
// again right before writing. Only the second protects the share, since
// live traffic can spend quota during the fetch (several seconds).
export function hasBackfillHeadroom(sql: SqlStorage, nowSec: number): boolean {
  return estimateRowsWrittenSince(sql, utcDayStartSeconds(nowSec * 1000)) < BACKFILL_ROWS_SHARE_LIMIT;
}

// Backs Relay.getBackfillState, read once per cron tick by
// backfill-worker.ts runBackfillTick.
export function getBackfillStatus(sql: SqlStorage): BackfillStatus {
  const meta = sql
    .exec<{ status: string; total_stored: number; last_run_at: number | null }>(
      `SELECT status, total_stored, last_run_at FROM backfill_meta LIMIT 1`,
    )
    .toArray()[0] ?? { status: "pending", total_stored: 0, last_run_at: null };

  const relays = sql
    .exec<{ relay_url: string; until_cursor: number; exhausted: number; last_refusal: string | null }>(
      `SELECT relay_url, until_cursor, exhausted, last_refusal FROM backfill_relays ORDER BY relay_url`,
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
    nextRefusal: next?.last_refusal ?? null,
    pageSize: BACKFILL_PAGE_SIZE,
  };
}

// Backs Relay.discoverBackfillRelays. A no-op if already seeded, so a
// duplicate call cannot reset progress. An empty `relayUrls` (the lookup
// failed) leaves status "pending" so the next tick retries discovery.
export function seedBackfillRelays(sql: SqlStorage, relayUrls: string[], nowSec: number): void {
  const alreadySeeded = sql.exec(`SELECT 1 FROM backfill_relays LIMIT 1`).toArray().length > 0;
  if (alreadySeeded || relayUrls.length === 0) return;

  // The owner's write relays usually include this relay. Seeding it would
  // fetch our own events from ourselves. Matched against the host learned
  // from traffic (host.ts), since the Worker can be named anything. The
  // host may not be known yet; purgeSelfRelay covers that case later.
  const ownHost = getOwnHost(sql);
  const relays = ownHost === null ? relayUrls : relayUrls.filter((url) => normalizeHost(url) !== ownHost);

  if (relays.length === 0) {
    // Every listed relay was this one: nothing to import. "done", not
    // "pending", or discovery would retry forever.
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

// Backs Relay.ingestBackfillPage: validates and stores one page the
// Worker already fetched from `relayUrl` (authors: [owner], until: this
// relay's cursor, limit: pageSize).
//
// Cheapest rejections first, schnorr verification last, as in relay.ts
// acceptEvent:
//   1. author mismatch: only the owner's events are in scope, whatever
//      the remote relay returns.
//   2. exact-id duplicate: every relay returns the same events; don't pay
//      a verify whose result cannot change the outcome.
//   3. tombstoned id: a NIP-09/NIP-62 deletion here must not be undone by
//      a copy still living on the remote relay.
//   4. id/signature validity.
//   5. storeEvent, the same function the live path uses, so replaceable,
//      addressable and ephemeral semantics are identical.
//
// The cursor advances over every parseable event, stored or not: a
// duplicate or tombstoned id is still progress, and skipping it would
// re-fetch it forever. If storeEvent throws (the shape a rows-written
// quota failure takes) the loop stops rather than failing the rest of
// the page.
export function applyBackfillPage(
  sql: SqlStorage,
  ownerPubkey: string,
  relayUrl: string,
  rawEvents: unknown[],
  eose: boolean,
  nowSec: number,
  // Whatever the relay sent that was not history (backfill-worker.ts
  // fetchPage). Recorded only when the page is empty.
  refusals: string[] = [],
): IngestResult {
  // The authoritative headroom check (see hasBackfillHeadroom). The page
  // is discarded and the cursor left alone, so the same page is fetched
  // again once headroom returns.
  if (!hasBackfillHeadroom(sql, nowSec)) {
    return { stored: 0, exhausted: false };
  }

  let stored = 0;
  // Advances only past fully handled events. An event whose storeEvent
  // threw must not be folded in, or a budget failure would skip it
  // forever instead of retrying it after the reset.
  let oldestProcessed: number | null = null;
  let budgetExceeded = false;

  for (const raw of rawEvents) {
    const event = parseEventShape(raw);
    if (!event) continue;

    if (
      event.pubkey === ownerPubkey &&
      !eventExists(sql, event.id) &&
      !isDeleted(sql, event.id) &&
      // See limits.ts MAX_CREATED_AT_FUTURE_SECONDS -- checked here,
      // before id/signature verification, same as the live path in
      // relay.ts acceptEvent.
      !isCreatedAtTooFarInFuture(event, nowSec)
    ) {
      if (idMatchesContent(event) && verifySignature(event)) {
        try {
          // Ingested at nowSec, not created_at: a backfilled event is
          // years old, and dating its write cost there would hide
          // backfill's own writes from hasBackfillHeadroom.
          const result = storeEvent(sql, event, nowSec);
          // `stored` means "broadcast-worthy", not "a row exists": an
          // ephemeral kind gets no row but is still returned. Backfill
          // never broadcasts, so ephemeral kinds are not counted.
          if (result.stored && !isEphemeralKind(event.kind)) stored++;
        } catch {
          budgetExceeded = true;
          break;
        }
      }
    }
    if (oldestProcessed === null || event.created_at < oldestProcessed) oldestProcessed = event.created_at;
  }

  // Exhausted only when a genuine EOSE arrives with an empty page, never
  // on a short page. Relays cap their own REQ limits, so short pages are
  // routine, and fetchPage resolves a timeout, socket error or close with
  // whatever partial page it had, which looks the same. Treating either
  // as exhaustion would permanently retire a relay that still has
  // history. History pagination walks `until` back until a page is empty.
  // A budget failure is never exhaustion either.
  const exhausted = !budgetExceeded && eose && rawEvents.length === 0;

  // Two updates: an empty page has no cursor to derive (oldestProcessed
  // is null) but must still record exhaustion, so the exhausted flag
  // cannot be gated on the cursor. `exhausted` and `last_refusal` share
  // one statement so the refusal costs no extra row write. last_refusal
  // is cleared as soon as a page carries events, so it never reports a
  // refusal the relay has stopped making.
  sql.exec(
    `UPDATE backfill_relays SET exhausted = ?, last_refusal = ? WHERE relay_url = ?`,
    exhausted ? 1 : 0,
    rawEvents.length === 0 && refusals.length > 0 ? refusals.join(" | ") : null,
    relayUrl,
  );
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

// Removes any backfill_relays row pointing at this deployment, on every
// cron tick rather than only at seed time. seedBackfillRelays can only
// filter the own host once it is known, and it is learned from inbound
// traffic (host.ts); a first cron tick that beats the first HTTP request
// seeds this relay as a source of its own history. Backfill would then
// spend ticks fetching its own events (all duplicates, nothing stored)
// while real sources wait behind it. Runs after
// resetWronglyExhaustedRelays in runCron, since that reset un-flags this
// row too.
export function purgeSelfRelay(sql: SqlStorage): number {
  const ownHost = getOwnHost(sql);
  if (ownHost === null) return 0;

  const rows = sql.exec<{ relay_url: string }>(`SELECT relay_url FROM backfill_relays`).toArray();
  let removed = 0;
  for (const row of rows) {
    if (normalizeHost(row.relay_url) === ownHost) {
      sql.exec(`DELETE FROM backfill_relays WHERE relay_url = ?`, row.relay_url);
      removed += 1;
    }
  }

  // If this relay was the only source, mark done, or status stays
  // 'running' forever over an empty table. Guarded on having removed
  // something, so a not-yet-seeded table keeps 'pending'.
  if (removed > 0 && sql.exec(`SELECT 1 FROM backfill_relays LIMIT 1`).toArray().length === 0) {
    sql.exec(`UPDATE backfill_meta SET status = 'done'`);
  }
  return removed;
}

// One-time migration: clears exhausted flags that an older rule (a short
// page counted as exhaustion) may have set wrongly. Runs at most once per
// deployment (backfill_meta.exhaust_reset_applied). Leaves until_cursor
// alone, so nothing already stored is re-fetched. A relay that really was
// exhausted costs one empty page and is re-flagged by applyBackfillPage.
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
