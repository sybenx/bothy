// Logs which Cloudflare free-tier allowance ran out, from the Worker
// (index.ts wraps fetch and scheduled). When an allowance is consumed
// every Durable Object path fails, while the static admin page (served
// from env.ASSETS, never touching the DO) still loads, just empty; without
// this, nothing in the logs names the cause.
//
// The allowances are per Cloudflare account, not per Worker: another
// Worker in the same account can consume them.
//
// The matching is substring signatures against Cloudflare's error text,
// which is not a documented or stable code. So it fails useful: the raw
// message is always logged, and the resource name is added only when a
// signature matches. A stale signature costs the label, never the line.

export type ExhaustedResource = "rows read" | "rows written" | "storage" | "requests" | "unknown";

interface Signature {
  resource: ExhaustedResource;
  pattern: RegExp;
}

// Ordered most specific first: a message naming both "rows read" and
// "limit" should be reported as rows read, not as the generic case.
const SIGNATURES: readonly Signature[] = [
  { resource: "rows read", pattern: /rows?\s+read/i },
  { resource: "rows written", pattern: /rows?\s+written/i },
  { resource: "storage", pattern: /storage\s+(limit|quota)|exceeded.*storage/i },
  { resource: "requests", pattern: /request\s+(limit|quota)|too\s+many\s+requests/i },
];

// Anything that looks like a quota refusal rather than an ordinary bug.
// Deliberately broad: a false positive costs one mislabelled log line, a
// false negative costs another silent outage.
const EXHAUSTION = /exceed(ed|s)?|quota|daily\s+limit|free\s+tier|limit\s+reached|out\s+of\s+(storage|quota)/i;

export interface ExhaustionVerdict {
  // Whether this error looks like a Cloudflare allowance being consumed
  // rather than a fault in this code.
  exhausted: boolean;
  // Which allowance, when a signature matched. "unknown" means it looks
  // like exhaustion but matched no signature, a sign they may be stale.
  resource: ExhaustedResource;
  message: string;
}

export function classifyExhaustion(err: unknown): ExhaustionVerdict {
  const message = err instanceof Error ? err.message : String(err);
  if (!EXHAUSTION.test(message)) {
    return { exhausted: false, resource: "unknown", message };
  }
  for (const signature of SIGNATURES) {
    if (signature.pattern.test(message)) {
      return { exhausted: true, resource: signature.resource, message };
    }
  }
  return { exhausted: true, resource: "unknown", message };
}

// `where` names the Worker entry point that failed, so a dead cron tick
// is distinguishable from a dead client request. console.error because
// the relay is down while any check that only fetches the static page
// still passes.
export function logExhaustion(where: string, err: unknown): ExhaustionVerdict {
  const verdict = classifyExhaustion(err);
  if (verdict.exhausted) {
    console.error(
      `BUDGET EXHAUSTED (${verdict.resource}) at ${where}: ${verdict.message} -- ` +
        `Cloudflare free-tier allowances reset at 00:00 UTC. ` +
        `/api/stats reports the rows-read breakdown by code path.`,
    );
  } else {
    console.error(`${where} failed:`, verdict.message, err instanceof Error ? err.stack : "");
  }
  return verdict;
}
