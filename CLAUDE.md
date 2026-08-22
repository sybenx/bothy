# bothy

A single-user nostr relay that runs on the Cloudflare free tier and deploys in one click.

A bothy is a small unlocked shelter in the Scottish highlands — free, unowned, maintained by whoever passes through. This is that, for your notes.

## What this is

One person clicks a button, pastes their npub, and gets a working `wss://` URL for their own relay. No terminal, no VPS, no domain purchase, no port forwarding, no dynamic DNS, no always-on box at home. The relay lives in their own Cloudflare account, so there is no operator who can rug them.

The target user has never opened a terminal. Every decision in this repo should be evaluated against that.

## What this is not

Do not add these. If a change request implies one, push back before implementing:

- **Pay-to-relay / zaps / any payment flow.** Not a business.
- **Multi-region Durable Object meshes, D1, read replication.** One user does not need horizontal scale, and these push the deployment onto the paid plan.
- **NIP-05 identity hosting.** Requires a custom domain, which breaks one-click.
- **Media / blossom / file uploads.** R2 has its own free-tier cliff and a different abuse profile.
- **Moderation tooling, invite hierarchies, community features.** Those are khatru-pyramid's and relay.tools' problem.
- **A public relay mode.** An open write path on a free tier is a storage-exhaustion attack with extra steps.

Scope discipline is the feature. Every added surface is another thing that can push a non-technical user into a surprise bill or a broken relay.

## Architecture

```
Client ──wss──> Worker (routing, NIP-11, static assets)
                  │
                  └──> Durable Object "relay" (SQLite) — the whole relay
```

- **One Worker.** Handles the `Upgrade` header, serves the NIP-11 relay info document on `Accept: application/nostr+json`, serves the static admin page otherwise, and forwards WebSocket upgrades to the DO.
- **Exactly one Durable Object instance**, addressed by `idFromName("relay")`. All connections, all storage, all subscription state. Do not shard. A single user's relay is not a scale problem.
- **SQLite storage backend, required.** The Workers Free plan can only create SQLite-backed DOs. Never use the key-value backend.
- **WebSocket Hibernation API, required.** Use `state.acceptWebSocket(ws)` and the `webSocketMessage()` / `webSocketClose()` handlers. Never call `ws.accept()` — that pins the object in memory and bills duration for the entire life of the connection, which will blow the free tier in a day.
- **`state.setWebSocketAutoResponse()`** for client-level ping/pong. Auto-responses do not incur wall-clock charges.
- **`*.workers.dev` is the shipped default.** Custom domains are an optional advanced step, never a prerequisite.

## The budget

These are the Cloudflare Workers Free plan limits this project exists to fit inside. Treat them as hard constraints, not guidance. Any change that could push a normal single-user relay past them is a bug.

| Dimension | Free limit | Notes |
|---|---|---|
| Worker requests | 100,000 / day | Static asset requests are free and unlimited |
| DO requests | 100,000 / day | Incoming WS messages billed at a **20:1** ratio |
| DO duration | 13,000 GB-s / day | At 128 MB that's ~101,000 object-seconds — a day is 86,400s |
| SQLite storage | 5 GB total | |
| Rows written | 100,000 / day | **The real write ceiling.** Each stored event is several rows |
| Rows read | 5,000,000 / day | |
| Worker CPU | 10 ms / request | |
| Cron triggers | 5 / account | |

Consequences to keep in mind:

- **Rows written is the binding constraint, not storage or requests.** Deletes count as writes. `setAlarm()` counts as a write. Budget indexes accordingly — every index multiplies per-event write cost. Prefer fewer, wider indexes.
- **Duration only stays cheap if hibernation actually works.** Anything that keeps the object awake — an open outbound WebSocket, a pending timer, an unawaited promise — silently converts an idle relay into a billed one. An outbound connection keeps the DO in memory for up to 15 minutes even with no traffic.
- **Schnorr verification is the CPU risk.** Every `EVENT` gets a signature check via `@noble/curves`. Measure it. If it approaches the 10 ms Worker limit, that is a release blocker, not a footnote.
- Free-tier limits reset at 00:00 UTC. Exceeding them fails operations rather than billing the user, which is the behaviour we want — but the admin page must make it visible when it happens.

Add a `docs/budget.md` note whenever a change measurably shifts per-event write or CPU cost.

## Configuration

All configuration is **environment variables and secrets in `wrangler.jsonc`**, never edits to source files. This is what makes the Deploy to Cloudflare button work — Cloudflare reads the config and prompts the user for each value during setup.

| Var | Purpose |
|---|---|
| `OWNER_PUBKEY` | Optional. If set, ownership is fixed at deploy time and the claim flow is disabled entirely. Advanced/deterministic path. |
| `ALLOW_FOLLOWS` | If true, also accept writes from the owner's kind-3 follow list. Default false. |
| `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON` | NIP-11 fields. |
| `RETENTION_DAYS` | Optional pruning window. Off by default. |

Accept `npub1...` and hex, normalize to hex at the boundary, store hex only. A user pasting an npub from their client is the expected path.

If `ALLOW_FOLLOWS` is on, a cron trigger refreshes the follow list on a schedule — do not refetch it per event. Cache the resolved set in SQLite with a timestamp.

## Ownership

**Trust on first use.** A fresh deployment is unclaimed. The first `POST /api/claim` with a pubkey binds the relay to it, permanently, and the claim endpoint returns 409 forever after. No signature is required.

This is deliberate, and the reasoning should not be relitigated in a PR:

- **A wrong claim is not an attack.** Every event is signature-verified regardless of who owns the relay, so binding to someone else's pubkey cannot enable forgery. The worst outcome is that the relay archives a stranger's public notes at the deployer's expense.
- **Recovery is free.** Cloudflare deployments are disposable. Delete and redeploy.
- **It moves the one hard step onto our page.** Asking a non-technical user to fill in an env var in Cloudflare's config UI is a worse first experience than landing on our page and pasting an npub with our validation and our copy around it.

Requiring a signature would buy no security and would reintroduce a signer at the exact moment we are trying to avoid one.

### Claim implementation

- Store the owner pubkey in DO SQLite. Under TOFU it has to be writable once, so the protection is structural in a different way: **the claim handler is the only writer, and it refuses if a row already exists.** Durable Objects are single-threaded per instance, so the check-then-write is atomic without locking. No other code path may write that row — enforce this in review.
- If `OWNER_PUBKEY` is set in env, skip storage entirely, use the env value, and return 404 from `/api/claim`. Same binary serves both paths.
- Accept `npub1...` and hex, normalize to hex at the boundary, store hex only. Validate the bech32 checksum before accepting.
- **Resolve and display the profile before confirming.** Fetch kind 0 from a couple of well-known relays and show name and avatar with a confirm step. This is a courtesy against typos, not a security control — a checksum catches garbage but not a valid-but-wrong key. If the lookup fails, allow the claim anyway; never block on it.
- Until claimed, the relay accepts no writes and the admin page shows the claim form.

### Resetting

Redeploying does **not** reset ownership. DO storage survives `wrangler deploy` — new code, same data, still claimed. A real reset requires deleting the Worker, or a migration with `deleted_classes` on the DO class.

This is unintuitive and users will get it wrong, since the instinct is to redeploy. It needs a prominent, plainly worded section in the README and a link from the admin page.

## Threat model

Hijacking is not the threat. Read abuse is.

Reads are public by design — serving other people's clients is what makes this useful as an outbox relay. That means anyone can burn the daily 5M rows-read and 100k DO requests without touching ownership at all. Mitigations, all required:

- Cap concurrent subscriptions per connection.
- Cap `limit` per filter, and cap total events returned per REQ.
- Reject filters with no `authors` and no `kinds` constraint.
- Per-IP throttling inside the DO.
- Document the free Cloudflare rate-limiting rule in the setup guide.

Writes are owner-only and signature-verified, so the write path is not the exposure.

## Admin page

A static HTML page served at the relay root. Deliberately minimal:

- The `wss://` URL with a copy button. This is the primary job of the page.
- Event count, storage used, events in the last 24h.
- Current position against the daily free-tier limits, so a user can see trouble coming.
- Nothing else. No charts library, no framework, no build step for this page.

Static assets are free and unlimited on Workers, so keep the page static and have it fetch one `/api/stats` JSON endpoint. Do not server-render it.

## Attribution and licensing

This project is **MIT licensed** and is an **original implementation, not a fork**.

[Nosflare](https://github.com/Spl0itable/nosflare) by Spl0itable is the prior art that proved a nostr relay works on Workers + Durable Objects, and is a useful reference for NIP-01 filter-matching edge cases. It is credited as such in the README. It is *not* credited in `LICENSE`, because no code is copied from it.

That claim has to stay true. The rule:

- **Read Nosflare to understand the protocol. Do not paste from it.** Learning how replaceable-event semantics work is fine; reproducing the function that implements them is not.
- If a change would copy more than a few incidental lines, **stop and raise it** rather than merging it. The choice at that point is to write an independent implementation or to formally become a fork — add the upstream copyright line to `LICENSE`, restate the README as a fork, and accept the ongoing obligation. That is a project-level decision, not a per-PR one.
- The same rule applies to any other MIT/GPL relay read for reference (khatru, haven, strfry).
- Never imply endorsement by, or affiliation with, Nosflare or its author.
- Protocol-level bugs found in upstream projects while reading them should be reported upstream.

Nosflare sells a paid no-code deploy service. We are not competing with that service and should not position ourselves against it in any docs, commit messages, or marketing copy. Different architecture, different user, no comparisons.

## Working agreement

Sessions here are typically unattended — the maintainer opens the repo, says go, and reviews at chunk boundaries. That makes the following non-optional:

- **Read `ROADMAP.md` first.** Work the current chunk only. Do not start the next one.
- **Read `DECISIONS.md` before proposing anything architectural.** If a change contradicts a closed decision, stop and name the decision instead of implementing it.
- **Never proceed past red tests.** There is no human watching between chunks, so the test gate is the only gate. A failing suite ends the session; report it rather than working around it.
- **Verify platform facts against live documentation.** The free-tier limits, wrangler config syntax, and Durable Objects migration format in this file were correct when written and change over time. Check `developers.cloudflare.com` before relying on a specific number or config shape, and update the table here if it has moved.
- **Pin versions.** Wrangler's DO migration syntax and SQLite backend flags have shifted across majors. Do not float to latest mid-project.
- **When genuinely ambiguous, stop and ask.** A wrong guess compounds across an unattended session. An unanswered question costs one round trip.
- Record any non-obvious tradeoff you resolve as a new entry in `DECISIONS.md`, including the option you rejected.

## Conventions

- TypeScript, strict mode. No `any` in the event-handling path.
- `@noble/curves` for crypto. Do not add a second crypto dependency.
- Dependencies are a liability here — the Worker size limit is 3 MB on the free plan. Justify every addition.
- Protocol errors go back to the client as `["OK", id, false, "reason: message"]` or `["CLOSED", subid, "reason: message"]` with the correct NIP-01 machine-readable prefix. Never fail silently.
- Comments explain why, especially around anything hibernation- or budget-related. The next reader needs to know which lines are load-bearing for the free tier.

## Commands

```bash
npm install
npm run dev        # wrangler dev, local DO with SQLite
npm run test       # protocol conformance + budget regression
npm run deploy     # wrangler deploy
```

## Testing

Two suites, both required to pass before merge:

1. **Protocol conformance.** NIP-01 REQ/EVENT/CLOSE/EOSE semantics, filter combinations, replaceable and addressable events, NIP-09 deletion, NIP-11 document shape, NIP-42 auth. Reject-path tests matter as much as accept-path: a non-owner pubkey must be rejected with the right message.

2. **Budget regression.** Assert rows-written per stored event and CPU time per signature verification against recorded baselines. A change that raises either without an explicit, documented reason fails the build. This suite is the reason the project can promise "free."

Test hibernation explicitly: after the last message, assert the object becomes eligible to hibernate. A regression here is invisible in normal testing and shows up as a bill.
