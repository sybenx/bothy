// Optional pruning window (CLAUDE.md "Configuration": RETENTION_DAYS,
// "Optional pruning window. Off by default."). Runs from the same cron
// trigger as the ALLOW_FOLLOWS refresh (index.ts scheduled()) rather than
// its own -- Workers Free caps an account at 5 cron triggers total.
export function pruneExpiredRetention(sql: SqlStorage, env: Env, nowSec: number): void {
  const days = Number(env.RETENTION_DAYS);
  if (!Number.isFinite(days) || days <= 0) return;

  const cutoff = nowSec - days * 86400;
  const stale = sql
    .exec<{ id: string }>(`SELECT id FROM events WHERE created_at < ?`, cutoff)
    .toArray();
  for (const row of stale) {
    sql.exec(`DELETE FROM event_tags WHERE event_id = ?`, row.id);
    sql.exec(`DELETE FROM events WHERE id = ?`, row.id);
  }
}
