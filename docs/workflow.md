# How bothy is built

The working method for one person and an AI assistant. Internal, like
[principles.md](principles.md); not rendered on the site.

## The gates

The expensive mistakes in this project were made by building before the
question was settled, so the method is its gates, whatever model is in
the chair.

1. **Ask first.** A request that still has an open question in it
   ("probably", "figure out", "maybe") is a frame, not a spec. The
   assistant reads the code, then asks every question whose answer would
   change the work, in one batch, before writing anything. A trivial
   change can skip this if the request says so.
2. **Plan, then build.** The plan names the files to change, what is
   deliberately not changed, and how the result will be verified.
   Nothing under `src/`, `public/` or README.md is written until the
   human approves it. The same session builds, so what the planner
   learned stays available.
3. **Checks before every commit.** `npm run typecheck`, `npm run test`
   and `node scripts/sync-badge.mjs --check` all pass. A failure is
   reported with its output. A test is never skipped or weakened to get
   green.
4. **No wider scope.** Anything discovered mid-build that the plan did
   not cover goes in the final report as a list, not into the diff.
5. **Review by a fresh session.** A session that did not write the code
   reads the diff against the approved plan and the checklist at the end
   of [principles.md](principles.md). It reports findings and changes
   nothing; the human decides which go back to step 2.

## Where things are written

Reasoning goes in code comments, beside the code it explains. The README
instructs the person running a relay. The tests are the record of every
measured cost. There is no CLAUDE.md.

## Conventions

- TypeScript strict mode, and no `any` in the event-handling path.
- `@noble/curves` and `@noble/hashes` are the only crypto dependencies.
  Dependencies are pinned to exact versions.
- Every refusal goes back as `["OK", id, false, ...]` or `["CLOSED", ...]`
  with a NIP-01 machine-readable prefix (`invalid:`, `restricted:`,
  `blocked:`, `rate-limited:`, `auth-required:`, `duplicate:`). Nothing
  fails silently.
- Check a Cloudflare platform limit against the live docs before relying
  on it, and cite the URL and the date checked where the number is used.
  They change between compatibility dates.

## Committing

- Commit directly to `main`. No branches and no pull requests: there is
  one contributor, Cloudflare builds from `main`, and work on any other
  branch does not reach the relay.
- A push to `main` is a deploy. The assistant pushes only when the human
  says so in that session; otherwise it commits locally and says so.
- One commit per decision.

## Releasing

- `package.json`'s `version` is the single source of truth. It is
  imported into the NIP-11 document and `/api/stats`; never write the
  version string anywhere else.
- The version bumps whenever `main` moves past the last tag, with no
  judgment call about whether the change is significant.
- Tags are annotated (`git tag -a`), never lightweight: `git push
  --follow-tags` silently skips a lightweight tag. Confirm a tag reached
  GitHub with `git ls-remote --tags origin <tag>`.

## The updater workflow

- After editing `.github/workflows/sync.yml`, run `npm run sync-badge`.
  The README hands that file to new deployments as a URL generated from
  it, and a stale URL enables an updater that no longer exists here.
- The workflow a downstream copy commits is the one it keeps: a sync
  restores the copy's own `.github/`, and `GITHUB_TOKEN` cannot push a
  workflow change anyway. A fix to `sync.yml` reaches existing
  deployments only if their owners re-commit it by hand, so it has to be
  right when it ships.
