// Column reconciliation (src/schema.ts reconcileColumns/initSchema).
//
// These are written against the MECHANISM first and the real tables
// second, and that ordering is the lesson rather than a style choice. The
// previous version of this file tested exactly one table, backfill_meta,
// and passed for weeks while `owner` was missing two columns and throwing
// `no such column: profile_synced_at` on every cron tick in production. A
// test shaped like one table cannot catch the next table. So the first
// describe below exercises the reconciler on a table that exists only for
// the test, and the second walks every real table's known historical
// shape.
//
// All of this drops below the wire to real SqlStorage via
// runInDurableObject, which is unavoidable here: every other suite starts
// from an empty database, where CREATE TABLE writes every column and there
// is nothing to migrate. Reproducing an old deployment means building an
// old table by hand. Same documented exception as the others in
// docs/test-notes.md.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  computeSchemaHash,
  eventRowCost,
  forgetSchemaHash,
  INDEXES,
  initSchema,
  reconcileColumns,
  TABLES,
  type IndexSpec,
  type TableSpec,
} from "../src/schema";
import { estimateRowsWrittenSince } from "../src/storage";
import { refreshProfile } from "../src/ownership";
import { isolateStorage } from "./helpers/isolate";
import { OWNER_PUBKEY_HEX } from "./helpers/keys";

isolateStorage();

async function withSql(fn: (sql: SqlStorage) => void | Promise<void>): Promise<void> {
  const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
  await runInDurableObject(stub, async (_instance, state) => {
    await fn(state.storage.sql);
  });
}

function columnsOf(sql: SqlStorage, table: string): string[] {
  return sql
    .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, table)
    .toArray()
    .map((r) => r.name);
}

describe("reconcileColumns", () => {
  // A table that exists only here, so this tests the reconciler rather
  // than any particular schema decision. Deliberately missing several
  // columns at once, of several shapes -- nullable, defaulted, and
  // NOT NULL DEFAULT -- because real drift arrives in batches, not one
  // column at a time.
  const SPEC: TableSpec = {
    name: "reconcile_fixture",
    columns: [
      { name: "id", definition: "TEXT PRIMARY KEY" },
      { name: "already_here", definition: "TEXT" },
      { name: "added_nullable", definition: "INTEGER" },
      { name: "added_with_default", definition: "INTEGER NOT NULL DEFAULT 7" },
      { name: "added_text_default", definition: "TEXT NOT NULL DEFAULT 'pending'" },
    ],
  };

  it("adds every missing column and leaves existing rows intact", async () => {
    await withSql((sql) => {
      sql.exec(`DROP TABLE IF EXISTS reconcile_fixture`);
      sql.exec(`CREATE TABLE reconcile_fixture (id TEXT PRIMARY KEY, already_here TEXT)`);
      sql.exec(`INSERT INTO reconcile_fixture (id, already_here) VALUES ('a', 'kept')`);

      const added = reconcileColumns(sql, SPEC);
      expect(added).toEqual(["added_nullable", "added_with_default", "added_text_default"]);

      const row = sql
        .exec<{
          id: string;
          already_here: string | null;
          added_nullable: number | null;
          added_with_default: number;
          added_text_default: string;
        }>(`SELECT * FROM reconcile_fixture`)
        .toArray()[0];

      // The row that was already there keeps its data and picks up each
      // new column's declared default -- exactly what it would have had
      // on a fresh database.
      expect(row).toEqual({
        id: "a",
        already_here: "kept",
        added_nullable: null,
        added_with_default: 7,
        added_text_default: "pending",
      });

      sql.exec(`DROP TABLE reconcile_fixture`);
    });
  });

  it("is idempotent -- a second pass adds nothing", async () => {
    await withSql((sql) => {
      sql.exec(`DROP TABLE IF EXISTS reconcile_fixture`);
      sql.exec(`CREATE TABLE reconcile_fixture (id TEXT PRIMARY KEY, already_here TEXT)`);
      reconcileColumns(sql, SPEC);
      expect(reconcileColumns(sql, SPEC)).toEqual([]);
      sql.exec(`DROP TABLE reconcile_fixture`);
    });
  });

  it("does nothing when the table does not exist yet", async () => {
    await withSql((sql) => {
      sql.exec(`DROP TABLE IF EXISTS reconcile_fixture`);
      // CREATE TABLE declares every column on a fresh database, so there
      // is nothing for the reconciler to do and it must not guess.
      expect(reconcileColumns(sql, SPEC)).toEqual([]);
    });
  });

  // SQLite cannot ADD COLUMN these shapes. Each must fail loudly at init
  // rather than being skipped -- silently continuing past a column the
  // code goes on to SELECT is precisely how the owner table broke.
  const UNADDABLE = [
    "TEXT PRIMARY KEY",
    "TEXT UNIQUE",
    "INTEGER NOT NULL",
    "INTEGER NOT NULL DEFAULT NULL",
    "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP",
    "TEXT REFERENCES events(id)",
  ];

  for (const definition of UNADDABLE) {
    it(`throws rather than skipping a missing column declared as ${definition}`, async () => {
      await withSql((sql) => {
        sql.exec(`DROP TABLE IF EXISTS reconcile_fixture`);
        sql.exec(`CREATE TABLE reconcile_fixture (id TEXT PRIMARY KEY)`);
        expect(() =>
          reconcileColumns(sql, {
            name: "reconcile_fixture",
            columns: [
              { name: "id", definition: "TEXT PRIMARY KEY" },
              { name: "impossible", definition },
            ],
          }),
        ).toThrow(/cannot add reconcile_fixture\.impossible/);
        sql.exec(`DROP TABLE reconcile_fixture`);
      });
    });
  }

  it("does not object to an unaddable column that is already present", async () => {
    // Every real table declares a PRIMARY KEY. Those are created by
    // CREATE TABLE and must never trip the addability check, or init
    // would throw on every fresh database.
    await withSql((sql) => {
      sql.exec(`DROP TABLE IF EXISTS reconcile_fixture`);
      sql.exec(`CREATE TABLE reconcile_fixture (id TEXT PRIMARY KEY)`);
      expect(() =>
        reconcileColumns(sql, {
          name: "reconcile_fixture",
          columns: [{ name: "id", definition: "TEXT PRIMARY KEY" }],
        }),
      ).not.toThrow();
      sql.exec(`DROP TABLE reconcile_fixture`);
    });
  });

});

describe("initSchema against historical table shapes", () => {
  // Each case rebuilds a real table as an older deployment actually had
  // it, then runs the real initSchema over it. Adding a table here is the
  // cost of adding a table to the schema.
  const HISTORICAL: Array<{
    table: string;
    label: string;
    create: string;
    seed: string;
    expectAdded: string[];
  }> = [
    {
      table: "owner",
      label: "pre-bc36cbf, before the profile-refresh columns",
      // The shape that threw `no such column: profile_synced_at` on every
      // cron tick, because these two columns were added to CREATE TABLE
      // with no migration beside them.
      create: `CREATE TABLE owner (pubkey TEXT NOT NULL, name TEXT, picture TEXT)`,
      seed: `INSERT INTO owner (pubkey, name, picture) VALUES ('abc', 'Aaro', 'https://example.com/a.png')`,
      expectAdded: ["about", "website", "profile_synced_at", "icon_refreshed_at"],
    },
    {
      table: "owner",
      label: "pre-v0.7.4, before website",
      // The shape that would leave NIP-11's `contact` permanently absent
      // without resetsOnAdd: profile_synced_at already holds the created_at
      // of a kind-0 that has been parsed, so refreshProfile's "is there a
      // newer one" guard answers no forever and the brand-new column never
      // gets its first parse. Same failure `about` hit; same fix.
      create: `CREATE TABLE owner (pubkey TEXT NOT NULL, name TEXT, picture TEXT, about TEXT, profile_synced_at INTEGER, icon_refreshed_at INTEGER)`,
      seed: `INSERT INTO owner (pubkey, name, profile_synced_at) VALUES ('abc', 'Aaro', 12345)`,
      expectAdded: ["website"],
    },
    {
      table: "backfill_meta",
      label: "pre-v0.2.1, before exhaust_reset_applied",
      create: `CREATE TABLE backfill_meta (status TEXT NOT NULL DEFAULT 'pending', total_stored INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER)`,
      seed: `INSERT INTO backfill_meta (status, total_stored, last_run_at) VALUES ('done', 42, 999)`,
      expectAdded: ["exhaust_reset_applied"],
    },
    {
      table: "events",
      label: "pre-v0.3.1, before ingested_at",
      create: `CREATE TABLE events (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, kind INTEGER NOT NULL, tags TEXT NOT NULL, content TEXT NOT NULL, sig TEXT NOT NULL, expiration INTEGER)`,
      seed: `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig) VALUES ('e1', 'p1', 100, 1, '[]', 'hi', 's1')`,
      expectAdded: ["ingested_at", "row_cost"],
    },
    {
      table: "events",
      label: "pre-v0.7.2, before row_cost",
      create: `CREATE TABLE events (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, created_at INTEGER NOT NULL, kind INTEGER NOT NULL, tags TEXT NOT NULL, content TEXT NOT NULL, sig TEXT NOT NULL, expiration INTEGER, ingested_at INTEGER)`,
      seed: `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, ingested_at) VALUES ('e1', 'p1', 100, 1, '[]', 'hi', 's1', 100)`,
      expectAdded: ["row_cost"],
    },
    {
      table: "backfill_relays",
      label: "pre-v0.3.2, before last_refusal",
      create: `CREATE TABLE backfill_relays (relay_url TEXT PRIMARY KEY, until_cursor INTEGER NOT NULL, exhausted INTEGER NOT NULL DEFAULT 0)`,
      seed: `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES ('wss://r', 500, 1)`,
      expectAdded: ["last_refusal"],
    },
  ];

  for (const { table, label, create, seed, expectAdded } of HISTORICAL) {
    it(`brings ${table} (${label}) up to the declaration without losing rows`, async () => {
      await withSql((sql) => {
        sql.exec(`DROP TABLE ${table}`);
        sql.exec(create);
        sql.exec(seed);
        const before = sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0] as { n: number };

        // The DO's real constructor already ran initSchema once for this
        // isolated database, storing today's fingerprint -- which would
        // make this second call a no-op match and skip the very
        // reconcile this test exists to exercise. A real relay in this
        // historical shape never wrote that fingerprint in the first
        // place, so simulate that honestly rather than relying on a
        // stale match to happen to skip nothing relevant.
        forgetSchemaHash(sql);
        initSchema(sql);

        const after = columnsOf(sql, table);
        for (const column of expectAdded) {
          expect(after).toContain(column);
        }
        // Every declared column, not just the ones this case names.
        const declared = TABLES.find((t) => t.name === table)!.columns.map((c) => c.name);
        expect(after.sort()).toEqual(declared.sort());
        // The row that was there is still there. A migration that
        // silently emptied a table would otherwise pass every column
        // assertion above.
        const stillThere = sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0] as { n: number };
        expect(stillThere.n).toBeGreaterThanOrEqual(before.n);
      });
    });
  }

  it("leaves the pre-bc36cbf owner row readable by the query that used to throw", async () => {
    // The actual production symptom, reproduced end to end: this exact
    // SELECT (ownership.ts refreshProfile) is what threw
    // `no such column: profile_synced_at` every hour.
    await withSql((sql) => {
      sql.exec(`DROP TABLE owner`);
      sql.exec(`CREATE TABLE owner (pubkey TEXT NOT NULL, name TEXT, picture TEXT)`);
      sql.exec(`INSERT INTO owner (pubkey, name) VALUES ('abc', 'Aaro')`);

      forgetSchemaHash(sql);
      initSchema(sql);

      const row = sql
        .exec(`SELECT name, picture, about, profile_synced_at, icon_refreshed_at FROM owner LIMIT 1`)
        .toArray()[0] as Record<string, unknown>;
      expect(row.name).toBe("Aaro");
      expect(row.profile_synced_at).toBeNull();
      expect(row.icon_refreshed_at).toBeNull();
    });
  });

  it("re-derives `about` once profile_synced_at already predates it (the owner.about production gap)", async () => {
    // owner.about was added to CREATE TABLE well after profile_synced_at
    // and icon_refreshed_at already existed on deployed relays, so it
    // landed NULL with profile_synced_at already non-null and no newer
    // kind-0 to trigger refreshProfile's re-parse. Reproduce exactly that:
    // an owner row with the pre-about columns already populated from a
    // real cron run, a locally-stored kind-0 whose created_at is not
    // newer than profile_synced_at, and about missing from the table.
    await withSql((sql) => {
      sql.exec(`DROP TABLE owner`);
      sql.exec(
        `CREATE TABLE owner (pubkey TEXT NOT NULL, name TEXT, picture TEXT, profile_synced_at INTEGER, icon_refreshed_at INTEGER)`,
      );
      sql.exec(
        `INSERT INTO owner (pubkey, name, picture, profile_synced_at, icon_refreshed_at) VALUES (?, 'Aaro', 'https://example.com/a.png', 1000, 1000)`,
        OWNER_PUBKEY_HEX,
      );
      sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig) VALUES ('e1', ?, 1000, 0, '[]', ?, 's1')`,
        OWNER_PUBKEY_HEX,
        JSON.stringify({ name: "Aaro", picture: "https://example.com/a.png", about: "Aaro's relay" }),
      );

      forgetSchemaHash(sql);
      initSchema(sql);
      // icon_refreshed_at gates refreshProfile's whole body to at most
      // once/day (ownership.ts), so `now` has to clear that window too --
      // not just be newer than the kind-0's created_at -- or the re-parse
      // this test exists to prove never runs at all.
      refreshProfile(sql, env as unknown as Env, 1000 + 86400 + 1);

      const row = sql.exec(`SELECT about FROM owner LIMIT 1`).toArray()[0] as { about: string | null };
      expect(row.about).toBe("Aaro's relay");
    });
  });

  it("creates every declared table and column on a fresh database", async () => {
    await withSql((sql) => {
      for (const spec of TABLES) {
        sql.exec(`DROP TABLE IF EXISTS ${spec.name}`);
      }
      forgetSchemaHash(sql);
      initSchema(sql);
      for (const spec of TABLES) {
        expect(columnsOf(sql, spec.name).sort()).toEqual(spec.columns.map((c) => c.name).sort());
      }
    });
  });

  it("does not clobber a pre-existing single-row table with its seed INSERT", async () => {
    // initSchema seeds backfill_meta and relay_meta when empty. On an
    // upgrade those rows already exist and carry real state, so the seed
    // must be a no-op -- overwriting them would silently reset an
    // in-progress backfill to 'pending' on every cold start.
    await withSql((sql) => {
      sql.exec(`DROP TABLE backfill_meta`);
      sql.exec(
        `CREATE TABLE backfill_meta (status TEXT NOT NULL DEFAULT 'pending', total_stored INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER)`,
      );
      sql.exec(`INSERT INTO backfill_meta (status, total_stored, last_run_at) VALUES ('done', 42, 999)`);

      forgetSchemaHash(sql);
      initSchema(sql);

      const row = sql
        .exec<{ status: string; total_stored: number; last_run_at: number; exhaust_reset_applied: number }>(
          `SELECT status, total_stored, last_run_at, exhaust_reset_applied FROM backfill_meta`,
        )
        .toArray();
      expect(row.length).toBe(1);
      expect(row[0]?.status).toBe("done");
      expect(row[0]?.total_stored).toBe(42);
      expect(row[0]?.last_run_at).toBe(999);
      // The newly added column takes its declared DEFAULT, which is what
      // leaves the one-time exhaustion reset still pending rather than
      // already-applied on a relay that never got to run it.
      expect(row[0]?.exhaust_reset_applied).toBe(0);
    });
  });

  it("is idempotent across repeated cold starts, hash match or not", async () => {
    await withSql((sql) => {
      initSchema(sql);
      // Same fingerprint as last time -- this call should hit the
      // short-circuit and do nothing.
      expect(() => initSchema(sql)).not.toThrow();
      // Forced back into the full reconcile pass, as a genuine schema
      // change would -- CREATE TABLE/INDEX IF NOT EXISTS and
      // reconcileColumns finding every column already present must be
      // just as harmless as the fast path above.
      forgetSchemaHash(sql);
      expect(() => initSchema(sql)).not.toThrow();
      for (const spec of TABLES) {
        expect(columnsOf(sql, spec.name).sort()).toEqual(spec.columns.map((c) => c.name).sort());
      }
    });
  });
});

// The schema-hash short-circuit that replaced reconciling the full
// declaration on every wake from hibernation (src/schema.ts initSchema).
// Measured live before this existed: 55 rows read per wake, ~94,000
// rows/day at the relay's wake rate, to do nothing on the overwhelming
// majority of wakes -- see CLAUDE.md "The budget". Two properties are
// load-bearing, per the header comment on initSchema, and each gets its
// own describe block below: the hash must be a structural function of the
// declaration (a hand-picked subset is a field that silently stops being
// migrated), and it must only be stored after a full reconcile succeeds (a
// migration that throws partway must not be mistaken for one that
// finished).
describe("computeSchemaHash", () => {
  const tables: readonly TableSpec[] = [
    {
      name: "t",
      columns: [
        { name: "id", definition: "TEXT PRIMARY KEY" },
        { name: "a", definition: "TEXT" },
      ],
    },
  ];
  const indexes: readonly IndexSpec[] = [{ name: "idx_t_a", table: "t", keyColumns: ["a"], orderedBy: "id" }];
  const baseline = computeSchemaHash(tables, indexes);

  it("is a pure function of the declaration -- the same declaration hashes the same", () => {
    expect(computeSchemaHash(tables, indexes)).toBe(baseline);
  });

  // Each case changes exactly one field reconcileColumns or createIndexSql
  // actually reads. A hash that missed one of these would be a field whose
  // change silently skips its own migration -- the owner.profile_synced_at
  // gap (see the header comment on TABLES) one layer up.
  const MUTATIONS: Array<{ label: string; tables: readonly TableSpec[]; indexes: readonly IndexSpec[] }> = [
    {
      label: "a column is added",
      tables: [{ name: "t", columns: [...tables[0]!.columns, { name: "b", definition: "INTEGER" }] }],
      indexes,
    },
    {
      label: "a column's definition changes",
      tables: [
        {
          name: "t",
          columns: [
            { name: "id", definition: "TEXT PRIMARY KEY" },
            { name: "a", definition: "INTEGER" },
          ],
        },
      ],
      indexes,
    },
    {
      label: "a column gains resetsOnAdd",
      tables: [
        {
          name: "t",
          columns: [
            { name: "id", definition: "TEXT PRIMARY KEY" },
            { name: "a", definition: "TEXT", resetsOnAdd: ["id"] },
          ],
        },
      ],
      indexes,
    },
    {
      label: "an index's key columns change",
      tables,
      indexes: [{ name: "idx_t_a", table: "t", keyColumns: ["id", "a"], orderedBy: "id" }],
    },
    {
      label: "an index's ordering column is removed",
      tables,
      indexes: [{ name: "idx_t_a", table: "t", keyColumns: ["a"] }],
    },
    {
      label: "an index gains a covering column",
      tables,
      indexes: [{ ...indexes[0]!, covering: ["a"] }],
    },
    {
      label: "an index is added",
      tables,
      indexes: [...indexes, { name: "idx_t_id", table: "t", keyColumns: [], orderedBy: "id" }],
    },
    {
      // A partial index and a full one over the same columns are
      // different indexes, and only one of them can serve a query that
      // names no partition -- so an unhashed `where` would be a migration
      // that silently never runs, on the field the whole group partition
      // depends on.
      label: "an index gains a partial predicate",
      tables,
      indexes: [{ ...indexes[0]!, where: "a = 0" }],
    },
    {
      label: "an index's partial predicate changes",
      tables,
      indexes: [{ ...indexes[0]!, where: "a = 1" }],
    },
  ];

  for (const { label, tables: mutatedTables, indexes: mutatedIndexes } of MUTATIONS) {
    it(`changes when ${label}`, () => {
      expect(computeSchemaHash(mutatedTables, mutatedIndexes)).not.toBe(baseline);
    });
  }

  it("the real declaration hashes deterministically", () => {
    expect(computeSchemaHash(TABLES, INDEXES)).toBe(computeSchemaHash(TABLES, INDEXES));
  });
});

// Sums SqlStorageCursor.rowsRead across every statement `fn` issues.
// Deliberately does NOT force-drain each cursor inline the way
// hibernation.test.ts's measureRowsWritten does for rowsWritten -- rowsRead
// only settles once a SELECT cursor is drained, and initSchema's own code
// (reconcileColumns, readStoredSchemaHash) already drains every cursor it
// opens before returning. Draining a second time here would hand callers a
// cursor that looks empty on ITS OWN drain, which is exactly the kind of
// interference that would make reconcileColumns think every column is
// missing. So this only collects the cursor references and sums
// `rowsRead` after `fn` returns, by which point real production code has
// already consumed each one.
function measureRowsRead(sql: SqlStorage, fn: (sql: SqlStorage) => void): number {
  const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
  const proxy = new Proxy(sql, {
    get(target, property) {
      if (property === "exec") {
        return (query: string, ...bindings: unknown[]) => {
          const cursor = target.exec(query, ...bindings);
          cursors.push(cursor);
          return cursor;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as SqlStorage;
  fn(proxy);
  return cursors.reduce((sum, c) => sum + c.rowsRead, 0);
}

// The before/after this whole file exists to prove -- see CLAUDE.md "The
// budget"'s `initSchema` row in the reads table.
// The group partition (src/groups.ts) is expressed entirely in the index
// declaration, so these assert the declaration itself and the migration
// that installs it. Both properties are load-bearing and neither is
// visible from the wire.
describe("partial index pairs", () => {
  it("declares every partial index as one half of a matched pair", () => {
    // schema.ts partialIndexPairsOn divides the partial count by two to
    // work out how much eventRowCost over-charges, and
    // test/hibernation.test.ts pins that arithmetic. A partial index with
    // no mirror would break the halving AND leave the other partition
    // unindexed for whatever the index serves -- so the pairing is
    // asserted rather than assumed.
    const partial = INDEXES.filter((i) => i.where !== undefined);
    expect(partial.length).toBeGreaterThan(0);
    const key = (i: IndexSpec) =>
      `${i.table}:${i.keyColumns.join(",")}:${i.orderedBy ?? ""}:${(i.covering ?? []).join(",")}`;
    const byShape = new Map<string, IndexSpec[]>();
    for (const index of partial) {
      byShape.set(key(index), [...(byShape.get(key(index)) ?? []), index]);
    }
    for (const [shape, halves] of byShape) {
      expect(halves.length, `${shape} is not a pair`).toBe(2);
      expect(new Set(halves.map((h) => h.where)).size, `${shape} has two identical predicates`).toBe(2);
      // Every row falls on exactly one side, which is what makes the pair
      // cost the same one row per stored event a single index did.
      expect(new Set(halves.map((h) => h.where))).toEqual(new Set(["is_group = 0", "is_group = 1"]));
    }
  });

  it("creates them as partial indexes, not as full ones with a longer name", async () => {
    await withSql((sql) => {
      const sqlText = sql
        .exec<{ name: string; sql: string | null }>(
          `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_kind_created_pub'`,
        )
        .toArray()[0]?.sql;
      expect(sqlText).toContain("WHERE is_group = 0");
    });
  });
});

describe("dropping indexes the declaration no longer carries", () => {
  it("removes an index left behind by an earlier schema", async () => {
    // CREATE INDEX IF NOT EXISTS will not redefine an index that already
    // exists under its name and reports no error either, so changing an
    // index's definition means changing its NAME -- which is how
    // idx_events_kind_created became idx_events_kind_created_pub/_grp. The
    // old name then has to go, or a deployed relay pays a row per stored
    // event forever to maintain an index nothing queries.
    await withSql((sql) => {
      sql.exec(`CREATE INDEX IF NOT EXISTS idx_events_kind_created ON events (kind, created_at DESC)`);
      const before = sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_kind_created'`,
        )
        .toArray()[0]?.n;
      expect(before).toBe(1);

      forgetSchemaHash(sql);
      initSchema(sql);

      const after = sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'idx_events_kind_created'`,
        )
        .toArray()[0]?.n;
      expect(after).toBe(0);
      // ...and every declared index is still there.
      const present = new Set(
        sql
          .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index'`)
          .toArray()
          .map((r) => r.name),
      );
      for (const index of INDEXES) expect(present.has(index.name), index.name).toBe(true);
    });
  });

  it("never touches SQLite's own implicit indexes", async () => {
    // sqlite_autoindex_* are the unique indexes behind TEXT PRIMARY KEY
    // columns. They are not ours to drop, they are half of what
    // EVENT_BASE_ROW_COST counts, and dropping one would take the id seek
    // -- the one lookup that needs no partition pin -- down with it.
    await withSql((sql) => {
      forgetSchemaHash(sql);
      initSchema(sql);
      const implicit = sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'sqlite_autoindex_%'`,
        )
        .toArray()[0]?.n;
      expect(implicit).toBeGreaterThan(0);
    });
  });
});

describe("initSchema's rows-read cost", () => {
  it("costs O(1) rows read on a wake where the schema hash already matches", async () => {
    await withSql((sql) => {
      initSchema(sql);
      const cost = measureRowsRead(sql, (proxied) => initSchema(proxied));
      // One row: the `schema_meta` lookup. Nothing else runs.
      expect(cost).toBe(1);
    });
  });

  it("costs the full reconcile pass only on the wake that actually needs it", async () => {
    await withSql((sql) => {
      forgetSchemaHash(sql);
      const cost = measureRowsRead(sql, (proxied) => initSchema(proxied));
      // Not a hardcoded figure -- that would be exactly the kind of
      // number this whole feature exists to stop hand-maintaining.
      // reconcileColumns' presence check reads one pragma_table_info row
      // per column TABLES already declares, so the full pass costs at
      // least the size of the declaration and grows automatically as
      // TABLES does. CLAUDE.md "The budget" cites the one number that
      // matters operationally -- 55 rows read/wake, measured live, before
      // this existed -- and this assertion only needs to show the full
      // pass is real work, dwarfing the O(1) steady-state cost above,
      // paid only on a schema change (or the very first wake after
      // upgrading to this).
      const declaredColumns = TABLES.reduce((n, t) => n + t.columns.length, 0);
      expect(cost).toBeGreaterThanOrEqual(declaredColumns);
    });
  });
});

describe("initSchema's schema-hash short-circuit", () => {
  it("skips the reconcile pass entirely on a wake with no schema change", async () => {
    await withSql((sql) => {
      initSchema(sql);
      const before = sql.exec<{ hash: string }>(`SELECT hash FROM schema_meta`).toArray();

      // Break a real table in a way the reconciler would normally fix --
      // if the second initSchema call below actually ran the reconcile
      // pass, this column would come back.
      sql.exec(`ALTER TABLE owner RENAME COLUMN about TO about_renamed`);
      initSchema(sql);

      const after = sql.exec<{ hash: string }>(`SELECT hash FROM schema_meta`).toArray();
      expect(after).toEqual(before);
      expect(columnsOf(sql, "owner")).not.toContain("about");
      expect(columnsOf(sql, "owner")).toContain("about_renamed");
    });
  });

  it("leaves the previously stored hash unmodified when a migration throws partway", async () => {
    await withSql((sql) => {
      // A known-good migration establishes a real hash first.
      initSchema(sql);

      // Simulate a genuine upgrade: the stored fingerprint is stale, which
      // is what makes initSchema attempt the reconcile pass below instead
      // of short-circuiting on a match.
      sql.exec(`UPDATE schema_meta SET hash = 'stale-hash-from-a-real-upgrade'`);

      // Corrupt deleted_ids so its declared PRIMARY KEY column looks
      // missing to the reconciler -- reconcileColumns cannot add a
      // PRIMARY KEY to an existing table (see whyNotAddable), so this
      // makes the full reconcile throw partway through, exactly as a
      // genuinely un-migratable schema change would.
      sql.exec(`DROP TABLE deleted_ids`);
      sql.exec(`CREATE TABLE deleted_ids (wrong_name TEXT PRIMARY KEY)`);

      expect(() => initSchema(sql)).toThrow(/cannot add deleted_ids\.id/);

      // The stale hash is still there -- not the new hash (the migration
      // never finished, so believing it succeeded would leave this table
      // broken forever) and not cleared either. The next wake retries with
      // the same stale hash and hits the same throw, loudly, every time,
      // until a human fixes the table -- which is the point: a schema
      // this reconciler cannot bring up to date must never be silently
      // accepted as current.
      const row = sql.exec<{ hash: string }>(`SELECT hash FROM schema_meta`).toArray();
      expect(row).toEqual([{ hash: "stale-hash-from-a-real-upgrade" }]);
    });
  });
});

// The one behaviour `row_cost` shares with `ingested_at`: rows written
// before the column existed carry NULL, and are simply absent from the
// SUM. Documented in schema.ts and asserted here because it is a real
// undercount with a real duration -- at most the one 24h window
// straddling an upgrade -- and because the alternative, backfilling the
// column from a guess, is exactly how this project got rows-written
// accounting wrong by 45x the first time.
describe("row_cost across the migration boundary", () => {
  it("omits pre-migration rows from the 24h estimate rather than inventing a cost for them", async () => {
    const stub = env.RELAY.get(env.RELAY.idFromName("relay"));
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      const now = Math.floor(Date.now() / 1000);

      // A row as an older deployment left it: ingested inside the window,
      // but with no row_cost, because the column did not exist when it
      // was written.
      sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at)
         VALUES ('legacy', 'p1', ?, 1, '[]', 'x', 's', NULL, ?)`,
        now,
        now,
      );
      expect(estimateRowsWrittenSince(sql, now - 86400)).toBe(0);

      // A row written by the current code counts in full, so the estimate
      // becomes exact again as the legacy rows age out of the window.
      sql.exec(
        `INSERT INTO events (id, pubkey, created_at, kind, tags, content, sig, expiration, ingested_at, row_cost)
         VALUES ('current', 'p1', ?, 1, '[]', 'x', 's', NULL, ?, ?)`,
        now,
        now,
        eventRowCost(0),
      );
      expect(estimateRowsWrittenSince(sql, now - 86400)).toBe(eventRowCost(0));
    });
  });
});
