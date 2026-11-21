// ---------------------------------------------------------------------
// DIAGNOSTIC, memory only, like read-metrics.ts and for the same reasons
// (a stored counter would spend the budget it explains; proportions, not
// daily totals).
//
// Answers whether the relay is what sends a rapidly reconnecting client
// away (see req-cache.ts). Refused REQs (say, kind 1059 without AUTH)
// followed by reconnects point at that interaction; clean 1000 closes
// after a few REQs with no refusals mean the client is polling.
//
// Published on /api/stats, which is public, so counts only: refusal
// reasons are the relay's own constant strings with digits masked, and
// nothing names an IP, a pubkey or a filter.
// ---------------------------------------------------------------------

const refusals = new Map<string, number>();
const closeCodes = new Map<string, number>();
const lifetimes = new Map<string, number>();
const reqsPerConnection = new Map<string, number>();

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

// A CLOSED reason, reduced to its category: the relay's reasons are
// constants apart from the numbers some of them quote, so masking digits
// and cutting at the advice that follows " -- " or ";" leaves a short,
// finite set of keys.
export function noteRefusal(reason: string): void {
  const category = reason.replace(/\d+/g, "N").split(/ -- |;/)[0]!.slice(0, 80);
  bump(refusals, category);
}

// `channel` separates the admin page's /live feed, which the server closes
// after LIVE_FEED_MAX_LIFETIME_MS, from nostr connections.
// `connectedAt`/`reqs` are undefined for a live feed socket and for a
// hibernated socket whose attachment predates those fields.
export function noteClose(
  channel: "nostr" | "live",
  code: number,
  connectedAt: number | undefined,
  reqs: number | undefined,
): void {
  bump(closeCodes, `${channel}:${code}`);
  if (channel !== "nostr") return;
  bump(lifetimes, connectedAt === undefined ? "unknown" : lifetimeBucket(Date.now() - connectedAt));
  bump(reqsPerConnection, reqs === undefined ? "unknown" : reqsBucket(reqs));
}

function lifetimeBucket(ms: number): string {
  if (ms < 15_000) return "<15s";
  if (ms < 60_000) return "<60s";
  if (ms < 600_000) return "<10m";
  return ">=10m";
}

function reqsBucket(reqs: number): string {
  if (reqs === 0) return "0";
  if (reqs <= 4) return "1-4";
  if (reqs <= 20) return "5-20";
  return ">20";
}

export interface ConnMetricsSnapshot {
  refusals: Record<string, number>;
  closeCodes: Record<string, number>;
  lifetimes: Record<string, number>;
  reqsPerConnection: Record<string, number>;
}

export function connMetricsSnapshot(): ConnMetricsSnapshot {
  return {
    refusals: Object.fromEntries(refusals),
    closeCodes: Object.fromEntries(closeCodes),
    lifetimes: Object.fromEntries(lifetimes),
    reqsPerConnection: Object.fromEntries(reqsPerConnection),
  };
}
