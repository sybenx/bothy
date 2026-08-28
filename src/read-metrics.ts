// ---------------------------------------------------------------------
// TWO INSTRUMENTS OVER ONE WRAPPER. The rows-READ attribution below is a
// diagnostic and is still expected to be removed; the rows-WRITTEN total
// at the bottom of this file is not, and the module can no longer be
// deleted wholesale. They share `instrumentSql` because they need the
// same thing -- a cursor, at the moment it is created -- and because
// wrapping once is what makes both of them unforgettable. Read the
// diagnostic's own terms first; the write meter's are stated where it
// starts.
//
// ---------------------------------------------------------------------
// DIAGNOSTIC INSTRUMENT -- NOT A LIMIT, AND EXPECTED TO BE REMOVED.
//
// The live relay exhausted the Workers Free plan's 5,000,000 rows-read/
// day allowance under ordinary single-owner operation and returned 500
// on every Durable Object path until the 00:00 UTC reset. Nothing in
// this codebase could say which code path spent them: rows *written* per
// event had been measured carefully and rows *read* only at the two
// places somebody happened to be suspicious of (the gift wrap probe, the
// pubkey-ban lookup). This module answers the question nobody had asked.
//
// It attributes rows read to the code path that caused them, so the
// breakdown in /api/stats can name a dominant consumer instead of
// leaving the remedy to guesswork. Deliberately measure-first: adding a
// read budget or a limiter before knowing what to guard is the mistake
// backfill.ts hasBackfillHeadroom already made once here -- it spent
// months guarding a number that could not see the writes it was
// restraining, because nobody had measured what it was actually
// counting (see schema.ts's `ingested_at` comment).
//
// IN MEMORY, NEVER IN STORAGE. A counter row incremented per query
// would cost a row write to measure a row read -- the same trade
// schema.ts rejected for a rows-written counter table, and a worse one
// here, since it spends the scarcer ceiling to measure the scarcer
// ceiling. The consequence is accepted: these
// numbers reset whenever the Durable Object is evicted (which, with
// WebSocket hibernation, is often). They are for PROPORTIONS -- which
// path dominates -- not for exact daily totals. `sinceMs` in the
// snapshot is what makes that legible: a breakdown covering four
// minutes of uptime is a sample, not a day.
//
// Cost of the instrument itself: one Proxy allocation per `sql.exec`
// and a Map lookup per consumed cursor. No storage, no query of its
// own. Measurable against the ~1.1ms/schnorr-verify baseline only in
// the sense of being far below it (src/validate.ts).
// ---------------------------------------------------------------------

// Every path is named here rather than passed as a free string, so a
// typo lands as a type error instead of silently opening a new bucket
// that looks like a real finding.
export const READ_PATHS = [
  // Client REQ handling: storage.ts queryFilters, one query per filter
  // in the REQ frame (relay.ts handleReq).
  "req",
  // GET /api/stats (relay.ts getStats), excluding the nested
  // estimateRowsWrittenSince below, which reports separately.
  "getStats",
  // storage.ts estimateRowsWrittenSince, on its own wherever it is called
  // from -- getStats displays it, and backfill.ts hasBackfillHeadroom
  // calls it on every cron tick AND again inside every ingest.
  "estimateRowsWrittenSince",
  // backfill.ts applyBackfillPage: the per-event eventExists/isDeleted
  // pair, plus the cursor/exhaustion bookkeeping.
  "backfillIngest",
  // relay.ts getBackfillState, minus the estimate above.
  "backfillState",
  // relay.ts runCron: refreshFollows, refreshProfile,
  // resetWronglyExhaustedRelays, purgeSelfRelay.
  "cron",
  // The live write path (relay.ts handleEvent/handleGiftWrap/
  // acceptEvent): ownership gate, tombstone and duplicate checks, the
  // gift wrap count, and storeEvent's own replaceable/addressable
  // lookups.
  "write",
  // relay.ts fetch(): recordHost plus the once-per-connection
  // isIpBlocked lookup.
  "connect",
  // NIP-11 document and the Worker's NIP-98 owner lookup.
  "identity",
  // NIP-86 management calls (relay.ts manage).
  "management",
  // schema.ts initSchema, which runs in the Durable Object constructor
  // -- i.e. on every wake from hibernation, not once per deploy.
  "schema",
  // storage.ts settleRowsWritten: the write meter landing its own total
  // into an ingest-hour bucket, on the paths that have no bucket write of
  // their own (cron ticks, NIP-86 calls, the follow rebuild). Named
  // rather than left to fall into `unattributed`, because a steady
  // trickle there would read as a gap in the instrument when it is
  // actually the instrument.
  "meter",
  // The gap detector. Anything reaching SQLite outside a withReadPath
  // scope lands here, and a large `unattributed` share is itself the
  // finding: it means the instrument is missing a path and no arithmetic
  // over the named ones can be trusted.
  "unattributed",
] as const;

export type ReadPath = (typeof READ_PATHS)[number];

interface PathCounters {
  // Rows read, summed from SqlStorageCursor.rowsRead.
  rowsRead: number;
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
    entry = { rowsRead: 0, queries: 0, calls: 0 };
    counters.set(path, entry);
  }
  if (startedAtMs === null) startedAtMs = Date.now();
  return entry;
}

// ---------------------------------------------------------------------
// THE WRITE METER. Rows written since the last landing, accumulated by
// the same cursor wrapper the read attribution uses.
//
// NOT a diagnostic and not attributed per path: this is the number
// /api/stats reports as `rowsWrittenToday`, measured against a ceiling
// Cloudflare empties at 00:00 UTC. It used to be a SUM over
// `events.row_cost`, which is the cost of storing events and nothing
// else -- it could not see a deletion, a tombstone, a follow-list
// rebuild, a NIP-86 ban or backfill's own bookkeeping, every one of
// which is a real row against the same 100,000/day allowance.
//
// MEASURED AT THE WRAPPER, NOT REPORTED BY EACH PATH, and that is the
// whole design. A path that has to remember to report its own writes is
// a path that will eventually forget, and nothing catches it: this
// project has already shipped BACKFILL_PAGE_SIZE wrong three times by
// hand-maintaining a figure derived from something else. Wrapping
// `sql.exec` once means a write can land in the wrong HOUR (if a handler
// straddles a bucket boundary) but never go uncounted.
//
// IN MEMORY UNTIL IT LANDS, which is the one correctness property this
// has to get right. `pendingRowsWritten` is instance memory and instance
// memory does not survive hibernation -- and this relay wakes on the
// order of seventy times per cron interval, so a meter that flushed on a
// timer or deferred to the next tick would lose almost all of what it
// measured, and lose MORE of it the quieter the relay is. So every entry
// point lands its own total before returning: see storage.ts
// settleRowsWritten and the `metered` wrapper in relay.ts.
//
// One row of residue can still be lost per wake, and it is exactly the
// landing statement's own cost: the landing is itself a write, the
// wrapper sees it, and it carries to the next landing rather than
// chasing itself. settleRowsWritten declines to land a residue that
// small, because spending one row to record one row is a treadmill
// rather than accounting. Against that undercount, deleteEventRow leans
// the other way by a much larger margin (schema.ts eventRemovalBudget),
// so the meter as a whole reads high, which is the safe direction for a
// budget.
// ---------------------------------------------------------------------
let pendingRowsWritten = 0;

// Rows written since the last landing, and reset to zero by the caller
// taking them. Only storage.ts settleRowsWritten and storage.ts
// insertEventRow's bucket bump may call this -- taking the total without
// writing it somewhere durable is how it gets lost.
export function takeRowsWritten(): number {
  const total = pendingRowsWritten;
  pendingRowsWritten = 0;
  return total;
}

// Rows written that the cursor did not report. The ONE caller is
// storage.ts deleteEventRow, and the reason is stated on schema.ts
// eventRemovalRowsWritten: SqlStorageCursor counts index maintenance on
// INSERT and not on DELETE, so a wrapper-only figure undercounts every
// removal -- the wrong direction for a meter whose whole job is saying
// how close the relay is to a ceiling.
export function addRowsWritten(rows: number): void {
  pendingRowsWritten += rows;
}

// What has not landed yet. For settleRowsWritten's own threshold and for
// the tests that assert the landing happened; nothing else should care.
export function unlandedRowsWritten(): number {
  return pendingRowsWritten;
}

// The innermost active scope. A plain variable, not an AsyncLocalStorage
// context: every path measured here is synchronous from the first
// sql.exec to the last (SqlStorage has no async surface), so there is no
// interleaving for a stack to get wrong.
let currentPath: ReadPath = "unattributed";

// Attributes every read performed by `fn` to `path`, restoring the
// previous scope afterwards. Nesting is innermost-wins, which is what
// keeps estimateRowsWrittenSince reporting separately from the getStats
// and backfill scopes that call it.
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

function record(path: ReadPath, rows: number, queries: number): void {
  const entry = bucket(path);
  entry.rowsRead += rows;
  entry.queries += queries;
}

// Wraps one cursor so its rowsRead lands in whichever bucket was active
// when the query was issued -- captured at exec time, not at consumption
// time, since a cursor may outlive its scope.
//
// rowsRead is cumulative on the cursor and only reaches its final value
// once the cursor is consumed, so this syncs the delta after every
// method call rather than reading it once. It also syncs immediately at
// exec time, which is what catches INSERT/UPDATE/DELETE statements: those
// execute eagerly and their cursor is never consumed by anything here,
// yet they genuinely read rows (`DELETE FROM event_tags WHERE event_id =
// ?` has no index to use, for one).
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
    // The write meter, on the same tick and by the same delta rule.
    // INSERT/UPDATE/DELETE execute eagerly and their cursor carries a
    // final rowsWritten immediately, so the sync at exec time below is
    // what catches every write; the syncs after each method call cost
    // nothing and are what would catch a statement whose write count
    // settled later.
    const written = cursor.rowsWritten;
    if (written > countedWritten) {
      pendingRowsWritten += written - countedWritten;
      countedWritten = written;
    }
  };
  record(path, 0, 1);
  sync();

  // `receiver` is deliberately not forwarded to Reflect.get: native
  // getters on a workerd cursor (rowsRead, rowsWritten) throw when
  // invoked with a Proxy as their receiver, so every access is resolved
  // against the real cursor.
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

// The single insertion point. Returns a SqlStorage that behaves exactly
// like the one passed in, except that every cursor it hands out reports
// its rows read into the active path.
//
// A wrapper rather than per-call-site instrumentation, deliberately: the
// question this exists to answer is "what is consuming the reads," and a
// list of call sites somebody remembered to annotate can only ever
// confirm suspicions already held. Wrapping exec means a query can be
// mis-LABELLED (it falls into `unattributed`) but never missed, which is
// what makes the `unattributed` bucket a real gap detector rather than
// decoration.
export function instrumentSql(sql: SqlStorage): SqlStorage {
  return new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return <T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]) =>
          trackCursor(target.exec<T>(query, ...bindings), currentPath);
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
  // Rows read per entry into this path -- the figure to multiply by a
  // daily call frequency when projecting against the ceiling. Null when
  // the path has not been entered, which is different from having been
  // entered and read nothing.
  rowsPerCall: number | null;
  // Share of the total, so the dominant consumer is readable without
  // arithmetic. 0-1.
  share: number;
}

export interface ReadMetricsSnapshot {
  // Milliseconds this sample covers. Counters live in memory and reset
  // on eviction, so this is what says whether the breakdown below
  // describes a day or the last ninety seconds.
  sinceMs: number;
  totalRowsRead: number;
  // Extrapolation of totalRowsRead to 24h at the observed rate, against
  // the 5,000,000/day ceiling. Always computed and rendered -- an
  // /api/stats page load costs a bounded handful of rows now that every
  // figure on it is a maintained counter, where it used to cost ~1,200,
  // which is what made a short sample projection swing wildly (the
  // observer dominating the measurement, not the relay). sinceMs stays
  // alongside it so the reader can judge how much a given projection
  // should be trusted.
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

// Tests only -- there is no production caller and there should not be
// one. Nothing outside a test has a reason to discard a sample.
export function resetReadMetrics(): void {
  counters.clear();
  startedAtMs = null;
  currentPath = "unattributed";
  pendingRowsWritten = 0;
}
