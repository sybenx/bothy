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
