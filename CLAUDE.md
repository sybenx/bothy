# bothy

A single-user nostr relay that deploys in one click and runs on the Cloudflare Workers free tier. Paste an npub, get a `wss://` URL, done — no terminal, no VPS, no domain.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: NIP-86 on `Content-Type: application/nostr+json+rpc` (checked first — that string contains `application/nostr+json`, so checking NIP-11 first would swallow it), NIP-11 on `Accept: application/nostr+json`, WebSocket upgrades to the Durable Object, `/api/claim`, `/api/stats`, `/api/profile` (a setup endpoint: it answers only while the relay is unclaimed, and 404s once it is), everything else to the static `public/` admin page. Every route that reaches the Durable Object is rate limited per IP by Cloudflare's Rate Limiting binding before the Worker's own code runs; static assets are not.
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

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s `vars` block — a clean deploy must ask for nothing but a project name. The `ratelimits` block is the one binding added to `wrangler.jsonc` since, and it fits that rule: its namespace ids are ours to pick, nothing is provisioned, and nothing is prompted for. Both bindings are still read as `env.X?.limit(...)` — the Cloudflare docs do not state which plans the binding is available on (checked 2026-08-27), so an absent binding means "allowed" rather than an exception on every request. Env vars, all added by hand in the Cloudflare dashboard if wanted: `OWNER_PUBKEY`, `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`, `ALLOW_FOLLOWS`, `MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUBKEY_PER_MINUTE`, `NON_OWNER_STORAGE_BYTES`. See [src/env.d.ts](src/env.d.ts).

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
8 + 3 × (single-letter tag count)
```

Six for the event row: one base row, one for the implicit unique index behind
`id TEXT PRIMARY KEY` (a TEXT primary key is not a rowid alias), and one for each
of the four declared indexes on `events`. Two more for the maintained counters
(`maintained_counts` and `event_hour_counts`, both unindexed or rowid-aliased, so one
row apiece). Three per indexed tag row: the row and its two indexes. A bare note
costs 8, a reply carrying `#e` and `#p` costs 14, a real note carrying about five
tags costs 23. A delete is a write too, so a replacement or a NIP-09 deletion
costs this shape again, plus 2 for a tombstone.

The two counter rows are the price of `/api/stats` no longer scanning the table
to report `totalEvents` and `events24h` — 2 rows written per event against
~1,100 events/day here, so ~2,200 of 100,000, to remove a ~3E read that grew
without bound. `schema.ts EVENT_COUNTER_ROW_COST` declares it and `eventRowCost`
folds it in, so backfill's page sizing, the vanish drain's pacing and the admin
page's budget bar all see it; a counter cost paid at the write site but hidden
from those guards would be the same shape of error that made
`estimateRowsWrittenSince` wrong by 45x.

`schema.ts eventRowCost` derives this from `INDEXES` rather than restating it, so
adding an index updates the admin page, backfill's headroom guard and
`BACKFILL_PAGE_SIZE`'s sizing at once. `events.row_cost` stamps the figure at
insert time so `estimateRowsWrittenSince` can sum a column.

### Rows read, by path

| Path | Rows read |
|---|---|
| REQ filter, `ids` | 1 per id |
| REQ filter, `#<letter>` tag | ~2 per matching tag row |
| REQ filter served by an index | combinations × (2 × limit + 1) |
| Gift wrap gate probe, per filter, only when `kinds` is absent | 1–5 |
| `estimateRowsWrittenSince` | bounded by today's ingest count, not E (`idx_events_ingested`) |
| `totalEvents` + `followCount` (`readMaintainedCounts`) | 1 for the pair, maintained |
| `events24h` (`countEvents24h`) | ≤ 26 bucket rows, maintained |
| `followsListAt` | 1 |
| `/api/stats`, live cache stale (recomputes) | ~2 × today's ingest count |
| `/api/stats`, live cache warm | ~10–36, independent of E, F and of the ingest window |
| `auditMaintainedCounts`, once a day | E + F (one scan of `events`, one of `follows`) |
| Backfill tick | bounded by today's ingest count (headroom check) + ~2 per event in the page |
| Live write, regular kind | 0–2, plus 2 for the counter updates |
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

Two paths used to scale with the accumulated table rather than with traffic,
getting worse as the relay filled whether or not anything else changed. Both
are closed now:

- **The cron floor.** The hourly tick called `estimateRowsWrittenSince` twice
  with no index behind `ingested_at`, so `2E × 24 = 48E` rows/day were spent
  with no client connected at all, reaching 5,000,000 at **E ≈ 104,000**.
  `idx_events_ingested` closed it in v0.7.6 — see that index's own comment in
  [src/schema.ts](src/schema.ts).
- **Removing an event.** Replaceable replacement, NIP-09 deletion and NIP-62
  vanish each scanned `event_tags` in full because no index covered
  `event_id`, costing `5E` per removed event and binding at
  `E × R = 1,000,000`, sooner than the cron floor for any meaningful rate.
  `idx_event_tags_event` closed it in v0.7.3, and the reasoning on
  `deleteEventRow` in [src/storage.ts](src/storage.ts) is why that index is not
  optional: the vanish path that reaches it cannot be gated, throttled or
  revoked, so cost is the only control the relay has over it.

Rows **written** are now the binding side of a vanish, and no index helps there:
removing an event costs its tag rows, its own row and a tombstone.
That is why vanish requests are checkpointed and drained across cron ticks rather
than attempted inside the request — see `beginVanish`/`drainVanish`.

The `/api/stats` snapshot recompute used to be the last path that scaled with E
(~3E + 2F, gated to four refreshes a day behind `STATS_SNAPSHOT_MAX_AGE_MS` for
`12E`/day). **It is gone, and so is the snapshot.** `totalEvents` and
`followCount` are maintained counters in one `maintained_counts` row;
`events24h` is per-`created_at`-hour buckets in `event_hour_counts` summed over
at most 26 keys; `followsListAt` answers from `LIMIT 1`, since every row in
`follows` carries the same value; and `largestNonOwnerAuthor`, an E-row
`GROUP BY` answering a question nothing asked, was deleted. With nothing left
that walked a table, `stats_snapshot`, `STATS_SNAPSHOT_MAX_AGE_MS`,
`refreshStatsSnapshot` and its cron call were a mechanism rationing a cost that
no longer existed, and were removed together.

That is the general lesson, and it is why `limits.ts` records it where costs get
priced: a TTL over an expensive read bounds how often you pay it, not what it
costs, and it survives only as long as nobody makes the read cheap. Reach for the
counter first and the clock second. `live_stats` is the one stats cache left,
over the two figures that genuinely resist a counter — `ingested24h` would need a
second bucket table keyed by ingest time (a third row written per event, for a
diagnostic), and `rowsWrittenToday` is a sum over a window that empties at 00:00
UTC, which no per-event increment expresses.

Buckets rather than a scalar because `events24h` is a **rolling** window: an
event leaves it by the clock moving, with nothing happening to the event, and no
single counter can express that. Keyed by `created_at` and never by
`ingested_at`, which is the whole subtlety — a backfilled note signed in 2021 and
stored this morning belongs in a 2021 bucket, and incrementing "the current hour"
on arrival would have made a backfill look like a posting spree, the mirror image
of the bug `ingested_at` exists to fix. The window is whole hours, so it spans
24–25h rather than exactly 24; it replaced a figure exact to the second and up to
six hours stale, so the number moved closer to the truth, not further.

The one path that still scales with E is `storage.ts auditMaintainedCounts`, and
it is deliberate: once a day the cron tick recounts `events` in a single scan and
`follows` beside it, and logs loudly if any counter disagrees. **Detect only — it
never repairs.** A
counter that silently corrects itself erases the evidence of whatever broke it,
so the drift returns on the next occurrence and is swallowed again, and the only
symptom is a number quietly wrong between repairs. E + F once a day, against the
`12E + 8F`/day the snapshot spent assuming these same numbers, is a quarter of
the cost for an answer that is checked rather than assumed.

A maintained count is only correct if nothing can change the counted table
without passing the counter, and each holds structurally. For `events`:
`storage.ts insertEventRow` and `deleteEventRow` are the only two functions in
the codebase that write to it, the counter writes sit inside them rather than
beside their callers, and every removal path — replaceable replacement, NIP-09,
NIP-62 vanish, NIP-86 `banevent` — reaches them. `deleteEventRow` reads the row's
`created_at` itself rather than taking it from the caller, because `banEvent` can
be handed an id that was never stored and must not decrement a bucket for it. For
`follows`: `ownership.ts refreshFollows` is the only function that writes it, and
the counter moves in each of its two write branches — the rebuild and the clear —
rather than at the function's exit, which two early returns on the common path
would otherwise skip. That a refresh finding an unchanged contact list writes zero
rows, counter included, is asserted in `test/follows.test.ts`.

The rest of `/api/stats` scaled with something else, and closing it took a
second cache beside the snapshot. `ingested24h` and `rowsWrittenToday` both seek
`idx_events_ingested`, so neither grows with E — but both read the ingest
*window*, measured live at 853 + 344 rows, ~1,200 per request with the
lookups beside them. `GET /api/stats` is unauthenticated and nothing
rate-limits it, so **~4,100 requests from anywhere took the whole
5,000,000 rows-read allowance for the rest of the UTC day**, at no cost to
the caller — the same shape as the gift wrap gate probe, an expensive read
on the far side of no gate. Both figures now come from the `live_stats`
row on a five-minute clock (`limits.ts LIVE_STATS_MAX_AGE_MS`), which
bounds the recompute rate at 288/day however many requests arrive:

```
flood floor = (86,400 / TTL) × 1.5D   (D = events ingested per day)
```

That is the arithmetic the TTL was chosen against — at 60s it admits only
D ≤ 2,315 events/day before the floor alone reaches the ceiling, which a
backfilling relay exceeds; at 300s it admits D ≤ 11,574, above anything the
100,000 rows-written ceiling permits this relay to ingest. A warm load
costs 8 rows measured (`test/read-cost.test.ts`), so the endpoint went from
~4,100 loads/day to ~387,000. In a row and not in memory for the reason the
`stats_snapshot` cache beside it was: a flood keeps the object awake, but
pacing one request every ten seconds misses an in-memory cache every time
and still reaches twice the ceiling. Hourly bucket counters are the better
shape where they fit — one row written per event, windowed sums reading at
most 26 rows, no staleness — and `events24h` is now exactly that. It does
not fit these two: `ingested24h` would need a second bucket table keyed by
ingest time, a third row written per event for a diagnostic, and
`rowsWrittenToday` is a sum over a window that empties at 00:00 UTC, which
no per-event increment expresses. So these stay cached and this is the one
stats cache left.

Traffic-driven paths are bounded by `limits.ts boundFilter`, which admits a REQ
filter only at a limit some index can afford, and by the per-IP message throttle
in `relay.ts`.

### The HTTP side

That message throttle covers WebSocket messages only — it starts counting once
a connection exists, so it never saw a connect-and-drop loop at all, and it saw
no HTTP request of any kind. For most of this project's life **nothing
rate-limited the HTTP endpoints**, and each was defended by its per-request cost
alone against callers who pay nothing per request. Cloudflare's Rate Limiting
binding now bounds them
per IP, declared in `wrangler.jsonc` and applied in `index.ts` (`rateLimited`):
60/minute shared across every HTTP path that wakes the Durable Object, and
10/minute for `/api/profile` alone. It runs in the runtime before the Worker's
code, so a refused request never reaches the object at all — which is the whole
reason for choosing it over a counter of our own, since the only two places such
a counter could live are DO storage (a row write per request, to measure a
request) or isolate memory (which a flood evicts). Static assets are outside it:
they never touch the DO and are free and unmetered.

The per-request cost of each HTTP path, after the pass that added it:

| Path | Reaches the DO? | Outbound? | Rows read | Per-IP limit |
|---|---|---|---|---|
| `GET /` and other static assets | no | no | 0 | none — free and unmetered |
| `GET /api/stats`, live cache warm | yes | no | ~10–36 | 60/min |
| `GET /api/stats`, live cache stale | yes | no | ~2 × today's ingest | 60/min |
| `POST /api/claim`, `OWNER_PUBKEY` set | **no** | **no** | 0 | 60/min |
| `POST /api/claim`, malformed pubkey | no | no | 0 | 60/min |
| `POST /api/claim`, already claimed | yes | **no** | 1–2 | 60/min |
| `POST /api/claim`, unclaimed | yes | 2 sockets, cached | 3–4 | 60/min |
| `GET /api/profile`, claimed | yes | **no** | 1–2 | 10/min |
| `GET /api/profile`, malformed pubkey | no | no | 0 | 10/min |
| `GET /api/profile`, unclaimed, cache hit | yes | no | 1–2 | 10/min |
| `GET /api/profile`, unclaimed, cache miss | yes | 2 sockets | 1–2 | 10/min |
| NIP-11 document | yes | no | 2 | 60/min |
| `POST /` (NIP-86), auth fails | **no** | no | 0 | 60/min |
| `POST /` (NIP-86), signature valid, not the owner | yes | no | 2 | 60/min |
| `POST /` (NIP-86), authorized | yes | no | 2 + the method's own | 60/min |
| WebSocket upgrade | yes | no | 1–2 | 60/min |
| Rate-limited, any path | no | no | 0 | — |

Four of those rows are the pass itself. `POST /` used to fetch the owner from
the DO *before* looking at the Authorization header, so a POST carrying nothing
but the management content type still woke the object and spent one of the day's
100,000 requests — the same shape as the gift wrap gate probe, an expensive
operation on the far side of no gate. `nip98.ts verifyNip98` no longer knows who
the owner is; `index.ts` asks the DO only once a valid schnorr signature over
this exact request exists. The schnorr verify moving ahead of the owner
comparison inverts that file's old ordering note, and deliberately: the
comparison came first because it was free, and it is not free any more —
obtaining the owner is what costs. ~1.1ms of Worker CPU out of 10ms is the
cheaper of the two.

`POST /api/claim` is the third, and it was the same defect wearing different
clothes: it resolved the pubkey's kind-0 over two outbound WebSockets *before*
anything had established the claim could succeed, so a relay that was going to
answer "already claimed" made two connections on a stranger's behalf to say so —
and unlike the claim itself, that stayed reachable forever. The checks that can
refuse now all run first, in `claim()`'s own order rather than in cost order, so
the status does not depend on which side of the RPC boundary answered.
`claim()` is still the authority: the Durable Object is single-threaded, and the
check-then-write inside it is what actually makes TOFU atomic.

`GET /api/profile` is the last. It is the claim form's courtesy profile preview
and nothing else — a typo guard for a one-time, irreversible setup step — and it
was permanently open, unauthenticated, uncached, and opening two outbound
WebSockets to `relay.damus.io` and `nos.lol` per request. That is worse than an
expensive read, because the cost lands on infrastructure that is not ours and
that this relay depends on: a flood pointed at it made this deployment an
amplifier toward the same two relays backfill and the claim-time lookup use, and
getting throttled or blocked by them for a stranger's traffic is a failure the
relay cannot fix from its own side. It cannot be authenticated — during a TOFU
claim there is by definition no owner to authenticate against — so the available
scope is time rather than identity: it answers while the relay is unclaimed and
404s the moment it is not, which is the same window the claim form is rendered
in. On a claimed relay, which is every relay for all but the first few minutes
of its life, the path no longer reaches the network at all. The kind-0 cache
(`profile-lookup.ts lookupProfileCached`, five minutes, negative results
included, concurrent lookups for one pubkey coalesced) is what keeps even that
window from amplifying. In-isolate rather than `caches.default`, because the
Cache API needs a custom domain and bothy's premise is a one-click deploy that
lands on `workers.dev`.

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
  per-connection subscription cap and a per-IP message throttle. On the HTTP
  side, Cloudflare's Rate Limiting binding bounds every path that wakes the
  Durable Object, per IP, before the Worker's code runs; underneath it
  `/api/stats` is still defended by cost. Every count it reports is maintained
  rather than computed, so no request walks a table at all; the two figures that
  resist a counter are cached in a row (`live_stats`) so their recompute rate is
  set by a TTL rather than by the request rate.
- **Being made into an amplifier.** `/api/profile` is the only path whose cost
  lands on somebody else's infrastructure — two outbound WebSockets to
  well-known relays per uncached miss. It is scoped to the pre-claim window,
  cached, and rate limited at a sixth of everything else.
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
  reports vanish requests still draining, so a stalled one is visible rather
  than inferred.
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
- [src/storage.ts](src/storage.ts) / [src/schema.ts](src/schema.ts) — SQLite schema and all read/write queries, including the row-cost accounting. `events.ingested_at` is wall-clock write time and must never be conflated with `created_at`: rows-written accounting and backfill's headroom guard both measure `ingested_at`, because a backfilled event's `created_at` is years old and measuring that made backfill's own writes invisible to the guard restraining them. A column, not a counter table — a counter costs a row write per event, a column costs nothing. The same argument added `events.row_cost` in v0.7.2: each event's rows-written cost is stamped at insert time so `estimateRowsWrittenSince` sums a column instead of rebuilding the figure from a `LEFT JOIN event_tags` with no index behind it, which read every tag row in the table to answer a question about the 24h window. The same argument runs the other way for `maintained_counts`/`event_hour_counts`, which DO pay a row write per event: there the alternative was a read that grew without bound, so 2 fixed rows against an event already costing 6 to 21 is the cheaper side. See CLAUDE.md "The budget".
- [src/filters.ts](src/filters.ts) — REQ filter parsing, SQL query building, in-memory match testing for live broadcast, and `expandFilter`, which splits one filter into the cross-product of its `authors` × `kinds` singletons. That split is what lets an index serve `ORDER BY created_at DESC LIMIT n`: a key column pinned to one value arrives sorted, `kind IN (1, 7)` does not, so a multi-kind filter defeats an index as thoroughly as no index at all. `storage.ts queryFilter` re-merges and re-slices to `limit`, so the split is invisible on the wire.
- [src/nostr.ts](src/nostr.ts) — wire types and kind-range classifiers (replaceable/ephemeral/addressable).
- [src/validate.ts](src/validate.ts) — event id computation and schnorr signature verification (`@noble/curves`).
- [src/ownership.ts](src/ownership.ts) — owner pubkey resolution, TOFU claim, follow-list cache, profile/icon refresh.
- [src/host.ts](src/host.ts) — this deployment's own host, learned from request traffic; lets backfill skip self-seeding.
- [src/pubkey.ts](src/pubkey.ts) / [src/bech32.ts](src/bech32.ts) — npub/hex normalization.
- [src/profile-lookup.ts](src/profile-lookup.ts) — best-effort kind-0 lookup from well-known relays, runs in the Worker only, plus the isolate-local cache in front of it (`lookupProfileCached`). The cache is not `caches.default`: the Cache API needs a custom domain (developers.cloudflare.com/workers/runtime-apis/cache/, checked 2026-08-27) and bothy deploys to `workers.dev`, so it would silently no-op on the deployment shape this project exists for. Negative results are cached and concurrent lookups for one pubkey are coalesced — without both, the cache would miss on exactly the traffic it exists to absorb.
- [src/backfill.ts](src/backfill.ts) / [src/backfill-worker.ts](src/backfill-worker.ts) — backfill state machine (DO-side, pure) and outbound fetch orchestration (Worker-side).
- [src/limits.ts](src/limits.ts) — every numeric abuse/budget cap in the project, each commented with what it bounds. The three write-path caps (event size, per-pubkey rate, non-owner storage share) are enforced in `relay.ts acceptEvent` before id/signature verification, exempt the owner from two of the three, and are each raisable or disablable by env var — disabled only by the exact string `"off"`, never by any truthy value. Also `boundFilter`, the read-abuse guard: it prices a REQ filter (`combinations × (2 × limit + 1)`, where `combinations` comes from `expandFilter` itself) against the index set declared in `schema.ts`, clamps the limit until the query is affordable, and refuses only what no limit can fix. It replaced `isUnconstrainedFilter`, which asked whether a field was *present* rather than what the query *cost* and so admitted the two shapes that read the whole table. The one cap NOT declared here is the HTTP rate limit: Cloudflare's runtime enforces it from `wrangler.jsonc` before any of this code runs, so a number here would be decorative and could silently disagree with the one in force — `limits.ts` carries the pointer and the reasoning instead.
- [src/exhaustion.ts](src/exhaustion.ts) — classifies a Cloudflare free-tier allowance being consumed and names which one; `index.ts` wraps both `fetch` and `scheduled` with it. Exists because the last outage's only symptom was an admin page that loaded the word "bothy" and no numbers — `public/` is served from `env.ASSETS` and never touches the DO, so the one part still working was the part that proved nothing. Matching is substring signatures against error text Cloudflare does not document as stable, so it fails useful rather than silent: the raw message is always logged, the resource name only added when a signature matches. Non-exhaustion errors are logged and rethrown, never converted into a quiet 503.
- [src/read-metrics.ts](src/read-metrics.ts) — **diagnostic, and expected to be removed**: in-memory attribution of rows *read* to the code path that caused them, surfaced as `reads` on `/api/stats`. Added after the live relay exhausted the 5,000,000 rows-read/day allowance under ordinary operation and nothing here could say which path spent it. Counters live in memory, never in storage — a counter costing a row write to measure a row read repeats the mistake CLAUDE.md "The budget" already rejected — so they reset on eviction and describe proportions, not daily totals. Every `SqlStorage` access in the DO goes through `instrumentSql`, so a query can be mislabelled into `unattributed` but never missed. See CLAUDE.md "The budget" for the per-call costs and the arithmetic against the ceiling.
- [src/nip11.ts](src/nip11.ts) — relay info document, and the name/description/icon resolution chain shared with `/api/stats`.
- [src/nip86.ts](src/nip86.ts) — management API method dispatch (runs in the DO; touches storage, opens nothing).
- [src/nip98.ts](src/nip98.ts) — HTTP auth verification for the management API (runs in the Worker only). Deliberately does not know who the owner is: establishing that costs a Durable Object round trip, which is the most expensive thing an unauthenticated caller can provoke on this path, so `verifyNip98` answers only what the request itself can answer and `index.ts` asks the DO afterwards (`ownerReason`).
- [public/index.html](public/index.html) — the static admin page (claim form, stats, live feed).

## Conventions

- TypeScript strict mode, no `any` in the event-handling path.
- `@noble/curves` + `@noble/hashes` only — no second crypto dependency.
- Protocol errors go back as `["OK", id, false, "reason: message"]` or `["CLOSED", subid, "reason: message"]` with the NIP-01 machine-readable prefix (`invalid:`, `restricted:`, `blocked:`, `rate-limited:`, `auth-required:`, `duplicate:`). Never fail silently.
- Comments explain *why*, especially anything hibernation- or budget-related — most modules carry inline notes on their row-write cost or CPU cost and point at CLAUDE.md "The budget" for the measured baseline.
- Cheapest/most-certain rejections run before expensive ones on every write path: ownership check and tombstone check both precede schnorr verification.
- Indexes are declared once, as data, in `schema.ts INDEXES`, and three things read that declaration: `limits.ts boundFilter` (which filters are affordable), `schema.ts eventRowCost` (what an event costs to write), and `limits.ts BACKFILL_PAGE_SIZE`/`VANISH_BATCH_SIZE` (how much work fits in a cron tick). Four on `events` — `(pubkey, kind, created_at)`, `(kind, created_at)`, `(pubkey, created_at)`, `(ingested_at)` covering `row_cost` — and two on `event_tags` — `(tag_name, tag_value, created_at)` and `(event_id)`. Adding another index therefore changes both the guard and the write accounting on its own; what it must NOT change silently is the measured baseline, so re-run `test/hibernation.test.ts`'s rows-written assertions and update the schema.ts comment and CLAUDE.md "The budget". Every accepted read filter must be answerable from one of these — that is enforced by cost, not by requiring a particular field.
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
