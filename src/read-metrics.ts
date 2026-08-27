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
  // The NIP-42 gift wrap read gate's existence probe -- the per-filter
  // `kinds: [1059], limit: 1` re-run that only fires when the client's
  // own filter omits `kinds` (relay.ts handleReq, CLAUDE.md "The budget").
  "giftWrapGate",
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
  const sync = (): void => {
    const total = cursor.rowsRead;
    if (total > counted) {
      record(path, total - counted, 0);
      counted = total;
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
  // the 5,000,000/day ceiling. Honest only if the sample is long enough
  // and representative; null under an hour of uptime, where the
  // multiplier is large enough (at least 24x) that ordinary burstiness in
  // traffic reads as a huge swing in the projection -- observed live at
  // 1,721 rows/2min projecting 1,447,302/24h where the same relay
  // projected 785,000 from a 14-minute window an hour earlier. Neither
  // number was wrong, the window was just too short to mean anything.
  projected24h: number | null;
  paths: ReadPathReport[];
}

const MIN_SAMPLE_MS = 3_600_000;

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
    projected24h:
      sinceMs >= MIN_SAMPLE_MS ? Math.round((totalRowsRead * 86_400_000) / sinceMs) : null,
    paths,
  };
}

// Tests only -- there is no production caller and there should not be
// one. Nothing outside a test has a reason to discard a sample.
export function resetReadMetrics(): void {
  counters.clear();
  startedAtMs = null;
  currentPath = "unattributed";
}
