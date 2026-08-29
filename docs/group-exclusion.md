# Excluding group events from public reads

The measurement record behind the `is_group` partition (`src/groups.ts`,
`schema.ts INDEXES`). Everything here is a figure off a real
`SqlStorageCursor`, using the technique in
[test/read-cost.test.ts](../test/read-cost.test.ts): rows inserted straight into
tables mirroring `events`/`event_tags`, then the same query shapes measured
against each candidate design.

The scenario the numbers are taken at: **1,000 public events by the owner, 500
gift wraps, and 50,000 group events by 20 members**, all interleaved through the
same window — a group replacing a chat app for twenty people, next to one
person's own posting. Group events are **kind 1** in the fixtures, because
NIP-29 scopes a group by an `h` tag and not by a kind range: any kind can be a
group event, and a design that assumed otherwise would be a subset of NIP-29
rather than NIP-29.

## Why not a post-filter

The obvious implementation is a column tested at query time — `AND is_group = 0`
against the existing indexes. A condition on an unindexed column is a
post-filter: one row read per row skipped, invisible to `limits.ts boundFilter`,
and flat in nothing. Measured, `{"kinds":[1],"limit":20}`:

| group events | 0 | 1,000 | 10,000 | 50,000 |
|---|---|---|---|---|
| no exclusion (leaks) | 41 | 41 | 41 | 41 |
| column, post-filter | 41 | 61 | 250 | **1,090** |
| column, post-filter, group events newest | 41 | 1,041 | 10,041 | **50,041** |
| column carried in the indexes | 41 | 41 | 41 | 41 |
| **partial index pairs** | 41 | 41 | 41 | 41 |
| separate table | 41 | 41 | 41 | 41 |
| disjoint kind space, no column | 41 | 41 | 41 | 41 |

`boundFilter` prices that filter at 41 in every cell. At `limit: 500` the
post-filter reads **26,050** where it is priced at 1,001 — over the 10,000
per-REQ cap, ten filters to a REQ, five REQs a second from one address: the
5,000,000/day read ceiling in about two seconds. The `expiration` post-filter
that took the relay down took eight minutes.

Rows written per stored event are **identical under every mechanism** — 6 for
the event row plus 3 per tag row, measured. A column costs no rows (a row write
is a row, not a column), widening an index costs no rows, and a partial pair
costs no rows because a row satisfies exactly one half of each pair.

## Why partial pairs rather than a widened index

Both are seeks, and both are free in rows written. The difference is what they
do to queries that pin no partition, and it only shows up if you sweep for it.

Carrying `is_group` as a leading **key column** changes the plan of every query
that does not name it. Measured at 50,000 group events:

| shape | today | `is_group` in the key | partial pairs |
|---|---|---|---|
| `{"#p":[owner],"kinds":[1059]}`, authenticated owner | 601 | **204,701** | 567 |
| `{"#p":[owner]}`, unauthenticated | 400 | 367 | 367 |

SQLite abandoned the primary-key seek for a partition scan. That shape — the
owner reading their own gift wrap inbox — is not one anybody would have thought
to check; it was found by sweeping every shape the relay serves, which is why
the sweep is a precondition rather than a formality.

A partial pair leaves the key columns exactly as they were. A query pinning the
partition gets the plan it got before the column existed; a query pinning the
other one gets the mirror image.

## The rule the pairs impose

SQLite uses a partial index only for a query whose `WHERE` clause implies the
index's predicate. So **every query against `events`/`event_tags` names a
partition**, or it scans:

| `SELECT id FROM events WHERE pubkey = ? AND kind = ?` | rows read |
|---|---|
| pinned to one partition | 2 |
| both partitions (`storage.ts acrossScopes`) | 2 |
| no partition named | **51,500** |

Reads that are about one partition — everything a REQ produces — pin it
directly. Lookups that are not about one in particular (replaceable and
addressable replacement, NIP-09 address deletion, the NIP-62 vanish sweep, the
gift wrap storage count, the owner's kind-0/kind-3 lookups) run once per
partition and concatenate. Primary-key lookups are exempt: `sqlite_autoindex_*`
is not partial.

The tag index is a pair for the same reason and with the same consequence, and
the flag has to be **on the tag rows**, not only on the events: the tag
subquery's own `LIMIT` (`filters.ts tagScanLimit`) applies before the outer
query's conditions, so a candidate set containing the other partition's rows is
a candidate set truncated by them. Measured, `{"#p":[owner],"limit":20}` at
50,000 group events: **1 event returned** without the flag on the tag rows, 20
with it.

## The sweep

Every shape the relay serves, before (today's schema, no exclusion) and after
(the shipped code), at 50,000 group events. "After, unauth" is what every public
read gets; "after, authed" is a reader the relay has authorised, which runs the
filter once per partition.

| shape | before | after, unauth | after, authed |
|---|---|---|---|
| `{"ids":[1]}` | 1 | 1 | 2 |
| `{"ids":[50]}` | 150 | 150 | 251 |
| `{"authors":[owner]}` | 41 | 41 | 42 |
| `{"authors":[member]}` | 41 | 1 | 42 |
| `{"kinds":[1]}` | 41 | 41 | 82 |
| `{"kinds":[1]}` limit 500 | 1,001 | 1,001 | 2,002 |
| `{"kinds":[11]}` | 41 | 1 | 42 |
| `{"authors":[owner],"kinds":[1]}` | 41 | 41 | 42 |
| `{"authors":[owner],"kinds":[1,7]}` | 82 | 82 | 84 |
| `{"kinds":[1],"since":..,"until":..}` | 41 | 41 | 82 |
| `{"#p":[owner]}` | 400 | 367 | 400 |
| `{"#p":[owner],"kinds":[1059]}` | 601 | 141 | 567 |
| `{"#h":["g1"]}` | 400 | refused | 202 |
| `giftWrapCount()` | 500 | 500 | — |
| `hasVanishTargets()` | 3,051 | 3,005 | — |
| replaceable lookup + insert | 3 | 3 | — |
| owner kind-3 lookup | 1 | 3 | — |

Nothing an unauthenticated client can reach costs more than it did. The
authorised path costs at most 2×, because it is two queries.

One figure improved for a reason worth naming: the owner's own
`{"#p":[owner],"kinds":[1059]}` returned **0 gift wraps** before and **16**
after. The tag scan depth is finite, and 50,000 group events' worth of `p` tags
filled it; splitting the budget across the partitions (`tagScanDivisor`) gives
the public partition its own share back. The split also keeps
`filterReadCost`'s tag term true for an authorised reader without doubling it.

## The four surfaces

An exclusion applied to REQ results alone is applied to one of four places a
group event reaches an unauthenticated reader.

| surface | what it costs to exclude |
|---|---|
| **REQ results** (`handleReqInner` → `queryFilters`) | the table above |
| **`broadcast()`**, the push to subscriptions registered *before* the event arrived | 0 rows read — an in-memory predicate, plus the owner lookup already paid for gift wraps. The REQ-time gate never re-examines a standing subscription, which is why gift wraps gate here separately and why groups must too |
| **`liveBroadcast()`**, the `/live` admin feed | 0 rows read — one in-memory predicate. That channel has no authentication at all, so even the redacted kind/time/8-hex notice would time every message in the group |
| **`/api/stats` counters** | 0 additional rows written. The split lives in columns on rows that were being written anyway: an `UPDATE` touching two columns reports the same 1 row as one touching one, and a bucket upsert carrying a third counter is still 1 row. A separate bucket row per partition would have been +1 row per event |

The stats surface is the one the security review named for gift wraps: hold a
`/live` socket, poll `totalEvents`, and every arrival the feed does not announce
is dated to the second. `totalEvents`, `events24h` and `ingested24h` now publish
the public half only.

**What that does not fix**, on the same document: `storageBytes` grows with every
stored event whatever partition it is in; `rowsWrittenToday` is deliberately
whole, because it is the owner's budget meter and a budget figure that
under-reports the day's real spend is worse than one that leaks traffic shape;
and the `reads` diagnostic moves with group REQs like any other. All three are
coarser channels than a per-event counter, and all three remain.

## What this deliberately gets wrong

`schema.ts EVENT_BASE_ROW_COST` is `2 + indexesOn("events").length`, which counts
each partial pair twice. A stored event is charged `12 + 4T` and costs `9 + 3T`
— a third too much on a real five-tag note.

It is left wrong. Every consumer of `eventRowCost` is a guard, and an
over-estimate makes each of them stricter: smaller backfill pages, smaller
vanish batches, an earlier headroom stop, an `events.row_cost` stamp that reads
high. Slower, never overrunning. `test/hibernation.test.ts` pins the measured
cost, the charged cost, and the gap between them, so the wrongness cannot drift
and a fix cannot land silently.

The one place over-charging is not safe is `storage.ts auditMaintainedCounts`,
whose rows-written check is a **floor**: a floor set above what the meter can
ever report is a drift line logged every day, on a check whose value is that it
fires rarely. That one comparison converts the stamped sum back to the measured
figure, using the same declarations it was built from
(`eventRowCostMeasured`). When the derivation is fixed, the two become equal and
that arithmetic — and `eventRowCostMeasured` with it — should be deleted.

## What is not implemented

Only the read partition. There is no group creation, no membership list, no
moderation events, and nothing signs 39000-series group metadata
(`src/relay-identity.ts` exists, and nothing calls `signAsRelay`). Group reads
are therefore gated on the only identity this relay knows: the owner. When
membership lands, two lines widen together — the gate in `handleReqInner` and
the gate in `broadcast()` — or a member subscribed before an event arrives gets
nothing.
