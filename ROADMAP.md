# Roadmap

Work proceeds **one chunk at a time, in order**. Do not start a chunk until the previous one meets its definition of done. Update `CURRENT` when a chunk completes.

CURRENT: 8

Chunks 1–7 are complete: skeleton, schema, conformance suite, NIP-01 core, ownership, admin page, deploy button, deploy-form reduction, inbox mode, live feed, backfill.

---

## 5. Reconcile and reduce the deploy form

Start with an audit. This plan was written without access to the code, so verify before changing anything:

- Is NIP-42 AUTH implemented, or only tested? Chunk 2 wrote the tests; confirm chunk 3 made them pass.
- Are ephemeral kinds (20000–29999) actually not persisted? Send one and check the row count. Kind 22242 included.
- Does the regular-kind range match the spec exactly — `1000 <= n < 10000 || 4 <= n < 45 || n == 1 || n == 2`? Kind 3 is **replaceable**, not regular, and 45–999 is undefined. An implementation that treats "everything under 1000" as regular is wrong.
- Post a kind 0 twice and confirm the row count does not increase.

Then the change that motivated this chunk:

**The Cloudflare deploy form must have exactly one field: project name.** Every var declared in `wrangler.jsonc` gets prompted, with no notion of optional, so a `RELAY_ICON` prompt lands in front of a non-technical user before they have anything working.

- Remove `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`, `RETENTION_DAYS`, `ALLOW_FOLLOWS` from `wrangler.jsonc`.
- Read optional vars defensively in code (`env.ALLOW_FOLLOWS ?? false`). Anyone who wants them adds the variable in the Cloudflare dashboard, where the Cloudflare account is the authentication.
- Derive NIP-11 name and icon from the owner's kind 0 at claim time — the claim flow already fetches it to show name and avatar for confirmation. Write to DO storage at claim. Hardcoded fallbacks in code for when the lookup fails.
- Retention is not a deploy-time concern. Keep the capability only if inbox mode (chunk 6) lands, scoped to gift wraps.
- Document that a git-connected Worker may sync vars from config on deploy and overwrite dashboard-added ones.

**Done when:** a clean deploy prompts for project name only, and NIP-11 reflects the owner's profile after claim.

## 6. Inbox mode

Bothy is currently an outbox relay (advertised via kind 10002). This chunk makes it optionally an inbox relay (kind 10050) as well. These are different security postures, and this chunk changes the relay's read policy — reads are no longer uniformly public once gift wraps are stored.

- Accept kind 1059 from **any** author when a `p` tag matches the owner. This is a deliberate exception to owner-only writes, and it is the only unauthenticated write path in the project.
- **NIP-42 gate on 1059 reads.** Serve gift wraps only to the authenticated p-tagged recipient. Unauthenticated REQ for kind 1059 gets an AUTH challenge plus `["CLOSED", subid, "auth-required: ..."]`. Without this, an anonymous query returns every DM envelope the owner has received, leaking volume and timing.
- **Recipient-authorized deletion (NIP-59).** Gift wraps are signed by random throwaway keys, so NIP-09's author-only rule means nobody could ever delete their own inbox. NIP-59 carves out the exception: the p-tagged recipient may delete. Resolve each `e` tag by id, then authorize per event type — regular events by author, kind 1059 by `p` tag. Getting this wrong in the permissive direction lets a counterparty delete the owner's messages.
- **NIP-62 vanish requests.** Bulk deletion of all gift wraps p-tagging the owner, and deleted events must not be re-broadcastable.
- Accept randomized `created_at` up to two days in the past. Naive timestamp sanity checks will reject valid mail.
- Abuse controls, all required: event size cap, per-IP write throttling, hard cap on total gift wrap storage. This is the only unbounded write path.
- No consent toggle is needed. Bothy cannot become anyone's DM relay unless the owner publishes a signed kind 10050 naming it, and bothy cannot sign that. The protocol already gates this on a deliberate owner action.
- README gets a plain-language paragraph: Cloudflare terminates TLS and therefore sees the `p` tag, arrival time, and sender IP. On a personal relay the `p` tag is always the owner and leaks nothing, but sender IPs belong to other people. State it plainly rather than defending it.

**Done when:** a gift wrap from a stranger is stored, an unauthenticated read of it is refused, an authenticated read by the owner succeeds, and the owner can delete it.

## 7. Live feed and backfill

**Live feed on the admin page.** Framed as debugging, but it is really onboarding — it turns an abstract `wss://` URL into something visibly alive. Kind, time, truncated id. Idle timeout required, since the browser socket costs DO duration for as long as the tab is open. Never render gift wrap `p` tags or content to an unauthenticated viewer.

**One-shot backfill.** An empty relay does not do what the project claims. Fetch the owner's own events from the write relays in their kind 10002 and store them.

- Owner's events only. Resumable across cron runs — a large history against the 100k rows/day ceiling may genuinely take more than one day.
- Rate-limited under the daily write budget, with visible progress on the admin page.
- **Not continuous sync.** That is a different product and Amethyst and `nak` already do it. One-shot, then done.
- Outbound connections pin the DO in memory, so this runs from the Worker on a cron trigger, never from inside the DO during normal operation.

**Done when:** a claimed relay backfills its owner's history without exceeding the daily write budget, and the admin page shows live events arriving.

## 8. Compression

The documentation should end up in the shape of the project, not the shape of the path taken to build it. This chunk is that pass, and it is where `ROADMAP.md` deletes itself.

**Regenerate, do not edit.** Editing preserves; regeneration describes what exists.

> Do not open `CLAUDE.md` — not once, not for reference. Read the codebase.
> Write a new `CLAUDE.md` describing this project as it exists: what it is,
> what it refuses to be, architecture, conventions, commands. Describe what
> you find, not what you would have built. Then open the old file, diff it,
> and list anything load-bearing the code does not make evident. Do not
> re-add anything — present the list and stop.

Then:

- **Move every constraint that is now enforced by a test into a pointer.** [unchanged]
- **Keep the interpretations.** [new bullet]
- **Delete `ROADMAP.md`.** It is scaffolding for getting here.
- **Keep permanently:** [unchanged]

**Done when:** `CLAUDE.md` is under 90 lines, `ROADMAP.md` is gone, every
removed constraint is enforced by a named test, and a fresh session given
only the repo can state the project's scope boundaries correctly.