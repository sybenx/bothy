// Regression test for the v0.2.0 backfill_meta migration (schema.ts
// initSchema). Every other test in this suite starts from a brand-new DO,
// where the constructor's own initSchema call creates backfill_meta via
// CREATE TABLE IF NOT EXISTS with exhaust_reset_applied already present --
// the ALTER TABLE branch, and the pragma_table_info probe that guards it,
// have never once executed under test. That is exactly the path a
// pre-v0.2.0 deployment's storage takes on its next cold start (a second
// initSchema call against a database that already has an old-shape
// backfill_meta), and exactly the path this test reproduces.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resetWronglyExhaustedRelays } from "../src/backfill";
import { initSchema } from "../src/schema";
import { isolateStorage } from "./helpers/isolate";

isolateStorage();

describe("initSchema migration from a pre-v0.2.0 database", () => {
  it("adds exhaust_reset_applied via ALTER TABLE, and resetWronglyExhaustedRelays clears every flag without touching cursors", async () => {
    const id = env.RELAY.idFromName("relay");
    const stub = env.RELAY.get(id);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;

      // Roll storage back to the pre-v0.2.0 shape: backfill_meta with only
      // the old column set (status, total_stored, last_run_at), one row,
      // status 'done' -- as the short-page exhaustion bug would have left
      // it once every relay was wrongly flagged exhausted.
      sql.exec(`DROP TABLE backfill_meta`);
      sql.exec(`
        CREATE TABLE backfill_meta (
          status       TEXT NOT NULL DEFAULT 'pending',
          total_stored INTEGER NOT NULL DEFAULT 0,
          last_run_at  INTEGER
        )
      `);
      sql.exec(`INSERT INTO backfill_meta (status, total_stored, last_run_at) VALUES ('done', 42, 999)`);

      // Several relays wrongly flagged exhausted, one genuinely still
      // running with a real cursor -- backfill_relays' shape is unchanged
      // across the migration, so this just seeds realistic pre-fix damage.
      sql.exec(`DELETE FROM backfill_relays`);
      sql.exec(
        `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES (?, ?, 1)`,
        "wss://relay-a",
        1000,
      );
      sql.exec(
        `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES (?, ?, 1)`,
        "wss://relay-b",
        2000,
      );
      sql.exec(
        `INSERT INTO backfill_relays (relay_url, until_cursor, exhausted) VALUES (?, ?, 0)`,
        "wss://relay-c",
        3000,
      );

      // This is the call that, in production, only ever runs against a
      // real pre-existing database -- every other test's DO starts empty,
      // so this is the first time the ALTER TABLE branch (and the
      // pragma_table_info probe guarding it) executes in workerd at all.
      // If pragma_table_info is unavailable here, this throws, and that
      // IS the production bug.
      expect(() => initSchema(sql)).not.toThrow();

      const hasColumn =
        sql
          .exec(`SELECT 1 FROM pragma_table_info('backfill_meta') WHERE name = 'exhaust_reset_applied'`)
          .toArray().length > 0;
      expect(hasColumn).toBe(true);

      const row = sql
        .exec<{ exhaust_reset_applied: number; status: string }>(
          `SELECT exhaust_reset_applied, status FROM backfill_meta`,
        )
        .toArray()[0];
      expect(row?.exhaust_reset_applied).toBe(0);
      // initSchema's seed-if-missing INSERT must not have touched the
      // pre-existing row.
      expect(row?.status).toBe("done");

      resetWronglyExhaustedRelays(sql);

      const relays = sql
        .exec<{ relay_url: string; exhausted: number; until_cursor: number }>(
          `SELECT relay_url, exhausted, until_cursor FROM backfill_relays ORDER BY relay_url`,
        )
        .toArray();
      expect(relays.every((r) => r.exhausted === 0)).toBe(true);
      expect(relays.find((r) => r.relay_url === "wss://relay-a")?.until_cursor).toBe(1000);
      expect(relays.find((r) => r.relay_url === "wss://relay-b")?.until_cursor).toBe(2000);
      expect(relays.find((r) => r.relay_url === "wss://relay-c")?.until_cursor).toBe(3000);

      const meta = sql
        .exec<{ status: string; exhaust_reset_applied: number }>(
          `SELECT status, exhaust_reset_applied FROM backfill_meta`,
        )
        .toArray()[0];
      expect(meta?.status).toBe("running");
      expect(meta?.exhaust_reset_applied).toBe(1);
    });
  });
});
