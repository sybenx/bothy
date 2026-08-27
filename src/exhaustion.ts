// Naming the resource that ran out, in the Worker, at the moment it runs
// out.
//
// When the live relay exhausted its 5,000,000 rows-read/day allowance,
// every Durable Object path started failing and the only symptom anyone
// could see was an admin page that loaded the word "bothy" and no
// numbers. The static assets are served straight from `env.ASSETS` and
// never touch the Durable Object, so the one part of the deployment that
// still worked was the part that proves nothing. Nothing was logged that
// named a resource, a ceiling, or even a failure -- the DO simply threw,
// the Worker's fault isolation absorbed it, and the page rendered empty.
//
// This module exists so that the next time it happens there is a log line
// saying which allowance was consumed.
//
// A note on the matching below, because it is the part most likely to be
// wrong: these are substring signatures against Cloudflare's error text,
// not a documented, stable error code. Cloudflare does not expose one for
// free-tier exhaustion, and the wording has changed before. So the
// classifier is built to fail useful rather than fail silent -- the raw
// message is logged in full ALWAYS, and the resource name is added only
// when a signature matches. A signature that has gone stale costs the
// label, never the log line, which is the opposite of how the original
// outage went.

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
  // like exhaustion but named nothing recognisable -- worth logging
  // loudly precisely because the signatures above may have gone stale.
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

// The log line the last outage should have produced. `where` is the
// Worker entry point that failed, so a reader can tell a dead cron tick
// from a dead client request without correlating timestamps.
//
// console.error, not console.log: this is the one condition under which
// the relay is down while every health check that only fetches the static
// page still passes.
export function logExhaustion(where: string, err: unknown): ExhaustionVerdict {
  const verdict = classifyExhaustion(err);
  if (verdict.exhausted) {
    console.error(
      `BUDGET EXHAUSTED (${verdict.resource}) at ${where}: ${verdict.message} -- ` +
        `Cloudflare free-tier allowances reset at 00:00 UTC. ` +
        `See CLAUDE.md "The budget"; /api/stats reports the rows-read breakdown by code path.`,
    );
  } else {
    console.error(`${where} failed:`, verdict.message, err instanceof Error ? err.stack : "");
  }
  return verdict;
}
