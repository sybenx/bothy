import { buildFilterQuery, compareEvents, expandFilter, type FilterQueryOptions } from "./filters";
import {
  groupIdOf,
  GROUP_METADATA_KIND,
  GROUP_ADMINS_KIND,
  acrossScopes,
  GROUP_CHAT_KIND,
  GROUP_SCOPE,
  type GroupScope,
  isGroupEvent,
  isGroupMetadataKind,
  PUBLIC_SCOPE,
  scopeOf,
  TOP_LEVEL_GROUP_ID,
} from "./groups";
import { CHAT_BACKLOG_SECONDS, CONVERSATION_IDLE_SECONDS, MAX_WRAP_RECIPIENTS_CHECKED } from "./limits";
import {
  EVENT_BASE_ROW_COST,
  EVENT_BASE_ROW_COST_MEASURED,
  EVENT_COUNTER_ROW_COST,
  eventRowCost,
  TAG_ROW_COST,
  TAG_ROW_COST_MEASURED,
  TOMBSTONE_ROW_COST,
  WRAP_FIXED_BYTES,
} from "./schema";
import { addRowsWritten, takeRowsWritten, unlandedRowsWritten, withReadPath } from "./read-metrics";
import { normalizeIp } from "./ip";
import { clearReqCache, readReqCache, reqCacheKey, writeReqCache } from "./req-cache";
import { getRelayPubkey } from "./relay-identity";
import {
  dTagValue,
  type Filter,
  GIFT_WRAP_KIND,
  isAddressableKind,
  isEphemeralKind,
  isReplaceableKind,
  type NostrEvent,
  pTagValues,
  isIndexedTag,
} from "./nostr";

interface EventRow extends Record<string, string | number | null> {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string;
  content: string;
  sig: string;
}

function rowToEvent(row: EventRow): NostrEvent {
  return {
    id: row.id,
    pubkey: row.pubkey,
    created_at: row.created_at,
    kind: row.kind,
    tags: JSON.parse(row.tags) as string[][],
    content: row.content,
    sig: row.sig,
  };
}

// Parses the NIP-40 `expiration` tag, if present and well-formed.
export function expirationOf(event: NostrEvent): number | null {
  const tag = event.tags.find((t) => t[0] === "expiration");
  if (!tag?.[1]) return null;
  const value = Number(tag[1]);
  return Number.isInteger(value) ? value : null;
}

// One of the only two functions that add or remove `events` rows (the
// other is deleteEventRow). The maintained counters move inside these two,
// so they cannot drift from the table; nothing else may insert an event
// row. (The one-time migrations below move rows between partitions in
// place and adjust the group counters themselves.)
//
// `ingestedAt` is wall-clock now, never event.created_at (schema.ts
// `ingested_at` explains why the two must not be conflated). `row_cost` is
// stamped here because only this INSERT knows the indexed tag count;
// estimateRowsWrittenSince sums that column. Both are extra columns on an
// INSERT that runs anyway, so they cost no rows written.
function insertEventRow(
  sql: SqlStorage,
  event: NostrEvent,
  expiration: number | null,
  ingestedAt: number,
): void {
  // req-cache.ts. The instrumented handle already clears it on this
  // INSERT; this covers a caller holding a raw ctx.storage.sql.
  clearReqCache();
  const indexedTags = event.tags.filter(isIndexedTag);
  // The partition is decided here, at the choke point, from the event
  // itself (groups.ts scopeOf), and copied onto the event row, its tag rows
  // and the counters, so no caller can file an event inconsistently.
  const scope = scopeOf(event, groupHost(sql));
  // NULL exactly when the row is public, including kinds 39000/39001,
  // which are public group state (groups.ts isPubliclyReadableGroupKind).
  const groupId = scope === GROUP_SCOPE ? groupIdOf(event) : null;
  // A gift wrap takes the home's next sequence number (schema.ts
  // events.seq): one row read here, and the counter moves in the mailbox
  // UPDATE below, which every stored wrap already pays.
  const seq =
    event.kind === GIFT_WRAP_KIND
      ? (sql.exec<{ seq: number }>(`SELECT seq FROM mail_usage WHERE pubkey = ?`, MAIL_TOTAL).toArray()[0]?.seq ??
          0) + 1
      : null;
  sql.exec(
    `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost, is_group, group_id, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.id,
    event.pubkey,
    event.created_at,
    event.kind,
    JSON.stringify(event.tags),
    event.content,
    event.sig,
    expiration,
    ingestedAt,
    eventRowCost(indexedTags.length),
    scope,
    groupId,
    seq,
  );
  // After the INSERT, so a duplicate id (which throws, and which
  // backfill.ts applyBackfillPage catches and continues past) leaves the
  // counters untouched. Before the tag loop, so if a tag insert throws, the
  // stored event row is still counted.
  //
  // Rows written: 2 (the third counter row is the ingest bucket below), on
  // top of the event row's own cost (schema.ts eventRowCostMeasured; the
  // guards use the deliberately higher eventRowCost).
  bumpEventCounters(sql, event.created_at, 1, scope);
  // The mailbox's bytes (schema.ts `mail_usage`) and the expiry index
  // (`wrap_expiry`), for gift wraps only. 2 to 3 rows written.
  if (event.kind === GIFT_WRAP_KIND) {
    bumpMailUsage(sql, wrapRecipients(event.tags), wrapBytes(event.content, JSON.stringify(event.tags)), 1, seq);
    if (expiration !== null) {
      sql.exec(`INSERT OR REPLACE INTO wrap_expiry (id, expiration) VALUES (?, ?)`, event.id, expiration);
    }
  }
  for (const tag of indexedTags) {
    sql.exec(
      `INSERT INTO event_tags (tag_name, tag_value, event_id, created_at, is_group, group_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      tag[0],
      tag[1],
      event.id,
      event.created_at,
      scope,
      groupId,
    );
  }
  // Must run LAST. This one upsert is both the ingest-hour bucket behind
  // `ingested24h` and where the write meter's running total
  // (read-metrics.ts) lands, so everything this event cost, tag rows
  // included, has to have happened before takeRowsWritten() or it is
  // attributed to the next event. Landing the meter here makes it free on
  // the event path; paths with no bucket of their own use settleRowsWritten.
  // The total also includes a superseded version deleted just before this
  // by a replaceable replacement (deleteEventRow adds to the same
  // accumulator).
  bumpIngestCounters(sql, hourBucket(ingestedAt), 1, scope === GROUP_SCOPE ? 1 : 0, takeRowsWritten());
}

// Whether this relay hosts a group with this id: what makes an `h` tag a
// group tag here rather than a reference to someone else's group.
//
// Memoised in module memory because it sits on the broadcast path (per
// event per open socket). Only createGroup changes the set, and it
// invalidates, so the memo is exact. Eviction just reloads it.
let hostedGroups: Set<string> | null = null;

export function invalidateHostedGroups(): void {
  hostedGroups = null;
}

export function hostsGroup(sql: SqlStorage, id: string): boolean {
  if (hostedGroups === null) {
    hostedGroups = new Set(
      sql.exec<{ id: string }>(`SELECT id FROM groups`).toArray().map((r) => r.id),
    );
  }
  return hostedGroups.has(id);
}

// The predicate shape groups.ts wants, bound to one storage handle.
export function groupHost(sql: SqlStorage): (id: string) => boolean {
  return (id) => hostsGroup(sql, id);
}

// The only function that removes an event row (see insertEventRow).
//
// `DELETE FROM event_tags WHERE event_id = ?` must stay served by
// idx_event_tags_event (schema.ts); without it each removal scans all of
// `event_tags` (~5E rows). That index is not optional, because NIP-62
// vanish reaches this path and cannot be gated, throttled below "eventually
// completes", or revoked: NIP-62 binds even write-restricted relays to
// honour it "regardless of the user's status", so relay.ts handleVanish
// runs before ownership.ts isAllowedWriter, and banpubkey/unfollowing never
// touch it. Cost is the only control. Unindexed, one vanish of N events
// read N x 5E rows, so N x E > 1,000,000 used the whole day's read ceiling
// in one request. test/read-cost.test.ts asserts the seek cost.
//
// The index fixes reads, not writes: each removal still costs its rows,
// index entries and a tombstone (schema.ts eventRemovalRowsWritten /
// eventRemovalBudget), which is why beginVanish/drainVanish checkpoint the
// work across cron ticks rather than doing it inside the request.
function deleteEventRow(sql: SqlStorage, id: string): void {
  // req-cache.ts, for the same reason as insertEventRow's.
  clearReqCache();
  // Read here rather than taken from the caller, because banEvent passes
  // ids that may never have been stored: the counters must move only for a
  // row that existed, by its own `created_at`. `undefined` means nothing
  // to remove. Rows read: 1 (the same PK seek the DELETE does).
  // `content` and `tags` only for a gift wrap, whose mailbox charge is
  // refunded below; no other kind pays to read them.
  const row = sql
    .exec<{
      created_at: number;
      ingested_at: number | null;
      row_cost: number | null;
      is_group: number;
      kind: number;
      wrap_content: string | null;
      wrap_tags: string | null;
    }>(
      `SELECT created_at, ingested_at, row_cost, is_group, kind,
              CASE WHEN kind = ? THEN content END AS wrap_content,
              CASE WHEN kind = ? THEN tags END AS wrap_tags
         FROM events WHERE id = ?`,
      GIFT_WRAP_KIND,
      GIFT_WRAP_KIND,
      id,
    )
    .toArray()[0];
  sql.exec(`DELETE FROM event_tags WHERE event_id = ?`, id);
  sql.exec(`DELETE FROM events WHERE id = ?`, id);
  // After the DELETEs, so a statement that throws cannot leave the
  // counters describing fewer events than are stored.
  if (row === undefined) return;
  if (row.kind === GIFT_WRAP_KIND && row.wrap_content !== null && row.wrap_tags !== null) {
    let tags: string[][] = [];
    try {
      tags = JSON.parse(row.wrap_tags) as string[][];
    } catch {
      tags = [];
    }
    bumpMailUsage(sql, wrapRecipients(tags), wrapBytes(row.wrap_content, row.wrap_tags), -1);
    sql.exec(`DELETE FROM wrap_expiry WHERE id = ?`, id);
  }
  // The partition the row was actually in, read from the row.
  const scope: GroupScope = row.is_group === 1 ? GROUP_SCOPE : PUBLIC_SCOPE;
  bumpEventCounters(sql, row.created_at, -1, scope);
  // `ingested24h` counts events taken in and still held, so a removal comes
  // out of the hour the event ARRIVED in. Plain UPDATE, not upsert, for the
  // reason bumpEventCounters gives. `rows_written` is left alone: a row
  // written and then deleted was still written.
  //
  // A NULL `ingested_at` (rows from before the column existed) was never
  // bucketed (schema.ts seedIngestCounts), so there is nothing to decrement.
  if (row.ingested_at !== null) {
    sql.exec(
      `UPDATE ingest_hour_counts SET n = n - 1, group_n = group_n - ? WHERE hour = ?`,
      scope === GROUP_SCOPE ? 1 : 0,
      hourBucket(row.ingested_at),
    );
  }
  // The one place rows written are accounted by hand. SqlStorageCursor
  // reports index maintenance on INSERT but not on DELETE (schema.ts
  // eventRemovalRowsWritten), so the read-metrics.ts wrapper undercounts
  // every removal. This adds the pessimistic figure on top: stamped
  // `row_cost` plus TOMBSTONE_ROW_COST, which is exactly schema.ts
  // eventRemovalBudget, the figure the vanish drain is paced against. A
  // budget meter should err high.
  //
  // It double-counts the base rows the cursor did report, deliberately:
  // tracking only the difference would need a second hand-maintained model
  // of what the cursor can see. A NULL `row_cost` (pre-migration row) falls
  // back to a bare note's cost.
  //
  // Not landed here: the next landing in the same execution context
  // (insertEventRow's bucket bump, or settleRowsWritten at the entry point)
  // writes it, so recording it costs no extra row.
  addRowsWritten((row.row_cost ?? eventRowCost(0)) + TOMBSTONE_ROW_COST);
}

// The hour key for both bucket tables: `event_hour_counts` is keyed by
// `created_at`, `ingest_hour_counts` by `ingested_at`. Which timestamp is
// passed is decided at each call site, and must not be mixed up.
//
// Math.trunc, not Math.floor, to match SQLite's integer `/` (toward zero),
// which the seed migrations (schema.ts seedMaintainedCounts,
// seedIngestCounts) and auditMaintainedCounts use. They differ for negative
// created_at, which nothing rejects, and a mismatch would seed an event
// into one bucket and decrement it from another.
export function hourBucket(createdAt: number): number {
  return Math.trunc(createdAt / 3600);
}

// The counters behind /api/stats' `totalEvents` and `events24h`.
//
// Called only from insertEventRow and deleteEventRow. A second caller
// would let the counters move without the table moving.
//
// Upsert on the way up, plain UPDATE on the way down: a decrement is
// always for a counted event whose bucket exists, and an upsert would
// silently create a -1 bucket if that ever stopped being true instead of
// leaving auditMaintainedCounts something to find.
function bumpEventCounters(
  sql: SqlStorage,
  createdAt: number,
  delta: 1 | -1,
  scope: GroupScope,
): void {
  // The group half is a second column in the same statements, which costs
  // no extra rows written (measured: 1 row either way).
  const group = scope === GROUP_SCOPE ? 1 : 0;
  sql.exec(
    `UPDATE maintained_counts SET events = events + ?, group_events = group_events + ?`,
    delta,
    delta * group,
  );
  if (delta === 1) {
    sql.exec(
      `INSERT INTO event_hour_counts (hour, n, group_n) VALUES (?, 1, ?)
         ON CONFLICT(hour) DO UPDATE SET n = n + 1, group_n = group_n + excluded.group_n`,
      hourBucket(createdAt),
      group,
    );
  } else {
    sql.exec(
      `UPDATE event_hour_counts SET n = n - 1, group_n = group_n - ? WHERE hour = ?`,
      group,
      hourBucket(createdAt),
    );
  }
}

// The ingest-hour bucket behind `ingested24h` and `rowsWrittenToday`
// (schema.ts `ingest_hour_counts`), moved by `events` (1 when an event
// arrives, 0 when only rows-written is landing) and `rowsWritten`.
//
// One row written, no index entry (`hour` is a rowid alias). The decrement
// is a plain UPDATE in deleteEventRow, as in bumpEventCounters.
function bumpIngestCounters(
  sql: SqlStorage,
  hour: number,
  events: number,
  groupEvents: number,
  rowsWritten: number,
): void {
  sql.exec(
    `INSERT INTO ingest_hour_counts (hour, n, group_n, rows_written) VALUES (?, ?, ?, ?)
       ON CONFLICT(hour) DO UPDATE SET n = n + excluded.n,
                                       group_n = group_n + excluded.group_n,
                                       rows_written = rows_written + excluded.rows_written`,
    hour,
    events,
    groupEvents,
    rowsWritten,
  );
}

// A landing costs one row, so landing one pending row records one row of
// writing at the price of one row of writing. Below this, the residue
// carries to the next landing instead -- see the write meter's comment in
// read-metrics.ts for what that costs (at most the landing statement's
// own row, lost only if the object is evicted before the next one).
const MIN_ROWS_WRITTEN_LANDING = 2;

// Lands the write meter's running total into the current ingest hour.
//
// Must be called at every Durable Object entry point (relay.ts `metered`),
// before that execution context returns. The accumulator is instance
// memory and the object hibernates between messages (~70 wakes per cron
// interval), so a timed or deferred flush would lose most of the count,
// and lose more the quieter the relay is.
//
// Usually a no-op: event writes land their own total in insertEventRow.
// What reaches here is cron, the follow rebuild, NIP-86 calls, backfill
// bookkeeping and the vanish drain. Rows read: 1, only when something
// lands. Scoped to "meter" so it does not swell `unattributed`, which is
// read-metrics.ts's gap detector.
export function settleRowsWritten(sql: SqlStorage, nowSec: number): void {
  if (unlandedRowsWritten() < MIN_ROWS_WRITTEN_LANDING) return;
  withReadPath("meter", () => bumpIngestCounters(sql, hourBucket(nowSec), 0, 0, takeRowsWritten()));
}

// /api/stats `ingested24h` and `rowsWrittenToday`, from the ingest-hour
// buckets in one statement.
//
// One range answers both because `budgetSince` (the last 00:00 UTC) is
// always inside the last 24 hours, and nothing is bucketed ahead of now
// (`ingested_at` is wall-clock). Rows read: at most 25, independent of E
// and request rate; /api/stats is unauthenticated, so this must not grow.
//
// `rowsWrittenToday` is exact, since 00:00 UTC falls on an hour boundary.
// `ingested24h` covers whole hours, so 24-25h (as countEvents24h).
export function readIngestCounts(
  sql: SqlStorage,
  nowSec: number,
  budgetSince: number,
): { ingested24h: number; ingestedGroup24h: number; rowsWrittenToday: number } {
  const row = sql
    .exec<{ ingested: number | null; grouped: number | null; written: number | null }>(
      `SELECT SUM(n) AS ingested,
              SUM(group_n) AS grouped,
              SUM(CASE WHEN hour >= ? THEN rows_written ELSE 0 END) AS written
         FROM ingest_hour_counts WHERE hour >= ?`,
      hourBucket(budgetSince),
      hourBucket(nowSec - 86400),
    )
    .toArray()[0];
  return {
    ingested24h: row?.ingested ?? 0,
    // relay.ts collectStats subtracts this before publishing, so a public
    // poller cannot time group arrivals. The audit uses both halves.
    ingestedGroup24h: row?.grouped ?? 0,
    rowsWrittenToday: row?.written ?? 0,
  };
}

export interface CountAuditStatus {
  // Null means the audit has never run -- see the `last_drift` column
  // comment in schema.ts for why that must render differently from "ran
  // and found nothing".
  lastRanAt: number | null;
  // One string per disagreement the last completed run found, or null if
  // that run found none. Only meaningful when `lastRanAt` is non-null.
  drift: string[] | null;
}

// /api/stats `totalEvents`, `followCount` and the audit status, from the
// one `maintained_counts` row. Rows read: 1, whatever E and F are.
export function readMaintainedCounts(
  sql: SqlStorage,
): { events: number; groupEvents: number; follows: number } & CountAuditStatus {
  const row = sql
    .exec<{
      events: number;
      group_events: number;
      follows: number;
      audited_at: number | null;
      last_drift: string | null;
    }>(`SELECT events, group_events, follows, audited_at, last_drift FROM maintained_counts`)
    .toArray()[0];
  return {
    events: row?.events ?? 0,
    // /api/stats reports `events - groupEvents`, so a public poller cannot
    // time group arrivals off the total (schema.ts `group_events`).
    groupEvents: row?.group_events ?? 0,
    follows: row?.follows ?? 0,
    lastRanAt: row?.audited_at ?? null,
    drift: row?.last_drift ? (JSON.parse(row.last_drift) as string[]) : null,
  };
}

// The follow count, for ownership.ts refreshFollows only. It must be called
// inside refreshFollows' own write branches (rebuild and clear), since
// refreshFollows is the only writer of `follows` and its early returns
// would otherwise skip it. Rows written: 1, only when the list changes.
export function setFollowCount(sql: SqlStorage, follows: number): void {
  sql.exec(`UPDATE maintained_counts SET follows = ?`, follows);
}

// The `created_at` of the contact list the follow cache reflects, not when
// the cache was rebuilt. Rows read: 1: every row in `follows` carries the
// same value (schema.ts `follows`), so `LIMIT 1` is exact.
export function followsListAt(sql: SqlStorage): number | null {
  return (
    sql.exec<{ fetched_at: number }>(`SELECT fetched_at FROM follows LIMIT 1`).toArray()[0]
      ?.fetched_at ?? null
  );
}

// /api/stats `events24h`: stored events whose own `created_at` is in the
// last 24 hours (what was posted, not what was ingested; that is
// readIngestCounts).
//
// Rows read: at most 26, independent of E: from the bucket containing
// now - 86400 to at most one hour ahead, since limits.ts
// MAX_CREATED_AT_FUTURE_SECONDS refuses anything further ahead. Whole
// hours, so the window is 24-25h.
export function countEvents24h(
  sql: SqlStorage,
  nowSec: number,
): { total: number; group: number } {
  const row = sql
    .exec<{ n: number | null; grouped: number | null }>(
      `SELECT SUM(n) AS n, SUM(group_n) AS grouped FROM event_hour_counts WHERE hour >= ?`,
      hourBucket(nowSec - 86400),
    )
    .toArray()[0];
  // /api/stats reports the difference; the audit checks each half.
  return { total: row?.n ?? 0, group: row?.grouped ?? 0 };
}

// Daily check that every maintained counter still matches the table it
// counts, called from relay.ts runCron.
//
// DETECT ONLY: it logs and records, and never writes a corrected figure.
// A self-repairing counter erases the evidence of whatever broke it, so the
// bug recurs silently and the number is quietly wrong between repairs.
//
// Rows read, once a day: E (one scan of `events` yields all the event
// figures; keep it one statement, as each extra pass costs another E), +
// at most 26 + 25 bucket rows, + F (`follows`, which has its own writer in
// ownership.ts refreshFollows and so gets checked too), + M for the
// membership check.
//
// Paced by `maintained_counts.audited_at`, not by the cron schedule.
export function auditMaintainedCounts(sql: SqlStorage, nowSec: number): void {
  const state = sql
    .exec<{ events: number; groupEvents: number; follows: number; audited_at: number | null }>(
      `SELECT events, group_events AS groupEvents, follows, audited_at FROM maintained_counts`,
    )
    .toArray()[0];
  if (state === undefined) return;
  if (state.audited_at !== null && nowSec - state.audited_at < 86400) return;

  const cutoff = hourBucket(nowSec - 86400);
  // One scan of `events` for every figure; see the header on why.
  const actual = sql
    .exec<{
      total: number;
      groupTotal: number;
      windowed: number;
      groupWindowed: number;
      ingested: number;
      groupIngested: number;
      ingestedCost: number;
      ingestedCosted: number;
    }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(is_group), 0) AS groupTotal,
              COALESCE(SUM(CASE WHEN created_at / 3600 >= ? THEN 1 ELSE 0 END), 0) AS windowed,
              COALESCE(SUM(CASE WHEN created_at / 3600 >= ? THEN is_group ELSE 0 END), 0) AS groupWindowed,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? THEN 1 ELSE 0 END), 0) AS ingested,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? THEN is_group ELSE 0 END), 0) AS groupIngested,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? THEN row_cost ELSE 0 END), 0) AS ingestedCost,
              COALESCE(SUM(CASE WHEN ingested_at / 3600 >= ? AND row_cost IS NOT NULL THEN 1 ELSE 0 END), 0) AS ingestedCosted
         FROM events`,
      cutoff,
      cutoff,
      cutoff,
      cutoff,
      cutoff,
      cutoff,
    )
    .toArray()[0] ?? {
    total: 0,
    groupTotal: 0,
    windowed: 0,
    groupWindowed: 0,
    ingested: 0,
    groupIngested: 0,
    ingestedCost: 0,
    ingestedCosted: 0,
  };
  const counted24h = countEvents24h(sql, nowSec);
  // `budgetSince` is passed as now - 86400 too, so `rowsWrittenToday` here
  // is a rolling 24h figure, matching the window of the floor check below.
  const ingestBuckets = readIngestCounts(sql, nowSec, nowSec - 86400);
  const actualFollows =
    sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM follows`).toArray()[0]?.n ?? 0;

  // Stored in `last_drift` for /api/stats to read back after the log line
  // has scrolled away.
  const driftMessages: string[] = [];
  // `message` is stored in `last_drift`, which the PUBLIC, unauthenticated
  // /api/stats reads back; `detail` goes only to the log. The membership
  // check below puts pubkeys in `detail` only, since storing them would
  // publish group membership. The stored half counts; the logged half names.
  const report = (message: string, where: string, detail = "") => {
    driftMessages.push(message);
    console.error(
      `MAINTAINED COUNT DRIFT: ${message}.${detail === "" ? "" : ` ${detail}.`} ` +
        `NOT corrected -- see storage.ts auditMaintainedCounts. ` +
        `Every write to the counted table must go through ${where}.`,
    );
  };
  const drift = (what: string, said: number, is: number, where: string) => {
    report(`${what} says ${said}, the table says ${is} (off by ${said - is})`, where);
  };

  if (actual.total !== state.events) {
    drift("maintained_counts.events", state.events, actual.total, "insertEventRow/deleteEventRow");
  }
  // The group halves are checked on their own because /api/stats subtracts
  // them: one that drifted low would leak group events onto a public
  // document while the total still matched.
  if (actual.groupTotal !== state.groupEvents) {
    drift(
      "maintained_counts.group_events",
      state.groupEvents,
      actual.groupTotal,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actual.windowed !== counted24h.total) {
    drift(
      "event_hour_counts, summed over the last 24h",
      counted24h.total,
      actual.windowed,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actual.groupWindowed !== counted24h.group) {
    drift(
      "event_hour_counts.group_n, summed over the last 24h",
      counted24h.group,
      actual.groupWindowed,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actualFollows !== state.follows) {
    drift("maintained_counts.follows", state.follows, actualFollows, "refreshFollows");
  }
  if (actual.ingested !== ingestBuckets.ingested24h) {
    drift(
      "ingest_hour_counts, summed over the last 24h",
      ingestBuckets.ingested24h,
      actual.ingested,
      "insertEventRow/deleteEventRow",
    );
  }
  if (actual.groupIngested !== ingestBuckets.ingestedGroup24h) {
    drift(
      "ingest_hour_counts.group_n, summed over the last 24h",
      ingestBuckets.ingestedGroup24h,
      actual.groupIngested,
      "insertEventRow/deleteEventRow",
    );
  }
  // A FLOOR, not an equality. `rows_written` includes deletions,
  // tombstones, follow rebuilds, NIP-86 calls and backfill bookkeeping, so
  // it normally exceeds the cost of the events still standing from those
  // hours. It can never legitimately fall below it; if it does, the meter
  // lost writes (an entry point that landed nothing, or a write that
  // bypassed the read-metrics.ts wrapper).
  //
  // Compared against the MEASURED cost, not the stamped one. `row_cost`
  // is schema.ts eventRowCost, a deliberate over-estimate (12 + 4T charged
  // against 9 + 3T spent; see EVENT_BASE_ROW_COST). Over-charging makes
  // every other consumer stricter, but here it would put the floor above
  // what the meter can report and log drift every day. So the tag rows are
  // recovered from the stamped total and re-priced at the measured
  // figures. If eventRowCost is ever made exact, this collapses to
  // `ingestedCost` and should be removed.
  //
  // Rows with NULL `row_cost` are excluded from both sides
  // (`ingestedCosted` counts only stamped rows).
  const stampedPerEvent = EVENT_BASE_ROW_COST + EVENT_COUNTER_ROW_COST;
  const measuredPerEvent = EVENT_BASE_ROW_COST_MEASURED + EVENT_COUNTER_ROW_COST;
  const tagRowsInWindow = Math.max(
    0,
    (actual.ingestedCost - actual.ingestedCosted * stampedPerEvent) / TAG_ROW_COST,
  );
  const measuredCost = Math.floor(
    actual.ingestedCosted * measuredPerEvent + tagRowsInWindow * TAG_ROW_COST_MEASURED,
  );
  if (ingestBuckets.rowsWrittenToday < measuredCost) {
    drift(
      "ingest_hour_counts.rows_written, summed over the last 24h, is BELOW the cost of the events in it",
      ingestBuckets.rowsWrittenToday,
      measuredCost,
      "the read-metrics.ts wrapper, landed by storage.ts settleRowsWritten at every entry point",
    );
  }

  // Not a counter: an invariant between two tables, checked here because
  // this is where the daily pacing lives. Every NIP-29 group member must
  // have an `allowed_pubkeys` row, because that outer list is what
  // ownership.ts isAllowedWriter consults; a member without one is refused
  // with a message about follows that never mentions groups. nip29.ts
  // applyModeration writes both, so they diverge only through a bug or a
  // hand-edit.
  //
  // Detect only: repairing it would grant relay write access on the
  // strength of a row just found untrustworthy.
  const unallowedMembers = groupMembersWithoutAllowance(sql);
  if (unallowedMembers.length > 0) {
    report(
      `${unallowedMembers.length} group member(s) have no allowed_pubkeys row, so the relay-wide write ` +
        `gate refuses their events even though the group holds them as members`,
      "nip29.ts applyModeration, which writes both tables together",
      `Affected pubkeys: ${unallowedMembers.join(", ")}`,
    );
  }

  // Written even when something drifted: `audited_at` paces the next run,
  // and skipping it would rescan E rows every cron tick. `last_drift` goes
  // in the same statement so the timestamp and findings always describe
  // the same run; NULL when clean (schema.ts `last_drift`).
  sql.exec(
    `UPDATE maintained_counts SET audited_at = ?, last_drift = ?`,
    nowSec,
    driftMessages.length > 0 ? JSON.stringify(driftMessages) : null,
  );
}

// One-time correction of rows wrongly stored with is_group = 1:
//
//   1. An `h`-tagged event naming a group this relay does not host
//      (typically backfilled from the owner's history elsewhere). It is
//      someone else's ordinary content, so it is moved to the PUBLIC
//      partition.
//   2. A 39000-series event not signed by this relay's own key
//      (relay-identity.ts). storeEvent now refuses these; this removes any
//      stored earlier. It is DELETED, not moved: a group reader's REQ
//      merges both partitions (relay.ts handleReqInner), so a public copy
//      would still sit beside the genuine member list, and an ordinary
//      unauthenticated `{"authors":[owner]}` would start returning it
//      (filterNamesGroup does not refuse an authors-only filter). Deletion
//      is safe because storeEvent's signer check keeps it from returning.
//      Matched by signer, not `d`, since a forged `d` is trivial.
//
// Batched by `limit` with no cursor (VANISH_BATCH_SIZE at the call site in
// relay.ts runCronInner, because moving a row between partitions or
// deleting it has the index-maintenance cost that constant is paced
// against). Guarded by relay_meta.group_scope_fixed, set to 1 once a call
// finds no candidates.
//
// Each candidate's fix runs in storage.transactionSync. DO SQLite commits
// each exec() separately, and raw BEGIN/SAVEPOINT is refused by the
// runtime; transactionSync rolls back every write made in its closure,
// including writes through read-metrics.ts instrumentSql's proxy.
// Without it, a crash between the `events` and `event_tags` flips would
// leave a stale `event_tags.is_group`, which filters.ts buildFilterQuery's
// tag subquery reads directly to decide which partition an event is
// served from.
//
// Population 1 is re-checked with isGroupEvent before writing, because an
// event can carry several `h` tags and groupIdOf reads only the first.
// Population 2 needs no recheck: `pubkey` is one column.
//
// Known limit, relevant only while the flag is still 0: the candidate
// query treats any `h` value other than TOP_LEVEL_GROUP_ID as suspect, so
// events with a mismatched second `h` tag, and events in any other group
// this relay hosts, are re-selected and skipped on every call. The flag
// then never flips and every tick pays one bounded query; and if such
// false positives fill `limit`, real candidates behind them are never
// reached.
export function fixMisclassifiedGroupEvents(
  sql: SqlStorage,
  storage: DurableObjectStorage,
  limit: number,
): number {
  const alreadyFixed =
    sql.exec<{ group_scope_fixed: number }>(`SELECT group_scope_fixed FROM relay_meta LIMIT 1`).toArray()[0]
      ?.group_scope_fixed ?? 1;
  if (alreadyFixed) return 0;

  const relayPubkey = getRelayPubkey(sql);

  const candidates = sql
    .exec<{ event_id: string }>(
      `SELECT DISTINCT event_id FROM (
         SELECT et.event_id FROM event_tags et JOIN events e ON e.id = et.event_id
          WHERE et.is_group = 1 AND e.is_group = 1 AND et.tag_name = 'h' AND et.tag_value <> ?
         UNION ALL
         SELECT id AS event_id FROM events
          WHERE is_group = 1 AND kind BETWEEN 39000 AND 39005 AND pubkey <> ?
       ) LIMIT ?`,
      TOP_LEVEL_GROUP_ID,
      relayPubkey,
      limit,
    )
    .toArray();

  if (candidates.length === 0) {
    sql.exec(`UPDATE relay_meta SET group_scope_fixed = 1`);
    return 0;
  }

  let fixed = 0;
  for (const { event_id } of candidates) {
    // Read, check and fix one candidate atomically (see the header).
    // Returns false for a false positive or a row already gone.
    const wasFixed = storage.transactionSync((): boolean => {
      const row = sql
        .exec<EventRow & { ingested_at: number | null }>(
          `SELECT id, pubkey, created_at, kind, tags, content, sig, ingested_at
             FROM events WHERE id = ? AND is_group = 1`,
          event_id,
        )
        .toArray()[0];
      if (row === undefined) return false;
      const event = rowToEvent(row);

      if (isGroupMetadataKind(event.kind)) {
        // Population 2: deleted, not moved (see the header).
        deleteEventRow(sql, event_id);
        return true;
      }

      // Population 1: skip anything that really is ours (see the header).
      if (isGroupEvent(event, groupHost(sql))) return false;

      sql.exec(`UPDATE events SET is_group = 0 WHERE id = ?`, event_id);
      sql.exec(`UPDATE event_tags SET is_group = 0 WHERE event_id = ?`, event_id);
      // A reclassification, not a removal: only the group halves of the
      // counters move, mirroring deleteEventRow's decrement.
      sql.exec(`UPDATE maintained_counts SET group_events = group_events - 1`);
      sql.exec(
        `UPDATE event_hour_counts SET group_n = group_n - 1 WHERE hour = ?`,
        hourBucket(row.created_at),
      );
      if (row.ingested_at !== null) {
        sql.exec(
          `UPDATE ingest_hour_counts SET group_n = group_n - 1 WHERE hour = ?`,
          hourBucket(row.ingested_at),
        );
      }
      return true;
    });
    if (wasFixed) fixed += 1;
  }
  return fixed;
}

// One-time migration of stored rows to multiple groups. New writes are
// already correct (insertEventRow derives both from the event); this fixes
// rows that predate the change:
//
//   - kinds 39000/39001 are now public group state (groups.ts
//     isPubliclyReadableGroupKind) and must leave the group partition, or
//     an unauthenticated NIP-29 client sees no groups on this relay;
//   - group-partition rows need `group_id`;
//   - legacy `group_members` rows move to `group_membership`.
//
// Run from cron in VANISH_BATCH_SIZE batches, like
// fixMisclassifiedGroupEvents and for the same index-maintenance reason.
// The membership copy is unbatched; it is bounded by group size.
//
// Each step is idempotent (membership by primary key, the moves and stamps
// by selecting only rows still needing them), so an interrupted tick just
// repeats. The flag is set only when a pass changes nothing.
export function migrateToMultiGroup(
  sql: SqlStorage,
  storage: DurableObjectStorage,
  limit: number,
): number {
  const done =
    sql
      .exec<{ multi_group_migrated: number }>(`SELECT multi_group_migrated FROM relay_meta LIMIT 1`)
      .toArray()[0]?.multi_group_migrated ?? 0;
  if (done) return 0;

  let changed = 0;

  // 1. Membership: every legacy member belonged to TOP_LEVEL_GROUP_ID, the
  //    only group there was. `source` is set to 'owner' because the old
  //    table did not record it, and 'owner' is the conservative choice:
  //    remove-user reclaims only 'invite' rows, so no access is silently
  //    revoked.
  const legacy = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'group_members'`,
    )
    .toArray()[0];
  if ((legacy?.n ?? 0) > 0) {
    sql.exec(
      `INSERT OR IGNORE INTO group_membership (group_id, pubkey, added_at, source)
         SELECT ?, pubkey, added_at, 'owner' FROM group_members`,
      TOP_LEVEL_GROUP_ID,
    );
    sql.exec(`DROP TABLE group_members`);
    changed += 1;
  }

  // 2. 39000/39001 rows still in the group partition, moved to public one
  //    per transaction with the same group-half counter adjustment as
  //    fixMisclassifiedGroupEvents.
  const misfiled = sql
    .exec<{ id: string; created_at: number; ingested_at: number | null }>(
      `SELECT id, created_at, ingested_at FROM events
        WHERE is_group = 1 AND kind IN (?, ?) LIMIT ?`,
      GROUP_METADATA_KIND,
      GROUP_ADMINS_KIND,
      limit,
    )
    .toArray();
  for (const row of misfiled) {
    storage.transactionSync(() => {
      sql.exec(`UPDATE events SET is_group = 0 WHERE id = ?`, row.id);
      sql.exec(`UPDATE event_tags SET is_group = 0 WHERE event_id = ?`, row.id);
      sql.exec(`UPDATE maintained_counts SET group_events = group_events - 1`);
      sql.exec(
        `UPDATE event_hour_counts SET group_n = group_n - 1 WHERE hour = ?`,
        hourBucket(row.created_at),
      );
      if (row.ingested_at !== null) {
        sql.exec(
          `UPDATE ingest_hour_counts SET group_n = group_n - 1 WHERE hour = ?`,
          hourBucket(row.ingested_at),
        );
      }
    });
    changed += 1;
  }

  // 3. `group_id` on group-partition rows that lack it. Read from the event,
  //    not assumed to be TOP_LEVEL_GROUP_ID: rows may belong to a group the
  //    owner has since created, and filing them under the wrong group would
  //    expose them to that group's members.
  const unstamped = sql
    .exec<EventRow>(
      `SELECT id, pubkey, created_at, kind, tags, content, sig FROM events
        WHERE is_group = 1 AND group_id IS NULL LIMIT ?`,
      limit,
    )
    .toArray();
  for (const row of unstamped) {
    const id = groupIdOf(rowToEvent(row));
    // Cannot happen via storeEvent. Skipped without counting it as a
    // change, so it does not keep the flag below from being set.
    if (id === null) continue;
    storage.transactionSync(() => {
      sql.exec(`UPDATE events SET group_id = ? WHERE id = ?`, id, row.id);
      sql.exec(`UPDATE event_tags SET group_id = ? WHERE event_id = ?`, id, row.id);
    });
    changed += 1;
  }

  if (changed === 0) {
    sql.exec(`UPDATE relay_meta SET multi_group_migrated = 1`);
    invalidateHostedGroups();
  }
  return changed;
}

// ---------------------------------------------------------------------
// THE PARTITION RULE, obeyed by every query below.
//
// Every event is in exactly one partition (`is_group` 0 or 1, groups.ts),
// and schema.ts declares the REQ-serving indexes on `events` and
// `event_tags` as partial PAIRS on it. SQLite uses a partial index only
// when the WHERE clause implies its predicate, so a query that pins
// `is_group` to neither value reads the whole table. Measured at 50,000
// group events, `SELECT id FROM events WHERE pubkey = ? AND kind = ?`:
// 2 rows read pinned, 51,500 unpinned.
//
// A lookup not about one partition runs once per partition
// (groups.ts acrossScopes). Primary-key lookups (`WHERE id = ?`) need no
// pin: the PK index is not partial.
// ---------------------------------------------------------------------
export function eventExists(sql: SqlStorage, id: string): boolean {
  return sql.exec(`SELECT 1 FROM events WHERE id = ?`, id).toArray().length > 0;
}

// Tombstone check for the write path: deletion removes the row, so
// eventExists cannot tell a new id from a replayed deleted one (schema.ts
// `deleted_ids`).
export function isDeleted(sql: SqlStorage, id: string): boolean {
  return sql.exec(`SELECT 1 FROM deleted_ids WHERE id = ?`, id).toArray().length > 0;
}

// Deletes an event and permanently refuses its id, so a sender holding a
// signed copy cannot replay it. For deletion requests and bans only
// (NIP-09, NIP-62 drainVanish, banEvent). A replaceable/addressable
// replacement is not a deletion and uses deleteEventRow; so do the chat and
// expired-gift-wrap sweeps, for the reasons given on them.
function deleteAndTombstone(sql: SqlStorage, id: string): void {
  deleteEventRow(sql, id);
  sql.exec(`INSERT OR IGNORE INTO deleted_ids (id) VALUES (?)`, id);
}

// True while the database is small enough to accept non-owner writes
// (limits.ts NON_OWNER_STORAGE_SHARE_LIMIT). `limit` is env-overridable and
// resolved by the caller. `databaseSize` is a property read, not a query.
export function hasNonOwnerStorageHeadroom(sql: SqlStorage, limit: number): boolean {
  return sql.databaseSize < limit;
}

// Stored gift wraps, for the maxGiftWraps cap (limits.ts), run on every
// accepted wrap. Answered from idx_events_kind_created_* without touching
// the table; do not add a condition on a column those indexes lack (see
// sweepExpiredGiftWraps).
export function giftWrapCount(sql: SqlStorage): number {
  // Both partitions: wraps stored before relay.ts handleGiftWrap refused
  // group-tagged ones may sit in the group partition, and the cap must
  // count them. Two index counts cost what one did (measured: 500 rows
  // either way).
  return acrossScopes((scope) =>
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM events WHERE kind = ? AND is_group = ?`,
        GIFT_WRAP_KIND,
        scope,
      )
      .toArray(),
  ).reduce((total, row) => total + row.n, 0);
}

// ---------------------------------------------------------------------
// The mailbox's bytes (schema.ts `mail_usage`, limits.ts
// mailStorageBytes and mailBytesPerMember).
// ---------------------------------------------------------------------

const MAIL_TOTAL = "*";

// What a stored wrap is charged: its content and serialized tags as
// stored, plus schema.ts WRAP_FIXED_BYTES. The same function on insert
// and delete, from the same stored strings, so the two always cancel.
export function wrapBytes(content: string, tagsJson: string): number {
  return content.length + tagsJson.length + WRAP_FIXED_BYTES;
}

// Who a wrap is charged to: its distinct `p` values, as many as
// relay.ts handleGiftWrap looks at (limits.ts MAX_WRAP_RECIPIENTS_CHECKED).
function wrapRecipients(tags: string[][]): string[] {
  return [...new Set(pTagValues(tags))].slice(0, MAX_WRAP_RECIPIENTS_CHECKED);
}

// `seq`, on a stored wrap, moves the `*` row's sequence counter to it in
// the same statement (schema.ts mail_usage.seq); deletes never move it.
function bumpMailUsage(
  sql: SqlStorage,
  recipients: string[],
  bytes: number,
  sign: 1 | -1,
  seq: number | null = null,
): void {
  for (const key of [MAIL_TOTAL, ...recipients]) {
    const counter = key === MAIL_TOTAL && seq !== null ? seq : 0;
    sql.exec(
      `INSERT INTO mail_usage (pubkey, bytes, n, seq) VALUES (?, MAX(?, 0), MAX(?, 0), ?)
         ON CONFLICT(pubkey) DO UPDATE SET bytes = MAX(bytes + ?, 0), n = MAX(n + ?, 0),
                                           seq = MAX(seq, excluded.seq)`,
      key,
      sign * bytes,
      sign,
      counter,
      sign * bytes,
      sign,
    );
  }
}

export interface MailUsage {
  bytes: number;
  messages: number;
}

export function mailUsage(sql: SqlStorage, pubkey: string | null): MailUsage {
  const row = sql
    .exec<{ bytes: number; n: number }>(`SELECT bytes, n FROM mail_usage WHERE pubkey = ?`, pubkey ?? MAIL_TOTAL)
    .toArray()[0];
  return { bytes: row?.bytes ?? 0, messages: row?.n ?? 0 };
}

// Whether a wrap of `bytes` fits: the home's total first, then each
// recipient's share. Two or three PK reads.
export type MailRoom = "ok" | "home-full" | "share-full";

export function mailRoom(
  sql: SqlStorage,
  recipients: readonly string[],
  bytes: number,
  homeCap: number | null,
  perMemberCap: number | null,
): MailRoom {
  if (homeCap !== null && mailUsage(sql, null).bytes + bytes > homeCap) return "home-full";
  if (perMemberCap !== null) {
    for (const pubkey of recipients) {
      if (mailUsage(sql, pubkey).bytes + bytes > perMemberCap) return "share-full";
    }
  }
  return "ok";
}

// Wraps this key has signed that are stored here, counted up to `limit`
// and no further (idx_events_pubkey_kind_created_pub), for
// limits.ts MAX_WRAPS_PER_AUTHOR.
export function wrapsSignedBy(sql: SqlStorage, pubkey: string, limit: number): number {
  return (
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM events WHERE pubkey = ? AND kind = ? AND is_group = 0 LIMIT ?)`,
        pubkey,
        GIFT_WRAP_KIND,
        limit,
      )
      .toArray()[0]?.n ?? 0
  );
}

export interface GiftWrapSweep {
  // How many wraps this tick actually removed.
  removed: number;
  // Whether every expired wrap is now gone, or a remainder waits for the
  // next tick.
  done: boolean;
}

// Deletes gift wraps whose NIP-40 `expiration` has passed. Every other
// kind is only hidden when expired (filters.ts); kind 1059 is the one kind
// capped by COUNT, so an expired wrap would hold a `maxGiftWraps` slot
// forever and eventually get the owner's real mail refused as "inbox
// full". Dead rows also cost `excludeGiftWraps` the same skip live ones do.
//
// Teaching giftWrapCount about expiry instead would be wrong: `expiration`
// is on no index, so the count would fetch every row and double a read paid
// on every accepted wrap, and the dead rows would still cost the skip.
//
// No tombstone: relay.ts acceptEvent refuses any event whose signed
// `expiration` has passed, so the event refuses its own replay.
//
// Oldest first via the index, stopping when the batch fills, so "run again
// next tick" is the whole checkpoint. A tick with nothing to do walks the
// kind-1059 range once per partition: bounded by `maxGiftWraps` (~2,048
// rows at defaults, ~1% of the daily read ceiling if run hourly on a
// permanently full inbox), and free on a relay holding no wraps.
//
// Both partitions, matching giftWrapCount.
export function sweepExpiredGiftWraps(
  sql: SqlStorage,
  nowSec: number,
  limit: number,
): GiftWrapSweep {
  // From `wrap_expiry`, soonest first (idx_wrap_expiry_expiration), so a
  // tick reads only what is due, however many wraps are stored.
  const targets = sql
    .exec<{ id: string }>(
      `SELECT id FROM wrap_expiry WHERE expiration <= ? ORDER BY expiration ASC LIMIT ?`,
      nowSec,
      limit,
    )
    .toArray();
  const done = targets.length < limit;
  for (const target of targets) deleteEventRow(sql, target.id);
  return { removed: targets.length, done };
}

interface StoreResult {
  ok: boolean;
  message: string;
  stored: NostrEvent | null;
}

// NIP-01 "Kinds" storage rules: regular kinds keep every event;
// replaceable/addressable kinds keep only the newest per key (ties: lowest
// id); ephemeral kinds are never stored, but `stored` is still the event so
// the caller broadcasts it. `stored: null` with `ok: true` means "accepted,
// not stored". Duplicate and tombstone checks are the caller's (relay.ts
// acceptEvent, which also refuses expired events; backfill.ts
// applyBackfillPage). Every event row, relay-generated ones included, must
// go through here.
export function storeEvent(sql: SqlStorage, event: NostrEvent, ingestedAt: number): StoreResult {
  if (isEphemeralKind(event.kind)) {
    return { ok: true, message: "", stored: event };
  }

  if (isReplaceableKind(event.kind)) {
    // Both partitions: NIP-01 keys a replaceable event by (pubkey, kind)
    // alone, so pinning only the incoming event's partition would let one
    // author keep a public and a group-scoped "current" version.
    const existing = acrossScopes((scope) =>
      sql
        .exec<{ id: string; created_at: number }>(
          `SELECT id, created_at FROM events WHERE pubkey = ? AND kind = ? AND is_group = ?`,
          event.pubkey,
          event.kind,
          scope,
        )
        .toArray(),
    );
    if (existing.some((row) => isSupersededBy(row, event))) {
      return { ok: true, message: "", stored: null };
    }
    for (const row of existing) {
      deleteEventRow(sql, row.id);
    }
    insertEventRow(sql, event, expirationOf(event), ingestedAt);
    return { ok: true, message: "", stored: event };
  }

  if (isAddressableKind(event.kind)) {
    // NIP-29: 39000-series events "MUST be created by the relay master key
    // only". nip29.ts authorizeGroupWrite refuses client-submitted ones,
    // but backfill.ts applyBackfillPage calls storeEvent without that gate
    // and could import one the owner signed elsewhere. Checked by SIGNER,
    // not by `d`: a forged event can carry any `d`, and would then be
    // indistinguishable from this relay's real member list. Only
    // relay-identity.ts signAsRelay produces an accepted signature.
    //
    // Dropped as "accepted, not stored" rather than as an error: the only
    // caller that reaches this is backfill, which reads `stored` only.
    if (isGroupMetadataKind(event.kind) && event.pubkey !== getRelayPubkey(sql)) {
      return { ok: true, message: "", stored: null };
    }
    const d = dTagValue(event.tags);
    // Both partitions, for the reason the replaceable branch above gives.
    const candidates = acrossScopes((scope) =>
      sql
        .exec<{ id: string; created_at: number; tags: string }>(
          `SELECT id, created_at, tags FROM events WHERE pubkey = ? AND kind = ? AND is_group = ?`,
          event.pubkey,
          event.kind,
          scope,
        )
        .toArray(),
    );
    const matching = candidates.filter((c) => dTagValue(JSON.parse(c.tags) as string[][]) === d);
    if (matching.some((c) => isSupersededBy(c, event))) {
      return { ok: true, message: "", stored: null };
    }
    for (const existing of matching) {
      deleteEventRow(sql, existing.id);
    }
    insertEventRow(sql, event, expirationOf(event), ingestedAt);
    return { ok: true, message: "", stored: event };
  }

  // Regular kinds, and the spec-undefined 45-999/>=40000 ranges, are stored
  // as regular events: 45-999 holds live assigned kinds, writes are already
  // gated by the write policy, and storing too much is recoverable while
  // rejecting the owner's own events is not.
  insertEventRow(sql, event, expirationOf(event), ingestedAt);
  return { ok: true, message: "", stored: event };
}

// True when `candidate` loses to `existing` under NIP-01's replacement
// rule: higher created_at wins; on a tie, the lowest id wins.
function isSupersededBy(
  existing: { id: string; created_at: number },
  candidate: NostrEvent,
): boolean {
  if (existing.created_at > candidate.created_at) return true;
  if (existing.created_at === candidate.created_at && existing.id < candidate.id) return true;
  return false;
}

// NIP-09 deletion (nips/09.md): an `e` tag removes the referenced event
// by id (unless it is itself a deletion request -- "deleting a deletion
// request has no effect", line 53); an `a` tag removes replaceable/
// addressable versions at or before the deletion's created_at.
//
// Authorization on the `e`-tag path depends on the target's kind:
//   - gift wrap (kind 1059): the deleter must be in the target's `p` tags.
//     Wraps are signed by a one-time key, so the same-author rule could
//     never match; NIP-59 lets the recipient delete instead.
//   - everything else: the deleter must be the target's author (NIP-09).
// Checked here rather than relying on the write gate, because the table
// holds events from many authors (gift wraps, follows, group members,
// other write policies), and the failure would be one author deleting
// another's events.
export function applyDeletion(sql: SqlStorage, deletion: NostrEvent): void {
  for (const tag of deletion.tags) {
    if (tag[0] === "e" && tag[1]) {
      const target = sql
        .exec<{ kind: number; pubkey: string; tags: string }>(
          `SELECT kind, pubkey, tags FROM events WHERE id = ?`,
          tag[1],
        )
        .toArray()[0];
      if (!target || target.kind === 5) continue;
      const authorized =
        target.kind === GIFT_WRAP_KIND
          ? pTagValues(JSON.parse(target.tags) as string[][]).includes(deletion.pubkey)
          : target.pubkey === deletion.pubkey;
      if (authorized) deleteAndTombstone(sql, tag[1]);
    } else if (tag[0] === "a" && tag[1]) {
      applyAddressDeletion(sql, tag[1], deletion);
    }
  }
}

// NIP-09 `a` tags address replaceable and addressable kinds only; regular
// events are deleted by `e` tag. The kind check is a cost bound, not just
// conformance: for a regular kind, `1:<pubkey>:` would match every kind-1
// by that author, so one tag could delete unboundedly many events. Limited
// to these kinds, each `a` tag matches at most one stored event, and
// MAX_EVENT_BYTES (roughly 870 `e` tags at 64 KiB) bounds a request's cost.
function applyAddressDeletion(sql: SqlStorage, address: string, deletion: NostrEvent): void {
  const [kindStr, pubkey, d = ""] = address.split(":");
  const kind = Number(kindStr);
  if (!Number.isInteger(kind) || pubkey !== deletion.pubkey) return;
  if (!isReplaceableKind(kind) && !isAddressableKind(kind)) return;

  // Both partitions: an address names the event wherever it is stored.
  if (isAddressableKind(kind)) {
    const candidates = acrossScopes((scope) =>
      sql
        .exec<{ id: string; created_at: number; tags: string }>(
          `SELECT id, created_at, tags FROM events WHERE pubkey = ? AND kind = ? AND created_at <= ? AND is_group = ?`,
          pubkey,
          kind,
          deletion.created_at,
          scope,
        )
        .toArray(),
    );
    for (const c of candidates) {
      if (dTagValue(JSON.parse(c.tags) as string[][]) === d) deleteAndTombstone(sql, c.id);
    }
  } else {
    const candidates = acrossScopes((scope) =>
      sql
        .exec<{ id: string }>(
          `SELECT id FROM events WHERE pubkey = ? AND kind = ? AND created_at <= ? AND is_group = ?`,
          pubkey,
          kind,
          deletion.created_at,
          scope,
        )
        .toArray(),
    );
    for (const c of candidates) deleteAndTombstone(sql, c.id);
  }
}

// NIP-62 Request to Vanish, in two halves: this records the request and
// drainVanish does the work across cron ticks.
//
// Split because the sender chooses the size: a pubkey with thousands of
// events cannot be removed inside one request without overrunning the
// write budget (schema.ts eventRemovalBudget), and NIP-62 says "fully
// delete", so stopping partway while reporting success is not an option.
// Once recorded, the drain resumes on the next tick whatever happens to the
// socket or the object.
//
// Applies to any requester, not only the owner, and is not routed through
// ownership.ts isAllowedWriter: NIP-62 binds write-restricted relays to
// honour it "regardless of the user's status". See deleteEventRow for what
// that costs.
//
// `cutoffCreatedAt` (the request's created_at) is stored, not recomputed
// on resume, so the set of events covered never changes.
export function beginVanish(
  sql: SqlStorage,
  requester: string,
  cutoffCreatedAt: number,
  nowSec: number,
): void {
  // The cutoff only moves outward: a second request with an earlier cutoff
  // must not narrow a deletion already promised.
  sql.exec(
    `INSERT INTO vanishing (pubkey, cutoff_created_at, requested_at) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET
         cutoff_created_at = MAX(cutoff_created_at, excluded.cutoff_created_at),
         requested_at = excluded.requested_at`,
    requester,
    cutoffCreatedAt,
    nowSec,
  );
}

// The one definition of what a vanish covers, shared by drainVanish and
// hasVanishTargets so they cannot disagree: events the requester authored,
// and gift wraps p-tagged to them (NIP-62 "SHOULD delete all NIP-59 Gift
// Wraps that p-tagged the .pubkey"). One UNION so a single `limit` bounds
// both clauses and neither can be reported done while the other remains.
function vanishTargets(
  sql: SqlStorage,
  requester: string,
  cutoffCreatedAt: number,
  limit: number,
): { id: string }[] {
  // Both partitions (a vanish covers group events too), with the pin on
  // the tag subquery as well, per the partition rule. `limit` applies per
  // partition and again in the slice, so a batch never exceeds it.
  return acrossScopes((scope) =>
    sql
      .exec<{ id: string }>(
        `SELECT id FROM events WHERE pubkey = ? AND created_at <= ? AND is_group = ?
         UNION
         SELECT id FROM events WHERE kind = ? AND created_at <= ? AND is_group = ?
           AND id IN (SELECT event_id FROM event_tags WHERE is_group = ? AND tag_name = 'p' AND tag_value = ?)
         LIMIT ?`,
        requester,
        cutoffCreatedAt,
        scope,
        GIFT_WRAP_KIND,
        cutoffCreatedAt,
        scope,
        scope,
        requester,
        limit,
      )
      .toArray(),
  ).slice(0, limit);
}

// Whether a vanish request has anything to remove: a read in front of
// beginVanish's write. A vanish over an empty set is already complete, and
// recording it anyway costs 4 rows written (measured) on a path any
// signer can reach before every write gate. At the 5 messages/second the
// per-IP throttle (relay.ts RATE_LIMIT_MAX_MESSAGES) permits, that is
// ~1,730,000 rows/day against the 100,000/day ceiling. This costs one seek.
export function hasVanishTargets(sql: SqlStorage, requester: string, cutoffCreatedAt: number): boolean {
  return vanishTargets(sql, requester, cutoffCreatedAt, 1).length > 0;
}

// The cutoff of a vanish already checkpointed for this pubkey, or null if
// none is pending.
//
// Backs relay.ts handleVanish's dedupe. A signed vanish event can be
// replayed by anyone who has seen it, and without this each replay would
// rewrite the checkpoint and run another drain batch. Compared against the
// incoming cutoff, a replay costs one row read; only a request that would
// widen the pending one writes.
export function pendingVanishCutoff(sql: SqlStorage, requester: string): number | null {
  const row = sql
    .exec<{ cutoff_created_at: number }>(
      `SELECT cutoff_created_at FROM vanishing WHERE pubkey = ?`,
      requester,
    )
    .toArray()[0];
  return row?.cutoff_created_at ?? null;
}

export interface VanishProgress {
  deleted: number;
  // True once nothing is left to remove for this pubkey, at which point
  // the `vanishing` row is gone and the request is complete.
  done: boolean;
}

// Removes up to `limit` of one pubkey's vanish targets (vanishTargets) and
// clears the checkpoint once nothing is left. Safe to call repeatedly; a
// no-op for a pubkey with no `vanishing` row.
export function drainVanish(sql: SqlStorage, requester: string, limit: number): VanishProgress {
  const row = sql
    .exec<{ cutoff_created_at: number; deleted_so_far: number }>(
      `SELECT cutoff_created_at, deleted_so_far FROM vanishing WHERE pubkey = ?`,
      requester,
    )
    .toArray()[0];
  if (!row) return { deleted: 0, done: true };

  const targets = vanishTargets(sql, requester, row.cutoff_created_at, limit);

  for (const target of targets) deleteAndTombstone(sql, target.id);

  // Fewer than `limit` means the set is exhausted; no second query needed.
  const done = targets.length < limit;
  if (done) {
    sql.exec(`DELETE FROM vanishing WHERE pubkey = ?`, requester);
  } else {
    sql.exec(
      `UPDATE vanishing SET deleted_so_far = ? WHERE pubkey = ?`,
      row.deleted_so_far + targets.length,
      requester,
    );
  }
  return { deleted: targets.length, done };
}

export interface PendingVanish {
  pubkey: string;
  deletedSoFar: number;
  requestedAt: number;
}

// Vanish requests still draining, for relay.ts runCron. Oldest first, so
// newer requests cannot starve older ones.
//
// INTERNAL ONLY: these rows name the pubkeys that asked to be erased.
// /api/stats uses vanishSummary.
export function pendingVanishes(sql: SqlStorage): PendingVanish[] {
  return sql
    .exec<{ pubkey: string; deleted_so_far: number; requested_at: number }>(
      `SELECT pubkey, deleted_so_far, requested_at FROM vanishing ORDER BY requested_at ASC`,
    )
    .toArray()
    .map((r) => ({ pubkey: r.pubkey, deletedSoFar: r.deleted_so_far, requestedAt: r.requested_at }));
}

export interface VanishSummary {
  // How many pubkeys have a drain in progress.
  pending: number;
  // Events removed so far across all of them.
  deletedSoFar: number;
  // When the oldest pending request arrived, or null if none is pending
  // -- what makes a stalled drain visible.
  oldestRequestedAt: number | null;
}

// What the public, unauthenticated /api/stats may say about vanish
// requests: a count, a progress total and an age, enough to see a stuck
// drain without naming who asked to be erased. One row read.
export function vanishSummary(sql: SqlStorage): VanishSummary {
  const row = sql
    .exec<{ pending: number; deleted: number; oldest: number | null }>(
      `SELECT COUNT(*) AS pending, COALESCE(SUM(deleted_so_far), 0) AS deleted,
              MIN(requested_at) AS oldest
         FROM vanishing`,
    )
    .toArray()[0];
  return {
    pending: row?.pending ?? 0,
    deletedSoFar: row?.deleted ?? 0,
    oldestRequestedAt: row?.oldest ?? null,
  };
}

// What a READER may see, set by relay.ts handleReqInner.
//
// `scopes` is the partitions this read covers: public only for an
// unauthenticated client, both for an authorised reader. A list, not a
// boolean, because each partition is a separate query (filters.ts
// FilterQueryOptions.scope).
export interface ReadOptions {
  excludeGiftWraps?: boolean;
  // Owner-only, and NOT implied by `scopes` including the group
  // partition: members read the group but not its invite codes (groups.ts
  // CREATE_INVITE_KIND).
  excludeInvites?: boolean;
  scopes?: readonly GroupScope[];
  // Oldest `created_at` a kind-9 chat message may be returned at (from
  // chatHorizon below; turned into SQL by filters.ts
  // FilterQueryOptions.chatHorizon). Undefined means no clamp, as when
  // EPHEMERAL_CHAT is unset. Not a permission: it applies to the owner too.
  chatHorizon?: number;
  // See FilterQueryOptions.groupIds. `undefined` is the owner, who reads
  // every group; an empty array is a reader who may read none.
  groupIds?: readonly string[];
}

export function queryFilter(
  sql: SqlStorage,
  filter: Filter,
  nowSec: number,
  options: ReadOptions = {},
): NostrEvent[] {
  const scopes = options.scopes ?? [PUBLIC_SCOPE];
  const parts = expandFilter(filter);
  const perQuery = (scope: GroupScope): FilterQueryOptions => ({
    ...(options.excludeGiftWraps === undefined ? {} : { excludeGiftWraps: options.excludeGiftWraps }),
    ...(options.excludeInvites === undefined ? {} : { excludeInvites: options.excludeInvites }),
    ...(options.chatHorizon === undefined ? {} : { chatHorizon: options.chatHorizon }),
    // This object is an explicit allowlist of what reaches the query
    // builder, so a new ReadOptions field must be forwarded here by hand.
    // Dropping `groupIds` lets a member of one group read every group
    // (test/nip29-groups.test.ts).
    ...(options.groupIds === undefined ? {} : { groupIds: options.groupIds }),
    scope,
    // Split the tag scan budget across partitions, so an authorised read
    // costs what limits.ts priced, not twice it.
    tagScanDivisor: scopes.length,
  });

  const onlyPart = parts[0];
  const onlyScope = scopes[0];
  if (parts.length === 1 && scopes.length === 1 && onlyPart !== undefined && onlyScope !== undefined) {
    return runFilterQuery(sql, onlyPart, nowSec, perQuery(onlyScope));
  }

  const byId = new Map<string, NostrEvent>();
  for (const scope of scopes) {
    for (const part of parts) {
      for (const event of runFilterQuery(sql, part, nowSec, perQuery(scope))) byId.set(event.id, event);
    }
  }
  const merged = [...byId.values()].sort(compareEvents);
  return filter.limit === undefined ? merged : merged.slice(0, filter.limit);
}

function runFilterQuery(
  sql: SqlStorage,
  filter: Filter,
  nowSec: number,
  options?: FilterQueryOptions,
): NostrEvent[] {
  const query = buildFilterQuery(filter, nowSec, options);
  if (query === null) return [];
  // req-cache.ts: a repeated query against unchanged data reads nothing.
  const key = reqCacheKey(query.sql, query.params);
  const cached = readReqCache(key, nowSec);
  if (cached !== undefined) return cached;
  const events = sql
    .exec<EventRow>(query.sql, ...query.params)
    .toArray()
    .map(rowToEvent);
  let minExpiration: number | null = null;
  for (const event of events) {
    const expiration = expirationOf(event);
    if (expiration !== null && (minExpiration === null || expiration < minExpiration)) minExpiration = expiration;
  }
  writeReqCache(key, events, minExpiration);
  return [...events];
}

// Estimated rows written storing events ingested after `sinceCutoff`,
// summed from the `row_cost` each insert stamps. Sole caller: backfill.ts
// hasBackfillHeadroom (since 00:00 UTC), which keeps backfill inside its
// BACKFILL_ROWS_SHARE_LIMIT so it never competes with live traffic.
//
// Keyed on `ingested_at`, never `created_at`: backfilled events carry
// years-old timestamps, and filtering on created_at hid backfill's own
// writes from the guard restraining it (schema.ts `ingested_at`).
//
// Rows read: the events ingested in the window, as a range seek on the
// covering idx_events_ingested (ingested_at, row_cost). Without that index
// it reads all of `events` on every check, a cost that grows with E. Never
// join `event_tags` here to count tags; that read the whole tag table.
//
// Insertions only, and an underestimate: deletions, tombstones and
// non-event writes are absent, events deleted since are dropped, and NULL
// `row_cost` rows are skipped. That is correct for this guard, because
// deletion traffic has its own reserved share (limits.ts
// VANISH_ROWS_SHARE_LIMIT). It is NOT the write-budget meter: /api/stats
// `rowsWrittenToday` is measured (read-metrics.ts, landed by
// settleRowsWritten). Keep the two separate; feeding the meter into this
// guard would make backfill yield to traffic it is already insulated from.
export function estimateRowsWrittenSince(sql: SqlStorage, sinceCutoff: number): number {
  return withReadPath("estimateRowsWrittenSince", () => estimateRowsWrittenSinceInner(sql, sinceCutoff));
}

// Reported under its own read-metrics.ts path rather than its caller's, so
// its cost stays visible on /api/stats `reads` wherever it is called from.
function estimateRowsWrittenSinceInner(sql: SqlStorage, sinceCutoff: number): number {
  return (
    sql
      .exec<{ total: number | null }>(
        `SELECT SUM(row_cost) AS total FROM events WHERE ingested_at > ?`,
        sinceCutoff,
      )
      .toArray()[0]?.total ?? 0
  );
}

// Multiple filters in one REQ are ORed (nips/01.md line 129) and
// deduped/re-sorted as a single result set, newest-first with ties
// broken by lowest id -- matching the ordering a single filter's query
// would produce.
export function queryFilters(
  sql: SqlStorage,
  filters: Filter[],
  nowSec: number,
  options?: ReadOptions,
): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const filter of filters) {
    for (const event of queryFilter(sql, filter, nowSec, options)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()].sort(compareEvents);
}

// ---------------------------------------------------------------------
// NIP-86 relay management (src/nip86.ts) storage, written at operator
// pace. Of this section, only isIpBlocked runs on a client-facing path
// (once per WebSocket connection).
// ---------------------------------------------------------------------

export interface BannedEvent {
  id: string;
  reason: string | null;
}

// Records the ban AND tombstones the id. `banned_events` is what
// listbannedevents reads back; the `deleted_ids` tombstone is what refuses
// a client re-send or a backfill replay. Banning an id that is not stored
// is meaningful for that reason.
export function banEvent(sql: SqlStorage, id: string, reason: string | null, nowSec: number): void {
  deleteAndTombstone(sql, id);
  sql.exec(
    `INSERT INTO banned_events (id, reason, banned_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at`,
    id,
    reason,
    nowSec,
  );
}

// The ONLY place that deletes a tombstone; everywhere else they are
// permanent. The owner explicitly asking for an id to be storable again is
// the one justification. This also lifts tombstones from NIP-09/NIP-62
// deletions, which is the owner's call. Do not restrict it to ids in
// `banned_events`; that would leave some tombstoned ids with no way back.
export function allowEvent(sql: SqlStorage, id: string): void {
  sql.exec(`DELETE FROM banned_events WHERE id = ?`, id);
  sql.exec(`DELETE FROM deleted_ids WHERE id = ?`, id);
}

// Reads `banned_events`, never `deleted_ids`, which also holds NIP-09 and
// NIP-62 deletions that are not bans.
export function listBannedEvents(sql: SqlStorage): BannedEvent[] {
  return sql
    .exec<{ id: string; reason: string | null }>(
      `SELECT id, reason FROM banned_events ORDER BY banned_at DESC`,
    )
    .toArray();
}

export interface BlockedIp {
  ip: string;
  reason: string | null;
}

// Every IP is canonicalized (ip.ts normalizeIp) before storage or
// comparison, here and in nip86.ts's self-block check. Otherwise an
// expanded IPv6 typed by the operator would never match Cloudflare's
// compressed CF-Connecting-IP, and the block would list as active while
// never firing.
export function blockIp(sql: SqlStorage, ip: string, reason: string | null, nowSec: number): void {
  sql.exec(
    `INSERT INTO blocked_ips (ip, reason, blocked_at) VALUES (?, ?, ?)
       ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, blocked_at = excluded.blocked_at`,
    normalizeIp(ip),
    reason,
    nowSec,
  );
}

export function unblockIp(sql: SqlStorage, ip: string): void {
  sql.exec(`DELETE FROM blocked_ips WHERE ip = ?`, normalizeIp(ip));
}

export function listBlockedIps(sql: SqlStorage): BlockedIp[] {
  return sql
    .exec<{ ip: string; reason: string | null }>(`SELECT ip, reason FROM blocked_ips ORDER BY blocked_at DESC`)
    .toArray();
}

// Once per WebSocket connection in Relay.fetch(), never per message. Never
// called for the management endpoint, so blocking your own address cannot
// lock you out of the API that unblocks it.
export function isIpBlocked(sql: SqlStorage, ip: string): boolean {
  return sql.exec(`SELECT 1 FROM blocked_ips WHERE ip = ?`, normalizeIp(ip)).toArray().length > 0;
}

// The stored rung of the relay identity chain (nip11.ts), written by
// changerelayname/description/icon. Absent keys read as null; there is no
// stored "" (see setRelaySetting).
export interface RelaySettings {
  name: string | null;
  description: string | null;
  icon: string | null;
  // Written by NIP-86 changewritepolicy. Stored as the operator's string
  // and parsed at resolution (write-policy.ts resolveWritePolicy), so an
  // unparseable value falls through to the default instead of refusing
  // every write.
  writePolicy: string | null;
  // The home's file server (nip86.ts setstorage): its URL, advertised on
  // NIP-11 as `storage`, and the pubkey it signs memberkeys calls with.
  // Both or neither.
  storageUrl?: string | null;
  storagePubkey?: string | null;
}

export function getRelaySettings(sql: SqlStorage): RelaySettings {
  const rows = sql.exec<{ key: string; value: string }>(`SELECT key, value FROM relay_settings`).toArray();
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  return {
    name: byKey.get("name") ?? null,
    description: byKey.get("description") ?? null,
    icon: byKey.get("icon") ?? null,
    writePolicy: byKey.get("write_policy") ?? null,
    storageUrl: byKey.get("storage_url") ?? null,
    storagePubkey: byKey.get("storage_pubkey") ?? null,
  };
}

// The stored policy alone, for the write path. One row read per wake, not
// per event: relay.ts caches the resolved policy per instance and clears it
// after every management call.
export function getStoredWritePolicy(sql: SqlStorage): string | null {
  const row = sql
    .exec<{ value: string }>(`SELECT value FROM relay_settings WHERE key = ?`, "write_policy")
    .toArray()[0];
  return row?.value ?? null;
}

// An empty string clears the stored value: NIP-86 has no unset operation,
// so this is bothy's convention (README.md "Relay management API"). A
// stored "" would shadow the kind-0 and default rungs forever.
export type RelaySettingKey = "name" | "description" | "icon" | "write_policy" | "storage_url" | "storage_pubkey";

// The storage service's pubkey alone, for the memberkeys gate.
export function storagePubkey(sql: SqlStorage): string | null {
  return (
    sql
      .exec<{ value: string }>(`SELECT value FROM relay_settings WHERE key = 'storage_pubkey'`)
      .toArray()[0]?.value ?? null
  );
}

export function setRelaySetting(sql: SqlStorage, key: RelaySettingKey, value: string): void {
  if (value === "") {
    sql.exec(`DELETE FROM relay_settings WHERE key = ?`, key);
    return;
  }
  sql.exec(
    `INSERT INTO relay_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

// ---------------------------------------------------------------------
// NIP-86 pubkey lists: banpubkey/unbanpubkey/listbannedpubkeys and
// allowpubkey/unallowpubkey/listallowedpubkeys. Two independent lists, not
// two ends of one. isPubkeyBanned and isPubkeyAllowed DO run on the
// per-event write path (ownership.ts isAllowedWriter).
// ---------------------------------------------------------------------

export interface BannedPubkey {
  pubkey: string;
  reason: string | null;
}

export function banPubkey(sql: SqlStorage, pubkey: string, reason: string | null, nowSec: number): void {
  sql.exec(
    `INSERT INTO banned_pubkeys (pubkey, reason, banned_at) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET reason = excluded.reason, banned_at = excluded.banned_at`,
    pubkey,
    reason,
    nowSec,
  );
}

export function unbanPubkey(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM banned_pubkeys WHERE pubkey = ?`, pubkey);
}

export function listBannedPubkeys(sql: SqlStorage): BannedPubkey[] {
  return sql
    .exec<{ pubkey: string; reason: string | null }>(
      `SELECT pubkey, reason FROM banned_pubkeys ORDER BY banned_at DESC`,
    )
    .toArray();
}

// One PK lookup per non-owner write, run before the follows check
// (ownership.ts isAllowedWriter) so a banned follow is still refused.
export function isPubkeyBanned(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM banned_pubkeys WHERE pubkey = ?`, pubkey).toArray().length > 0;
}

export interface AllowedPubkey {
  pubkey: string;
  reason: string | null;
}

// NIP-86 allowpubkey: the only writer of `source = 'owner'`. An existing
// row is PROMOTED to 'owner' (one-way), so a later kind-9001 remove-user,
// which deletes only 'invite' rows, cannot revoke a deliberate grant.
//
// `invitedBy` is the caller (the owner); a promotion keeps an earlier
// inviter when none is given.
export function allowPubkey(
  sql: SqlStorage,
  pubkey: string,
  reason: string | null,
  nowSec: number,
  invitedBy: string | null = null,
): void {
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source, invited_by) VALUES (?, ?, ?, 'owner', ?)
       ON CONFLICT(pubkey) DO UPDATE SET reason = excluded.reason, allowed_at = excluded.allowed_at,
                                         source = 'owner',
                                         invited_by = COALESCE(excluded.invited_by, invited_by)`,
    pubkey,
    reason,
    nowSec,
    invitedBy,
  );
  readmitFormerMember(sql, pubkey);
}

// ---------------------------------------------------------------------
// NIP-29 group membership (src/nip29.ts). Two nested lists: a
// `group_membership` row lets a pubkey write to that group, an
// `allowed_pubkeys` row lets it write here at all, and a member needs both.
// `allowed_pubkeys.source` records who granted the outer row, so
// remove-user can reclaim only what the group granted.
// ---------------------------------------------------------------------

// The outer-list row a new member needs, written by kind-9000 put-user and
// a redeemed kind-9021 join. DO NOTHING on conflict, never an upsert: an
// upsert writing 'invite' would silently demote an owner grant into one
// remove-user can reclaim.
export function allowPubkeyForGroup(
  sql: SqlStorage,
  pubkey: string,
  reason: string,
  nowSec: number,
): void {
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source, close)
       VALUES (?, ?, ?, 'invite', 0)
       ON CONFLICT(pubkey) DO NOTHING`,
    pubkey,
    reason,
    nowSec,
  );
  readmitFormerMember(sql, pubkey);
}

// The inverse: removes only a group-granted ('invite') row, never an owner
// grant.
export function revokeGroupAllowance(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM allowed_pubkeys WHERE pubkey = ? AND source = 'invite'`, pubkey);
}

// `groupId` here and in the next two functions defaults to
// TOP_LEVEL_GROUP_ID for callers that do not yet pass the event's group
// (nip29.ts authorizeGroupWrite and handleJoinRequest still rely on it).
// A default parameter rather than a constant in the query, so removing it
// makes the compiler find every such caller.
export function addGroupMember(
  sql: SqlStorage,
  pubkey: string,
  nowSec: number,
  groupId: string = TOP_LEVEL_GROUP_ID,
): void {
  sql.exec(
    `INSERT INTO group_membership (group_id, pubkey, added_at) VALUES (?, ?, ?)
       ON CONFLICT(group_id, pubkey) DO NOTHING`,
    groupId,
    pubkey, nowSec);
}

export function removeGroupMember(
  sql: SqlStorage,
  pubkey: string,
  groupId: string = TOP_LEVEL_GROUP_ID,
): void {
  sql.exec(`DELETE FROM group_membership WHERE group_id = ? AND pubkey = ?`, groupId, pubkey);
}

// The group write check (nip29.ts authorizeGroupWrite), reached only for a
// non-owner's group event, so ordinary traffic never pays it.
export function isGroupMember(
  sql: SqlStorage,
  pubkey: string,
  groupId: string = TOP_LEVEL_GROUP_ID,
): boolean {
  return (
    sql.exec(`SELECT 1 FROM group_membership WHERE group_id = ? AND pubkey = ?`, groupId, pubkey)
      .toArray().length > 0
  );
}

// Brings a group into being: the row that makes an id one this relay hosts.
// Must invalidate the hostsGroup memo, or the new group's events would be
// filed in the public partition.
export function createGroup(sql: SqlStorage, id: string, nowSec: number): void {
  sql.exec(
    `INSERT INTO groups (id, created_at, is_closed) VALUES (?, ?, 1) ON CONFLICT(id) DO NOTHING`,
    id,
    nowSec,
  );
  invalidateHostedGroups();
}

// The groups this pubkey may READ, which is the same list it may write to;
// one query for both keeps them from diverging. Asked once per REQ by an
// authenticated non-owner.
//
// Not an index seek: no index leads with `pubkey`, so this reads every
// `group_membership` row. The primary key is (group_id, pubkey) because the
// commoner question, "is THIS pubkey in THIS group" (isGroupMember), wants
// that prefix.
export function listMemberGroups(sql: SqlStorage, pubkey: string): string[] {
  return sql
    .exec<{ group_id: string }>(
      `SELECT group_id FROM group_membership WHERE pubkey = ? ORDER BY group_id ASC`,
      pubkey,
    )
    .toArray()
    .map((r) => r.group_id);
}

// Ordered by pubkey so the regenerated kind-39002 member list depends only
// on the member SET: nip29.ts skips the rewrite when the tags are equal,
// and ordering by `added_at` would make a remove-and-re-add rewrite an
// unchanged list.
export function listGroupMembers(sql: SqlStorage, groupId: string = TOP_LEVEL_GROUP_ID): string[] {
  return sql
    .exec<{ pubkey: string }>(
      `SELECT pubkey FROM group_membership WHERE group_id = ? ORDER BY pubkey ASC`,
      groupId,
    )
    .toArray()
    .map((r) => r.pubkey);
}

// Members (of any group) with no `allowed_pubkeys` row, for the daily
// check in auditMaintainedCounts. Rows read: M plus a PK seek each.
export function groupMembersWithoutAllowance(sql: SqlStorage): string[] {
  return sql
    .exec<{ pubkey: string }>(
      `SELECT m.pubkey FROM group_membership m
         LEFT JOIN allowed_pubkeys a ON a.pubkey = m.pubkey
        WHERE a.pubkey IS NULL
        ORDER BY m.added_at ASC`,
    )
    .toArray()
    .map((r) => r.pubkey);
}

// ---------------------------------------------------------------------
// NIP-29 invite codes (src/nip29.ts). One row per kind-9009 the owner
// publishes; a kind-9021 join is checked against the row, not the event
// (schema.ts `group_invites`).
// ---------------------------------------------------------------------

export interface GroupInvite {
  code: string;
  created_at: number;
  expires_at: number;
  redeemed_at: number | null;
  redeemed_by: string | null;
  revoked_at: number | null;
}

// What a presented code turned out to be. nip29.ts handleJoinRequest sends
// the same refusal for all four failures, so the code cannot be used as an
// oracle; the distinction is for the owner's log and NIP-86 only.
export type InviteOutcome = "redeemed" | "unknown" | "revoked" | "spent" | "expired";

export function lookupInvite(sql: SqlStorage, code: string): GroupInvite | null {
  return (
    sql
      .exec<{
        code: string;
        created_at: number;
        expires_at: number;
        redeemed_at: number | null;
        redeemed_by: string | null;
        revoked_at: number | null;
      }>(
        `SELECT code, created_at, expires_at, redeemed_at, redeemed_by, revoked_at
           FROM group_invites WHERE code = ?`,
        code,
      )
      .toArray()[0] ?? null
  );
}

export function createInvite(sql: SqlStorage, code: string, createdAt: number, expiresAt: number): void {
  sql.exec(
    `INSERT INTO group_invites (code, created_at, expires_at) VALUES (?, ?, ?)`,
    code,
    createdAt,
    expiresAt,
  );
}

// Outstanding = redeemable now: unspent, unrevoked, unexpired. Keep these
// conditions identical to listUnusedInvites and redeemInvite, or the
// MAX_OUTSTANDING_INVITES cap could count invites that can never be used.
export function countOutstandingInvites(sql: SqlStorage, nowSec: number): number {
  return (
    sql
      .exec<{
        n: number
      }>(
        `SELECT COUNT(*) AS n FROM group_invites
          WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
        nowSec,
      )
      .toArray()[0]?.n ?? 0
  );
}

export interface UnusedInvite {
  code: string;
  created_at: number;
  expires_at: number;
}

export function listUnusedInvites(sql: SqlStorage, nowSec: number): UnusedInvite[] {
  return sql
    .exec<{ code: string; created_at: number; expires_at: number }>(
      `SELECT code, created_at, expires_at FROM group_invites
        WHERE redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at DESC`,
      nowSec,
    )
    .toArray();
}

// Classify, then spend, both here so single use does not depend on a
// caller's ordering. The UPDATE repeats the SELECT's conditions on
// purpose: the SELECT decides what to report, the UPDATE what to write, and
// only the UPDATE must be safe against a double redemption if anything is
// ever put between the two.
//
// Order revoked, spent, expired: a row can be several at once, and the
// owner should see the act (revoked) rather than the clock (expired).
export function redeemInvite(
  sql: SqlStorage,
  code: string,
  pubkey: string,
  nowSec: number,
): InviteOutcome {
  const invite = lookupInvite(sql, code);
  if (invite === null) return "unknown";
  if (invite.revoked_at !== null) return "revoked";
  if (invite.redeemed_at !== null) return "spent";
  if (invite.expires_at <= nowSec) return "expired";
  sql.exec(
    `UPDATE group_invites SET redeemed_at = ?, redeemed_by = ?
      WHERE code = ? AND redeemed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    nowSec,
    pubkey,
    code,
    nowSec,
  );
  return "redeemed";
}

// What a revoke did. Separate from InviteOutcome so "revoked" does not mean
// both "this revoke succeeded" and "the code was already dead".
export type RevokeOutcome = "revoked" | "unknown" | "spent" | "already-revoked";

// NIP-86 revokeinvite. The caller is the authenticated owner, so unlike
// the join path it says exactly why nothing happened.
//
// A spent invite is left alone: it is already unusable, and `redeemed_by`
// is the only record of who it let in. An expired but unspent invite is
// revoked normally, so the row records the owner's act, not just the clock.
export function revokeInvite(sql: SqlStorage, code: string, nowSec: number): RevokeOutcome {
  const invite = lookupInvite(sql, code);
  if (invite === null) return "unknown";
  if (invite.revoked_at !== null) return "already-revoked";
  if (invite.redeemed_at !== null) return "spent";
  sql.exec(`UPDATE group_invites SET revoked_at = ? WHERE code = ? AND redeemed_at IS NULL`, nowSec, code);
  return "revoked";
}

// NIP-86 unallowpubkey, which is also how a member is removed: every
// `allowed_pubkeys` row is a member (isMember). Removal refuses new mail
// for them from now on (relay.ts handleGiftWrap), drops their devices and
// any notification queued for them, and starts the grace period after
// which their stored mail is deleted (schema.ts `former_members`,
// sweepFormerMembers). Nothing beyond the row delete happens for a pubkey
// that was not on the list, so removing a stranger starts no clock.
// What happens to the people a removed member invited (nip86.ts
// unallowpubkey's second parameter). "keep", the default: they stay
// members and are re-parented to the owner, so nobody is left hanging
// from a removed member. "remove": they go too, and so does everyone
// they invited, each with the usual grace period. Nothing cascades
// unless the owner says "remove".
export type InviteesChoice = "keep" | "remove";

// Returns everyone removed, the named pubkey first. Empty if it was not a
// member.
//
// `newParent` is who "keep" re-hangs the invitees under: the owner when
// the owner or an admin removes someone, the remover when a member removes
// someone in their own subtree (the nearest ancestor who remains).
export function removeMember(
  sql: SqlStorage,
  pubkey: string,
  owner: string,
  invitees: InviteesChoice,
  nowSec: number,
  newParent: string = owner,
): string[] {
  if (!isPubkeyAllowed(sql, pubkey)) {
    unallowPubkey(sql, pubkey, nowSec);
    return [];
  }
  if (invitees === "keep") {
    sql.exec(`UPDATE allowed_pubkeys SET invited_by = ? WHERE invited_by = ?`, newParent, pubkey);
    unallowPubkey(sql, pubkey, nowSec);
    return [pubkey];
  }
  const order = invitedSubtree(sql, pubkey, owner);
  for (const member of order) unallowPubkey(sql, member, nowSec);
  return order;
}

// Whether `pubkey` is somewhere below `ancestor` in the invite tree:
// invited by them, or by someone they invited, and so on. Walks up from
// `pubkey`, stopping at the owner, a missing inviter, a cycle or 64 steps.
export function isBelow(sql: SqlStorage, ancestor: string, pubkey: string, owner: string | null): boolean {
  const seen = new Set<string>([pubkey]);
  let current = pubkey;
  for (let step = 0; step < 64; step++) {
    const parent = sql
      .exec<{ invited_by: string | null }>(`SELECT invited_by FROM allowed_pubkeys WHERE pubkey = ?`, current)
      .toArray()[0]?.invited_by;
    if (!parent || seen.has(parent)) return false;
    if (parent === ancestor) return true;
    if (parent === owner) return false;
    seen.add(parent);
    current = parent;
  }
  return false;
}

// `pubkey` and everyone below it in the invite tree, breadth first,
// `pubkey` first. `seen` guards against a cycle, which no writer makes but
// a hand-edited row could. The owner is never a row, so never in it.
export function invitedSubtree(sql: SqlStorage, pubkey: string, owner: string): string[] {
  const seen = new Set<string>([pubkey]);
  const order = [pubkey];
  for (let i = 0; i < order.length; i++) {
    const children = sql
      .exec<{ pubkey: string }>(`SELECT pubkey FROM allowed_pubkeys WHERE invited_by = ?`, order[i]!)
      .toArray();
    for (const child of children) {
      if (seen.has(child.pubkey) || child.pubkey === owner) continue;
      seen.add(child.pubkey);
      order.push(child.pubkey);
    }
  }
  return order;
}

export function unallowPubkey(
  sql: SqlStorage,
  pubkey: string,
  nowSec: number,
  reason: "removed" | "erased" = "removed",
): void {
  const existed = sql.exec(`SELECT 1 FROM allowed_pubkeys WHERE pubkey = ?`, pubkey).toArray().length > 0;
  if (!existed) return;
  sql.exec(`DELETE FROM allowed_pubkeys WHERE pubkey = ?`, pubkey);
  // An admin is a member first (schema.ts `admins`).
  sql.exec(`DELETE FROM admins WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM member_seen WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM push_subscriptions WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM fcm_tokens WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM inbox_push WHERE pubkey = ?`, pubkey);
  sql.exec(
    `INSERT INTO former_members (pubkey, removed_at, reason) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET removed_at = excluded.removed_at, reason = excluded.reason`,
    pubkey,
    nowSec,
    reason,
  );
}

// A member erasing their own account (nip86.ts eraseme). Unlike removal
// there is no grace: what bothy holds for them goes now.
//
//   - Their invitees stay members, re-hung under the person who invited
//     them (or the owner, if that person is not a member).
//   - The invite place they used goes back to whoever invited them
//     (giveBackInvite).
//   - Codes of their own still waiting are revoked: nobody joins under
//     someone who has left.
//   - Their mail here (wraps addressed to them and no one else still
//     entitled to it), their profile photo, their devices, any join
//     request and group rows are deleted.
//   - The membership ends as a removal does, recorded as 'erased' so the
//     storage service can tell (memberkeys), with nothing left for the
//     grace sweep to delete.
//
// Returns how many wraps were deleted. `mailLimit` bounds the work; the
// inbox is capped (limits.ts maxGiftWraps), so passing that cap deletes
// everything.
export function eraseMember(
  sql: SqlStorage,
  pubkey: string,
  owner: string | null,
  nowSec: number,
  mailLimit: number,
): number {
  const row = sql
    .exec<{ invited_by: string | null; via_code: string | null }>(
      `SELECT invited_by, via_code FROM allowed_pubkeys WHERE pubkey = ?`,
      pubkey,
    )
    .toArray()[0];
  if (row === undefined) return 0;
  const inviter =
    row.invited_by !== null && row.invited_by !== pubkey && isPubkeyAllowed(sql, row.invited_by)
      ? row.invited_by
      : owner;
  if (inviter !== null) {
    sql.exec(`UPDATE allowed_pubkeys SET invited_by = ? WHERE invited_by = ?`, inviter, pubkey);
  }
  if (row.invited_by !== null) giveBackInvite(sql, row.invited_by, row.via_code);
  sql.exec(
    `UPDATE member_invites SET revoked_at = ?
      WHERE created_by = ? AND revoked_at IS NULL AND uses < uses_allowed AND expires_at > ?`,
    nowSec,
    pubkey,
    nowSec,
  );
  let deleted = 0;
  for (const { id } of mailOnlyFor(sql, pubkey, owner, mailLimit)) {
    deleteEventRow(sql, id);
    deleted++;
  }
  sql.exec(`DELETE FROM photos WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM photo_uploads WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM join_requests WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM group_membership WHERE pubkey = ?`, pubkey);
  unallowPubkey(sql, pubkey, nowSec, "erased");
  return deleted;
}

// Gives one invite place back to `creator` (limits.ts memberInviteLimits
// counts places: all uses of a live code, the used ones of a dead one).
// The code the person redeemed if it was recorded (`via_code`), otherwise
// any used code of the creator's. Taking one from both `uses` and
// `uses_allowed` frees the place without making a used-up code
// redeemable again.
function giveBackInvite(sql: SqlStorage, creator: string, code: string | null): void {
  const exact =
    code === null
      ? undefined
      : sql
          .exec<{ code: string }>(
            `SELECT code FROM member_invites WHERE code = ? AND created_by = ? AND uses > 0`,
            code,
            creator,
          )
          .toArray()[0];
  const target =
    exact ??
    sql
      .exec<{ code: string }>(
        `SELECT code FROM member_invites WHERE created_by = ? AND uses > 0 ORDER BY created_at DESC LIMIT 1`,
        creator,
      )
      .toArray()[0];
  if (target === undefined) return;
  sql.exec(
    `UPDATE member_invites SET uses = uses - 1, uses_allowed = MAX(uses_allowed - 1, 0) WHERE code = ?`,
    target.code,
  );
}

export function listAllowedPubkeys(sql: SqlStorage): AllowedPubkey[] {
  return sql
    .exec<{ pubkey: string; reason: string | null }>(
      `SELECT pubkey, reason FROM allowed_pubkeys ORDER BY allowed_at DESC`,
    )
    .toArray();
}

// ownership.ts isAllowedWriter calls this only on a path already about to
// reject the write, so the common accept path never pays it.
export function isPubkeyAllowed(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM allowed_pubkeys WHERE pubkey = ?`, pubkey).toArray().length > 0;
}

// ---------------------------------------------------------------------
// Members. A member is a pubkey with an `allowed_pubkeys` row, however it
// got there (schema.ts `allowed_pubkeys.source`): the owner allowed them,
// a group admitted them, or they redeemed a member invite. Being a member
// means the relay keeps an inbox for you and pushes to your devices; the
// owner is not a row here and is handled by name wherever it matters.
//
// One list rather than a second table on purpose: a member can also
// publish here, and two lists would have to be kept from disagreeing
// about who that is.
// ---------------------------------------------------------------------

// One PK seek. The gift wrap path (relay.ts handleGiftWrap) asks it once
// per recipient, bounded by limits.ts MAX_WRAP_RECIPIENTS_CHECKED.
export function isMember(sql: SqlStorage, pubkey: string): boolean {
  return isPubkeyAllowed(sql, pubkey);
}

// For NIP-11 and /api/stats. Reads M rows; M is the size of a friend group.
export function memberCount(sql: SqlStorage): number {
  return sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM allowed_pubkeys`).toArray()[0]?.n ?? 0;
}

// Called wherever a pubkey is (re)admitted: a returning member's mail is
// theirs again, so the grace clock stops, and a request they had waiting
// is answered.
function readmitFormerMember(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM former_members WHERE pubkey = ?`, pubkey);
  sql.exec(`DELETE FROM join_requests WHERE pubkey = ?`, pubkey);
}

export interface MemberInvite {
  code: string;
  created_at: number;
  expires_at: number;
  uses_allowed: number;
  uses: number;
  revoked_at: number | null;
  created_by: string | null;
}

function lookupMemberInvite(sql: SqlStorage, code: string): MemberInvite | null {
  return (
    sql
      .exec<{
        code: string;
        created_at: number;
        expires_at: number;
        uses_allowed: number;
        uses: number;
        revoked_at: number | null;
        created_by: string | null;
      }>(
        `SELECT code, created_at, expires_at, uses_allowed, uses, revoked_at, created_by
           FROM member_invites WHERE code = ?`,
        code,
      )
      .toArray()[0] ?? null
  );
}

export function createMemberInvite(
  sql: SqlStorage,
  code: string,
  usesAllowed: number,
  createdAt: number,
  expiresAt: number,
  createdBy: string,
): void {
  sql.exec(
    `INSERT INTO member_invites (code, created_at, expires_at, uses_allowed, uses, created_by)
       VALUES (?, ?, ?, ?, 0, ?)`,
    code,
    createdAt,
    expiresAt,
    usesAllowed,
    createdBy,
  );
}

// Redeemable now: uses left, unrevoked, unexpired. Keep these conditions
// identical to listUnusedMemberInvites and redeemMemberInvite's UPDATE.
//
// Per creator: one person's outstanding codes, so members' codes cannot
// crowd out the owner's.
export function countOutstandingMemberInvites(sql: SqlStorage, nowSec: number, createdBy: string): number {
  return (
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM member_invites
          WHERE uses < uses_allowed AND revoked_at IS NULL AND expires_at > ? AND created_by = ?`,
        nowSec,
        createdBy,
      )
      .toArray()[0]?.n ?? 0
  );
}

// How many of a member's invite slots are taken (limits.ts
// memberInviteLimits): every use of a live code, used or not, and only the
// used ones of a revoked or expired code, so revoking a code, or letting
// it lapse, gives its unused slots back.
export function inviteSlotsUsed(sql: SqlStorage, createdBy: string, nowSec: number): number {
  return (
    sql
      .exec<{ n: number }>(
        `SELECT COALESCE(SUM(CASE WHEN revoked_at IS NULL AND expires_at > ? THEN uses_allowed ELSE uses END), 0) AS n
           FROM member_invites WHERE created_by = ?`,
        nowSec,
        createdBy,
      )
      .toArray()[0]?.n ?? 0
  );
}

// Steps from the owner along `invited_by`: the owner is 0, the owner's
// invitees 1. A member with no recorded inviter, or whose inviter is no
// longer a member, counts as the owner's (as listMembers reports them).
// Bounded by `cap` (the walk stops there) and guarded against a cycle.
export function inviteDepth(sql: SqlStorage, pubkey: string, owner: string | null, cap: number): number {
  if (owner !== null && pubkey === owner) return 0;
  let depth = 1;
  let current = pubkey;
  const seen = new Set<string>([pubkey]);
  while (depth < cap) {
    const parent = sql
      .exec<{ invited_by: string | null }>(`SELECT invited_by FROM allowed_pubkeys WHERE pubkey = ?`, current)
      .toArray()[0]?.invited_by;
    if (!parent || parent === owner || seen.has(parent) || !isPubkeyAllowed(sql, parent)) return depth;
    seen.add(parent);
    current = parent;
    depth++;
  }
  return depth;
}

export interface UnusedMemberInvite {
  code: string;
  created_at: number;
  expires_at: number;
  uses_left: number;
}

// `createdBy` limits it to one person's codes (a member's own view);
// null lists everyone's (the owner's and admins' view).
export function listUnusedMemberInvites(
  sql: SqlStorage,
  nowSec: number,
  createdBy: string | null = null,
): UnusedMemberInvite[] {
  return sql
    .exec<{ code: string; created_at: number; expires_at: number; uses_left: number }>(
      `SELECT code, created_at, expires_at, uses_allowed - uses AS uses_left FROM member_invites
        WHERE uses < uses_allowed AND revoked_at IS NULL AND expires_at > ?
          AND (? IS NULL OR created_by = ?)
        ORDER BY created_at DESC`,
      nowSec,
      createdBy,
      createdBy,
    )
    .toArray();
}

// What presenting a member code did. nip86.ts redeeminvite gives the
// presenter one refusal for all four failures, as the NIP-29 join path
// does, so a code cannot be probed for which way it is dead; the split is
// for revokeinvite and the tests.
export type MemberInviteOutcome = "joined" | "already-member" | "unknown" | "revoked" | "used-up" | "expired";

// Classify, then spend, both here. An existing member is answered
// "already-member" WITHOUT spending a use: an app that retries a request
// it never saw the answer to must not burn a second use of a code meant
// for someone else. Checked before the code, so a member presenting any
// string learns nothing about it.
//
// The UPDATE repeats the SELECT's conditions for the reason redeemInvite
// gives: the SELECT decides what to report, the UPDATE what to write.
// Nothing awaits between them, so inside this object they cannot
// interleave with another redemption.
//
// The new member is recorded as invited by the code's creator, or by
// `owner` for a code from before creators were recorded.
export function redeemMemberInvite(
  sql: SqlStorage,
  code: string,
  pubkey: string,
  nowSec: number,
  owner: string | null = null,
): MemberInviteOutcome {
  if (isPubkeyAllowed(sql, pubkey)) return "already-member";
  const invite = lookupMemberInvite(sql, code);
  if (invite === null) return "unknown";
  if (invite.revoked_at !== null) return "revoked";
  if (invite.uses >= invite.uses_allowed) return "used-up";
  if (invite.expires_at <= nowSec) return "expired";
  sql.exec(
    `UPDATE member_invites SET uses = uses + 1
      WHERE code = ? AND uses < uses_allowed AND revoked_at IS NULL AND expires_at > ?`,
    code,
    nowSec,
  );
  // Location trust: on when the owner or an admin made the code, off when
  // a member did (schema.ts `allowed_pubkeys.close`).
  const creator = invite.created_by ?? owner;
  const close = creator === null || creator === owner || isAdmin(sql, creator) ? 1 : 0;
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source, invited_by, via_code, close)
       VALUES (?, 'joined with an invite', ?, 'member', ?, ?, ?)
       ON CONFLICT(pubkey) DO NOTHING`,
    pubkey,
    nowSec,
    creator,
    code,
    close,
  );
  readmitFormerMember(sql, pubkey);
  return "joined";
}

export type RevokeMemberInviteOutcome = "revoked" | "unknown" | "used-up" | "already-revoked";

// The member half of nip86.ts revokeinvite. A used-up code is left alone,
// like a spent group invite: there is nothing left to revoke, and the
// people it let in are removed one by one.
//
// `createdBy` (a member revoking) makes someone else's code "unknown": a
// member can revoke only codes they made.
export function revokeMemberInvite(
  sql: SqlStorage,
  code: string,
  nowSec: number,
  createdBy: string | null = null,
): RevokeMemberInviteOutcome {
  const invite = lookupMemberInvite(sql, code);
  if (invite === null) return "unknown";
  if (createdBy !== null && invite.created_by !== createdBy) return "unknown";
  if (invite.revoked_at !== null) return "already-revoked";
  if (invite.uses >= invite.uses_allowed) return "used-up";
  sql.exec(`UPDATE member_invites SET revoked_at = ? WHERE code = ?`, nowSec, code);
  return "revoked";
}

// ---------------------------------------------------------------------
// Home activity (nip86.ts homestats): counts only, for the owner and
// admins. Nothing here returns a pubkey.
// ---------------------------------------------------------------------

export function utcDay(nowSec: number): number {
  return Math.floor(nowSec / 86400);
}

// A member's last-seen day. The caller (relay.ts handleAuth) skips it when
// memory already has today, so this is at most one row a member a day.
export function noteMemberSeen(sql: SqlStorage, pubkey: string, day: number): void {
  sql.exec(
    `INSERT INTO member_seen (pubkey, day) VALUES (?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET day = excluded.day WHERE excluded.day > member_seen.day`,
    pubkey,
    day,
  );
}

export function countMailDay(sql: SqlStorage, day: number): void {
  sql.exec(`INSERT INTO mail_days (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1`, day);
}

export function pruneHomeStats(sql: SqlStorage, today: number, daysKept: number): void {
  sql.exec(`DELETE FROM mail_days WHERE day <= ?`, today - daysKept);
}

export interface HomeStats {
  members: number;
  // Members seen on one of the last N UTC days, today included, so
  // last1Day is "seen today".
  activeMembers: { last1Day: number; last7Days: number; last30Days: number };
  // Oldest first, one entry a UTC day, zeros included. Gift wraps: a
  // NIP-17 message is usually two, one for each side.
  messagesPerDay: { day: string; count: number }[];
  // Oldest first: seven-day windows ending today. newMembers counts people
  // still members who joined in the window, any way; invitesUsed those of
  // them who came with an invite code.
  weeks: { from: string; newMembers: number; invitesUsed: number }[];
  pushSubscribers: number;
}

function isoDay(day: number): string {
  return new Date(day * 86400 * 1000).toISOString().slice(0, 10);
}

export function homeStats(sql: SqlStorage, nowSec: number, days: number, weeks: number): HomeStats {
  const today = utcDay(nowSec);
  const seen = sql
    .exec<{ d1: number; d7: number; d30: number }>(
      `SELECT COALESCE(SUM(s.day >= ?), 0) AS d1, COALESCE(SUM(s.day > ?), 0) AS d7,
              COALESCE(SUM(s.day > ?), 0) AS d30
         FROM member_seen s JOIN allowed_pubkeys a ON a.pubkey = s.pubkey`,
      today,
      today - 7,
      today - 30,
    )
    .toArray()[0] ?? { d1: 0, d7: 0, d30: 0 };
  const counted = new Map(
    sql
      .exec<{ day: number; n: number }>(`SELECT day, n FROM mail_days WHERE day > ?`, today - days)
      .toArray()
      .map((r) => [r.day, r.n] as const),
  );
  const messagesPerDay = Array.from({ length: days }, (_, i) => {
    const day = today - days + 1 + i;
    return { day: isoDay(day), count: counted.get(day) ?? 0 };
  });
  const joins = sql
    .exec<{ allowed_at: number; source: string }>(
      `SELECT allowed_at, source FROM allowed_pubkeys WHERE allowed_at > ?`,
      (today - weeks * 7 + 1) * 86400,
    )
    .toArray();
  const weekly = Array.from({ length: weeks }, (_, i) => {
    const fromDay = today - (weeks - i) * 7 + 1;
    const inWeek = joins.filter((j) => utcDay(j.allowed_at) >= fromDay && utcDay(j.allowed_at) < fromDay + 7);
    return {
      from: isoDay(fromDay),
      newMembers: inWeek.length,
      invitesUsed: inWeek.filter((j) => j.source === "member").length,
    };
  });
  return {
    members: memberCount(sql),
    activeMembers: { last1Day: seen.d1, last7Days: seen.d7, last30Days: seen.d30 },
    messagesPerDay,
    weeks: weekly,
    pushSubscribers:
      sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM allowed_pubkeys a
            WHERE EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.pubkey = a.pubkey)
               OR EXISTS (SELECT 1 FROM fcm_tokens f WHERE f.pubkey = a.pubkey)`,
        )
        .toArray()[0]?.n ?? 0,
  };
}

// ---------------------------------------------------------------------
// Admins (schema.ts `admins`).
// ---------------------------------------------------------------------

export function isAdmin(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM admins WHERE pubkey = ?`, pubkey).toArray().length > 0;
}

// Makes them a member too if they are not one, with the owner as inviter,
// and leaves an existing membership as it was.
export function addAdmin(sql: SqlStorage, pubkey: string, owner: string, nowSec: number): void {
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source, invited_by)
       VALUES (?, 'made an admin', ?, 'owner', ?)
       ON CONFLICT(pubkey) DO NOTHING`,
    pubkey,
    nowSec,
    owner,
  );
  readmitFormerMember(sql, pubkey);
  sql.exec(`INSERT INTO admins (pubkey, added_at) VALUES (?, ?) ON CONFLICT(pubkey) DO NOTHING`, pubkey, nowSec);
  // An admin is close by default, as anyone the owner lets in is.
  sql.exec(`UPDATE allowed_pubkeys SET close = 1 WHERE pubkey = ?`, pubkey);
}

// False if they were not an admin. Their membership stays.
export function removeAdmin(sql: SqlStorage, pubkey: string): boolean {
  if (!isAdmin(sql, pubkey)) return false;
  sql.exec(`DELETE FROM admins WHERE pubkey = ?`, pubkey);
  return true;
}

export function listAdmins(sql: SqlStorage): { pubkey: string; addedAt: number }[] {
  return sql
    .exec<{ pubkey: string; added_at: number }>(`SELECT pubkey, added_at FROM admins ORDER BY added_at ASC`)
    .toArray()
    .map((r) => ({ pubkey: r.pubkey, addedAt: r.added_at }));
}

// Who a key is here, for the management gate (index.ts) and nip86.ts
// myrole. "member" includes a member of the NIP-29 group `_`, as the
// member gate always has.
export type Role = "owner" | "admin" | "member" | "none";

// ---------------------------------------------------------------------
// Location trust (schema.ts `allowed_pubkeys.close`): who may see where
// a member's photos were taken. On for people the owner or an admin let
// in, and admins; off for people who came in on a member's code. The
// owner and admins change it (setclose). It governs that one thing; every
// member uses the box (storage, media) whatever it says.
// ---------------------------------------------------------------------

export function isClose(sql: SqlStorage, pubkey: string, owner: string | null): boolean {
  if (owner !== null && pubkey === owner) return true;
  return (
    sql.exec<{ close: number }>(`SELECT close FROM allowed_pubkeys WHERE pubkey = ?`, pubkey).toArray()[0]
      ?.close === 1
  );
}

export type SetCloseOutcome = "ok" | "not-member" | "owner";

export function setClose(sql: SqlStorage, pubkey: string, value: boolean, owner: string | null): SetCloseOutcome {
  if (owner !== null && pubkey === owner) return "owner";
  if (!isPubkeyAllowed(sql, pubkey)) return "not-member";
  sql.exec(`UPDATE allowed_pubkeys SET close = ? WHERE pubkey = ?`, value ? 1 : 0, pubkey);
  return "ok";
}

// For each asked pubkey: may the caller and it see each other's photo
// locations? True only when both are close (the owner always is), so a
// caller without the flag learns nothing. The asked pubkeys bind as one
// json_each parameter.
export function areClose(
  sql: SqlStorage,
  caller: string,
  pubkeys: string[],
  owner: string | null,
): Record<string, boolean> {
  const answer: Record<string, boolean> = Object.fromEntries(pubkeys.map((p) => [p, false]));
  if (!isClose(sql, caller, owner)) return answer;
  const close = new Set(
    sql
      .exec<{ pubkey: string }>(
        `SELECT pubkey FROM allowed_pubkeys WHERE close = 1 AND pubkey IN (SELECT value FROM json_each(?))`,
        JSON.stringify(pubkeys),
      )
      .toArray()
      .map((r) => r.pubkey),
  );
  if (owner !== null) close.add(owner);
  for (const p of pubkeys) answer[p] = close.has(p);
  return answer;
}

export function roleOf(sql: SqlStorage, pubkey: string, owner: string | null): Role {
  if (owner !== null && pubkey === owner) return "owner";
  if (isAdmin(sql, pubkey)) return "admin";
  if (isPubkeyAllowed(sql, pubkey) || isGroupMember(sql, pubkey)) return "member";
  return "none";
}

// ---------------------------------------------------------------------
// Join requests (schema.ts `join_requests`, nip86.ts requestjoin).
// ---------------------------------------------------------------------

// What asking did. "created" is the only outcome that sends the owner a
// message: asking again while a request waits changes nothing, so a
// requester's app can call requestjoin on every open to learn where it
// stands without the owner hearing about it twice.
export type JoinRequestOutcome =
  | { status: "created"; expiresAt: number }
  | { status: "pending"; expiresAt: number }
  | { status: "declined" }
  | { status: "full" };

export function recordJoinRequest(
  sql: SqlStorage,
  pubkey: string,
  name: string | null,
  note: string | null,
  nowSec: number,
  ttlSec: number,
  maxPending: number,
  via: string | null = null,
): JoinRequestOutcome {
  const existing = sql
    .exec<{ expires_at: number; declined_at: number | null }>(
      `SELECT expires_at, declined_at FROM join_requests WHERE pubkey = ?`,
      pubkey,
    )
    .toArray()[0];
  if (existing !== undefined && existing.expires_at > nowSec) {
    return existing.declined_at === null ? { status: "pending", expiresAt: existing.expires_at } : { status: "declined" };
  }
  const pending =
    sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM join_requests WHERE declined_at IS NULL AND expires_at > ?`,
        nowSec,
      )
      .toArray()[0]?.n ?? 0;
  if (pending >= maxPending) return { status: "full" };
  const expiresAt = nowSec + ttlSec;
  sql.exec(
    `INSERT INTO join_requests (pubkey, name, note, requested_at, expires_at, declined_at, via)
       VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(pubkey) DO UPDATE SET name = excluded.name, note = excluded.note,
         requested_at = excluded.requested_at, expires_at = excluded.expires_at, declined_at = NULL,
         via = excluded.via`,
    pubkey,
    name,
    note,
    nowSec,
    expiresAt,
    via,
  );
  return { status: "created", expiresAt };
}

export interface JoinRequest {
  pubkey: string;
  name: string | null;
  note: string | null;
  // Whose link they say it came through; unverified (schema.ts).
  via: string | null;
  requestedAt: number;
  expiresAt: number;
}

// Waiting ones only, newest first: a declined request is the owner's own
// decision and needs no second look.
export function listJoinRequests(sql: SqlStorage, nowSec: number): JoinRequest[] {
  return sql
    .exec<{
      pubkey: string;
      name: string | null;
      note: string | null;
      via: string | null;
      requested_at: number;
      expires_at: number;
    }>(
      `SELECT pubkey, name, note, via, requested_at, expires_at FROM join_requests
        WHERE declined_at IS NULL AND expires_at > ? ORDER BY requested_at DESC`,
      nowSec,
    )
    .toArray()
    .map((r) => ({
      pubkey: r.pubkey,
      name: r.name,
      note: r.note,
      via: r.via,
      requestedAt: r.requested_at,
      expiresAt: r.expires_at,
    }));
}

function hasPendingJoinRequest(sql: SqlStorage, pubkey: string, nowSec: number): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM join_requests WHERE pubkey = ? AND declined_at IS NULL AND expires_at > ?`,
        pubkey,
        nowSec,
      )
      .toArray().length > 0
  );
}

// False when nothing from that pubkey is waiting. Makes them a member the
// way an invite does and deletes the request (readmitFormerMember). Their
// inviter is the request's `via` if that is a member now, else `owner`:
// a claim about a link is taken only as far as the tree it would join.
// `approver` (the owner or an admin) is the inviter otherwise.
export function approveJoinRequest(sql: SqlStorage, pubkey: string, approver: string, nowSec: number): boolean {
  if (!hasPendingJoinRequest(sql, pubkey, nowSec)) return false;
  const via = sql
    .exec<{ via: string | null }>(`SELECT via FROM join_requests WHERE pubkey = ?`, pubkey)
    .toArray()[0]?.via;
  const invitedBy = via && via !== pubkey && isPubkeyAllowed(sql, via) ? via : approver;
  sql.exec(
    `INSERT INTO allowed_pubkeys (pubkey, reason, allowed_at, source, invited_by)
       VALUES (?, 'asked to join', ?, 'request', ?)
       ON CONFLICT(pubkey) DO NOTHING`,
    pubkey,
    nowSec,
    invitedBy,
  );
  readmitFormerMember(sql, pubkey);
  return true;
}

// False when nothing from that pubkey is waiting. The row stays, declined,
// for `ttlSec`, so asking again inside that time gets "declined" and sends
// the owner nothing.
export function declineJoinRequest(sql: SqlStorage, pubkey: string, nowSec: number, ttlSec: number): boolean {
  if (!hasPendingJoinRequest(sql, pubkey, nowSec)) return false;
  sql.exec(
    `UPDATE join_requests SET declined_at = ?, expires_at = ? WHERE pubkey = ?`,
    nowSec,
    nowSec + ttlSec,
    pubkey,
  );
  return true;
}

// Cron tick. Rows are bounded by MAX_PENDING_JOIN_REQUESTS plus the
// declined ones, so one statement.
export function sweepExpiredJoinRequests(sql: SqlStorage, nowSec: number): void {
  sql.exec(`DELETE FROM join_requests WHERE expires_at <= ?`, nowSec);
}

// ---------------------------------------------------------------------
// The member list for the owner's management screen (nip86.ts
// listmembers): everyone with a home here, and everyone removed whose mail
// is still waiting to be deleted.
// ---------------------------------------------------------------------

export interface MemberDetails extends MemberActivity {
  pubkey: string;
  invitedBy: string | null;
  joinedAt: number;
  source: string;
  // "admin" for a pubkey in `admins`, else "member".
  role: "admin" | "member";
  // Location trust (schema.ts `allowed_pubkeys.close`).
  close: boolean;
  // invitedBy is the owner by default, not by record (see listMembers).
  inviterUnknown: boolean;
}

// Activity, from what bothy already keeps; nothing new is recorded for
// it. On members and removed members alike.
export interface MemberActivity {
  // The last UTC day they completed NIP-42 auth (schema.ts `member_seen`),
  // as a day number: days since 1970-01-01, i.e. floor(unix seconds /
  // 86400). null if never. Removal deletes the row, so a removed member's
  // is null.
  lastSeen: number | null;
  // Any push registration: web push (`push_subscriptions`) or an Android
  // FCM token (`fcm_tokens`). Removal deletes both, so false once removed.
  push: boolean;
  // Stored gift wraps (kind 1059) p-tagged to them (schema.ts
  // `mail_usage.n`), waiting until they delete them or they expire.
  waiting: number;
}

export interface RemovedMember extends MemberActivity {
  pubkey: string;
  removedAt: number;
  // When their stored mail is deleted (removedAt + grace). The sweep
  // runs hourly, so the deletion lands within the hour after this.
  deletesAt: number;
}

// Flat; the apps build the tree from `invitedBy`. Every row has one: a row
// with no recorded inviter, or whose inviter is no longer a member, is
// reported as the owner's, so every member hangs from the owner. (Removal
// re-parents invitees itself; this covers rows from before it did.)
// What the storage service is told (nip86.ts memberkeys): who may upload
// (the owner and every member, admins included) and who has left, with
// when their files should go. Pubkeys only, no names or roles.
export function memberKeys(
  sql: SqlStorage,
  owner: string | null,
  graceSec: number,
): {
  owner: string | null;
  members: string[];
  admins: string[];
  removed: { pubkey: string; removedAt: number; deletesAt: number; reason: string }[];
} {
  const members = sql
    .exec<{ pubkey: string }>(`SELECT pubkey FROM allowed_pubkeys ORDER BY pubkey ASC`)
    .toArray()
    .map((r) => r.pubkey);
  const removed = sql
    .exec<{ pubkey: string; removed_at: number; reason: string }>(
      `SELECT pubkey, removed_at, reason FROM former_members ORDER BY removed_at DESC`,
    )
    .toArray()
    // An erased account's mail is already gone, so its deadline is now.
    .map((r) => ({
      pubkey: r.pubkey,
      removedAt: r.removed_at,
      deletesAt: r.reason === "erased" ? r.removed_at : r.removed_at + graceSec,
      reason: r.reason,
    }));
  // Admins, sorted, for the account page's owner and admin views of disk
  // use. Only ever seen by the storage service's key (memberkeys), so the
  // admin list is still never public.
  const admins = sql
    .exec<{ pubkey: string }>(`SELECT pubkey FROM admins ORDER BY pubkey ASC`)
    .toArray()
    .map((r) => r.pubkey);
  return { owner, members, admins, removed };
}

// When bothy stored each of these gift wraps (events.ingested_at), for
// the ones addressed to `recipient` only; any other id is left out, so
// the answer says nothing about anyone else's mail. The ids go in as one
// JSON parameter (json_each), so 500 of them bind one parameter, not 500
// (limits.ts MAX_QUERY_BOUND_PARAMS). One PK seek per id plus a tag check.
//
// With `withSeq`, each value is {storedAt, seq} instead of a number: the
// home's sequence number too (schema.ts events.seq).
export function mailTimes(
  sql: SqlStorage,
  recipient: string,
  ids: string[],
  withSeq = false,
): Record<string, number | { storedAt: number; seq: number | null }> {
  const rows = sql
    .exec<{ id: string; ingested_at: number; seq: number | null }>(
      `SELECT e.id AS id, e.ingested_at AS ingested_at, e.seq AS seq FROM events e
        WHERE e.id IN (SELECT value FROM json_each(?)) AND e.kind = ? AND e.ingested_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM event_tags t
                       WHERE t.event_id = e.id AND t.tag_name = 'p' AND t.tag_value = ?)`,
      JSON.stringify(ids),
      GIFT_WRAP_KIND,
      recipient,
    )
    .toArray();
  return Object.fromEntries(
    rows.map((r) => [r.id, withSeq ? { storedAt: r.ingested_at, seq: r.seq } : r.ingested_at]),
  );
}

// Who is in the home, for any member to see (nip86.ts homemembers): every
// member and the owner, as hex pubkeys, sorted. Nothing else about them.
export function homeMemberPubkeys(sql: SqlStorage, owner: string | null): string[] {
  const pubkeys = new Set(
    sql
      .exec<{ pubkey: string }>(`SELECT pubkey FROM allowed_pubkeys`)
      .toArray()
      .map((r) => r.pubkey),
  );
  if (owner !== null) pubkeys.add(owner);
  return [...pubkeys].sort();
}

export function listMembers(
  sql: SqlStorage,
  graceSec: number,
  owner: string,
): { members: MemberDetails[]; removed: RemovedMember[] } {
  const rows = sql
    .exec<{ pubkey: string; invited_by: string | null; allowed_at: number; source: string; close: number }>(
      `SELECT pubkey, invited_by, allowed_at, source, close FROM allowed_pubkeys ORDER BY allowed_at DESC`,
    )
    .toArray();
  const present = new Set(rows.map((r) => r.pubkey));
  const admins = new Set(
    sql.exec<{ pubkey: string }>(`SELECT pubkey FROM admins`).toArray().map((r) => r.pubkey),
  );
  const activity = memberActivity(sql);
  const members = rows.map((r) => ({
    pubkey: r.pubkey,
    invitedBy: r.invited_by !== null && r.invited_by !== r.pubkey && present.has(r.invited_by) ? r.invited_by : owner,
    joinedAt: r.allowed_at,
    source: r.source,
    role: admins.has(r.pubkey) ? ("admin" as const) : ("member" as const),
    close: r.close === 1,
    // True when invitedBy above is the owner only by default: the stored
    // inviter is NULL (rows from before v0.19.0), the member's own key, or
    // a key no longer a member. invitedBy itself is unchanged, so clients
    // that build the tree from it keep working.
    inviterUnknown:
      r.invited_by === null ||
      r.invited_by === r.pubkey ||
      (!present.has(r.invited_by) && r.invited_by !== owner),
    ...activity(r.pubkey),
  }));
  const removed = sql
    .exec<{ pubkey: string; removed_at: number; reason: string }>(
      `SELECT pubkey, removed_at, reason FROM former_members ORDER BY removed_at DESC`,
    )
    .toArray()
    // An erased account's mail is already gone, so its deadline is now.
    .map((r) => ({
      pubkey: r.pubkey,
      removedAt: r.removed_at,
      deletesAt: r.reason === "erased" ? r.removed_at : r.removed_at + graceSec,
      ...activity(r.pubkey),
    }));
  return { members, removed };
}

// listMembers' activity fields: one query per field over everyone listed
// (members and removed members), not one per person. Each table has one
// row per pubkey, or a few per pubkey for push devices.
function memberActivity(sql: SqlStorage): (pubkey: string) => MemberActivity {
  const listed = `SELECT pubkey FROM allowed_pubkeys UNION SELECT pubkey FROM former_members`;
  const seen = new Map(
    sql
      .exec<{ pubkey: string; day: number }>(`SELECT pubkey, day FROM member_seen WHERE pubkey IN (${listed})`)
      .toArray()
      .map((r) => [r.pubkey, r.day] as const),
  );
  const push = new Set(
    sql
      .exec<{ pubkey: string }>(
        `SELECT pubkey FROM push_subscriptions WHERE pubkey IN (${listed})
         UNION SELECT pubkey FROM fcm_tokens WHERE pubkey IN (${listed})`,
      )
      .toArray()
      .map((r) => r.pubkey),
  );
  const waiting = new Map(
    sql
      .exec<{ pubkey: string; n: number }>(`SELECT pubkey, n FROM mail_usage WHERE pubkey IN (${listed})`)
      .toArray()
      .map((r) => [r.pubkey, r.n] as const),
  );
  return (pubkey) => ({
    lastSeen: seen.get(pubkey) ?? null,
    push: push.has(pubkey),
    waiting: waiting.get(pubkey) ?? 0,
  });
}

export interface FormerMemberSweep {
  // Wraps deleted this tick.
  removed: number;
  // Former members whose grace ended and who now have nothing left here.
  finished: number;
}

// Deletes the mail of members removed more than `graceSec` ago
// (limits.ts MEMBER_REMOVAL_GRACE_SECONDS), then forgets them.
//
// A wrap is deleted only if it names nobody who is still entitled to it:
// not the owner, not a current member. Mail p-tagged to two people is
// rare, but it is the remaining recipient's mail too. Those wraps are
// excluded in SQL, so they never fill a batch and stall the sweep.
//
// Per former member: one indexed range over `event_tags` for their `p`,
// per partition, at most `limit` rows. A former member with no wraps left
// is deleted, which ends the work for them. Called from the cron tick.
// How many wraps are still waiting to be deleted for someone who left,
// counted up to `limit` (eraseme's answer, messagesLeft).
export function mailLeftFor(sql: SqlStorage, pubkey: string, owner: string | null, limit: number): number {
  return mailOnlyFor(sql, pubkey, owner, limit).length;
}

// Gift wraps addressed to `pubkey` and to nobody else still entitled to
// them (the owner, a current member), up to `limit` per partition. What
// leaves with a person who leaves: the grace sweep below and eraseMember.
function mailOnlyFor(sql: SqlStorage, pubkey: string, owner: string | null, limit: number): { id: string }[] {
  return acrossScopes((scope) =>
    sql
      .exec<{ id: string }>(
        `SELECT e.id AS id FROM event_tags t JOIN events e ON e.id = t.event_id
          WHERE t.is_group = ? AND t.tag_name = 'p' AND t.tag_value = ? AND e.kind = ?
            AND NOT EXISTS (
              SELECT 1 FROM event_tags o
               WHERE o.event_id = e.id AND o.tag_name = 'p' AND o.tag_value != ?
                 AND (o.tag_value = ? OR o.tag_value IN (SELECT pubkey FROM allowed_pubkeys))
            )
          LIMIT ?`,
        scope,
        pubkey,
        GIFT_WRAP_KIND,
        pubkey,
        owner ?? "",
        limit,
      )
      .toArray(),
  );
}

export function sweepFormerMembers(
  sql: SqlStorage,
  nowSec: number,
  graceSec: number,
  owner: string | null,
  pubkeyLimit: number,
  limit: number,
): FormerMemberSweep {
  const due = sql
    .exec<{ pubkey: string }>(
      `SELECT pubkey FROM former_members WHERE removed_at <= ? OR reason = 'erased'
        ORDER BY removed_at ASC LIMIT ?`,
      nowSec - graceSec,
      pubkeyLimit,
    )
    .toArray();
  let removed = 0;
  let finished = 0;
  for (const { pubkey } of due) {
    const budget = limit - removed;
    if (budget <= 0) break;
    const targets = mailOnlyFor(sql, pubkey, owner, budget);
    const batch = targets.slice(0, budget);
    for (const target of batch) deleteEventRow(sql, target.id);
    removed += batch.length;
    // Fewer than asked for in total means both partitions are empty of
    // this member's mail now.
    if (targets.length < budget) {
      sql.exec(`DELETE FROM former_members WHERE pubkey = ?`, pubkey);
      // Their profile photo goes with their mail (src/photos.ts).
      sql.exec(`DELETE FROM photos WHERE pubkey = ?`, pubkey);
      sql.exec(`DELETE FROM photo_uploads WHERE pubkey = ?`, pubkey);
      finished++;
    }
  }
  return { removed, finished };
}

// ---------------------------------------------------------------------
// Web push subscriptions (src/push.ts, src/nip86.ts subscribepush).
//
// The pubkey on every row is the one the NIP-98 signature proved, never one
// from a request body (schema.ts `push_subscriptions`); these functions
// take it as a parameter and never derive it.
// ---------------------------------------------------------------------

export interface PushSubscriptionRow {
  endpoint: string;
  pubkey: string;
  p256dh: string;
  auth: string;
  // The app's tag for the account (schema.ts `push_subscriptions.label`).
  label: string | null;
}

// Plus `last_ok_at`, which decides whether a successful send is worth a
// row write (limits.ts PUSH_LAST_OK_INTERVAL_SECONDS).
export interface PushFanoutRow extends PushSubscriptionRow {
  last_ok_at: number | null;
}

// Registers or refreshes one endpoint, evicting this pubkey's oldest beyond
// the cap.
//
// An upsert on (endpoint, pubkey): browsers re-send the same endpoint on
// every load, and its keys can change. The same endpoint under a second
// pubkey is a second row, not a rebinding: an app holding two accounts
// shares one browser endpoint between them, and each keeps receiving.
// The label is replaced on every call, so subscribing without one clears
// it.
export function upsertPushSubscription(
  sql: SqlStorage,
  row: PushSubscriptionRow,
  perPubkeyCap: number,
  nowSec: number,
): void {
  sql.exec(
    `INSERT INTO push_subscriptions (endpoint, pubkey, p256dh, auth, created_at, last_ok_at, label)
       VALUES (?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT(endpoint, pubkey) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         created_at = excluded.created_at,
         label = excluded.label`,
    row.endpoint,
    row.pubkey,
    row.p256dh,
    row.auth,
    nowSec,
    row.label,
  );
  // Evict the oldest rather than refuse the newest: browsers rotate
  // endpoints silently, and refusing would fill the slots with dead rows
  // and turn away the one live registration.
  //
  // `rowid DESC` is a load-bearing tie-break: several registrations often
  // share one `created_at` second, and the implicit rowid (free because the
  // composite primary key is not a rowid alias) keeps the newest.
  sql.exec(
    `DELETE FROM push_subscriptions
       WHERE pubkey = ?
         AND endpoint NOT IN (
           SELECT endpoint FROM push_subscriptions WHERE pubkey = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
    row.pubkey,
    row.pubkey,
    perPubkeyCap,
  );
}

// Scoped to the signing pubkey, not the endpoint alone. Endpoints are not
// secret, so without `AND pubkey = ?` any member could silently turn off
// someone else's notifications.
export function deletePushSubscription(sql: SqlStorage, pubkey: string, endpoint: string): boolean {
  const before = sql
    .exec(`SELECT 1 FROM push_subscriptions WHERE endpoint = ? AND pubkey = ?`, endpoint, pubkey)
    .toArray().length;
  if (before === 0) return false;
  sql.exec(`DELETE FROM push_subscriptions WHERE endpoint = ? AND pubkey = ?`, endpoint, pubkey);
  return true;
}

// Deletes by endpoint alone, every account on it, for an endpoint the push
// service reported gone (404/410). The authority is the push service, not
// a caller.
export function forgetPushEndpoint(sql: SqlStorage, endpoint: string): void {
  sql.exec(`DELETE FROM push_subscriptions WHERE endpoint = ?`, endpoint);
}

// The fan-out cursor (schema.ts `push_outbox.cursor`) for the row a page
// ended on: its key, endpoint then pubkey, joined by a newline, which no
// URL contains. A cursor written before rows had two-part keys is a bare
// endpoint, read as that endpoint with the lowest pubkey, so a fan-out in
// flight across the upgrade repeats at most that endpoint's rows.
export function pushCursor(row: { endpoint: string; pubkey: string }): string {
  return `${row.endpoint}\n${row.pubkey}`;
}

// One page of the fan-out, ordered and resumed by the primary key, so
// subscriptions added or removed mid-fan-out cannot shift the page
// boundary as a rowid offset would.
export function pushSubscriptionsAfter(
  sql: SqlStorage,
  after: string | null,
  limit: number,
): PushFanoutRow[] {
  const [endpoint = "", pubkey = ""] = (after ?? "").split("\n");
  return sql
    .exec<{
      endpoint: string;
      pubkey: string;
      p256dh: string;
      auth: string;
      last_ok_at: number | null;
      label: string | null;
    }>(
      `SELECT endpoint, pubkey, p256dh, auth, last_ok_at, label FROM push_subscriptions
         WHERE endpoint > ? OR (endpoint = ? AND pubkey > ?)
         ORDER BY endpoint ASC, pubkey ASC LIMIT ?`,
      endpoint,
      endpoint,
      pubkey,
      limit,
    )
    .toArray();
}

// One member's devices, for their own mail (relay.ts drainInboxPushes).
// An index seek on idx_push_subscriptions_pubkey, at most
// limits.ts MAX_PUSH_SUBSCRIPTIONS_PER_PUBKEY rows.
export function pushSubscriptionsFor(sql: SqlStorage, pubkey: string): PushFanoutRow[] {
  return sql
    .exec<{
      endpoint: string;
      pubkey: string;
      p256dh: string;
      auth: string;
      last_ok_at: number | null;
      label: string | null;
    }>(
      `SELECT endpoint, pubkey, p256dh, auth, last_ok_at, label FROM push_subscriptions
         WHERE pubkey = ? ORDER BY endpoint ASC`,
      pubkey,
    )
    .toArray();
}

// Asked on the gift wrap write path before queuing, so mail for a member
// with no devices writes no queue row and wakes no alarm. Web push or
// Android, whichever this relay can send.
export function hasPushSubscription(sql: SqlStorage, pubkey: string, web = true, fcm = false): boolean {
  if (web && sql.exec(`SELECT 1 FROM push_subscriptions WHERE pubkey = ? LIMIT 1`, pubkey).toArray().length > 0) {
    return true;
  }
  return fcm && sql.exec(`SELECT 1 FROM fcm_tokens WHERE pubkey = ? LIMIT 1`, pubkey).toArray().length > 0;
}

// ---------------------------------------------------------------------
// Android push tokens (schema.ts `fcm_tokens`, src/fcm.ts). The pubkey is
// always the NIP-98 signer.
// ---------------------------------------------------------------------

export interface FcmTokenRow {
  token: string;
  pubkey: string;
  label: string | null;
}

// Upsert on (token, pubkey), the label replaced every time, then this
// pubkey's oldest beyond the cap evicted (rowid DESC as the tie-break,
// as for web push).
export function upsertFcmToken(sql: SqlStorage, row: FcmTokenRow, cap: number, nowSec: number): void {
  sql.exec(
    `INSERT INTO fcm_tokens (token, pubkey, label, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(token, pubkey) DO UPDATE SET label = excluded.label, created_at = excluded.created_at`,
    row.token,
    row.pubkey,
    row.label,
    nowSec,
  );
  sql.exec(
    `DELETE FROM fcm_tokens
       WHERE pubkey = ?
         AND token NOT IN (
           SELECT token FROM fcm_tokens WHERE pubkey = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
    row.pubkey,
    row.pubkey,
    cap,
  );
}

export function deleteFcmToken(sql: SqlStorage, pubkey: string, token: string): void {
  sql.exec(`DELETE FROM fcm_tokens WHERE token = ? AND pubkey = ?`, token, pubkey);
}

// Every account on a token Google says is dead.
export function forgetFcmToken(sql: SqlStorage, token: string): void {
  sql.exec(`DELETE FROM fcm_tokens WHERE token = ?`, token);
}

export function fcmTokensFor(sql: SqlStorage, pubkey: string): FcmTokenRow[] {
  return sql
    .exec<{ token: string; pubkey: string; label: string | null }>(
      `SELECT token, pubkey, label FROM fcm_tokens WHERE pubkey = ? ORDER BY token ASC`,
      pubkey,
    )
    .toArray();
}

// ---------------------------------------------------------------------
// The inbox push queue (schema.ts `inbox_push`): one row per recipient
// with mail not yet announced.
// ---------------------------------------------------------------------

// DO NOTHING on conflict: a recipient already queued gets one
// notification for the burst, and the fold costs no row.
export function queueInboxPush(sql: SqlStorage, pubkey: string, nowSec: number): void {
  sql.exec(
    `INSERT INTO inbox_push (pubkey, queued_at) VALUES (?, ?) ON CONFLICT(pubkey) DO NOTHING`,
    pubkey,
    nowSec,
  );
}

export function pendingInboxPushes(sql: SqlStorage, limit: number): string[] {
  return sql
    .exec<{ pubkey: string }>(`SELECT pubkey FROM inbox_push ORDER BY queued_at ASC, pubkey ASC LIMIT ?`, limit)
    .toArray()
    .map((row) => row.pubkey);
}

export function clearInboxPush(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM inbox_push WHERE pubkey = ?`, pubkey);
}

export function markPushEndpointOk(sql: SqlStorage, endpoint: string, nowSec: number): void {
  sql.exec(`UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?`, nowSec, endpoint);
}

export function countPushSubscriptions(sql: SqlStorage): number {
  const row = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM push_subscriptions`).toArray()[0];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------
// The push outbox (schema.ts `push_outbox`, relay.ts drainPushOutbox):
// one row per notification reason, so messages arriving close together
// become one notification.
// ---------------------------------------------------------------------

export interface PushOutboxRow {
  reason: string;
  actors: string[];
  queued_at: number;
  cursor: string | null;
  sent: number;
}

// Queues a notification, or folds this occurrence into the one already
// queued for the same reason.
//
// Folding does NOT reset `cursor` or `sent`, so a busy room cannot keep
// restarting a fan-out that never reaches the last member. It does add the
// actor, so nobody is pushed about their own message.
export function queuePush(sql: SqlStorage, reason: string, actor: string, nowSec: number): void {
  const existing = sql
    .exec<{ actors: string }>(`SELECT actors FROM push_outbox WHERE reason = ?`, reason)
    .toArray()[0];
  if (existing === undefined) {
    sql.exec(
      `INSERT INTO push_outbox (reason, actors, queued_at, cursor, sent) VALUES (?, ?, ?, NULL, 0)`,
      reason,
      JSON.stringify([actor]),
      nowSec,
    );
    return;
  }
  const actors = parseActors(existing.actors);
  if (actors.includes(actor)) return;
  actors.push(actor);
  sql.exec(`UPDATE push_outbox SET actors = ? WHERE reason = ?`, JSON.stringify(actors), reason);
}

// A malformed `actors` value degrades to "exclude nobody" rather than
// throwing inside the alarm and stalling every pending notification.
function parseActors(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function pendingPushes(sql: SqlStorage): PushOutboxRow[] {
  return sql
    .exec<{ reason: string; actors: string; queued_at: number; cursor: string | null; sent: number }>(
      `SELECT reason, actors, queued_at, cursor, sent FROM push_outbox ORDER BY queued_at ASC`,
    )
    .toArray()
    .map((row) => ({ ...row, actors: parseActors(row.actors) }));
}

export function advancePush(sql: SqlStorage, reason: string, cursor: string, sent: number): void {
  sql.exec(`UPDATE push_outbox SET cursor = ?, sent = ? WHERE reason = ?`, cursor, sent, reason);
}

export function clearPush(sql: SqlStorage, reason: string): void {
  sql.exec(`DELETE FROM push_outbox WHERE reason = ?`, reason);
}

// ---------------------------------------------------------------------
// Call presence (schema.ts `presence`, limits.ts's presence block).
//
// Reached at most once per PRESENCE_WRITE_INTERVAL_SECONDS per pubkey;
// relay.ts's in-memory tier answers the beats in between.
// ---------------------------------------------------------------------

export function lastPresenceAt(sql: SqlStorage, pubkey: string): number | null {
  const row = sql
    .exec<{ last_seen: number }>(`SELECT last_seen FROM presence WHERE pubkey = ?`, pubkey)
    .toArray()[0];
  return row?.last_seen ?? null;
}

export function recordPresence(sql: SqlStorage, pubkey: string, nowSec: number): void {
  sql.exec(
    `INSERT INTO presence (pubkey, last_seen) VALUES (?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET last_seen = excluded.last_seen`,
    pubkey,
    nowSec,
  );
}

// For hearth's kind-25051 `{"status":"leave"}`: clearing the row means the
// next arrival is announced even within PRESENCE_STALE_SECONDS, which is
// silent by default so that a dropped connection is not announced.
export function clearPresence(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM presence WHERE pubkey = ?`, pubkey);
}

// ---------------------------------------------------------------------
// Ephemeral group chat (schema.ts `chat_state`, limits.ts's chat block).
//
// State is the single `chat_state` row these functions read and update
// without a group_id filter (schema.ts seeds exactly one); the sweep is a
// range over idx_events_kind_created_grp.
//
// Only kind 9 (groups.ts GROUP_CHAT_KIND) expires. The group partition
// also holds reactions, moderation events, relay-generated state and
// invite codes, none of which is conversation. A kind-7 reaction to a
// swept message outlives it; that is accepted, and GROUP_CHAT_KIND is the
// one place to widen the scope.
// ---------------------------------------------------------------------

export interface ChatState {
  lastOccupiedAt: number;
  sweptThrough: number;
  sweptTotal: number;
  reportedAt: number;
  reportedPending: number;
}

// One row read. initSchema seeds the row; the fallback is defensive only.
export function readChatState(sql: SqlStorage): ChatState {
  const row = sql
    .exec<{
      last_occupied_at: number;
      swept_through: number;
      swept_total: number;
      reported_at: number;
      reported_pending: number;
    }>(
      `SELECT last_occupied_at, swept_through, swept_total, reported_at, reported_pending
         FROM chat_state LIMIT 1`,
    )
    .toArray()[0];
  return {
    lastOccupiedAt: row?.last_occupied_at ?? 0,
    sweptThrough: row?.swept_through ?? 0,
    sweptTotal: row?.swept_total ?? 0,
    reportedAt: row?.reported_at ?? 0,
    reportedPending: row?.reported_pending ?? 0,
  };
}

// Records that the room was occupied at `nowSec`. The caller decides that
// it is (relay.ts groupOccupants, MIN_ROOM_OCCUPANTS) and that the stored
// value is stale enough to rewrite (CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS).
//
// MAX, not assignment: after an eviction the in-memory tier is empty and
// writes can arrive out of order, and the watermark must never move back.
export function noteRoomOccupied(sql: SqlStorage, nowSec: number): void {
  sql.exec(`UPDATE chat_state SET last_occupied_at = MAX(last_occupied_at, ?)`, nowSec);
}

// The oldest `created_at` a read of the group's chat may return:
//
//   room occupied  watermark is near now, so the horizon is
//                  now - CHAT_BACKLOG_SECONDS: a late arrival sees the
//                  last few minutes.
//   room empty     the horizon is the watermark: a reader sees only the
//                  notes left since the room emptied.
//
// The MIN makes the change gradual over CHAT_BACKLOG_SECONDS. Not a second
// expiry: it clamps REQs, which is where the rows-read saving between
// sweeps comes from.
export function chatHorizon(state: ChatState, nowSec: number): number {
  return Math.min(nowSec - CHAT_BACKLOG_SECONDS, state.lastOccupiedAt);
}

// The cutoff a sweep removes up to (inclusive). Once the room has been
// empty for CONVERSATION_IDLE_SECONDS, everything at or before the
// watermark (said while somebody was present) goes. The watermark both
// ends the conversation and separates speech from notes, so no
// per-message bookkeeping is needed.
//
// A note (a message sent to an empty room) is after the cutoff and waits,
// with no time limit, until the watermark passes it (see limits.ts on why
// there is no ceiling). Returns 0 while the room is in use.
export function chatSweepCutoff(state: ChatState, nowSec: number): number {
  return nowSec - state.lastOccupiedAt >= CONVERSATION_IDLE_SECONDS ? state.lastOccupiedAt : 0;
}

// How many messages that cutoff covers, for the report. A range over
// idx_events_kind_created_grp; `group_id` is not in that index, so it also
// reads the table row of every kind-9 in the group partition up to the
// cutoff. Bounded by what the group holds, so call it once per cron tick,
// never per request.
export function countChatBefore(sql: SqlStorage, cutoff: number): number {
  const row = sql
    .exec<{ n: number }>(
      // Same scope as sweepChat's delete, so reporting mode reports what
      // deleting mode would remove.
      `SELECT COUNT(*) AS n FROM events
        WHERE kind = ? AND is_group = ? AND group_id = ? AND created_at <= ?`,
      GROUP_CHAT_KIND,
      GROUP_SCOPE,
      TOP_LEVEL_GROUP_ID,
      cutoff,
    )
    .toArray()[0];
  return row?.n ?? 0;
}

export interface ChatSweep {
  // For the log line.
  cutoff: number;
  // How many messages the cutoff covered when the sweep began.
  pending: number;
  // How many it actually removed -- 0 in reporting mode, whatever it
  // managed in deleting mode.
  removed: number;
  // Whether the cutoff is now fully drained.
  done: boolean;
}

// One cron tick of the sweep. `remove` (decided by the caller from
// EPHEMERAL_CHAT) separates deleting from reporting; both modes compute and
// store the same report.
//
// No tombstones (deleteEventRow, not deleteAndTombstone): a `deleted_ids`
// row per message would keep a permanent record of every conversation,
// which is what this exists to remove. Replay is refused instead by
// `swept_through`, which nip29.ts authorizeGroupWrite compares an incoming
// chat message's `created_at` against.
//
// Oldest first, so a partial batch leaves a contiguous remainder.
//
// The sweep and the read horizon measure the client-signed `created_at`,
// the column idx_events_kind_created_grp is keyed on. A member can date a
// message forward to outlive its conversation (by at most
// MAX_CREATED_AT_FUTURE_SECONDS) or backward to have it swept early.
// Accepted: writers are members, and the next cutoff collects it.
export function sweepChat(
  sql: SqlStorage,
  state: ChatState,
  nowSec: number,
  limit: number,
  remove: boolean,
): ChatSweep {
  const cutoff = chatSweepCutoff(state, nowSec);

  // Nothing new to cover (room in use, or already drained). Return before
  // the COUNT and any write: an empty room holding an unread note is a
  // normal long-lived state and must cost nothing per tick beyond the state
  // read.
  if (cutoff <= state.sweptThrough) {
    return { cutoff, pending: 0, removed: 0, done: true };
  }

  const pending = countChatBefore(sql, cutoff);

  if (!remove) {
    // Reporting mode writes only the report: one row per tick.
    sql.exec(`UPDATE chat_state SET reported_at = ?, reported_pending = ?`, nowSec, pending);
    return { cutoff, pending, removed: 0, done: pending === 0 };
  }

  // Limited to TOP_LEVEL_GROUP_ID, the group the single `chat_state` row
  // describes. Without this, a relay hosting several groups would delete
  // one group's chat on another group's schedule. Known limit until the
  // sweep is made per-group: chat in any other group never expires.
  const targets = sql
    .exec<{ id: string }>(
      `SELECT id FROM events WHERE kind = ? AND is_group = ? AND group_id = ? AND created_at <= ?
         ORDER BY created_at ASC LIMIT ?`,
      GROUP_CHAT_KIND,
      GROUP_SCOPE,
      TOP_LEVEL_GROUP_ID,
      cutoff,
      limit,
    )
    .toArray();
  for (const target of targets) deleteEventRow(sql, target.id);

  // Fewer than `limit` means the range is exhausted.
  const done = targets.length < limit;
  // `swept_through` advances only when the range is complete, so it never
  // runs ahead of messages still stored.
  sql.exec(
    `UPDATE chat_state
        SET swept_through = MAX(swept_through, ?),
            swept_total = swept_total + ?,
            reported_at = ?,
            reported_pending = ?`,
    done ? cutoff : 0,
    targets.length,
    nowSec,
    pending,
  );
  return { cutoff, pending, removed: targets.length, done };
}
