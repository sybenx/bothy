// A member's own keys (nip86.ts addmykey): another key of the same person,
// such as the per-app child a Keykin account makes, let into the home as
// theirs. Both keys sign: the member signs the NIP-98 call, and the child
// signs a proof naming the member and this home. The proof is checked
// here, in the Worker (index.ts), and never stored or published.
//
// The proof: kind 21236 (ephemeral range, so a relay that sees it by
// mistake keeps nothing), tags ["p", <member hex>] and
// ["relay", "https://<this home>/"], empty content, created_at within
// limits.ts OWN_KEY_PROOF_MAX_AGE_SECONDS of now.
import { normalizeHost } from "./host";
import { OWN_KEY_PROOF_MAX_AGE_SECONDS } from "./limits";
import { normalizePubkey } from "./pubkey";
import { idMatchesContent, parseEventShape, verifySignature } from "./validate";

export const OWN_KEY_PROOF_KIND = 21236;

// A refusal message, or null when the proof holds. `host` is the host the
// call was made to.
export function checkOwnKeyProof(
  params: unknown[],
  member: string,
  host: string,
  nowSec: number,
): string | null {
  const child = typeof params[0] === "string" ? normalizePubkey(params[0]) : null;
  if (child === null) return "addmykey: it takes [your other key, as npub or hex, and its proof event]";
  const proof = parseEventShape(params[1]);
  if (proof === null) return "addmykey: the proof must be an event signed by that key";
  if (proof.kind !== OWN_KEY_PROOF_KIND) return `addmykey: the proof must be kind ${OWN_KEY_PROOF_KIND}`;
  if (proof.pubkey !== child) return "addmykey: the proof must be signed by that key";
  if (Math.abs(proof.created_at - nowSec) > OWN_KEY_PROOF_MAX_AGE_SECONDS) {
    return `addmykey: the proof must be made within ${OWN_KEY_PROOF_MAX_AGE_SECONDS} seconds`;
  }
  const tags = (name: string) => proof.tags.filter((t) => t[0] === name).map((t) => t[1]);
  const p = tags("p");
  if (p.length !== 1 || p[0] !== member) return "addmykey: the proof's p tag must be your own key";
  const relays = tags("relay");
  const relayOk =
    relays.length === 1 &&
    typeof relays[0] === "string" &&
    /^(https|wss):\/\//i.test(relays[0]) &&
    normalizeHost(relays[0]) === normalizeHost(host);
  if (!relayOk) return "addmykey: the proof's relay tag must be this home";
  // Signature last: it is the expensive check.
  if (!idMatchesContent(proof) || !verifySignature(proof)) {
    return "addmykey: the proof's signature is invalid";
  }
  return null;
}
