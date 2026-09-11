# The budget

The measurements and arithmetic behind bothy's design on the Cloudflare
Workers free tier. Internal, like [principles.md](principles.md);
reasoning is allowed here. The costs that a design choice was made
against are in [decisions.md](decisions.md); what they defend is in
[threat-model.md](threat-model.md).

Everything here runs on the Cloudflare Workers free tier, and the ceilings are
what shape the design. Per day, per account: **100,000 rows written**,
**5,000,000 rows read**, 5GB of SQLite storage per Durable Object, 10ms of
Worker CPU per request. Allowances reset at 00:00 UTC. Rows written and rows
read are the two that bind; storage and CPU are not close.

Every figure below is asserted by the suite — [test/hibernation.test.ts](../test/hibernation.test.ts)
for rows written, [test/read-cost.test.ts](../test/read-cost.test.ts) for rows read —
so the tests are the record and a change that moves one fails rather than
drifting. The one cost the suite cannot assert is schnorr verification, because
the workerd test harness does not expose isolate CPU time; that number and its
caveat sit on `verifySignature` in [src/validate.ts](../src/validate.ts). Below,
**E** is rows in `events` and **T** is rows in `event_tags` (≈ 5E for real notes,
which carry about five single-letter tags each).

## Rows written, per stored event

```
measured   9 + 3 × (single-letter tag count)
charged   12 + 4 × (single-letter tag count)   <- deliberately high, see below
```

Six for the event row: one base row, one for the implicit unique index behind
`id TEXT PRIMARY KEY` (a TEXT primary key is not a rowid alias), and one for each
of the four declared indexes on `events`. Three more for the maintained counters
(`maintained_counts`, `event_hour_counts` and `ingest_hour_counts`, all unindexed or
rowid-aliased, so one row apiece). Three per indexed tag row: the row and its two
indexes. A bare note costs 9, a reply carrying `#e` and `#p` costs 15, a real note
carrying about five tags costs 24. A delete is a write too, so a replacement or a
NIP-09 deletion costs this shape again, plus 2 for a tombstone.

`eventRowCost` charges more than an event costs, on purpose. The three
REQ-serving indexes on `events` and the tag lookup index are declared as
partial PAIRS keyed on `is_group` (one half over the public partition, one
over the group partition), and a stored row satisfies exactly one half of
each pair — so it pays one index entry per pair, exactly what the single
index it replaced cost. `EVENT_BASE_ROW_COST` is
`2 + indexesOn("events").length` and counts the halves separately, so a real
five-tag note is charged 32 and spends 24.

Left wrong, because every consumer of that number is a GUARD and an
over-estimate makes each of them stricter rather than looser:
`BACKFILL_PAGE_SIZE` fetches smaller pages, `VANISH_BATCH_SIZE` drains fewer
events per tick, `hasBackfillHeadroom` stops sooner, and the `row_cost`
stamped on each row reads high. Slower, never overrunning — the same
direction `eventRemovalBudget` is deliberately wrong in.
[test/hibernation.test.ts](../test/hibernation.test.ts) pins the measured cost,
the charged cost and the gap between them, so the wrongness cannot drift and
a fix cannot land quietly. The one place it is NOT safe is
`auditMaintainedCounts`' rows-written check, which is a floor: a floor above
what the meter can report is a daily false alarm, so that one comparison
converts the stamped sum back through `eventRowCostMeasured`. When the
derivation is fixed, the two become equal and that arithmetic goes with it.

The three counter rows are the price of `/api/stats` no longer scanning or
sampling anything at all — 3 rows written per event against ~1,100 events/day
here, so ~3,300 of 100,000, to remove a ~3E read that grew without bound
(`totalEvents`, `events24h`) and two window scans behind a five-minute cache
(`ingested24h`, `rowsWrittenToday`). `schema.ts EVENT_COUNTER_ROW_COST` declares
it and `eventRowCost` folds it in, so backfill's page sizing, the vanish drain's
pacing and the admin page's budget bar all see it; a counter cost paid at the
write site but hidden from those guards would be the same shape of error that
made `estimateRowsWrittenSince` wrong by 45x.

The third row does double duty, and that is why it is affordable. It is the
ingest-hour bucket behind `ingested24h`, and it is also where the **measured**
rows-written total lands: `read-metrics.ts` wraps `SqlStorage` once in the Relay
constructor, so every cursor's `rowsWritten` accumulates without any query being
instrumented by hand, and `insertEventRow` folds the running total into the
bucket UPDATE it was already issuing. Measuring what the relay writes therefore
costs nothing on the path that dominates the budget. Only writes with no bucket
of their own — cron ticks, the follow rebuild, NIP-86 calls — pay a row to land
their total (`storage.ts settleRowsWritten`), on the order of thirty a day.

A wrapper rather than per-path reporting, deliberately: a path that must remember
to report is a path that will eventually forget, and nothing catches it. This
codebase has that history — `BACKFILL_PAGE_SIZE` was hand-maintained and silently
wrong three times. The wrapper can mis-attribute an hour; it cannot be forgotten.

**Where the count lands is the correctness property.** The accumulator is
instance memory, and this relay wakes ~70 times per cron interval, so a flush on
a timer or one deferred to the next tick would lose roughly 98% of the count —
and lose more of it the quieter the relay is, which is the failure mode nobody
would notice. Every Durable Object entry point therefore lands its own total
before returning (`relay.ts metered`).

**Removals are accounted explicitly, on top of the wrapper.** `SqlStorageCursor`
reports index maintenance on INSERT but not on DELETE, so a wrapper-only figure
undercounts every removal, which is the wrong direction for a budget meter.
`deleteEventRow` adds `eventRemovalBudget` — the pessimistic figure the vanish
drain is already paced against — over what the cursor reported, accepting the
double-count of the portion the cursor did see. Leaning high is the call
`schema.ts` already made for the drain, and it is made here for the same reason.

Prediction and measurement stay separate. `eventRowCost` answers "what will this
cost" before doing it, which is what sizes backfill pages and paces the vanish
drain; the wrapper answers "what did we spend". Neither feeds the other —
`estimateRowsWrittenSince` survives as backfill's headroom guard alone, where
seeing only event writes is correct, since deletion traffic is bounded by its own
reserved share.

`schema.ts eventRowCost` derives this from `INDEXES` rather than restating it, so
adding an index updates the admin page, backfill's headroom guard and
`BACKFILL_PAGE_SIZE`'s sizing at once. `events.row_cost` stamps the figure at
insert time so `estimateRowsWrittenSince` can sum a column.

## Rows written, per NIP-29 membership change

Measured (`test/nip29-groups.test.ts`), at a 21-member list going to 22:

```
the kind-9000 itself      9 + 3 x 2 tags (`h`, `p`)                  15
group_members row         1 base + 1 PK index                         2
allowed_pubkeys row       1 base + 1 PK index                         2
removing the old 39002    22 tag rows + 1 event row + 3 counters      26
storing the new 39002     9 + 3 x 23 tags                             78
                                                                    ---
                                                                    123
```

The kind-39002 member list dominates, and it is **replaced in place, not
accumulated** — it is an addressable kind, so `storeEvent`'s addressable
branch removes the previous version keyed by (pubkey, kind, `d`). No
tombstone: a replacement is not a deletion. It grows at 3 rows per member
on the insert and 1 on the removal, so **~4 rows per member per membership
change on top of a fixed ~45**. A twenty-person group churns ~123 rows per
change; a two-hundred-person one would churn ~845. Against the 100,000/day
ceiling that is ~800 membership changes a day at twenty members and ~118 at
two hundred — which was written down as the number to look at before this
grew a self-service join path, since a join path is what turns "the owner
occasionally adds somebody" into a rate strangers choose. It has now grown
one, and the section below is that arithmetic.

The kind-39000 metadata and kind-39001 admin list are NOT in that figure:
neither changed, so neither was rewritten. Regenerating all three on every
membership change would have added ~60 rows to it for no change in content.
Re-adding a member who is already in the group costs 15 — the moderation
event, which is part of the group's canonical history, and nothing else.

## Rows written, per invite and per join

Measured (`test/nip29-invites.test.ts`), against the same 21-member list:

```
issuing an invite (kind 9009)
  the kind-9009 itself      9 + 3 x 1 indexed tag (`h`)                12
  group_invites row         1 base + 1 PK index                         2
  regeneration              nothing changed                             0
                                                                      ---
                                                                       14

redeeming one (kind 9021)
  the kind-9021 itself      NOT STORED                                  0
  spending the invite       1 row updated in place                      1
  group_members row         1 base + 1 PK index                         2
  allowed_pubkeys row       1 base + 1 PK index                         2
  removing the old 39002    22 tag rows + 1 event row + 3 counters      26
  storing the new 39002     9 + 3 x 23 tags                            78
                                                                      ---
                                                                      109
```

The kind-9009 costs 12 and not 15 because `code` is a multi-character tag
name and `event_tags` indexes single letters only — the code lives in the
event body, where a reader entitled to the group partition can see it and
no tag filter can be pointed at it.

A join is CHEAPER than the put-user it replaces (109 against 123): the 15
rows a kind-9000 spends on its own event row and tags become the 1 row the
invite spends marking itself spent, because the request is never stored.
The member list dominates either way, so the ~4 rows per member per
membership change holds unchanged. What is new is who chooses the rate, and
`MAX_OUTSTANDING_INVITES` is what bounds it: 64 live invites redeemed all at
once is ~7,000 rows, ~7% of the daily ceiling. A refused join writes **0**.

## Rows written, per push and per hour of a call

Measured (`test/push.test.ts`, and derived in `limits.ts`):

```
one message notification, however many devices it reaches
  the kind-9 itself           9 + 3 x 1 indexed tag (`h`)             12
  queueing it                 1 outbox row + 1 PK index                2
  scheduling the alarm        setAlarm                                 1
  clearing the outbox row     base + index                             2
                                                                     ---
                                                                      17

each further message inside the coalescing window
  the kind-9 itself                                                    12
  folding it into the queued row (1 row updated in place)                1
                                                                     ---
                                                                      13

registering a device (subscribepush)   1 base + 1 PK index              2
disposing of a 404/410 endpoint        base + index                     2
a successful push                      0, or 1 once a day per endpoint
a refused push                                                          0
```

The fan-out writes NOTHING per endpoint on the ordinary path, so a
notification reaching sixty devices costs the same 17 rows as one reaching
one. That is the second place the presence lesson had to be applied:
`push_subscriptions.last_ok_at` is the field reference/push.md asks for
("when it was last seen working"), and refreshing it on every successful
send would have been one row per device per notification — thousands a day
to maintain a column whose only conceivable reader is a sweep of
long-dead endpoints. It is refreshed at most once a day per endpoint
(`limits.ts PUSH_LAST_OK_INTERVAL_SECONDS`), which is far finer than that
reader would need, and the disposal that actually matters does not wait
for it at all: a 404 or 410 deletes the row on the spot.

What sixty devices costs is SUBREQUESTS, which is a different ceiling and
is bounded separately — see below.

Presence is the one that could have been ruinous and is not. hearth beats
every five seconds while somebody is in a call, so a stored beat would be
a row write every five seconds per participant:

```
ten people in a call, one hour, one write per beat        72,000 rows
ten people in a call, one hour, as written                   900 rows
```

That is 0.9% of the day's ceiling against 72% of it. The interval is
derived rather than chosen (`limits.ts PRESENCE_WRITE_INTERVAL_SECONDS`):
one percent of `DAILY_ROWS_WRITTEN_LIMIT` per hour, divided by a ten-person
reference call, is one write per 36 seconds, rounded UP to a whole
heartbeat because a write that would land between beats does not happen
until the next one — 8 beats, 40 seconds. `PRESENCE_STALE_SECONDS` then
falls out of that: a live row is refreshed on the first beat at or after
the interval, so it is never older than the interval plus one beat, and
45 seconds is therefore exactly the boundary between "has been beating all
along" and "arrived". Seven beats in eight cost nothing at all, answered
from the in-memory tier (`relay.ts presenceWrites`); the eighth costs one
read and one write.

The cost of that coarseness is stated where it is paid: the stored tier
resolves presence at 45 seconds rather than hearth's 13, so somebody whose
connection drops and comes back inside 45 seconds of an EVICTION is
treated as having been there all along and is not announced twice. That is
the right direction to be wrong in — a reconnect is not an arrival, and
announcing one would be a quieter version of the twelve-a-minute noise the
whole design exists to avoid. A deliberate `{"status":"leave"}` beat
clears the row, so leaving and coming straight back IS announced.

## Subrequests, which is the ceiling the fan-out actually hits

Rows are not what bounds a push. Workers Free allows **50 subrequests per
invocation** (developers.cloudflare.com/workers/platform/limits/, checked
2026-08-30) and every push is one outbound HTTPS request. Twenty members
with a phone, a laptop and a home-screen install each is sixty endpoints,
so a fan-out written inline inside the request that stored the message
starts failing at exactly the group size this was built for — and fails at
the fifty-first request rather than the first, which is a partial delivery
nobody notices rather than an error.

The bound, derived in `limits.ts`:

```
WORKER_SUBREQUEST_LIMIT                 50   platform, Workers Free
PUSH_SUBREQUEST_RESERVE                 10   left unspent
MAX_PUSHES_PER_TICK                     40   one alarm invocation
PUSH_MAX_TICKS                           4   invocations one notification may span
MAX_PUSH_ENDPOINTS_PER_NOTIFICATION    160   = 40 members at the 4-device cap
```

Endpoints past `MAX_PUSHES_PER_TICK` are DEFERRED, not dropped: the outbox
row carries a cursor (ordered by endpoint, which survives a subscription
being added or removed mid-fan-out where a rowid offset would not) and the
alarm reschedules itself immediately. Endpoints past
`MAX_PUSH_ENDPOINTS_PER_NOTIFICATION` ARE dropped, and dropped loudly — a
`console.warn` naming the reason and the count, because a notification is
news, news goes stale, and a queue that stopped quietly would be
indistinguishable from one that finished. Raising the ceiling means
raising `PUSH_MAX_TICKS` and accepting the extra staleness, which is a
decision with a cost rather than a number to nudge.

## Rows written, per swept conversation

Measured (`test/ephemeral-chat.test.ts`), for a kind-9 carrying its one
`h` tag:

```
storing one chat message      9 base + 3 x 1 tag                     12
removing it again
  the `h` tag row                                                     1
  the event row                                                       1
  the three maintained counters                                       3
  a tombstone                                          deliberately   0
                                                                    ---
                                                                      5
one sweep's checkpoint, however many messages it removed               1
```

**Five rows to remove a message, against twelve to store it**, and that
asymmetry is why this path has no daily share of the ceiling. Backfill and
the vanish drain are paced against a share of the day because their volume
is chosen by somebody else — a stranger's request, a relay list of unknown
size. Every message this sweep removes was written by this relay first, and
writing one costs more than removing it does, so a day's sweeping can never
exceed a day's chat ingest and a day's chat ingest is already inside the
ceiling or the relay had a larger problem. A conversation of three hundred
messages costs **~1,500 rows to remove, 1.5% of the day**, having cost
~3,600 to store.

What IS needed is a per-tick ceiling, so a large accumulated backlog — the
first live sweep after an observation period, most obviously — drains
across ticks rather than being attempted at once. `CHAT_SWEEP_BATCH_SIZE`
is five percent of the day per tick, which at the charged cost of a
two-tag message is **250 messages**: an ordinary evening clears in one or
two ticks, a backlog drains at 6,000 a day, and `chat_state.swept_through`
carries the remainder exactly as `drainVanish` does.

## Rows written, per swept gift wrap

Measured (`test/nip59-giftwrap.test.ts`), for a wrap carrying its one `p`
tag:

```
storing one gift wrap         9 base + 3 x 1 tag                     12
removing it again
  the `p` tag row                                                     1
  the event row                                                       1
  the three maintained counters                                       3
  a tombstone                                          deliberately   0
                                                                    ---
                                                                      5
```

The same five-against-twelve asymmetry the chat sweep has, and it buys
the same conclusion: a day's sweeping cannot exceed a day's gift wrap
ingest, so this path needs no daily share. It has two bounds the chat
sweep does not — its input is throttled by
`MAX_GIFT_WRAPS_PER_IP_PER_WINDOW` and capped outright by `maxGiftWraps`
— so the largest backlog it can ever face is the inbox itself, 2,048
wraps at the defaults, about 32,000 charged rows, inside a single day
and very nearly inside a single tick. `GIFT_WRAP_SWEEP_BATCH_SIZE` is
still declared, at the same five percent of the day, for the case that
makes it matter: a 30-day TTL means a burst of wraps can all lapse in the
same hour. The remainder costs nothing to carry, because there is no
checkpoint to keep — the sweep takes the oldest first, so "run again next
tick" is the whole of its state.

`expiration` is a multi-character tag name, so `event_tags` never indexes
it and a wrap costs the same 12 to store whether or not it carries one.

## Rows read, per chat REQ

Measured (`test/ephemeral-chat.test.ts`), against a room holding a day of
talk (300 messages) with thirteen of them inside the horizon window — an
active conversation:

| filter | unclamped | clamped | falls by |
|---|---|---|---|
| `{"kinds":[9],"limit":50}` | 101 | 29 | 71% |
| `{"kinds":[9],"limit":200}` | 401 | 29 | 93% |
| `{"kinds":[9],"#h":["_"],"limit":200}` | ~714 | ~44 | ~94% |

The pair of `kinds` rows is the finding, not either number: clamped, the
cost **stops depending on the limit at all** — it is what the five-minute window holds,
not what the client asked for, so a client raising its limit stops buying
rows read. That is the horizon folding into `since` and becoming a bound
on the index range rather than a condition applied to rows already read;
emitted as a residual it would bound nothing, because `ORDER BY created_at
DESC` walks back from the newest row and every row past the horizon fails
the residual, so the scan would read the whole partition looking for a
LIMIT it can never fill. The residual form is used only where there is no
kind to pin.

The tagged shape is asserted as a ratio rather than pinned to the row: the
tag path's exact count moves with the `ORDER BY created_at DESC, id ASC`
tie-break, so a pinned figure would wobble under unrelated edits and get
updated without being read.

Two effects compound over time and neither is in that table. The sweep
means the group partition stops accumulating chat at all, so the index the
clamped query seeks stays the size of a conversation rather than of a
history; and `storageBytes` and `totalEvents` stop growing with the room's
talk.

The occupancy watermark costs one row per
`CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS` while the room is occupied — 192
rows a day with somebody in the room around the clock, 0.2% of the
ceiling. A room standing empty with an unread note in it costs **zero**:
the sweep finds a cutoff it has already drained and returns before the
COUNT and before any write. With no ceiling on a note, that is not a rare
state — it is where an unread note lives.

## Rows read, by path

| Path | Rows read |
|---|---|
| REQ filter, `ids` | 1 per id, × combinations |
| Group exclusion, any filter | 0 — it is a partition seek, not a post-filter |
| REQ filter, reader authorised for the group | × 2, one query per partition |
| Any `events` lookup that names no partition | the whole table — see below |
| REQ filter, `#<letter>` tag | ~2 per matching tag row |
| REQ filter served by an index | combinations × (2 × limit + 1) |
| Gift wrap exclusion, tag-driven filter | 0 — bounded by the tag subquery's own LIMIT |
| Gift wrap exclusion, `authors`-pinned filter with no `kinds` | up to the wraps that author holds, ≤ `maxGiftWraps` |
| `estimateRowsWrittenSince` (backfill's headroom guard only) | bounded by today's ingest count, not E (`idx_events_ingested`) |
| `totalEvents` + `followCount` (`readMaintainedCounts`) | 1 for the pair, maintained |
| `events24h` (`countEvents24h`) | ≤ 26 bucket rows, maintained |
| `ingested24h` + `rowsWrittenToday` (`readIngestCounts`) | ≤ 25 bucket rows for the pair, one statement, maintained |
| `followsListAt` | 1 |
| `/api/stats`, any request | ~10 measured, ≤ ~61 bounded; independent of E, F and of the ingest window |
| `auditMaintainedCounts`, once a day | E + F + M + ≤ 51 bucket rows (one scan of `events`, one of `follows`, one of `group_members`) |
| Backfill tick | bounded by today's ingest count (headroom check) + ~2 per event in the page |
| Live write, regular kind | 0–2, plus 3 for the counter updates |
| Presence beat, inside the write interval | 0 — answered from memory, seven beats in eight |
| Presence beat, outside it | 1 for the stored watermark |
| Push fan-out, per alarm tick | 1–2 outbox rows + ≤ `MAX_PUSHES_PER_TICK` subscription rows + 1 per distinct recipient pubkey |
| Push fan-out, no VAPID key | 0 — `vapidKeys` returns before any storage access |
| Replaceable/addressable replacement | ~2 per tag on the replaced event |
| NIP-62 vanish, per event removed | ~2 per tag on that event |
| `giftWrapCount`, per gift wrap accepted | ~0 |
| NIP-29 moderation event | ~3 for the relay's own group state, + the regeneration's own |
| Group write, non-owner | 1 for the membership lookup |
| Group chat write, sweep armed | + 1 for `chat_state` (the replay gate) |
| REQ by a group reader, sweep armed | + 1 for `chat_state` (the horizon) |
| Chat sweep, room in use or already drained | 1 — the state row, then it returns |
| Gift wrap sweep, nothing expired | one walk of the stored wraps, ≤ `maxGiftWraps` — 0 on a relay that holds none |
| Gift wrap sweep, a backlog to remove | stops at the batch: `ORDER BY created_at` is served by the index, not sorted |
| Chat sweep, a conversation to remove | 1 + one index entry per eligible message |
| Occupancy sample, inside the write interval | 0 — one integer comparison, no socket walk |
| REQ, authenticated non-owner | 1 for the membership lookup the read gate runs — 0 if the pubkey is not a member (the seek lands between index entries) |
| REQ, unauthenticated | 0 — both the owner lookup and the membership lookup sit behind `authedPubkey !== undefined` |
| Join request, refused | 1–3 — the owner, the membership, and the invite row if it got that far |
| Join request, accepted | the above + ~3 for the regeneration |
| Cron refreshes | ~7 + 2F |
| WebSocket connect | 1–2 |
| NIP-11 document / NIP-98 owner lookup | 2 |
| `initSchema`, per Durable Object constructor, schema hash matches | 1 |
| `initSchema`, per Durable Object constructor, schema hash mismatch | ~66 |

F is the follow count and M the group's member count. `initSchema` runs in the constructor, so it is paid per
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
in [src/schema.ts](../src/schema.ts).

The partition is what makes the group exclusion affordable, and it imposes a
rule: SQLite uses a partial index only for a query whose `WHERE` implies the
index's predicate, so **every query against `events`/`event_tags` names a
partition** or reads the table. Measured at 50,000 group events, `SELECT id
FROM events WHERE pubkey = ? AND kind = ?`: 2 rows pinned, 2 rows run once per
partition (`storage.ts acrossScopes`), **51,500** with no pin. A post-filter
instead of a partition would have cost 1,090 rows on a
`{"kinds":[1],"limit":20}` priced at 41, and 26,050 at limit 500 — one REQ
frame over the whole per-REQ cap, invisible to `boundFilter`. Nothing an
unauthenticated client can reach costs more than it did before the partition
existed; an authorised reader (two queries, one per partition) costs at most
2×. See `src/groups.ts` and `schema.ts INDEXES` for the reasoning behind
partial pairs over a widened index, which took the owner's own gift wrap read
from 601 rows to 204,701.

`combinations` is the number of queries `filters.ts expandFilter` runs for a
filter — its `authors` × `kinds` cross-product. The `2` is the index entry plus
the table row it points at. It multiplies **every** access path, the primary key
included: the expansion happens before storage sees the filter, so each expanded
query carries the whole of the rest of it, `id IN (...)` list and all.

## Where the read ceiling actually binds

Two paths used to scale with the accumulated table rather than with traffic,
getting worse as the relay filled whether or not anything else changed. Both
are closed now:

- **The cron floor.** The hourly tick called `estimateRowsWrittenSince` twice
  with no index behind `ingested_at`, so `2E × 24 = 48E` rows/day were spent
  with no client connected at all, reaching 5,000,000 at **E ≈ 104,000**.
  `idx_events_ingested` closed it in v0.7.6 — see that index's own comment in
  [src/schema.ts](../src/schema.ts).
- **Removing an event.** Replaceable replacement, NIP-09 deletion and NIP-62
  vanish each scanned `event_tags` in full because no index covered
  `event_id`, costing `5E` per removed event and binding at
  `E × R = 1,000,000`, sooner than the cron floor for any meaningful rate.
  `idx_event_tags_event` closed it in v0.7.3, and the reasoning on
  `deleteEventRow` in [src/storage.ts](../src/storage.ts) is why that index is not
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
counter first and the clock second. That lesson then got its second demonstration
one release later: `live_stats`, the five-minute cache over `ingested24h` and
`rowsWrittenToday`, went the same way when those two were bucketed by ingest hour.
**There is no cache on `/api/stats` at all, and no `liveAt` age, because nothing
on the document is stale.**

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
it is deliberate: once a day the cron tick recounts `events` in a single scan —
producing the total, the `created_at` window, the `ingest_at` window and the
stamped cost in that window, four figures from one pass — and `follows` beside it,
and logs loudly if any counter disagrees. The rows-written check is a **floor**
rather than an equality: the bucket legitimately exceeds the cost of the events
still standing in it, since it also holds deletions, follow rebuilds and NIP-86
calls, but it can never fall below it, and below means the meter lost writes. **Detect only — it
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
be handed an id that was never stored and must not decrement a bucket for it — and
it reads `ingested_at` and `row_cost` in the same seek, for the ingest bucket and
the removal's rows-written estimate. For
`follows`: `ownership.ts refreshFollows` is the only function that writes it, and
the counter moves in each of its two write branches — the rebuild and the clear —
rather than at the function's exit, which two early returns on the common path
would otherwise skip. That a refresh finding an unchanged contact list writes zero
rows, counter included, is asserted in `test/follows.test.ts`.

The rest of `/api/stats` scaled with something else, and closing it took two
passes. `ingested24h` and `rowsWrittenToday` both seek `idx_events_ingested`, so
neither grows with E — but both read the ingest *window*, measured live at
853 + 344 rows, ~1,200 per request with the lookups beside them. `GET /api/stats`
is unauthenticated, so **~4,100 requests from anywhere took the whole 5,000,000
rows-read allowance for the rest of the UTC day**, at no cost to the caller — the
same shape as the gift wrap gate probe, an expensive read on the far side of no
gate.

The first pass moved both into a `live_stats` row on a five-minute clock, which
bounded the recompute rate at 288/day however many requests arrived:

```
flood floor = (86,400 / TTL) × 1.5D   (D = events ingested per day)
```

That bounded the request rate and not the cost, and the cost was the term that
grew: at D = 5,000 events/day — an ordinary backfill day — the 288 refreshes
alone were **~2,160,000 rows/day, ~43% of the read ceiling, spent whether or not
anybody loaded the page**.

The second pass removed it. Both figures are now `ingest_hour_counts`, one bucket
row per ingest hour carrying an event count and a rows-written total, read as **at
most 25 rows in one statement**. That table was named here as the next step, with
the caveat that these two were harder than `events24h`: `ingested24h` would want
its own bucket table, and `rowsWrittenToday` is a sum over a window that empties
at 00:00 UTC, which no per-event increment expresses. Both objections dissolved in
the same table — one bucket carries both figures, so the "third row per event" is
the same row as the second, and a UTC day boundary falls on a whole hour, so the
reset is a range start rather than something a counter has to express. It is
*more* exact than the sum it replaced at exactly the moment that matters, 00:01
UTC during a recovery, where the cached figure was two minutes old and describing
the wrong day.

Measured: **10 rows per load** (`test/read-cost.test.ts`), bounded at ~61 —
`maintained_counts`, ≤ 26 `event_hour_counts` rows, ≤ 25 `ingest_hour_counts`
rows and the fixed lookups beside them. The endpoint went from ~4,100 loads/day
before any cache, to ~387,000 with one plus a floor that grew with D, to ~82,000
with no cache and no floor at all. Keyed by ingest time and NOT sharing
`event_hour_counts`: the two tables are the same events viewed through the two
clocks `events.ingested_at` exists to keep apart, and merging them would undo
exactly the distinction that column was added to make.

Traffic-driven paths are bounded by `limits.ts boundFilter`, which admits a REQ
filter only at a limit some index can afford, and by the per-IP message throttle
in `relay.ts`.

Four quantities bound one REQ, and they are four because pricing alone bounds
none of the other three:

- **Rows read per REQ** — `MAX_FILTER_ROWS_READ`, 10,000, divided equally
  among the frame's filters and passed to `boundFilter` as a budget.
  `filterReadCost`
  prices the cheapest access path, and the `ids` path was priced as though the
  filter ran once. It runs `combinations` times: `{"ids":[<one id>],
  "authors":[<5,000 keys>]}` priced at 1 row and read 5,000, while the identical
  filter *without* the id priced at 5,005,000 and was refused at any limit. One
  64-hex string turned a refused filter into a free one. The price is now
  `combinations × ids.length`.
- **Queries per filter** — `MAX_FILTER_COMBINATIONS`, derived as
  `MAX_FILTER_ROWS_READ / (ROWS_READ_PER_MATCH + 1)` = 3,333, which is the bound
  the index path already implied at a limit of 1. Capped *independently* of the
  price, because statements cost CPU whether or not they read rows: those 5,000
  seeks were 71ms of Durable Object time, and no lowered limit removes one of
  them.
- **Filters per REQ** — `MAX_FILTERS_PER_REQ`, 10. `MAX_FILTER_ROWS_READ` was
  enforced per filter while its comment read as a per-message bound; a REQ
  frame carried as many filters as fit, each admitted at the full cap, while
  the per-IP throttle counted the frame once. Measured before the cap: a REQ
  carrying 200 filters was answered with EOSE, and ~540 fit in the 16KiB the
  connection state holds — one frame able to ask for the whole day's rows-read
  allowance. This cap bounds the statement count and keeps the per-filter share
  from thinning to uselessness; the *rows* are bounded by the shared budget
  above.
- **Bound parameters per query** — `MAX_QUERY_BOUND_PARAMS`, 90, checked
  against `filterParamCount` before the halving loop, for the same reason
  `MAX_FILTER_COMBINATIONS` is: rows-read pricing bounds neither `ids.length`
  nor a `#<letter>` tag's value count, and a lowered `limit` shrinks neither
  either. A live deployment hit this directly — `{"ids":[<enough ids>]}` with
  no `authors`/`kinds` priced at one row per id, so it passed
  `MAX_FILTER_ROWS_READ` two orders of magnitude before it reached SQLite's
  own 100-bound-parameter ceiling, and the resulting `SQLITE_ERROR` was
  uncaught. See below for the platform limit it bounds.

What none of this bounds is spend over TIME, and it is worth stating rather
than leaving to be rediscovered. The per-IP message throttle
(`relay.ts RATE_LIMIT_MAX_MESSAGES`: 50 per 10s) permits 5 REQs/second, and at
the per-REQ cap that is **50,000 rows/second — the 5,000,000 daily ceiling in
100 seconds from one address**. That was true before these caps and is true
after; they bound what one message costs, not what a connection costs. Closing
it needs a per-connection or per-IP rows-read budget, which this relay does not
have.

A fourth bound is not a budget cap but a platform one. Subscriptions live in the
WebSocket attachment so they survive hibernation, and `serializeAttachment`
throws above 16KiB. Nothing checked it, so an ordinary
`{"authors":[<400 keys>],"kinds":[1]}` — ~26KB serialized, admitted by every cap
above — ran its query, sent its events, and then took an uncaught exception in
place of the EOSE. `MAX_CONN_STATE_BYTES` checks the *would-be* state before
storing it, so an oversized REQ is refused with `CLOSED` and leaves the
subscriptions it could not join intact.

A fifth bound is the same kind: a platform ceiling rather than a budget cap.
Cloudflare's SQLite-backed Durable Object storage refuses any single query
bound with more than 100 parameters
(developers.cloudflare.com/durable-objects/platform/limits/, checked
2026-08-28), and nothing checked it either, on the read path this time rather
than the storage path. `filterReadCost` prices `ids.length` and a tag's value
count by rows read, which is a different quantity from how many `?`
placeholders `buildFilterQuery` binds into one `exec()` call — an `ids`
filter with no `authors`/`kinds` prices at one row per id, so a filter naming
enough ids passed `MAX_FILTER_ROWS_READ` while its parameter count blew past
SQLite's own ceiling. Measured on the live relay: `"too many SQL variables
at offset 517: SQLITE_ERROR"`, uncaught, in place of a clean refusal.
`MAX_QUERY_BOUND_PARAMS` (`limits.ts`, 90 — a margin below the real 100 for
the same reason `MAX_CONN_STATE_BYTES` sits below 16KiB) checks
`filterParamCount`'s count before the query is ever built, refused with
`CLOSED` alongside every other read-abuse rejection above.

## The HTTP side

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
| `OPTIONS` any path (CORS preflight) | **no** | no | 0 | none — reaches no DO |
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
