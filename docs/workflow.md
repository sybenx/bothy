# How bothy is built

The working method for one person and an AI assistant. Internal, like
[principles.md](principles.md); not rendered on the site. CLAUDE.md
"Conventions" carries the three rules a session must follow and points
here for the rest.

## The lesson this is built on

The expensive mistakes in this project were not made by a weak model.
They were made by a strong model that started building before the
question was settled. One session produced a full implementation of a
half-formed brief in a single pass, and the correction took longer than
the build. The same session, once it was made to ask first and write a
plan the human approved, produced the right thing at the first attempt.

So the method is defined by its gates, not by which model sits in the
chair. The model is chosen per stage, inside the gates.

## Four stages, four gates

Each stage ends at a gate, and each gate is held by a different party.

### 1. Frame (held by the human)

One message that states the outcome and lists the open questions. It
says what should be true afterwards, not how to get there. It names
anything that must not change.

A frame is not a spec. If it contains "probably", "figure out", "maybe",
"I think", or a question mark, the assistant treats it as a frame and
starts the next stage in plan mode. If the human wants to skip planning
for a trivial change, the frame says so.

### 2. Plan (held by the human, produced by the most capable model)

The assistant reads the code, then asks every question whose answer
would change the work. All of them, in one batch, before any plan is
written. Not one at a time, and never after building.

The plan names: the files to change; the functions and patterns to
reuse; what is deliberately not changed; how the result will be
verified; what the assistant will push and where. Nothing is written to
the repository until the human approves the plan.

Model: Claude Fable 5.1 (`claude-fable-5-1`) at `xhigh` effort for any
change that touches the write path, the budget accounting, or a surface
a person sees. Claude Opus 5 (`claude-opus-5`) at `high` for the rest.
Planning is where the expensive mistakes are made and it is a small
share of the tokens, so this is where the most capable model pays for
itself.

### 3. Build (held by the tests, executed in the same session)

The same session implements the approved plan and nothing else. Keeping
planner and builder in one context is deliberate: everything the planner
learned that did not fit in the plan document stays available.

Before every commit: `npm run typecheck`, `npm run test`, and
`node scripts/sync-badge.mjs --check`, all passing. A failing suite is
reported with its output. It is never worked around, and a test is
never skipped or weakened to get green.

Anything discovered mid-build that the plan did not cover is listed in
the final report. It is not done.

The assistant pushes to `main` only when the frame or the approval said
so in that session. Otherwise it commits to its own branch and says so.

Model: the session's model, at `high`. Claude Opus 5 is sufficient for
building against an approved plan. For mechanical follow-through inside
a plan (renames across test files, fixture updates, docs mirroring a
decision already made) Claude Sonnet 5 (`claude-sonnet-5`) is adequate
and cheaper; hand it the plan and the exact list.

### 4. Review (held by the human, produced by a fresh session)

A session that did not write the code reads the diff against two
things: the approved plan, and the checklist at the end of
[principles.md](principles.md). Its instruction is to find what is
wrong, not to summarise what was done. It reports findings; it changes
nothing. The human decides which findings go back to stage 3.

This is the balance against two blind spots at once: the builder's,
which cannot see its own assumptions, and the human's, whose attention
is the resource that runs out in a long session.

Model: Claude Fable 5.1 at `high`, or Claude Opus 5. Claude Sonnet 5
for a first pass on a large diff, with one of the others doing the
final read.

## The methods tried, and why this one

**Claude Fable 5.1 in Claude Code, directly.** The strongest model,
and the one that built the wrong thing fastest. Without the plan gate,
capability turns into speed in the wrong direction. With the gate it is
the best planner and the best reviewer available.

**Claude Opus 5 planning, Claude Sonnet 5 building in Claude Code.**
Splits one task across two contexts. Everything the planner understood
that did not make it into the plan document is lost at the handoff, and
the builder fills the gaps with guesses that look like the plan. The
saving is the Sonnet/Opus price gap on the build stage only, and the
build stage is not where this project's cost went wrong.

**Claude Opus 5 in Claude Code, directly.** The first method one tier
down, with the same failure when the gate is missing.

The one-line version: keep the planner and the builder in one context,
and spend the second model on review, where independence is worth more
than continuity.

## What each model costs

First-party API rates per million tokens, input and output, at the time
of writing. Claude Code plans price differently, but the ordering holds.

| Model | Input | Output | Used for |
|---|---|---|---|
| Claude Fable 5.1 | $10 | $50 | planning the risky changes; final review |
| Claude Opus 5 | $5 | $25 | planning the rest; building; review |
| Claude Sonnet 5 | $2 | $10 | mechanical follow-through; first-pass review |
| Claude Haiku 4.5 | $1 | $5 | nothing here |

Claude Haiku 4.5 is not used in this repository. The rules in the code
are dense enough that the cheapest tier's misreads cost more than they
save.

## The checks and balances

1. Plan mode is mandatory for any change to `src/`, `public/`,
   README.md or CLAUDE.md. The frame may waive it for a trivial change.
2. Questions are asked once, in a batch, before the plan is written.
3. The plan names what it will not change.
4. Nothing is written to the repository before the plan is approved.
5. Typecheck, the full suite and the badge check pass before every
   commit. A failure is reported, never worked around.
6. No push to `main` without the human saying so in that session.
7. Review is done by a session that did not write the code, against the
   checklist in principles.md.
8. The version bumps whenever `main` moves. Tags are the human's.
9. The assistant never widens scope. Findings outside the task go in the
   report as a list, not into the diff.
10. Reasoning goes in code comments. CLAUDE.md describes. The README
    instructs.

## Session hygiene

- One task per session. Start a new one for the next task.
- The frame is the first message. If the human is still thinking, the
  first message says "plan only".
- The assistant restates the frame's open questions before asking
  anything else, so both sides can see the same list.
- A session that has run long gets a review pass from a fresh one
  before anything is pushed, whatever the model.
- The assistant's final message stands on its own: what changed, what
  was verified, what was left out and why, and what the human has to
  do next.

## Worked example

The write-policy work in September 2026.

First pass, no gate: the frame said "probably via commands?" and
"figure out". The assistant read that as a spec, built five features in
one commit, and put the mechanism on the admin page. Everything in it
had to be revisited.

Second pass, with the gate: four questions in one batch, then four more
when the answers changed the design, then a plan naming every file and
every rename. Approved, built, pushed. One correction round instead of
three.

Third pass, review: a read of the shipped surfaces against principles.md
found what neither of the earlier passes had, including a refusal
message that told strangers the operator's environment variable name.

The difference between the passes was not the model. It was the same
model each time.
