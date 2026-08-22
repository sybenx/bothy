# Roadmap

Work proceeds **one chunk at a time, in order**. Do not start a chunk until the previous one meets its definition of done. Update `CURRENT` below when a chunk completes.

CURRENT: 4

---

## 1. Skeleton and schema

Establish the deployment shape and the storage design. No protocol logic.

- `package.json`, `tsconfig.json`, `wrangler.jsonc`, folder layout
- Worker: routing, `Upgrade` handling, NIP-11 document on `Accept: application/nostr+json`
- One Durable Object, SQLite backend, addressed by `idFromName("relay")`
- WebSocket hibernation wired correctly — `state.acceptWebSocket()`, `webSocketMessage()`, `webSocketClose()`, `setWebSocketAutoResponse()`
- SQLite schema and indexes

**Schema is the irreversible decision in this repo.** Every later chunk inherits it, and index count directly multiplies per-event rows-written against a 100k/day ceiling. Write the per-event write cost out as a comment above the schema and justify each index. Do not add an index speculatively.

**Done when:** `npm run deploy` succeeds, the relay accepts and holds a WebSocket connection, NIP-11 returns valid JSON, and a hibernation test confirms the object becomes eligible to hibernate after the last message.

## 2. Conformance tests, all red

Write the test suite **from the NIP specifications**, not from any implementation. This suite is the spec for chunk 3 and the only mechanism that makes it verifiable.

Cover: EVENT/REQ/CLOSE/EOSE flow; filter AND-within / OR-across semantics; `ids`, `authors`, `kinds`, `#<tag>`, `since`, `until`, `limit`; `limit` interaction with ordering and EOSE; regular vs. replaceable (0, 3, 10000–19999) vs. addressable (30000–39999) kinds; NIP-09 deletion; NIP-40 expiration; NIP-42 AUTH; signature rejection; non-owner write rejection with the correct machine-readable prefix.

**Done when:** the suite runs, every test fails for the right reason, and no test asserts behaviour not traceable to a NIP.

## 3. NIP-01 core

Implement until chunk 2 is green.

Signature verification via `@noble/curves`. Measure CPU per verification and record it — if it approaches the 10 ms Worker limit that is a release blocker, not a footnote.

**Done when:** chunk 2 passes in full, and CPU-per-verification and rows-written-per-event are recorded in `docs/baselines.json`.

## 4. Ownership, admin, deploy

- TOFU claim endpoint per the Ownership section of CLAUDE.md
- `OWNER_PUBKEY` env override that disables the claim endpoint
- `ALLOW_FOLLOWS` with a cron-refreshed, cached follow set
- Read-abuse limits: subscription caps, `limit` caps, rejection of unconstrained filters, per-IP throttling
- Static admin page with copyable `wss://` URL, counts, and position against daily limits
- `/api/stats`
- Deploy to Cloudflare button, README, reset instructions

**Done when:** a deploy from a clean Cloudflare account reaches a working `wss://` URL and a successful claim without touching the Cloudflare dashboard.

---

## After chunk 4

Feature requests go through `DECISIONS.md` first. Check the "What this is not" section of CLAUDE.md before implementing anything new — most requests that arrive will be things that list already rules out.
