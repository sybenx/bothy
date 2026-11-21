// The deployment's own host (a workers.dev name or a custom domain),
// learned from inbound requests that reach the DO (Relay.fetch, the claim
// calls, getIdentity, getStats). It cannot be known at deploy time: the
// Worker is named by whoever deployed it, and a domain can be attached
// later. Backfill uses it to drop this relay from the owner's write-relay
// list (backfill.ts seedBackfillRelays/purgeSelfRelay).

// Reduces a relay URL ("wss://relay.example.com/", from a kind-10002 tag)
// or a bare host (a Request's `.host`) to a lowercased host with any
// port. Null rather than a throw for an unparseable value.
export function normalizeHost(value: string): string | null {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  try {
    return new URL(candidate).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export function getOwnHost(sql: SqlStorage): string | null {
  const row = sql.exec<{ host: string | null }>(`SELECT host FROM relay_meta LIMIT 1`).toArray()[0];
  return row?.host ?? null;
}

// Writes only when the host changes, so calling it on every request
// costs no row write once the host is known.
export function recordHost(sql: SqlStorage, host: string): void {
  const normalized = normalizeHost(host);
  if (normalized === null) return;
  sql.exec(`UPDATE relay_meta SET host = ? WHERE host IS NULL OR host <> ?`, normalized, normalized);
}
