// ---------------------------------------------------------------------
// DIAGNOSTIC, memory only, like read-metrics.ts and for the same reasons:
// a counter that cost a row write would spend the budget it is helping to
// explain, and these are for proportions rather than daily totals.
//
// The question it answers: why does a client reconnect every ~13 seconds?
// On 2026-10-09 one did, re-sending ~4 REQs per connection, and that was
// 99.4% of the relay's rows read. req-cache.ts makes the repeats cheap;
// this says whether the relay is what is sending the client away. If REQs
// are refused (a client asking for kind 1059 without AUTH, say, then
// reconnecting to try again), the fix is that interaction rather than a
// cache. If connections end with 1000 after a few REQs and no refusals,
// the client is polling, and the cache is the whole answer.
//
// Published on /api/stats, which is public, so it holds counts only:
// refusal reasons are the relay's own constant strings with numbers
// masked, and nothing here names an IP, a pubkey, or a filter.
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

// `channel` separates the admin page's /live feed, which the server
// itself closes every ten minutes, from nostr protocol connections.
// `connectedAt`/`reqs` are undefined for a connection accepted before
// this was deployed, and for a live feed socket's REQ count.
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
