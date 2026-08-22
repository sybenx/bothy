// The deployment's own host -- e.g. "my-notes.example.workers.dev" or a
// custom domain -- recorded opportunistically from whichever inbound
// request reaches the DO first (Relay.fetch, claim, NIP-11/getProfile,
// getStats all pass their request's host through). There is no way to
// know this at deploy time: the Worker's own name is whatever the
// deployer typed into the Cloudflare deploy button, and a custom domain
// can be attached later, so this is learned from traffic rather than
// guessed from a project name.
//
// Backfill (backfill.ts seedBackfillRelays) is the reason this exists:
// the owner's own kind-10002 write-relay list legitimately lists this
// relay among their write relays, and without filtering it out,
// /api/stats' nextRelay ends up pointing at the relay's own URL forever.

// Extracts a bare, lowercased host (with port, if any) from either a
// full relay URL ("wss://relay.example.com/") or a bare host
// ("relay.example.com") -- both shapes flow through here: relay URLs
// come from a kind-10002 tag, the deployment's own host comes from a
// Request's `.host`. Scheme and trailing slash are both irrelevant once
// reduced to `.host`, which the WHATWG URL parser already lowercases.
// Returns null for a value that isn't parseable as a URL at all (a
// malformed relay-list tag, say) rather than throwing.
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

// Idempotent: only writes when the normalized host actually changes, so
// calling this on every request that touches the DO (as callers do)
// doesn't cost a row write per request once the host is known.
export function recordHost(sql: SqlStorage, host: string): void {
  const normalized = normalizeHost(host);
  if (normalized === null) return;
  sql.exec(`UPDATE relay_meta SET host = ? WHERE host IS NULL OR host <> ?`, normalized, normalized);
}
