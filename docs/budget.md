# Budget notes

Per-change notes on anything that measurably shifts per-event write or CPU
cost against the limits in `CLAUDE.md` "The budget". Baseline numbers
live in `docs/baselines.json`; this file is the changelog explaining how
they got that way.

## Chunk 3 — NIP-01 core lands, write-cost estimate corrected

Chunk 1's schema comment estimated 2 rows written per bare stored event
(1 base + 1 for the composite index). Measuring against a real DO
instance (`SqlStorageCursor.rowsWritten`) during chunk 3 showed the
actual cost is **3 rows**, not 2: `id TEXT PRIMARY KEY` is not a rowid
alias in SQLite, so it carries its own implicit unique index in addition
to the explicit `(pubkey, kind, created_at)` index. A reply carrying `#e`
and `#p` tags costs 7 rows, not the previously estimated 6.

This doesn't change the schema or the write-cost *shape*
(`3 + 2 * tag_count` instead of `2 + 2 * tag_count`) — no index was added
or removed — it corrects an estimate made before any code existed to
measure against. `schema.ts`'s comment and `docs/baselines.json` are
updated accordingly.

At 3 rows/event, the 100,000 rows-written/day ceiling still comfortably
covers a single owner's realistic posting volume (tens of thousands of
bare-note-equivalent writes/day before hitting the ceiling).

Schnorr signature verification measured at ~1.1ms/call (Node/V8, see
`docs/baselines.json` for caveats) — well under the 10ms Worker CPU
limit, so it is not currently a release blocker.

## Chunk 4 — ownership, admin, read-abuse limits

None of chunk 4's additions change the per-event write-cost formula
above. Specifically:

- **Claim is a one-time write**, not per-event: one `INSERT` into the new
  `owner` table (schema.ts), guarded so it can only ever happen once.
  Irrelevant to the steady-state rows-written budget.
- **`/api/stats`** is read-only. `totalEvents`/`events24h` are `COUNT`
  queries; the rows-written estimate is computed by re-deriving the
  existing write-cost formula (`3 + 2 * tag_count`) over events already
  in storage, not by tracking a separate write-per-request counter —
  adding a counter would itself cost a row write per event just to
  measure the thing the budget exists to protect.
- **ALLOW_FOLLOWS** refresh (`refreshFollows`, ownership.ts) re-derives
  the follow cache from the owner's own most recent kind-3 event
  *already stored on this relay*, not a fresh outbound fetch. This
  avoids the outbound-WebSocket-keeps-the-DO-in-memory-for-15-minutes
  cost entirely (see CLAUDE.md "The budget"), at the cost of the follow
  list only being as fresh as the owner's last kind-3 publish to this
  relay. Runs from a cron trigger, not per event, and is a full
  delete-and-reinsert of the `follows` table (write cost proportional to
  follow-list size, once per cron tick — hourly by default).
- **RETENTION_DAYS pruning** (retention.ts) is off by default (empty
  string). When set, it deletes events older than the window on the same
  cron tick as the follows refresh, reusing one of the account's 5 cron
  triggers rather than adding a second. Deletes count as writes (2 rows
  per pruned bare event, same shape as storeEvent's replace path) — this
  is an explicit tradeoff the user opts into by setting the var, not a
  cost imposed on the default deployment.
- **Read-abuse caps** (limits.ts: `MAX_SUBSCRIPTIONS_PER_CONNECTION`,
  `MAX_FILTER_LIMIT`, `MAX_EVENTS_PER_REQ`, per-IP throttling) bound
  rows-*read* and DO-request volume, not rows-written — they exist
  against the 5M rows-read/100k DO-request ceilings, which this relay's
  public read path is what's actually exposed to (CLAUDE.md "Threat
  model").
- **The outbound profile lookup at claim time** (profile-lookup.ts) runs
  in the stateless Worker, not the Durable Object, specifically so its
  short-lived outbound WebSocket to well-known relays never risks
  pinning the DO in memory. It happens once, at claim time, not per
  event.

No baseline in `docs/baselines.json` changes as a result of this chunk.

## Chunk 5 audit — ephemeral kinds (20000-29999) were being stored

`storeEvent` (storage.ts) only special-cased replaceable and addressable
kinds; anything else, including ephemeral kinds, fell through to the
plain-insert branch and was written at the full `3 + 2 * tag_count`
rows-per-event cost, forever, with no replacement or expiry to bound it.
NIP-01 says ephemeral events are not expected to be persisted at all.

Fixed by adding `isEphemeralKind` (nostr.ts) and an early return in
`storeEvent` that skips `insertEventRow` entirely for that range while
still returning the event so relay.ts's caller broadcasts it live to
open subscriptions. Net effect: ephemeral kinds now cost **0 rows
written**, down from `3 + 2 * tag_count`. This is a pure reduction —
regular/replaceable/addressable kinds are unaffected, so no baseline in
`docs/baselines.json` changes.

`45-999` and `>=40000` are undefined by NIP-01 and still fall through to
the plain-insert branch (stored like a regular event) — that's an open
question for the maintainer, not a fix, so it's not reflected here.

## Chunk 5 — deploy-form reduction, ownership check before signature verification

- **NIP-11 now costs one DO request per fetch, not zero.** Deriving
  `name`/`icon` from the owner's kind-0 profile (nip11.ts, ownership.ts
  `getOwnerProfile`) means the document depends on DO storage, so
  `GET /` with `Accept: application/nostr+json` now calls
  `Relay.getProfile()` (a cheap `SELECT` against the one-row `owner`
  table) instead of building the document from `env` alone. This is a
  read against the 100,000 DO-requests/day ceiling, not the rows-written
  one — NIP-11 is typically fetched once per client connection attempt,
  well under a single owner's realistic budget, but it's a real shift
  from "free" to "one DO request," worth knowing if that ceiling is ever
  approached.
- **`RETENTION_DAYS` and its cron pruning are removed**, not just moved
  out of `wrangler.jsonc`'s `vars` (retention.ts deleted; `Relay.runCron`
  no longer calls it). ROADMAP.md chunk 5: "Retention is not a
  deploy-time concern. Keep the capability only if inbox mode (chunk 6)
  lands, scoped to gift wraps." Net effect: one fewer `SELECT`+delete
  pass on the hourly cron tick for every deployment, since the feature
  no longer exists rather than merely defaulting off.
- **Ownership is now checked before id/signature validity** in
  `handleEvent` (relay.ts). A non-owner event is rejected on the pubkey
  check alone and never reaches `idMatchesContent` or `verifySignature`.
  This doesn't change the write-cost formula (a rejected event was never
  stored either way) but removes a schnorr verification — the single
  most expensive per-event operation, per the chunk 3 measurement above
  — from every write attempt made against someone else's claimed relay,
  which is exactly the shape of traffic a relay is likely to see the most
  of from strangers. `test/ownership.test.ts` asserts this via a
  `vi.mock` spy on `verifySignature`.
- The claim-time profile lookup itself (`profile-lookup.ts`) is
  unchanged in shape — still one outbound call from the stateless
  Worker, still once per claim — it's just now also passed into
  `claimOwner` and written to the `owner` table's new `name`/`picture`
  columns in the same one-time write already accounted for in chunk 4's
  notes above.

## Chunk 6 — inbox mode: tombstones, gift wraps, vanish requests

- **Deletion now costs 2 rows more, but only for genuine deletions.**
  NIP-09/NIP-62 both require a deleted event to stay deleted even though
  the sender (for a gift wrap, an anonymous one) may still hold their own
  signed copy and resend it. `deleted_ids` (schema.ts) is a one-row-per-id
  tombstone table, `id TEXT PRIMARY KEY` — same shape as `events.id`, so
  2 rows written per insert (base + implicit PK index, per the chunk 3
  correction above). `storage.ts`'s new `deleteAndTombstone` wraps the
  existing `deleteEventRow` with this insert, used only by
  `applyDeletion`, `applyAddressDeletion`, and `applyVanish`. Net: a
  NIP-09/NIP-62 delete goes from `3 + 2*tags` to `5 + 2*tags` rows written
  (a bare note: 3→5; an `#e`+`#p` reply: 7→9). **Not** applied to
  `storeEvent`'s replaceable/addressable replacement path (an old kind-0
  or kind-10002 version being superseded by a newer publish) — that path
  still calls plain `deleteEventRow`, since a superseded version has no
  adversarial replay risk to guard against and this would otherwise add
  +2 rows to every single profile/relay-list edit, forever.
- **Gift wraps (kind 1059) cost the same as any other regular-kind event**
  — `3 + 2*tags` rows written, and NIP-59 gift wraps only ever carry one
  tag (`p`), so 5 rows per stored gift wrap in practice. No schema or
  write-cost-formula change; storeEvent's default branch already handles
  it as a regular kind.
- **Abuse caps chosen against the 100,000 rows-written/day ceiling**
  (limits.ts): `MAX_GIFT_WRAPS = 2000` bounds concurrently-stored gift
  wraps (worst case ~10,000 rows if every one carried its max tag count,
  well inside a day's budget with room for the owner's own traffic);
  `MAX_GIFT_WRAP_BYTES = 64KB` bounds any single write; the per-IP gift
  wrap throttle (`MAX_GIFT_WRAPS_PER_IP_PER_WINDOW = 5` per
  `GIFT_WRAP_RATE_LIMIT_WINDOW_MS = 60s`) is what actually protects the
  daily ceiling from a sustained flood, since it's a rate rather than a
  one-time cap — at 5 rows/gift wrap and 5/minute/IP, one IP alone could
  reach at most ~36,000 rows/day, comfortably under the ceiling even
  before the general per-connection message limiter or a
  Cloudflare-level rate rule ever engages.
- **NIP-62 vanish requests are not stored** (the spec says relays MAY
  keep them for bookkeeping, not MUST) — zero row cost for the request
  itself, only for whatever it deletes, at the same `+2`/event marginal
  rate as any other deletion. This is the one write-cost risk in this
  chunk worth flagging rather than fully mitigating: a single large
  vanish (years of accumulated gift wraps, say) runs synchronously in one
  pass and could consume a real fraction of the daily rows-written
  ceiling in one request. Deliberately not built out with resumable/cron
  processing — that's speculative complexity for what should be a rare,
  one-time action — but it's worth knowing about if a vanish request ever
  seems to time out or partially apply.
- **NIP-42 AUTH is real now** (a challenge is actually issued and
  checked, not just answered unconditionally) but costs nothing new in
  rows: challenges live in the WebSocket attachment (already-paid-for
  per-connection state, like `subs`), never in SQLite.
- **The gift wrap read gate probe: 1-2 rows read per filter, index-driven,
  against the 5,000,000/day ceiling — never the rows-written one.** The
  first version of this gate tried to decide "could this filter return a
  kind-1059 row" by pattern-matching the filter's shape
  (`kinds`/`authors`/`ids`/tags), reasoning that an `ids`-only filter
  couldn't be a discovery vector since ids are unguessable content
  hashes. That reasoning held for a stranger with no prior knowledge, but
  missed the actual promise this relay makes ("serve gift wraps only to
  the authenticated recipient," no exception for "already knows the
  id") — an ids-only REQ naming a real, already-known gift wrap id sailed
  through ungated. Fixed by re-running the filter restricted to
  `kinds: [1059], limit: 1` against real storage instead of
  pattern-matching it (relay.ts handleReq).

  This probe only ever runs when the filter's own `kinds` is absent —
  when `kinds` is present (whether or not it names 1059), the decision is
  made in JS against the filter object with zero storage cost, which
  covers most real-world REQs (a client that already knows what it
  wants asks for specific kinds). When `kinds` is absent,
  `isUnconstrainedFilter` guarantees the filter still carries `ids`,
  `authors`, or a `#<letter>` tag — so the probe's generated SQL (see
  filters.ts `buildFilterQuery`) always has an equality condition on one
  of: the `events` primary key (`ids`), the leftmost column of
  `idx_events_pubkey_kind_created` (`authors`), or the leftmost columns
  of `idx_event_tags_lookup` (a tag filter). It never runs as "kind
  alone," which is the one condition with no supporting index (see this
  file's own schema.ts comment on why that second index was rejected).

  Measured directly via `SqlStorageCursor.rowsRead` (same method chunk 3
  used for `rowsWritten`) rather than assumed:

  | Scenario | rows read |
  |---|---|
  | `authors` probe, empty database | 1 |
  | `authors` probe, owner has 500 kind-1 notes, zero gift wraps | 1 |
  | `authors` probe, 500 notes + 1 matching gift wrap | 2 |
  | `ids` probe, 2,000 unrelated events in the table | 1 |
  | `#p` tag probe, 2,000 unrelated events, no `p`-tag rows at all | 2 |

  The cost tracks the *filter's own* selectivity (how many rows share its
  pubkey/tag), not the table's total size or the relay's total gift wrap
  count — the 500-notes and 2,000-events cases cost the same 1-2 rows as
  the empty database.

  **No explicit "zero gift wraps" fast path exists, and one should not be
  added.** The natural way to write one — check `giftWrapCount(sql) === 0`
  (storage.ts, already used by the write-side storage cap) before running
  any per-filter probe — was measured too: `SELECT COUNT(*) FROM events
  WHERE kind = 1059` read **2,000 rows** against the same 2,000-row table,
  i.e. a full scan, because `kind` alone isn't the leftmost column of any
  index. That's strictly worse than the per-filter probe it would be
  guarding, and worst for exactly the case it's meant to help (a relay
  with zero gift wraps still has to scan every row to prove none exist).
  Indexing `kind` to fix that would multiply the per-event write cost for
  *every* event forever, which schema.ts's own comment already rejected
  for this exact reason when chunk 4 considered a `(kind, created_at)`
  index. The probe's existing index-driven, filter-scoped design already
  delivers what a "zero gift wraps" fast path would have promised — cheap
  regardless of gift wrap count — without paying for a new index or a
  full scan to get there.

## Chunk 7 (live feed) — a second, deliberately narrow broadcast path

The admin page's live feed (`GET`-upgraded `/live`, `relay.ts` `liveBroadcast`)
adds zero rows-written cost — it's a push notification derived from an
event already being stored/broadcast, not a new write. What it does add:

- **One extra `ctx.getWebSockets(LIVE_FEED_TAG)` call and a `JSON.stringify`
  per stored event**, gated on `live.length === 0` first so a claimed
  relay with the admin page closed pays nothing beyond the array lookup.
  Negligible next to the schnorr verification already paid for every
  write (chunk 3's ~1.1ms baseline dwarfs this).
- **No new rows-read either.** The live feed is push-only and never
  queries storage — it only ever forwards fields already present on the
  `NostrEvent` object `acceptEvent` just finished handling.
- **Deliberately not built on the existing REQ/broadcast path.** Reusing
  `handleReq`'s filter engine would have required either exempting the
  live feed from `isUnconstrainedFilter` (CLAUDE.md "Threat model": every
  other REQ must name `authors` or `kinds`) or making it name every kind
  explicitly, both worse than a dedicated tag: a second `ctx.getWebSockets`
  bucket costs nothing extra in DO duration (hibernation applies per
  connection regardless of tag) and sidesteps the gift-wrap NIP-42 read
  gate entirely by construction — `liveBroadcast` never sends kind 1059
  to anyone, so there's no per-viewer auth state to track for it.
- **Idle-timeout is client-enforced first, cooperatively** — the admin
  page closes its live feed WebSocket on `visibilitychange` (tab hidden),
  which is what keeps a merely-backgrounded tab free under normal use. A
  background tab simply closes its own connection; hibernation already
  makes a visible-but-quiet tab free.
- **A server-side ceiling backs the client one up, for the case the
  client never cooperates** — a tab left visible indefinitely, or any
  other client speaking the `/live` protocol directly without ever
  closing (`relay.ts` `scheduleLiveFeedAlarm`/`alarm`). `LIVE_FEED_MAX_LIFETIME_MS`
  (limits.ts) is **10 minutes**: no live feed connection can survive past
  that regardless of client behavior, and a client that wants to keep
  watching just reconnects, which the admin page already does
  automatically. This is a real DO alarm (`ctx.storage.setAlarm`), not an
  in-memory timer, so it's hibernation-compatible — the object can evict
  between the connection opening and the alarm firing and still gets
  woken to enforce it (CLAUDE.md "The budget": duration only stays cheap
  if hibernation actually works). Cost: at most one `setAlarm` write per
  "wave" of live feed connections, not one per connection —
  `scheduleLiveFeedAlarm` only calls it when no earlier alarm is already
  pending, and `alarm()` reschedules itself for whatever's next rather
  than a fresh caller re-arming it. In the steady state (one admin page
  tab, reconnecting every ~10 minutes) that's one write per ten minutes
  of active viewing, and zero while the tab is closed or hidden.
- **`MAX_LIVE_FEED_CONNECTIONS = 5`** bounds concurrent live feed sockets
  independent of the lifetime cap — caps worst-case per-event broadcast
  fan-out (`liveBroadcast` iterates every open one) and how much
  attachment state the object carries, at a cost of zero rows (rejected
  at the WebSocket upgrade, before any storage is touched).

## Chunk 7 — one-shot backfill

- **The Durable Object's CPU allowance is not the Worker's 10ms/request
  limit.** Checked against `developers.cloudflare.com/workers/platform/limits/`
  and `developers.cloudflare.com/durable-objects/platform/limits/`
  (2026-08-22): the Worker's 10ms/request ceiling (this file's table
  above) is a Workers-Free HTTP-request number; a Durable Object gets its
  own, much larger CPU budget — **30 seconds by default per incoming
  request or RPC call** (configurable up to 5 minutes via
  `limits.cpu_ms`), reset on every new invocation. An RPC method call
  (`env.RELAY.get(id).ingestBackfillPage(...)`, the same mechanism
  `claim()`/`getStats()` already use) counts as one such invocation, not
  as a fetch subject to the Worker's own limit. At the chunk 3 baseline of
  ~1.1ms/schnorr-verify, a `BACKFILL_PAGE_SIZE` in the low hundreds
  (limits.ts) costs roughly 150–220ms of DO CPU per ingest call — under 1%
  of the DO's own budget, nowhere near a constraint. This directly changed the design:
  the original plan assumed small (~10-event) batches to stay under a
  10ms ceiling that turns out not to apply here.
- **The real constraint is rows-written, not CPU**, so `BACKFILL_PAGE_SIZE`
  is instead sized against the 100,000 rows-written/day ceiling: one page
  from exactly one relay per hourly cron tick (`runBackfillTick` fetches a
  single `nextRelay`, not one page per relay — `getBackfillStatus` hands
  back only one relay to work on at a time). **The arithmetic here was
  wrong from the start and is corrected in the v0.3.3 note at the end of
  this document** — it assumed ~5 rows/event, where real backfilled history
  measures 13.0, and the resulting page size overran the reserved share
  rather than fitting inside it.
- **Backfill reuses `storeEvent` (storage.ts) rather than reimplementing
  storage semantics**, so replaceable/addressable/ephemeral handling is
  identical to the live write path by construction: several old versions
  of the owner's kind 0 arriving in one page collapse to the one row
  `storeEvent`'s replaceable-kind branch already keeps, and ephemeral
  kinds are dropped the same way `storeEvent` already drops them for live
  writes (chunk 5 audit, above) — zero additional row cost, and no new
  code path to keep in sync with the write-cost formula. The one place
  this needed a correction rather than a reuse: `storeEvent`'s `stored`
  field means "broadcast-worthy" (true even for a dropped ephemeral
  event, so relay.ts's live path still forwards it to subscribers), not
  "a row was written" — backfill.ts's own stored-count (surfaced on the
  admin page) explicitly excludes ephemeral kinds from that count so
  progress reporting isn't inflated by events that cost zero rows.
- **Exact-id duplicates cost one `SELECT` (rows-read), not a wasted
  write.** The same event routinely comes back from every write relay
  that has it; `applyBackfillPage` checks `eventExists` (and `isDeleted`
  for tombstones) before `idMatchesContent`/`verifySignature`, the same
  cheapest-check-first ordering `relay.ts`'s live accept path already uses
  for ownership and tombstones — a duplicate or already-deleted id never
  reaches a schnorr verification, let alone an insert.
- **A rows-written quota failure mid-page is caught, not fatal to the
  tick.** `storeEvent` throwing (CLAUDE.md: "Exceeding them fails
  operations rather than billing the user") stops the page immediately
  and leaves `backfill_meta.status = 'paused-budget'` without advancing
  the failed relay's cursor past whatever didn't get durably stored —
  the next successful tick (after the daily reset) resumes from exactly
  that point rather than silently skipping it.
- **Backfill reserves at most half the daily rows-written ceiling for
  itself, and checks it twice.** The `paused-budget` handling above only
  fires *after* a write has already failed — reactive, not preventive,
  and "a relay that can't accept the owner's new note because it's busy
  importing 2023 has the priority backwards." `hasBackfillHeadroom`
  (backfill.ts) reads the same rolling 24h rows-written estimate
  `/api/stats` displays and refuses to let backfill write at all once it
  already accounts for more than `BACKFILL_ROWS_SHARE_LIMIT` (limits.ts,
  half the daily ceiling) — reserving the other half for the owner's own
  traffic regardless of how much of backfill's own half it has already
  spent earlier in the window. Checked twice: `getBackfillState` (relay.ts)
  so the Worker's cron tick skips opening an outbound socket at all on a
  day live traffic already dominates, and `applyBackfillPage` again,
  authoritatively, immediately before writing — live traffic can consume
  real quota during the several-second outbound round-trip in between, so
  only the second check actually protects the reserved share.
- **Fixed a real "too many SQL variables" failure in the rows-written
  estimate query itself**, found while adding a test for the headroom
  check above. The original `rowsWrittenEstimate24h` (chunk 4) fetched
  matching event ids and then ran a second query with one bound
  parameter per id (`WHERE event_id IN (?, ?, ?, ...)`) to count their
  tags — fine for the handful of events a personal relay normally sees in
  24h, but it throws once that count climbs into the thousands, which is
  now a live path: `hasBackfillHeadroom` calls this same function while
  the 24h window may contain exactly that kind of burst. Rewritten as one
  `LEFT JOIN events ⋈ event_tags ... GROUP BY e.id` query with a single
  bound parameter (the cutoff timestamp) regardless of how many events
  match — no per-row parameter, so no ceiling on how large the window can
  get. Same read-only, rows-read cost as before, just one query instead
  of two.

## NIP-51 mute list (added in v0.2.0, removed in v0.2.2)

Mute-list-based write revocation existed for one release: a `mutes`
table and cron/immediate-refresh logic mirroring ALLOW_FOLLOWS's follow
cache. It was removed because a relay-level mute doesn't accomplish what
it looks like it does — bothy is meant to be one of several relays in
the owner's NIP-65 list, so blocking someone here never stopped the
owner's client from seeing them via another relay; muting is a client
concern, not a relay one. The removal drops the `mutes` table (via a
one-time `DROP TABLE IF EXISTS` in `initSchema`) and adds no new cost of
its own — see the v0.2.2 release notes for the full rationale.

## Immediate follow refresh on owner writes, and stats visibility

Previously `refreshFollows` only ran on the hourly cron tick, so a
follow the owner just added couldn't write for up to an hour, and a
relay whose owner had never published a kind-3 here had a silently
empty allowlist with no visible signal. `relay.ts`'s `acceptEvent` now
calls `refreshFollows` right after a successfully stored kind-3 event
whose pubkey is the owner's — the same delete-and-reinsert
`refreshFollows` already does on cron, just triggered sooner. Gated on
`event.pubkey === owner`, not just `event.kind`, so a follow's own
kind-3 (reachable under ALLOW_FOLLOWS) can never be mistaken for the
owner's and used to drive the refresh.

Write-cost impact: none in the steady state. A contact list edit is a
rare, human-paced event, not a per-note cost — the extra
delete-and-reinsert this triggers happens at most as often as the owner
edits their follows, which is orders of magnitude less frequent than
their regular note-publishing rate this project already budgets for. No
new baseline is added to `docs/baselines.json`; the existing
cron-triggered refresh already accounts for the same table's write cost,
and this only changes *when* it fires, not the total volume over a day
of normal use.

`Relay.getStats()`/`GET /api/stats` also report `writePolicy` ("owner" |
"follows"), `followCount`, and `followsRefreshedAt` — cheap `COUNT`/`MAX`
reads over an already-small table, no new write cost. The admin page
(`public/index.html`) renders these as a plain-language sentence rather
than a bare number specifically so `writePolicy: "follows"` with
`followCount: 0` — an enabled but functionally empty allowlist blocking
every follow — is legible as a problem, not a healthy zero.

## NIP-86 relay management (added in v0.3.0)

Phase one was scoped by exactly one rule: nothing that adds a per-event lookup. That is what decided which NIP-86 methods landed and which did not.

The three new tables (`banned_events`, `blocked_ips`, `relay_settings`, see schema.ts) cost nothing on the per-event write path. `banned_events` and `relay_settings` are written only by an authenticated management call, at operator pace — a handful of rows in the lifetime of a relay, against a 100,000 rows-written/day ceiling. `banevent` additionally writes a `deleted_ids` tombstone, which is the same 2-row cost NIP-09 deletion already pays and is accounted for in the chunk 6 notes above.

The only one of the three that is read on a client-facing path is `blocked_ips`, and it is read exactly once per WebSocket connection in `Relay.fetch`, before `acceptWebSocket`. One indexed lookup per connection, not per message and not per event: at the observed traffic shape (see the requests-by-type breakdown in the Cloudflare dashboard, where HTTP upgrades are a small fraction of total DO requests and WebSocket messages dominate) this is invisible against the 5,000,000 rows-read/day ceiling. Checking per message instead would have put a storage read in front of every frame on a table that is almost always empty, which is precisely the trade this phase refused to make.

`banpubkey`/`allowpubkey` are deferred for the same reason in reverse. Enforcing a pubkey ban means a lookup on every incoming event, on the hot path, in front of the write. That is a real cost against the rows-read ceiling and a real addition to per-event CPU, and it deserves a measured baseline before it lands rather than after — which is why a metrics baseline was taken against the deployed relay before this work started.

Authentication cost sits in the Worker, not the Durable Object. A NIP-98 verification is one schnorr verify (~1.1ms, docs/baselines.json) plus a SHA256 of the request body, and it happens before any RPC into the DO, so a forged management request costs zero DO time and zero rows. Within the verification itself the ownership comparison precedes the schnorr verify, the same cheapest-first ordering the write path uses: a stranger's syntactically perfect authorization is rejected by a string comparison rather than by curve math.

## Rows-written accounting corrected (v0.3.1)

`estimateRowsWritten24h` was measuring the wrong thing, and the gap was large enough to invalidate a baseline: Cloudflare reported **33,000 rows written** over a 24h window in which this function reported **729**.

The function filtered on `events.created_at`, which is when the author says they signed an event, not when this relay wrote the row. For live traffic the two coincide, which is why the bug survived. For backfill they do not: a backfilled event carries its original timestamp, frequently years old, so every row backfill wrote fell outside the window and cost nothing as far as this function could tell.

That was cosmetic on the admin page and structural in `backfill.ts hasBackfillHeadroom`, which calls the same function to decide whether backfill may write. The guard reserving half the daily ceiling for the owner's own traffic was blind to the only writer it exists to restrain. Backfill could never throttle itself, because by its own measurement it had never written anything.

The fix is an `ingested_at` column on `events`, set to wall-clock now at insert. A counter table was considered and rejected again for the reason recorded earlier in this document — a counter incremented per stored event costs a row write per event, which fights the thing the stats endpoint exists to make visible. A column does not: a row write is a row, not a column, and `ingested_at` is added to an INSERT this code already performs. **The per-event write cost is unchanged at 3 + 2 × (single-letter tag count).** No index covers the new column, and none should; an index would cost exactly the per-event row the column was chosen to avoid.

An in-memory counter with periodic persistence was the other candidate and was rejected on hibernation grounds. This object is designed to be evicted between messages and spends most of its life hibernating, so an in-memory counter would be lost between hourly cron ticks almost every time — and it would fail in the dangerous direction, reporting less usage than reality and telling backfill it had headroom it did not have. Flushing often enough to bound that loss reintroduces the per-event write.

What the estimate still does not count: a row written and then deleted inside the same window drops out, and neither the deletion's own write nor any tombstone is counted. Both make the number a floor rather than a ceiling. That is the safe direction for the budget guard, which will only ever believe it has *less* headroom than the raw figure suggests, never more.

Existing deployments carry NULL in `ingested_at` for every row written before the migration, and NULL never satisfies `> cutoff`. That undercounts for at most the single 24h window straddling the upgrade, and is exact thereafter. Backfilling the column from `created_at` would have reintroduced the exact conflation being removed.

The admin page changed alongside it. `events24h` counts by `created_at` and now says so — "events dated in the last 24h" — and a second figure, "events received, last 24h", reports what the relay actually ingested. Previously the page carried two headline numbers that both understated the same day's work: 9 events and 729 rows, on a day that saw thousands of events and 33,000 rows.

## Backfill's write projection was wrong by 2.6x (corrected in v0.3.3)

The chunk 7 note above sized `BACKFILL_PAGE_SIZE` against an assumed **~5 rows per stored event**. That number was never measured; it was carried over from the gift-wrap estimate, where a NIP-59 wrap really does carry a single `p` tag. Real backfilled history does not look like that.

The first honest measurement was only possible after v0.3.1, because until then `estimateRowsWritten24h` filtered on `created_at` and could not see a single row backfill wrote. One tick, immediately after that fix landed:

```
204 events ingested,  2,642 rows written        (/api/stats)
  4 of those were live writes accounting for 42 rows
=> 200 backfilled events, 2,600 rows
=> 13.0 rows per backfilled event
```

Which reconciles exactly against the per-event cost at the top of `schema.ts`:

```
13 = 3 base rows + 2 x 5 indexed tags
```

A real note carries about five single-letter tags — `e` and `p` on replies, plus the rest — not the one or two the old estimate assumed. So the projection was off by a factor of 2.6, and in the direction that matters:

| | rows/event | worst case/day | vs. the 50,000 reserved share |
|---|---|---|---|
| assumed | 5 | 24,000 | 48% |
| measured | 13 | **62,400** | **125%** |

Backfill was sized to overrun its own reserved half by a quarter. It only ever got away with it because the guard meant to stop it — `hasBackfillHeadroom`, which calls the same broken estimate — was equally blind. Two errors that cancelled: an under-projection nobody could check, and a guard that could not see what it was guarding.

Fixing the accounting removed the cancellation. With the guard working, the old page size would not have exceeded the ceiling; it would have tripped the reserved-share limit partway through each day and stalled backfill until the window rolled. Correct behaviour from a correct guard, and a bad way to run a backfill.

**The guard was not changed. The page size was.** `BACKFILL_PAGE_SIZE` drops 200 → 128, sized so the daily worst case lands at about 80% of the reserved share:

```
128 events x 13 rows x 24 ticks/day = 39,936 rows/day   (80% of 50,000)
```

The remaining 20% is deliberate margin, not slack: it absorbs history heavier than the measured average, up to ~16 rows/event (about 6.5 indexed tags) before the projection would reach the share at all. Beyond that the guard throttles, which is now the correct outcome rather than a silent overrun.

Backfill gets slower — 128 events/hour instead of 200, about 3,000/day — and that is the right trade. Backfill is a one-shot job that runs unattended for as long as the owner's history requires; the owner's own live writes are not.

The lesson worth keeping: this constant was justified in a comment, in prose, with arithmetic, and was still wrong, because the input to the arithmetic was assumed rather than measured. The comment now shows its measurement and where it came from.
