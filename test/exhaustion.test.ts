// Budget exhaustion has to be visible in the logs (src/exhaustion.ts).
//
// When the live relay consumed its 5,000,000 rows-read/day allowance,
// every Durable Object path failed at once while the static admin page --
// served from env.ASSETS, which never touches the DO -- kept returning
// 200. The only symptom was a page that loaded the word "bothy" and no
// numbers, and nothing anywhere named a resource or a ceiling.
//
// These assert the classifier's two jobs, which are deliberately
// asymmetric: name the resource when it can, and NEVER swallow an
// ordinary bug into a quiet 503 when it cannot.
import { describe, expect, it } from "vitest";
import { classifyExhaustion } from "../src/exhaustion";

describe("classifyExhaustion", () => {
  it("names the resource for each allowance it knows about", () => {
    const cases: [string, string][] = [
      ["Durable Object storage: exceeded daily limit of rows read", "rows read"],
      ["exceeded the free tier daily limit for rows written", "rows written"],
      ["Cannot allocate storage: storage limit exceeded for this account", "storage"],
      ["Daily request limit exceeded for this Durable Object", "requests"],
    ];
    for (const [message, resource] of cases) {
      const verdict = classifyExhaustion(new Error(message));
      expect(verdict.exhausted).toBe(true);
      expect(verdict.resource).toBe(resource);
    }
  });

  it("still reports exhaustion when the wording names no resource it recognises", () => {
    // The signatures are substring matches against error text Cloudflare
    // does not document as stable, and the wording has changed before. A
    // stale signature must cost the label, not the finding -- otherwise
    // this module reproduces the silence it exists to end.
    const verdict = classifyExhaustion(new Error("account exceeded its free tier quota"));
    expect(verdict.exhausted).toBe(true);
    expect(verdict.resource).toBe("unknown");
  });

  it("does not classify an ordinary bug as exhaustion", () => {
    // The consequence of a false positive here is worse than a missed
    // label: src/index.ts turns an exhaustion verdict into a 503 and
    // rethrows everything else, so a greedy matcher would convert real
    // errors into "out of budget, try tomorrow" and hide them.
    for (const message of [
      "no such column: profile_synced_at",
      "Cannot read properties of undefined (reading 'pubkey')",
      "D1_ERROR: near \"SELCT\": syntax error",
    ]) {
      const verdict = classifyExhaustion(new Error(message));
      expect(verdict.exhausted).toBe(false);
    }
  });

  it("handles a thrown non-Error without losing the message", () => {
    expect(classifyExhaustion("daily limit exceeded").exhausted).toBe(true);
    expect(classifyExhaustion("daily limit exceeded").message).toBe("daily limit exceeded");
  });
});
