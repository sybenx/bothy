# bothy

A single-user nostr relay that deploys in one click and runs on the Cloudflare Workers free tier. Paste an npub, get a `wss://` URL, done — no terminal, no VPS, no domain.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: NIP-86 on `Content-Type: application/nostr+json+rpc` (checked first — that string contains `application/nostr+json`, so checking NIP-11 first would swallow it), NIP-11 on `Accept: application/nostr+json`, WebSocket upgrades to the Durable Object, `/api/claim`, `/api/stats`, `/api/profile`, everything else to the static `public/` admin page.
- Exactly one Durable Object (`Relay`, [src/relay.ts](src/relay.ts)), addressed by `idFromName("relay")`. SQLite-backed. All protocol state, storage, and subscriptions live here.
- WebSocket Hibernation API throughout (`acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`alarm`), `setWebSocketAutoResponse` for ping/pong. The Durable Object must never open an outbound connection — doing so breaks hibernation. The Worker owns every outbound connection (claim-time profile lookup, backfill fetches) on the DO's behalf.
- TOFU ownership: unclaimed until `POST /api/claim` binds a pubkey, permanently, with no signature required (`OWNER_PUBKEY` env var skips this and disables the endpoint). Every event is still signature-verified regardless of owner.
- Writes are owner-gated, with two exceptions: `ALLOW_FOLLOWS` (opt-out, on unless set to `"false"`) also accepts the owner's kind-3 follow list (cached from the owner's own stored contact list, refreshed immediately when the owner publishes a new one to this relay, with hourly cron as the fallback for when it arrived some other way — never fetched per event); kind-1059 gift wraps (NIP-59) are accepted from anyone, p-tag-addressed to the owner, gated by their own storage cap and per-IP throttle on top of the general write caps below. [docs/rungs.md](docs/rungs.md) describes this kind of escalation generically, in terms of who may write and what bounds the volume — bothy implements rung 3 (follows may write) with kind-1059 gift wraps layered in as an instance of rung 2 (addressed mail).
- Gift wrap reads require NIP-42 AUTH as the p-tagged recipient. The gate re-runs the filter restricted to `kinds: [1059]` against real storage rather than pattern-matching the filter shape.
- NIP-09 deletion and NIP-62 vanish requests both tombstone ids (`deleted_ids`) so a deleted event — gift wraps especially, since the sender keeps their own signed copy — can't be replayed back into storage.
- Live feed (`/live`) is a separate, unauthenticated, push-only WebSocket channel for the admin page, capped at 5 concurrent connections and a 10-minute server-enforced lifetime (DO alarm). Never sends gift wraps or event content, only kind/time/truncated id.
- NIP-86 relay management API: `banevent`/`allowevent`/`listbannedevents`, `banpubkey`/`unbanpubkey`/`listbannedpubkeys`, `allowpubkey`/`unallowpubkey`/`listallowedpubkeys`, `blockip`/`unblockip`/`listblockedips`, and `changerelayname`/`changerelaydescription`/`changerelayicon`, plus `supportedmethods`. Authenticated by a NIP-98 event ([src/nip98.ts](src/nip98.ts)) signed by the owner, with the `payload` tag required rather than optional; verification runs in the Worker so a forged request costs no DO time, and storage mutations go to the DO by RPC (`Relay.manage`). Phase one shipped only the methods that cost nothing on the per-event write path; phase two (`banpubkey`/`allowpubkey`) is the one addition that does, landed only once a metrics baseline existed to compare against — see CLAUDE.md "The budget". The kind allowlist methods answer with an explanation rather than a generic unknown-method error, since bothy stores every kind deliberately.
- `banevent` writes both a `banned_events` row and a `deleted_ids` tombstone: the ban is what the operator reads back, the tombstone is what actually refuses a re-send or a backfill replay. `listbannedevents` reads `banned_events`, never `deleted_ids` — the latter holds NIP-09 and NIP-62 deletions too. `allowevent` is the one place in the codebase that deletes a tombstone.
- `banpubkey`/`allowpubkey` are two independent lists (`banned_pubkeys`/`allowed_pubkeys`), not opposite ends of one — unlike `allowevent`, `unbanpubkey` and `unallowpubkey` each just delete their own row. `ownership.ts isAllowedWriter` checks `banned_pubkeys` before the follows lookup, unconditionally for every non-owner write, so a banned pubkey is refused even if it's also a follow; it checks `allowed_pubkeys` only on the path already about to reject (owner-only mode, or "not a follow"), so that lookup costs nothing on the common accept path. The owner's own pubkey can never be banned — `banpubkey` refuses the call outright rather than accepting it and having no effect.
- IP blocks are checked exactly once per WebSocket connection in `Relay.fetch`, never per message, and never on the management endpoint — blocking your own address must not lock you out of the API that unblocks it. Blocking the caller's own address refuses once and names an exact confirmation string to pass back as the reason.
- The NIP-11 document also carries `pubkey` (the owner's, from `getOwnerPubkey` — omitted while unclaimed) and `contact` (the owner's kind-0 `website`, omitted if absent). Neither has an environment-variable or NIP-86 rung: name/description/icon do because an operator may want the relay to present differently from the person, and a contact address has no such split. `website` and not `nip05` or `lud16` — see `resolveContact`.
- Relay name, description and icon resolve through one chain in [src/nip11.ts](src/nip11.ts): environment variable, then stored value (NIP-86 `change*`), then the owner's kind-0 (`name`/`about`/`picture`), then a hardcoded default. A `change*` call under a set environment variable still stores the value and says the variable is winning — store and warn, never silently discard. An empty string clears the stored value; NIP-86 defines no unset operation, so this is bothy's convention and is documented in the README. Every successful `change*` response carries an error-field note teaching that escape hatch and pointing at the NIP-11 document as the readback. A name derived from the owner's kind-0 renders possessively ("Aaron's relay", always `'s`); a chosen name from any other rung is used verbatim. `resolveName` backs both the NIP-11 document and `/api/stats`, so the two can never disagree.
- One-shot backfill pulls the owner's own historical events from their kind-10002 write relays, resumable across cron ticks, reserving at most half the daily rows-written budget so it never competes with the owner's live traffic.

## What it refuses to be

No payments/zaps, no multi-region/D1/read-replica scaling, no NIP-05 hosting, no media/blossom uploads, no community moderation tooling (no moderator roles, no invite system, no report queue — the NIP-86 management API is the owner administering their own relay, which is a different thing), no public write mode, no continuous multi-relay sync (backfill is one-shot only). See [README.md](README.md) "What this is not".

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s `vars` block — a clean deploy must ask for nothing but a project name. Env vars, all added by hand in the Cloudflare dashboard if wanted: `OWNER_PUBKEY`, `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`, `ALLOW_FOLLOWS`, `MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUBKEY_PER_MINUTE`, `NON_OWNER_STORAGE_BYTES`. See [src/env.d.ts](src/env.d.ts).

The three identity variables sit at the top of the resolution chain described above — they outrank a value stored through NIP-86, which outranks the owner's kind-0.

`MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUBKEY_PER_MINUTE` and `NON_OWNER_STORAGE_BYTES` are the write-path abuse caps; each takes a number or the exact string `"off"`. What bounds a follow, and the before/after arithmetic, is in CLAUDE.md "The budget".

`ALLOW_FOLLOWS` defaults to on; must be set to the literal string `"false"` to disable it and fall back to owner-only writes. When on, the owner's kind-3 follow list gates writes. The cache refreshes immediately when the owner publishes a new contact list to this relay; hourly cron is the fallback for when it arrived some other way (backfill, or a client that published it elsewhere first).

Redeploying does not reset ownership or storage — DO storage survives `wrangler deploy`. Resetting requires deleting the Worker.

[.github/workflows/sync.yml](.github/workflows/sync.yml) ships in every downstream copy of this repo so the "Deploy to Cloudflare" button's clone can still pull in upstream changes (it no-ops in `sybenx/bothy` itself via the job-level `if` guard). The `git checkout HEAD -- wrangler.jsonc .github/` step is load-bearing — it restores the user's own Cloudflare resource IDs and this workflow after the upstream checkout overwrites them; don't remove or reorder it.

## The budget

Everything here runs on the Cloudflare Workers free tier, and the ceilings are
what shape the design. Per day, per account: **100,000 rows written**,
**5,000,000 rows read**, 5GB of SQLite storage per Durable Object, 10ms of
Worker CPU per request. Allowances reset at 00:00 UTC. Rows written and rows
read are the two that bind; storage and CPU are not close.

Every figure below is asserted by the suite — [test/hibernation.test.ts](test/hibernation.test.ts)
for rows written, [test/read-cost.test.ts](test/read-cost.test.ts) for rows read —
so the tests are the record and a change that moves one fails rather than
drifting. The one cost the suite cannot assert is schnorr verification, because
the workerd test harness does not expose isolate CPU time; that number and its
caveat sit on `verifySignature` in [src/validate.ts](src/validate.ts). Below,
**E** is rows in `events` and **T** is rows in `event_tags` (≈ 5E for real notes,
which carry about five single-letter tags each).

### Rows written, per stored event

```
5 + 3 × (single-letter tag count)
```

Five for the event row: one base row, one for the implicit unique index behind
`id TEXT PRIMARY KEY` (a TEXT primary key is not a rowid alias), and one for each
of the three declared indexes on `events`. Three per indexed tag row: the row and
its two indexes. A bare note costs 5, a reply carrying `#e` and `#p` costs 11, a
real note carrying about five tags costs 20. A delete is a write too, so a
replacement or a NIP-09 deletion costs this shape again, plus 2 for a tombstone.

`schema.ts eventRowCost` derives this from `INDEXES` rather than restating it, so
adding an index updates the admin page, backfill's headroom guard and
`BACKFILL_PAGE_SIZE`'s sizing at once. `events.row_cost` stamps the figure at
insert time so `estimateRowsWritten24h` can sum a column.

### Rows read, by path

| Path | Rows read |
|---|---|
| REQ filter, `ids` | 1 per id |
| REQ filter, `#<letter>` tag | ~2 per matching tag row |
| REQ filter served by an index | combinations × (2 × limit + 1) |
| Gift wrap gate probe, per filter, only when `kinds` is absent | 1–5 |
| `estimateRowsWritten24h` | E |
| `/api/stats`, cache miss | ~5E |
| `/api/stats`, within `STATS_CACHE_TTL_MS` | ~1 |
| Backfill tick | 2E + ~2 per event in the page |
| Live write, regular kind | 0–2 |
| Replaceable/addressable replacement | ~2 per tag on the replaced event |
| NIP-62 vanish, per event removed | ~2 per tag on that event |
| `giftWrapCount`, per gift wrap accepted | ~0 |
| Cron refreshes | ~7 + 2F |
| WebSocket connect | 1–2 |
| NIP-11 document / NIP-98 owner lookup | 2 |
| `initSchema`, per Durable Object constructor, schema hash matches | 1 |
| `initSchema`, per Durable Object constructor, schema hash mismatch | ~66 |

F is the follow count. `initSchema` runs in the constructor, so it is paid per
wake from hibernation, not once per deploy — which is why the row above is
split in two. It used to reconcile the full `TABLES`/`INDEXES` declaration
unconditionally on every wake: measured live, 55 rows read/wake, ~94,000
rows/day at the relay's wake rate, to redeclare a schema that had not changed
since the wake before. It now instead compares one stored row — a hash of
the declaration (`schema.ts computeSchemaHash`) against the hash the
database was last reconciled to (`schema_meta`) — and only runs the reconcile
pass on a mismatch: a real schema change, or the first wake after upgrading
to this. The hash is derived from every field `reconcileColumns` and
`createIndexSql` act on, not hand-maintained, so a changed column or index
cannot silently skip its own migration; and it is written only after the
reconcile completes without throwing, so a migration that dies partway
leaves the previous hash in place for the next wake to retry rather than
being mistaken for one that finished. See the header comment on `initSchema`
in [src/schema.ts](src/schema.ts).

`combinations` is the number of queries `filters.ts expandFilter` runs for a
filter — its `authors` × `kinds` cross-product. The `2` is the index entry plus
the table row it points at.

### Where the read ceiling actually binds

One path scales with the accumulated table rather than with traffic, so it gets
worse as the relay fills whether or not anything else changes:

- **The cron floor.** The hourly tick calls `estimateRowsWritten24h` twice, so
  `2E × 24 = 48E` rows/day are spent with no client connected at all. That
  reaches 5,000,000 at **E ≈ 104,000**.

There were two. The second was every operation that removed an event —
replaceable replacement, NIP-09 deletion, NIP-62 vanish — each of which scanned
`event_tags` in full because no index covered `event_id`. That cost `5E` per
removed event and bound at `E × R = 1,000,000`, sooner than the cron floor for
any meaningful rate. `idx_event_tags_event` closed it in v0.7.3, and the reasoning
on `deleteEventRow` in [src/storage.ts](src/storage.ts) is why that index is not
optional: the vanish path that reaches it cannot be gated, throttled or revoked,
so cost is the only control the relay has over it.

Rows **written** are now the binding side of a vanish, and no index helps there:
removing an event costs its tag rows, its own row and a tombstone.
That is why vanish requests are checkpointed and drained across cron ticks rather
than attempted inside the request — see `beginVanish`/`drainVanish`.

Traffic-driven paths are bounded by `limits.ts boundFilter`, which admits a REQ
filter only at a limit some index can afford, and by the per-IP message throttle
in `relay.ts`.

## Threat model

Reads are public by design and writes are owner-gated, so the two halves are
defended differently. What follows is what the relay actually does, and — more
usefully — what it structurally cannot do.

### What it defends against

- **Unauthorized writes.** TOFU ownership binds one pubkey permanently; every
  event is signature-verified regardless of who sent it. `ALLOW_FOLLOWS` widens
  writes to the owner's kind-3 list and nothing else. NIP-86 `banpubkey` and
  `allowpubkey` adjust that set by hand.
- **Read abuse.** `limits.ts boundFilter` admits a REQ filter only at a limit
  some index can afford, so no filter can scan the table. Plus a
  per-connection subscription cap and a per-IP message throttle.
- **Write abuse from an authorized writer.** `MAX_EVENT_BYTES` bounds the
  permanent damage one event can do; a per-pubkey rate limit bounds how fast;
  `NON_OWNER_STORAGE_BYTES` reserves half the 5GB ceiling for the owner. Gift
  wraps carry their own count cap and per-IP throttle on top.
- **Gift wrap disclosure.** Reads of kind-1059 require NIP-42 AUTH as the
  p-tagged recipient, checked by re-running the filter against real storage
  rather than by pattern-matching its shape.
- **Replay of deleted events.** `deleted_ids` tombstones every id removed by
  NIP-09, NIP-62 or `banevent`, so a sender holding a signed copy cannot put it
  back.
- **Self-inflicted lockout.** An event dated far in the future would freeze a
  replaceable kind permanently — including the kind-3 that gates writes — so
  `MAX_CREATED_AT_FUTURE_SECONDS` refuses it.
- **Connection-level abuse.** NIP-86 `blockip`, checked once per WebSocket
  connection and never on the management endpoint, so blocking your own address
  cannot lock you out of the API that unblocks it.

### What it structurally cannot defend against

- **NIP-62 vanish.** The spec binds write-restricted relays to honour a vanish
  "regardless of the user's status", so the path is dispatched before the write
  gate and pays none of the abuse caps. It cannot be gated, it cannot be
  throttled below "eventually completes", and it cannot be revoked — `banpubkey`
  and unfollowing both act through `isAllowedWriter`, which this path never
  calls, so an ex-follow keeps both their stored events and the ability to
  trigger it. Cost is the only available control, which is why
  `idx_event_tags_event` exists and why the drain is checkpointed. `/api/stats`
  reports the largest number of events any single non-owner pubkey holds, since
  that is the worst case a given deployment is actually exposed to.
- **Anyone reading anything that is not a gift wrap.** There is no read
  authentication and none is planned; a personal relay's contents are as public
  as the notes in it.
- **A compromised follow.** Follows are trusted with writes. The caps bound what
  one can cost, they do not prevent it, and the owner is expected to notice and
  revoke.
- **In-memory limits across eviction.** The per-IP, per-pubkey and gift wrap
  throttles are held in memory so they cost no rows to enforce. A Durable Object
  that hibernates loses them, so an attacker who paces themselves around
  eviction gets a fresh window. This is a deliberate trade, not an oversight.
- **The owner.** Nothing here defends the relay against its own owner, and the
  storage and rate caps deliberately exempt them.
- **Account-wide exhaustion.** The Cloudflare ceilings are per account, not per
  Worker. Another Worker in the same account can consume them, and when they are
  consumed every Durable Object path fails at once — see `src/exhaustion.ts`
  for how that is made visible rather than silent.

## Architecture map

- [src/index.ts](src/index.ts) — Worker entry: routing, `/api/*`, `scheduled()` cron dispatch.
- [src/relay.ts](src/relay.ts) — the `Relay` Durable Object: connection lifecycle, NIP-01 message handling, live feed, alarm.
- [src/relay-stub.ts](src/relay-stub.ts) — the one `idFromName("relay")` accessor, shared so nothing else can shard it.
- [src/storage.ts](src/storage.ts) / [src/schema.ts](src/schema.ts) — SQLite schema and all read/write queries, including the row-cost accounting. `events.ingested_at` is wall-clock write time and must never be conflated with `created_at`: rows-written accounting and backfill's headroom guard both measure `ingested_at`, because a backfilled event's `created_at` is years old and measuring that made backfill's own writes invisible to the guard restraining them. A column, not a counter table — a counter costs a row write per event, a column costs nothing. The same argument added `events.row_cost` in v0.7.2: each event's rows-written cost is stamped at insert time so `estimateRowsWritten24h` sums a column instead of rebuilding the figure from a `LEFT JOIN event_tags` with no index behind it, which read every tag row in the table to answer a question about the 24h window. See CLAUDE.md "The budget".
- [src/filters.ts](src/filters.ts) — REQ filter parsing, SQL query building, in-memory match testing for live broadcast, and `expandFilter`, which splits one filter into the cross-product of its `authors` × `kinds` singletons. That split is what lets an index serve `ORDER BY created_at DESC LIMIT n`: a key column pinned to one value arrives sorted, `kind IN (1, 7)` does not, so a multi-kind filter defeats an index as thoroughly as no index at all. `storage.ts queryFilter` re-merges and re-slices to `limit`, so the split is invisible on the wire.
- [src/nostr.ts](src/nostr.ts) — wire types and kind-range classifiers (replaceable/ephemeral/addressable).
- [src/validate.ts](src/validate.ts) — event id computation and schnorr signature verification (`@noble/curves`).
- [src/ownership.ts](src/ownership.ts) — owner pubkey resolution, TOFU claim, follow-list cache, profile/icon refresh.
- [src/host.ts](src/host.ts) — this deployment's own host, learned from request traffic; lets backfill skip self-seeding.
- [src/pubkey.ts](src/pubkey.ts) / [src/bech32.ts](src/bech32.ts) — npub/hex normalization.
- [src/profile-lookup.ts](src/profile-lookup.ts) — best-effort kind-0 lookup from well-known relays, runs in the Worker only.
- [src/backfill.ts](src/backfill.ts) / [src/backfill-worker.ts](src/backfill-worker.ts) — backfill state machine (DO-side, pure) and outbound fetch orchestration (Worker-side).
- [src/limits.ts](src/limits.ts) — every numeric abuse/budget cap in the project, each commented with what it bounds. The three write-path caps (event size, per-pubkey rate, non-owner storage share) are enforced in `relay.ts acceptEvent` before id/signature verification, exempt the owner from two of the three, and are each raisable or disablable by env var — disabled only by the exact string `"off"`, never by any truthy value. Also `boundFilter`, the read-abuse guard: it prices a REQ filter (`combinations × (2 × limit + 1)`, where `combinations` comes from `expandFilter` itself) against the index set declared in `schema.ts`, clamps the limit until the query is affordable, and refuses only what no limit can fix. It replaced `isUnconstrainedFilter`, which asked whether a field was *present* rather than what the query *cost* and so admitted the two shapes that read the whole table.
- [src/exhaustion.ts](src/exhaustion.ts) — classifies a Cloudflare free-tier allowance being consumed and names which one; `index.ts` wraps both `fetch` and `scheduled` with it. Exists because the last outage's only symptom was an admin page that loaded the word "bothy" and no numbers — `public/` is served from `env.ASSETS` and never touches the DO, so the one part still working was the part that proved nothing. Matching is substring signatures against error text Cloudflare does not document as stable, so it fails useful rather than silent: the raw message is always logged, the resource name only added when a signature matches. Non-exhaustion errors are logged and rethrown, never converted into a quiet 503.
- [src/read-metrics.ts](src/read-metrics.ts) — **diagnostic, and expected to be removed**: in-memory attribution of rows *read* to the code path that caused them, surfaced as `reads` on `/api/stats`. Added after the live relay exhausted the 5,000,000 rows-read/day allowance under ordinary operation and nothing here could say which path spent it. Counters live in memory, never in storage — a counter costing a row write to measure a row read repeats the mistake CLAUDE.md "The budget" already rejected — so they reset on eviction and describe proportions, not daily totals. Every `SqlStorage` access in the DO goes through `instrumentSql`, so a query can be mislabelled into `unattributed` but never missed. See CLAUDE.md "The budget" for the per-call costs and the arithmetic against the ceiling.
- [src/nip11.ts](src/nip11.ts) — relay info document, and the name/description/icon resolution chain shared with `/api/stats`.
- [src/nip86.ts](src/nip86.ts) — management API method dispatch (runs in the DO; touches storage, opens nothing).
- [src/nip98.ts](src/nip98.ts) — HTTP auth verification for the management API (runs in the Worker only).
- [public/index.html](public/index.html) — the static admin page (claim form, stats, live feed).

## Conventions

- TypeScript strict mode, no `any` in the event-handling path.
- `@noble/curves` + `@noble/hashes` only — no second crypto dependency.
- Protocol errors go back as `["OK", id, false, "reason: message"]` or `["CLOSED", subid, "reason: message"]` with the NIP-01 machine-readable prefix (`invalid:`, `restricted:`, `blocked:`, `rate-limited:`, `auth-required:`, `duplicate:`). Never fail silently.
- Comments explain *why*, especially anything hibernation- or budget-related — most modules carry inline notes on their row-write cost or CPU cost and point at CLAUDE.md "The budget" for the measured baseline.
- Cheapest/most-certain rejections run before expensive ones on every write path: ownership check and tombstone check both precede schnorr verification.
- Indexes are declared once, as data, in `schema.ts INDEXES`, and three things read that declaration: `limits.ts boundFilter` (which filters are affordable), `schema.ts eventRowCost` (what an event costs to write), and `limits.ts BACKFILL_PAGE_SIZE`/`VANISH_BATCH_SIZE` (how much work fits in a cron tick). Three on `events` — `(pubkey, kind, created_at)`, `(kind, created_at)`, `(pubkey, created_at)` — and two on `event_tags` — `(tag_name, tag_value, created_at)` and `(event_id)`. A fourth index therefore changes both the guard and the write accounting on its own; what it must NOT change silently is the measured baseline, so re-run `test/hibernation.test.ts`'s rows-written assertions and update the schema.ts comment and CLAUDE.md "The budget". Every accepted read filter must be answerable from one of these — that is enforced by cost, not by requiring a particular field.
- Verify Cloudflare's own platform limits against live docs before relying on a number in a file — they change between compatibility dates. CLAUDE.md "The budget" cites the source and date at each point of use rather than assuming a cached number still holds.
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
2. **Budget/hibernation regression** — [test/hibernation.test.ts](test/hibernation.test.ts) asserts the object becomes eligible to hibernate after the last message, and pins the per-event rows-written cost against a real `SqlStorageCursor.rowsWritten`; [test/read-cost.test.ts](test/read-cost.test.ts) pins rows read per query shape. These assertions are the budget baseline — there is no separate file of recorded numbers to fall out of step with them.

See [docs/test-notes.md](docs/test-notes.md) for suite layout, fixture rationale, and the couple of places tests drop below the wire protocol to real storage (documented exceptions, not the norm).

## Release step

`package.json`'s `version` is the single source of truth, imported directly (`resolveJsonModule`) into NIP-11's `version` field and `/api/stats`, which the admin page displays. Never hardcode the version string elsewhere. Cutting a release means bumping `package.json`'s `version` to match the release tag — every release must do this, or the deployed relay reports the wrong version.

## Attribution

MIT licensed, original implementation. See [README.md](README.md) "Attribution" for the full statement and the rule for any reference reading (Nosflare, khatru, haven, strfry): read to understand the protocol, never paste.
