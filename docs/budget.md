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
