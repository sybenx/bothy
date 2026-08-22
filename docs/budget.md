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
