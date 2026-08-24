# bothy

A single-user nostr relay that deploys in one click and runs on the Cloudflare Workers free tier. Paste an npub, get a `wss://` URL, done — no terminal, no VPS, no domain.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: NIP-11 on `Accept: application/nostr+json`, WebSocket upgrades to the Durable Object, `/api/claim`, `/api/stats`, `/api/profile`, everything else to the static `public/` admin page.
- Exactly one Durable Object (`Relay`, [src/relay.ts](src/relay.ts)), addressed by `idFromName("relay")`. SQLite-backed. All protocol state, storage, and subscriptions live here.
- WebSocket Hibernation API throughout (`acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`alarm`), `setWebSocketAutoResponse` for ping/pong. No outbound socket is ever opened from inside the DO — the Worker owns every outbound connection (claim-time profile lookup, backfill fetches) so the DO can hibernate.
- TOFU ownership: unclaimed until `POST /api/claim` binds a pubkey, permanently, with no signature required (`OWNER_PUBKEY` env var skips this and disables the endpoint). Every event is still signature-verified regardless of owner, so a wrong claim can't forge anything.
- Writes are owner-gated, with two deliberate exceptions: `ALLOW_FOLLOWS` (opt-out, on unless set to `"false"`) also accepts the owner's kind-3 follow list (cached from the owner's own stored contact list, refreshed hourly by cron — never fetched per event); kind-1059 gift wraps (NIP-59) are accepted from anyone, p-tag-addressed to the owner, gated by a separate byte cap, storage cap, and per-IP throttle.
- Gift wrap reads require NIP-42 AUTH as the p-tagged recipient. The gate re-runs the filter restricted to `kinds: [1059]` against real storage rather than pattern-matching the filter shape.
- NIP-09 deletion and NIP-62 vanish requests both tombstone ids (`deleted_ids`) so a deleted event — gift wraps especially, since the sender keeps their own signed copy — can't be replayed back into storage.
- Live feed (`/live`) is a separate, unauthenticated, push-only WebSocket channel for the admin page, capped at 5 concurrent connections and a 10-minute server-enforced lifetime (DO alarm). Never sends gift wraps or event content, only kind/time/truncated id.
- One-shot backfill pulls the owner's own historical events from their kind-10002 write relays, resumable across cron ticks, reserving at most half the daily rows-written budget so it never competes with the owner's live traffic.

## What it refuses to be

No payments/zaps, no multi-region/D1/read-replica scaling, no NIP-05 hosting, no media/blossom uploads, no moderation/invite/community tooling, no public write mode, no continuous multi-relay sync (backfill is one-shot only). Reasoning for each lives in [README.md](README.md) "What this is not".

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s absent `vars` block, because the Cloudflare deploy button prompts for every declared var with no notion of "optional" — a clean deploy must ask for nothing but a project name. Env vars, all added by hand in the Cloudflare dashboard if wanted: `OWNER_PUBKEY`, `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`, `ALLOW_FOLLOWS`. See [src/env.d.ts](src/env.d.ts).

`ALLOW_FOLLOWS` is opt-out, not opt-in: it defaults to on and must be set to the literal string `"false"` to disable it and fall back to owner-only writes. When on, the owner's kind-3 follow list gates writes. Independent of that flag, the owner's kind-10000 NIP-51 mute list (public `p` tags only — private mutes are NIP-44-encrypted to a key the relay never holds) always revokes write access for a muted pubkey, checked before the follows lookup so a mute overrides being followed. Both caches refresh hourly by cron. See [docs/rungs.md](docs/rungs.md) for the full write ladder this sits on.

Redeploying does not reset ownership or storage — DO storage survives `wrangler deploy`. Resetting requires deleting the Worker.

[.github/workflows/sync.yml](.github/workflows/sync.yml) is downstream-facing tooling, not CI for this repo: the "Deploy to Cloudflare" button clones this repo into the user's account rather than forking it, so this workflow ships in every downstream copy to give them a way to pull in upstream changes anyway (it no-ops in `sybenx/bothy` itself via the job-level `if` guard). The `git checkout HEAD -- wrangler.jsonc .github/` step is load-bearing — it restores the user's own Cloudflare resource IDs and this workflow after the upstream checkout overwrites them; don't remove or reorder it.

## Architecture map

- [src/index.ts](src/index.ts) — Worker entry: routing, `/api/*`, `scheduled()` cron dispatch.
- [src/relay.ts](src/relay.ts) — the `Relay` Durable Object: connection lifecycle, NIP-01 message handling, live feed, alarm.
- [src/relay-stub.ts](src/relay-stub.ts) — the one `idFromName("relay")` accessor, shared so nothing else can shard it.
- [src/storage.ts](src/storage.ts) / [src/schema.ts](src/schema.ts) — SQLite schema and all read/write queries, including the row-cost accounting.
- [src/filters.ts](src/filters.ts) — REQ filter parsing, SQL query building, in-memory match testing for live broadcast.
- [src/nostr.ts](src/nostr.ts) — wire types and kind-range classifiers (replaceable/ephemeral/addressable).
- [src/validate.ts](src/validate.ts) — event id computation and schnorr signature verification (`@noble/curves`).
- [src/ownership.ts](src/ownership.ts) — owner pubkey resolution, TOFU claim, follow-list cache, profile/icon refresh.
- [src/host.ts](src/host.ts) — this deployment's own host, learned from request traffic; lets backfill skip self-seeding.
- [src/pubkey.ts](src/pubkey.ts) / [src/bech32.ts](src/bech32.ts) — npub/hex normalization.
- [src/profile-lookup.ts](src/profile-lookup.ts) — best-effort kind-0 lookup from well-known relays, runs in the Worker only.
- [src/backfill.ts](src/backfill.ts) / [src/backfill-worker.ts](src/backfill-worker.ts) — backfill state machine (DO-side, pure) and outbound fetch orchestration (Worker-side).
- [src/limits.ts](src/limits.ts) — every numeric abuse/budget cap in the project, each commented with what it bounds.
- [src/nip11.ts](src/nip11.ts) — relay info document.
- [public/index.html](public/index.html) — the static admin page (claim form, stats, live feed).

## Conventions

- TypeScript strict mode, no `any` in the event-handling path.
- `@noble/curves` + `@noble/hashes` only — no second crypto dependency.
- Protocol errors go back as `["OK", id, false, "reason: message"]` or `["CLOSED", subid, "reason: message"]` with the NIP-01 machine-readable prefix (`invalid:`, `restricted:`, `blocked:`, `rate-limited:`, `auth-required:`, `duplicate:`). Never fail silently.
- Comments explain *why*, especially anything hibernation- or budget-related — most modules carry inline notes on their row-write cost or CPU cost and point at [docs/budget.md](docs/budget.md) for the measured baseline.
- Cheapest/most-certain rejections run before expensive ones on every write path: ownership check and tombstone check both precede schnorr verification.
- SQLite has exactly one secondary index on `events` (`(pubkey, kind, created_at)`) and one on `event_tags` (`(tag_name, tag_value, created_at)`) — deliberately not more, since every accepted read filter is required to constrain on `authors`/`ids`/`kinds`/a tag, and a second index would multiply per-event write cost. Don't add one without updating the schema.ts comment and docs/budget.md.
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

1. **Protocol conformance** — NIP-01 REQ/EVENT/CLOSE/EOSE, filters, replaceable/addressable/ephemeral storage rules, NIP-09/40/42/59/62. Reject paths are asserted as carefully as accept paths.
2. **Budget/hibernation regression** — [test/hibernation.test.ts](test/hibernation.test.ts) asserts the object becomes eligible to hibernate after the last message; write-cost and CPU-cost baselines are recorded in [docs/baselines.json](docs/baselines.json) and explained in [docs/budget.md](docs/budget.md).

See [docs/test-notes.md](docs/test-notes.md) for suite layout, fixture rationale, and the couple of places tests drop below the wire protocol to real storage (documented exceptions, not the norm).

## Attribution

MIT licensed, original implementation. [Nosflare](https://github.com/Spl0itable/nosflare) was read as prior art for NIP-01 filter-matching edge cases but no code is shared — see [README.md](README.md) "Attribution" for the full statement and the rule for any future reference reading (khatru, haven, strfry): read to understand the protocol, never paste.
