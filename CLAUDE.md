# bothy

A single-user nostr relay that deploys in one click and runs on the Cloudflare Workers free tier. Paste an npub, get a `wss://` URL, done — no terminal, no VPS, no domain.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: NIP-86 on `Content-Type: application/nostr+json+rpc` (checked first — that string contains `application/nostr+json`, so checking NIP-11 first would swallow it), NIP-11 on `Accept: application/nostr+json`, WebSocket upgrades to the Durable Object, `/api/claim`, `/api/stats`, `/api/profile`, everything else to the static `public/` admin page.
- Exactly one Durable Object (`Relay`, [src/relay.ts](src/relay.ts)), addressed by `idFromName("relay")`. SQLite-backed. All protocol state, storage, and subscriptions live here.
- WebSocket Hibernation API throughout (`acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`alarm`), `setWebSocketAutoResponse` for ping/pong. The Durable Object must never open an outbound connection — doing so breaks hibernation. The Worker owns every outbound connection (claim-time profile lookup, backfill fetches) on the DO's behalf.
- TOFU ownership: unclaimed until `POST /api/claim` binds a pubkey, permanently, with no signature required (`OWNER_PUBKEY` env var skips this and disables the endpoint). Every event is still signature-verified regardless of owner.
- Writes are owner-gated, with two exceptions: `ALLOW_FOLLOWS` (opt-out, on unless set to `"false"`) also accepts the owner's kind-3 follow list (cached from the owner's own stored contact list, refreshed immediately when the owner publishes a new one to this relay, with hourly cron as the fallback for when it arrived some other way — never fetched per event); kind-1059 gift wraps (NIP-59) are accepted from anyone, p-tag-addressed to the owner, gated by a separate byte cap, storage cap, and per-IP throttle. [docs/rungs.md](docs/rungs.md) describes this kind of escalation generically, in terms of who may write and what bounds the volume — bothy implements rung 3 (follows may write) with kind-1059 gift wraps layered in as an instance of rung 2 (addressed mail).
- Gift wrap reads require NIP-42 AUTH as the p-tagged recipient. The gate re-runs the filter restricted to `kinds: [1059]` against real storage rather than pattern-matching the filter shape.
- NIP-09 deletion and NIP-62 vanish requests both tombstone ids (`deleted_ids`) so a deleted event — gift wraps especially, since the sender keeps their own signed copy — can't be replayed back into storage.
- Live feed (`/live`) is a separate, unauthenticated, push-only WebSocket channel for the admin page, capped at 5 concurrent connections and a 10-minute server-enforced lifetime (DO alarm). Never sends gift wraps or event content, only kind/time/truncated id.
- NIP-86 relay management API, phase one: `banevent`/`allowevent`/`listbannedevents`, `blockip`/`unblockip`/`listblockedips`, and `changerelayname`/`changerelaydescription`/`changerelayicon`, plus `supportedmethods`. Authenticated by a NIP-98 event ([src/nip98.ts](src/nip98.ts)) signed by the owner, with the `payload` tag required rather than optional; verification runs in the Worker so a forged request costs no DO time, and storage mutations go to the DO by RPC (`Relay.manage`). Nothing here costs anything on the per-event write path — that is the criterion for what made phase one. `banpubkey`/`allowpubkey` are deferred to phase two because enforcing them means a per-event lookup; the kind allowlist methods answer with an explanation rather than a generic unknown-method error, since bothy stores every kind deliberately.
- `banevent` writes both a `banned_events` row and a `deleted_ids` tombstone: the ban is what the operator reads back, the tombstone is what actually refuses a re-send or a backfill replay. `listbannedevents` reads `banned_events`, never `deleted_ids` — the latter holds NIP-09 and NIP-62 deletions too. `allowevent` is the one place in the codebase that deletes a tombstone.
- IP blocks are checked exactly once per WebSocket connection in `Relay.fetch`, never per message, and never on the management endpoint — blocking your own address must not lock you out of the API that unblocks it. Blocking the caller's own address refuses once and names an exact confirmation string to pass back as the reason.
- Relay name, description and icon resolve through one chain in [src/nip11.ts](src/nip11.ts): environment variable, then stored value (NIP-86 `change*`), then the owner's kind-0 (`name`/`about`/`picture`), then a hardcoded default. A `change*` call under a set environment variable still stores the value and says the variable is winning — store and warn, never silently discard. An empty string clears the stored value; NIP-86 defines no unset operation, so this is bothy's convention and is documented in the README. Every successful `change*` response carries an error-field note teaching that escape hatch and pointing at the NIP-11 document as the readback. A name derived from the owner's kind-0 renders possessively ("Aaron's relay", always `'s`); a chosen name from any other rung is used verbatim. `resolveName` backs both the NIP-11 document and `/api/stats`, so the two can never disagree.
- One-shot backfill pulls the owner's own historical events from their kind-10002 write relays, resumable across cron ticks, reserving at most half the daily rows-written budget so it never competes with the owner's live traffic.

## What it refuses to be

No payments/zaps, no multi-region/D1/read-replica scaling, no NIP-05 hosting, no media/blossom uploads, no community moderation tooling (no moderator roles, no invite system, no report queue — the NIP-86 management API is the owner administering their own relay, which is a different thing), no public write mode, no continuous multi-relay sync (backfill is one-shot only). See [README.md](README.md) "What this is not".

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s `vars` block — a clean deploy must ask for nothing but a project name. Env vars, all added by hand in the Cloudflare dashboard if wanted: `OWNER_PUBKEY`, `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`, `ALLOW_FOLLOWS`. See [src/env.d.ts](src/env.d.ts).

The three identity variables sit at the top of the resolution chain described above — they outrank a value stored through NIP-86, which outranks the owner's kind-0.

`ALLOW_FOLLOWS` defaults to on; must be set to the literal string `"false"` to disable it and fall back to owner-only writes. When on, the owner's kind-3 follow list gates writes. The cache refreshes immediately when the owner publishes a new contact list to this relay; hourly cron is the fallback for when it arrived some other way (backfill, or a client that published it elsewhere first).

Redeploying does not reset ownership or storage — DO storage survives `wrangler deploy`. Resetting requires deleting the Worker.

[.github/workflows/sync.yml](.github/workflows/sync.yml) ships in every downstream copy of this repo so the "Deploy to Cloudflare" button's clone can still pull in upstream changes (it no-ops in `sybenx/bothy` itself via the job-level `if` guard). The `git checkout HEAD -- wrangler.jsonc .github/` step is load-bearing — it restores the user's own Cloudflare resource IDs and this workflow after the upstream checkout overwrites them; don't remove or reorder it.

## Architecture map

- [src/index.ts](src/index.ts) — Worker entry: routing, `/api/*`, `scheduled()` cron dispatch.
- [src/relay.ts](src/relay.ts) — the `Relay` Durable Object: connection lifecycle, NIP-01 message handling, live feed, alarm.
- [src/relay-stub.ts](src/relay-stub.ts) — the one `idFromName("relay")` accessor, shared so nothing else can shard it.
- [src/storage.ts](src/storage.ts) / [src/schema.ts](src/schema.ts) — SQLite schema and all read/write queries, including the row-cost accounting. `events.ingested_at` is wall-clock write time and must never be conflated with `created_at`: rows-written accounting and backfill's headroom guard both measure `ingested_at`, because a backfilled event's `created_at` is years old and measuring that made backfill's own writes invisible to the guard restraining them. A column, not a counter table — a counter costs a row write per event, a column costs nothing. See docs/budget.md.
- [src/filters.ts](src/filters.ts) — REQ filter parsing, SQL query building, in-memory match testing for live broadcast.
- [src/nostr.ts](src/nostr.ts) — wire types and kind-range classifiers (replaceable/ephemeral/addressable).
- [src/validate.ts](src/validate.ts) — event id computation and schnorr signature verification (`@noble/curves`).
- [src/ownership.ts](src/ownership.ts) — owner pubkey resolution, TOFU claim, follow-list cache, profile/icon refresh.
- [src/host.ts](src/host.ts) — this deployment's own host, learned from request traffic; lets backfill skip self-seeding.
- [src/pubkey.ts](src/pubkey.ts) / [src/bech32.ts](src/bech32.ts) — npub/hex normalization.
- [src/profile-lookup.ts](src/profile-lookup.ts) — best-effort kind-0 lookup from well-known relays, runs in the Worker only.
- [src/backfill.ts](src/backfill.ts) / [src/backfill-worker.ts](src/backfill-worker.ts) — backfill state machine (DO-side, pure) and outbound fetch orchestration (Worker-side).
- [src/limits.ts](src/limits.ts) — every numeric abuse/budget cap in the project, each commented with what it bounds.
- [src/nip11.ts](src/nip11.ts) — relay info document, and the name/description/icon resolution chain shared with `/api/stats`.
- [src/nip86.ts](src/nip86.ts) — management API method dispatch (runs in the DO; touches storage, opens nothing).
- [src/nip98.ts](src/nip98.ts) — HTTP auth verification for the management API (runs in the Worker only).
- [public/index.html](public/index.html) — the static admin page (claim form, stats, live feed).

## Conventions

- TypeScript strict mode, no `any` in the event-handling path.
- `@noble/curves` + `@noble/hashes` only — no second crypto dependency.
- Protocol errors go back as `["OK", id, false, "reason: message"]` or `["CLOSED", subid, "reason: message"]` with the NIP-01 machine-readable prefix (`invalid:`, `restricted:`, `blocked:`, `rate-limited:`, `auth-required:`, `duplicate:`). Never fail silently.
- Comments explain *why*, especially anything hibernation- or budget-related — most modules carry inline notes on their row-write cost or CPU cost and point at [docs/budget.md](docs/budget.md) for the measured baseline.
- Cheapest/most-certain rejections run before expensive ones on every write path: ownership check and tombstone check both precede schnorr verification.
- SQLite has exactly one secondary index on `events` (`(pubkey, kind, created_at)`) and one on `event_tags` (`(tag_name, tag_value, created_at)`). Every accepted read filter is required to constrain on `authors`/`ids`/`kinds`/a tag. Do not add another index — it multiplies per-event write cost — without updating the schema.ts comment and docs/budget.md.
- Verify Cloudflare's own platform limits against live docs before relying on a number in a file — they change between compatibility dates. docs/budget.md cites the source and date at each point of use rather than assuming a cached number still holds.
- Pin dependency versions; don't float to `latest` mid-project.

## Commands

```bash
npm install
npm run dev         # wrangler dev, local DO with SQLite
npm run test        # vitest — protocol conformance + budget/hibernation regression
npm run typecheck
npm run deploy       # wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts
```

## Testing

Two kinds of assertion live in the same suite ([test/](test)):

1. **Protocol conformance** — NIP-01 REQ/EVENT/CLOSE/EOSE, filters, replaceable/addressable/ephemeral storage rules, NIP-09/40/42/59/62, and NIP-86/98 management. Reject paths are asserted as carefully as accept paths.
2. **Budget/hibernation regression** — [test/hibernation.test.ts](test/hibernation.test.ts) asserts the object becomes eligible to hibernate after the last message; write-cost and CPU-cost baselines are recorded in [docs/baselines.json](docs/baselines.json) and explained in [docs/budget.md](docs/budget.md).

See [docs/test-notes.md](docs/test-notes.md) for suite layout, fixture rationale, and the couple of places tests drop below the wire protocol to real storage (documented exceptions, not the norm).

## Release step

`package.json`'s `version` is the single source of truth, imported directly (`resolveJsonModule`) into NIP-11's `version` field and `/api/stats`, which the admin page displays. Never hardcode the version string elsewhere. Cutting a release means bumping `package.json`'s `version` to match the release tag — every release must do this, or the deployed relay reports the wrong version.

## Attribution

MIT licensed, original implementation. See [README.md](README.md) "Attribution" for the full statement and the rule for any reference reading (Nosflare, khatru, haven, strfry): read to understand the protocol, never paste.
