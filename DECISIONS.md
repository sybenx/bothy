# Decisions

Settled calls and why. **Closed decisions are not reopened without the maintainer explicitly saying so in the current session.** If a change would contradict one of these, stop and say which decision it contradicts rather than implementing it.

Add an entry whenever a non-obvious tradeoff is resolved. Record the rejected option and the reason it lost — a decision without its alternatives is just an assertion, and the next session will re-derive the alternatives from scratch.

---

**Original implementation, not a fork of Nosflare.** *Closed.*
Nosflare targets a paid, multi-tenant, horizontally-scaled deployment. Stripping D1, read replication, the multi-region DO mesh, pay-to-relay, and NIP-05 hosting is more work than writing a single-DO relay, and would leave inherited assumptions that fight the free tier. Nosflare remains prior art and is credited in the README, not in LICENSE. Rejected: forking, which would have meant ongoing attribution obligations for code we would have deleted anyway.

**MIT license.** *Closed.*
Copyleft's usual motivation — preventing closed hosted services — fires on exactly the intended use case here, since every deployment is someone running their own relay. AGPL would penalize the target user. Matches haven, khatru, and the NIPs themselves. Rejected: AGPL, GPL.

**Trust on first use for ownership. No signature required.** *Closed.*
A wrong claim is not an attack: every event is signature-verified regardless of owner, so a wrong `OWNER_PUBKEY` cannot enable forgery — the worst outcome is archiving a stranger's public notes. Recovery is free because Cloudflare deployments are disposable. Rejected: env-var-only ownership, which pushed the one hard step into Cloudflare's developer-facing config UI; and signature-gated claims, which reintroduce a signer at precisely the moment we are trying to avoid one, for no security gain.

**Reads are public; writes are owner-only.** *Closed.*
Serving other people's clients is what makes this useful as an outbox relay. This means read abuse, not hijacking, is the real threat, and it is mitigated by subscription and filter caps rather than by authentication.

**Single Durable Object, no sharding.** *Closed.*
One user is not a scale problem. Sharding adds cost and complexity against a workload that will never need it. Rejected: multi-region mesh.

**Free tier is a hard constraint, enforced by tests.** *Closed.*
"Free" is the entire product claim, so it needs a failing build behind it rather than good intentions. Rejected: treating limits as guidance.

**No key generation in the deploy flow.** *Closed.*
Generating or storing a nostr private key requires encrypted-key-behind-social-login machinery and carries a far worse failure mode than anything else in this project. Users without a key are directed to a client. Rejected: Wisp-style onboarding, which is a different product.
