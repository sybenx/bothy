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

**Test-only OWNER_PUBKEY is injected via vitest's `miniflare.bindings`, not wrangler.jsonc.** *Closed.*
The conformance suite (chunk 2) needs a deterministic owner pubkey to test the write gate without depending on chunk 4's unbuilt TOFU claim endpoint. `@cloudflare/vitest-plugin` supports pointing at a named wrangler environment (`wrangler.jsonc`'s `env.<name>`) for this, but Cloudflare's own docs confirm `vars` and bindings are non-inheritable per named environment -- using one would mean duplicating `durable_objects`, `migrations`, and all `vars` under `env.test`, with an ongoing risk of drift between the two copies. Setting `OWNER_PUBKEY` directly in wrangler.jsonc's top-level `vars` was also rejected, since that would disable TOFU-by-default for real deployments too. Instead `vitest.config.ts` passes `miniflare: { bindings: { OWNER_PUBKEY } }`, which vitest merges on top of the parsed wrangler config for tests only, matching the fixture pubkey in `test/helpers/keys.ts`. Rejected: named wrangler environment (duplication/drift risk), top-level wrangler.jsonc var (breaks TOFU default).

**No key generation in the deploy flow.** *Closed.*
Generating or storing a nostr private key requires encrypted-key-behind-social-login machinery and carries a far worse failure mode than anything else in this project. Users without a key are directed to a client. Rejected: Wisp-style onboarding, which is a different product.

**ALLOW_FOLLOWS re-derives the follow list from the owner's own stored kind-3, not a fresh fetch from other relays.** *Closed.*
CLAUDE.md's "Configuration" section describes ALLOW_FOLLOWS as accepting writes from "the owner's kind-3 follow list" without specifying its source. Fetching it fresh from other relays would mean the DO opening an outbound WebSocket, which CLAUDE.md's budget section flags as pinning the object in memory for up to 15 minutes per connection — a real cost for a feature that's off by default and, when on, only needs to refresh hourly. Since this relay is necessarily in the owner's own relay list (that's how they claimed it), their client will already have replicated their contact list here, so reading the most recent locally-stored kind-3 event gets the same data without the outbound connection. Tradeoff: the follow list is only as fresh as the owner's last kind-3 publish *to this relay specifically*, not their global follow state. Rejected: fetching from well-known relays on the same cadence as the claim-time profile lookup, which would reintroduce the outbound-connection cost on a recurring cron schedule rather than a one-time claim action.

**Claim-time profile lookup runs from the Worker, not the Durable Object.** *Closed.*
CLAUDE.md's "Claim implementation" asks for a best-effort kind-0 lookup to show a name/avatar before confirming a claim. Doing this from inside the Relay DO would mean the DO holding an outbound WebSocket open while waiting on a remote relay's response — exactly the pattern CLAUDE.md's budget section warns can silently convert an idle relay into a billed one. The stateless Worker has no such cost: it fetches, resolves or times out, and returns, with nothing left running. The claim write itself still goes through the DO via RPC, unaffected by whether the lookup succeeded. Rejected: doing the lookup DO-side for architectural symmetry with the rest of the relay's storage-touching logic.

**`/api/claim`, `/api/stats`, and the cron entry point are Durable Object RPC methods, not additional `fetch()` routes on the DO.** *Closed.*
The DO's `fetch()` already has one job (WebSocket upgrade) and a `426` reject-path test can stay simple. Adding a second HTTP-parsing surface inside the DO for claim/stats/cron would duplicate routing logic the Worker (`src/index.ts`) already owns, and RPC methods on a `DurableObject` subclass are callable directly from a stub (`stub.claim(...)`) without constructing a `Request`. Rejected: routing everything through DO `fetch()` with internal path matching, which is how the WebSocket path already works but adds nothing for these three call sites beyond what fetch already does for the one case that needs it (the protocol upgrade).

**`/api/stats`' rows-written estimate is computed by re-querying existing rows, not tracked with a running counter.** *Closed.*
A counter incremented on every stored event would itself cost a row write per event, which directly fights the thing the stats endpoint exists to make visible. Since the write-cost formula (`3 + 2 * tag_count`, schema.ts) is already known and fixed, `/api/stats` instead re-derives it with a read-only query over events from the last 24h. Rejected: a `usage` counter table, which would add write cost to measure write cost.
