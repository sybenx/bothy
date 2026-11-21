import { clearReqCache } from "./req-cache";

// ---------------------------------------------------------------------
// Two instruments over one SqlStorage wrapper (instrumentSql below):
//   - rows-READ attribution per code path: a diagnostic, expected to be
//     removed eventually;
//   - the rows-WRITTEN meter (pendingRowsWritten): permanent, it backs
//     /api/stats `rowsWrittenToday`. Removing the read attribution must
//     keep it.
// Wrapping exec once means no code path has to remember to report itself.
//
// The read attribution lets /api/stats `reads` name which path spends the
// 5,000,000 rows-read/day allowance. In memory, never in storage: a
// counter row per query would spend a row write to measure a row read. So
// it resets on every eviction (frequent under hibernation) and gives
// proportions, not daily totals; `sinceMs` says how long a sample covers.
//
// Cost: one Proxy allocation per sql.exec and a Map lookup per consumed
// cursor. No storage, no query of its own.
// ---------------------------------------------------------------------

// Paths are a closed list so a typo is a type error rather than a new
// bucket that looks like a real finding.
export const READ_PATHS = [
  // Client REQ handling: storage.ts queryFilters, one query per filter
  // in the REQ frame (relay.ts handleReq).
  "req",
  // GET /api/stats (relay.ts getStats).
  "getStats",
  // storage.ts estimateRowsWrittenSince, wherever it is called from:
  // backfill.ts hasBackfillHeadroom calls it on every cron tick and
  // again inside every ingest.
  "estimateRowsWrittenSince",
  // backfill.ts applyBackfillPage: the per-event eventExists/isDeleted
  // pair, plus the cursor/exhaustion bookkeeping.
  "backfillIngest",
  // relay.ts getBackfillState, minus the estimate above.
  "backfillState",
  // relay.ts runCron: everything the hourly tick does that has no scope
  // of its own below.
  "cron",
  // The live write path (relay.ts handleEvent/handleGiftWrap/
  // acceptEvent): ownership gate, tombstone and duplicate checks, the
  // gift wrap count, and storeEvent's replaceable/addressable lookups.
  "write",
  // nip29.ts applyModeration: the membership writes a moderation event
  // triggers and the group state events it regenerates. Separate from
  // "write" because only a moderation event pays it.
  "groupState",
  // nip29.ts handleJoinRequest. Separate from "write" because a join
  // stores no event.
  "join",
  // relay.ts notePresence: the call-presence watermark. This bucket
  // should grow with limits.ts PRESENCE_WRITE_INTERVAL_SECONDS, not with
  // the beat rate; growth with the beat rate is the failure to watch for.
  "presence",
  // relay.ts drainPushOutbox: one push fan-out. Runs in the alarm, not
  // on the write path.
  "push",
  // relay.ts runCron -> storage.ts sweepChat. Separate from "cron"
  // because its size follows how much the room has talked; it should
  // never grow with the accumulated table.
  "chatSweep",
  // relay.ts runCron -> storage.ts sweepExpiredGiftWraps. Its size
  // follows how full the gift wrap inbox is: a permanently full inbox
  // pays one walk an hour to find nothing to reclaim.
  "giftWrapSweep",
  // relay.ts fetch(): recordHost plus the once-per-connection
  // isIpBlocked lookup.
  "connect",
  // Owner and identity lookups from the Worker: the NIP-11 document,
  // the NIP-98 owner check, and the claim, claim-nonce and claim-status
  // calls.
  "identity",
  // NIP-86 management calls (relay.ts manage).
  "management",
  // Profile photos (src/photos.ts): serving, uploading and deleting one.
  "photos",
  // schema.ts initSchema, which runs in the Durable Object constructor,
  // so on every wake from hibernation.
  "schema",
  // storage.ts settleRowsWritten: the write meter landing its own total,
  // on the paths that have no bucket write of their own. Named so it
  // does not read as a gap in `unattributed`.
  "meter",
  // Anything reaching SQLite outside a withReadPath scope. A large share
  // here means the instrument is missing a path and the named figures
  // cannot be trusted.
  "unattributed",
] as const;

export type ReadPath = (typeof READ_PATHS)[number];

interface PathCounters {
  // Rows read, summed from SqlStorageCursor.rowsRead.
  rowsRead: number;
  // Rows written (cursor rowsWritten plus addRowsWritten top-ups): the
  // per-path mirror of pendingRowsWritten, but never reset by a landing.
  // A since-eviction diagnostic total, like rowsRead.
  rowsWritten: number;
  // Individual sql.exec calls made inside this path.
  queries: number;
  // Times this path was entered. rowsRead/calls is the per-call cost to
  // multiply by a daily frequency when projecting against the ceiling.
  calls: number;
}

const counters = new Map<ReadPath, PathCounters>();
// Set on first use rather than at module scope: top-level Date.now() in
// a Worker returns a frozen startup time, which would make every
// snapshot claim a window beginning at the same instant.
let startedAtMs: number | null = null;

function bucket(path: ReadPath): PathCounters {
  let entry = counters.get(path);
  if (!entry) {
    entry = { rowsRead: 0, rowsWritten: 0, queries: 0, calls: 0 };
    counters.set(path, entry);
  }
  if (startedAtMs === null) startedAtMs = Date.now();
  return entry;
}

// ---------------------------------------------------------------------
// THE WRITE METER. Not a diagnostic: `pendingRowsWritten` is what
// /api/stats reports as `rowsWrittenToday`, landed durably into
// `ingest_hour_counts` by storage.ts settleRowsWritten/insertEventRow.
// Measured at the wrapper, it sees every write (deletions, tombstones,
// follow rebuilds, NIP-86 calls, backfill bookkeeping), which a sum over
// `events.row_cost` cannot. A write can land in the wrong hour if a
// handler straddles a bucket boundary, but cannot go uncounted.
//
// It is instance memory, which hibernation discards, and the relay wakes
// dozens of times per cron interval. A timer or next-tick flush would
// lose most of the count (more, the quieter the relay), so every DO entry
// point lands its own total before returning: relay.ts `metered` ->
// storage.ts settleRowsWritten.
//
// One small residue can be lost per wake: the landing statement's own
// write, which carries to the next landing, and settleRowsWritten skips
// landing a residue below MIN_ROWS_WRITTEN_LANDING. deleteEventRow
// over-counts by far more (schema.ts eventRemovalBudget), so the meter
// reads high overall, the safe direction for a budget.
// ---------------------------------------------------------------------
let pendingRowsWritten = 0;

// Returns and resets the unlanded total. Only storage.ts
// settleRowsWritten and insertEventRow's bucket bump may call this:
// taking the total without writing it somewhere durable loses it.
export function takeRowsWritten(): number {
  const total = pendingRowsWritten;
  pendingRowsWritten = 0;
  return total;
}

// Rows written that the cursor did not report. Sole caller: storage.ts
// deleteEventRow, because SqlStorageCursor counts index maintenance on
// INSERT but not on DELETE (schema.ts eventRemovalRowsWritten), so a
// wrapper-only figure would undercount every removal.
export function addRowsWritten(rows: number): void {
  pendingRowsWritten += rows;
  // Attributed to whichever scope is active, as trackCursor does.
  record(currentPath, 0, 0, rows);
}

// For settleRowsWritten's threshold and for tests.
export function unlandedRowsWritten(): number {
  return pendingRowsWritten;
}

// The innermost active scope. A plain variable rather than
// AsyncLocalStorage is safe because SqlStorage is synchronous: no
// measured path can interleave with another between sql.exec calls.
let currentPath: ReadPath = "unattributed";

// Attributes every query `fn` issues to `path`, restoring the previous
// scope afterwards. Nesting is innermost-wins.
export function withReadPath<T>(path: ReadPath, fn: () => T): T {
  const previous = currentPath;
  currentPath = path;
  bucket(path).calls++;
  try {
    return fn();
  } finally {
    currentPath = previous;
  }
}

function record(path: ReadPath, rowsRead: number, queries: number, rowsWritten = 0): void {
  const entry = bucket(path);
  entry.rowsRead += rowsRead;
  entry.rowsWritten += rowsWritten;
  entry.queries += queries;
}

// Wraps one cursor so its counts land in the scope active when the query
// was issued (a cursor may outlive its scope).
//
// rowsRead is cumulative and only final once the cursor is consumed, so
// the delta is synced after every method call. It is also synced at exec
// time, which is what catches INSERT/UPDATE/DELETE: they execute eagerly,
// nothing consumes their cursor, and they still read rows.
function trackCursor<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
  path: ReadPath,
): SqlStorageCursor<T> {
  let counted = 0;
  let countedWritten = 0;
  const sync = (): void => {
    const total = cursor.rowsRead;
    if (total > counted) {
      record(path, total - counted, 0);
      counted = total;
    }
    // The write meter, by the same delta rule. Writes are final at exec
    // time; the later syncs would catch a count that settled afterwards.
    const written = cursor.rowsWritten;
    if (written > countedWritten) {
      const delta = written - countedWritten;
      pendingRowsWritten += delta;
      // Per-path mirror, never reset by a landing: says which path is
      // spending the write budget.
      record(path, 0, 0, delta);
      countedWritten = written;
    }
  };
  record(path, 0, 1);
  sync();

  // `receiver` is deliberately not forwarded to Reflect.get: workerd's
  // native cursor getters (rowsRead, rowsWritten) throw when invoked with
  // a Proxy as receiver.
  return new Proxy(cursor, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") {
        // rowsRead/rowsWritten/columnNames read straight through.
        return value;
      }
      return (...args: unknown[]) => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        sync();
        return result;
      };
    },
  }) as SqlStorageCursor<T>;
}

// Not part of the diagnostic: removing the read attribution must keep
// this hook, or req-cache.ts serves stale answers.
//
// True for a write naming `events` or `event_tags`, the only tables REQ
// SQL reads. Decided from the statement text, not cursor.rowsWritten, so
// it does not depend on how Cloudflare reports a DELETE's writes.
// Narrowed to those two tables because writes that run on nearly every
// connection (host.ts recordHost's `UPDATE relay_meta`) would otherwise
// empty the cache on every reconnect, the traffic it exists for. `\b`
// treats `_` as a word character, so `banned_events` and
// `event_hour_counts` do not match.
const WRITE_STATEMENT = /^\s*(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER)\b/i;
// In table position, not anywhere: `maintained_counts` has a column
// called `events`.
const REQ_TABLES = /\b(INTO|UPDATE|FROM|TABLE)\s+(events|event_tags)\b/i;
function changesReqResults(query: string): boolean {
  return WRITE_STATEMENT.test(query) && REQ_TABLES.test(query);
}


// The single insertion point: a SqlStorage identical to the one passed
// in, except every cursor reports into the active path. Wrapping exec
// means a query can be mislabelled (into `unattributed`) but never
// missed, which is what makes `unattributed` a real gap detector.
export function instrumentSql(sql: SqlStorage): SqlStorage {
  return new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) => {
          if (changesReqResults(query)) clearReqCache();
          return trackCursor(target.exec<T>(query, ...bindings), currentPath);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as SqlStorage;
}

export interface ReadPathReport {
  path: ReadPath;
  rowsRead: number;
  queries: number;
  calls: number;
  // Rows read per entry into this path. Null when never entered, which
  // differs from entered and read nothing.
  rowsPerCall: number | null;
  // Share of the total, 0-1.
  share: number;
}

export interface ReadMetricsSnapshot {
  // Milliseconds this sample covers (counters reset on eviction).
  sinceMs: number;
  totalRowsRead: number;
  // totalRowsRead extrapolated to 24h at the observed rate, against the
  // 5,000,000/day ceiling. Trust it more the larger sinceMs is.
  projected24h: number;
  paths: ReadPathReport[];
}

export function readMetricsSnapshot(): ReadMetricsSnapshot {
  const sinceMs = startedAtMs === null ? 0 : Math.max(0, Date.now() - startedAtMs);
  let totalRowsRead = 0;
  for (const entry of counters.values()) totalRowsRead += entry.rowsRead;

  const paths: ReadPathReport[] = [];
  for (const path of READ_PATHS) {
    const entry = counters.get(path);
    if (!entry || (entry.rowsRead === 0 && entry.calls === 0)) continue;
    paths.push({
      path,
      rowsRead: entry.rowsRead,
      queries: entry.queries,
      calls: entry.calls,
      rowsPerCall: entry.calls > 0 ? entry.rowsRead / entry.calls : null,
      share: totalRowsRead > 0 ? entry.rowsRead / totalRowsRead : 0,
    });
  }
  paths.sort((a, b) => b.rowsRead - a.rowsRead);

  return {
    sinceMs,
    totalRowsRead,
    projected24h: sinceMs > 0 ? Math.round((totalRowsRead * 86_400_000) / sinceMs) : 0,
    paths,
  };
}

export interface WritePathReport {
  path: ReadPath;
  rowsWritten: number;
  queries: number;
  calls: number;
  // Rows written per entry into this path. Null when never entered.
  rowsWrittenPerCall: number | null;
  // Share of the total, 0-1.
  share: number;
}

// The write-side twin of ReadMetricsSnapshot, with the same caveats
// (in memory, resets on eviction, proportions only). `rowsWrittenToday`
// is the durable total; this says which path is spending it.
export interface WriteMetricsSnapshot {
  sinceMs: number;
  totalRowsWritten: number;
  // Extrapolated to 24h against the 100,000/day ceiling; same caveat as
  // ReadMetricsSnapshot.projected24h.
  projected24h: number;
  paths: WritePathReport[];
}

export function writeMetricsSnapshot(): WriteMetricsSnapshot {
  const sinceMs = startedAtMs === null ? 0 : Math.max(0, Date.now() - startedAtMs);
  let totalRowsWritten = 0;
  for (const entry of counters.values()) totalRowsWritten += entry.rowsWritten;

  const paths: WritePathReport[] = [];
  for (const path of READ_PATHS) {
    const entry = counters.get(path);
    if (!entry || (entry.rowsWritten === 0 && entry.calls === 0)) continue;
    paths.push({
      path,
      rowsWritten: entry.rowsWritten,
      queries: entry.queries,
      calls: entry.calls,
      rowsWrittenPerCall: entry.calls > 0 ? entry.rowsWritten / entry.calls : null,
      share: totalRowsWritten > 0 ? entry.rowsWritten / totalRowsWritten : 0,
    });
  }
  paths.sort((a, b) => b.rowsWritten - a.rowsWritten);

  return {
    sinceMs,
    totalRowsWritten,
    projected24h: sinceMs > 0 ? Math.round((totalRowsWritten * 86_400_000) / sinceMs) : 0,
    paths,
  };
}

// Tests only.
export function resetReadMetrics(): void {
  counters.clear();
  startedAtMs = null;
  currentPath = "unattributed";
  pendingRowsWritten = 0;
}
