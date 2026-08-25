# bothy

[![Release](https://img.shields.io/github/v/tag/sybenx/bothy?style=for-the-badge)](../../tags)

A single-user nostr relay that runs on the Cloudflare free tier and deploys in one click.

A bothy is a shelter in the Scottish highlands that someone built and left unlocked for whoever needs it. Cloudflare's free tier is a bit like that, and this is a relay that runs in it.

Click the button, paste your `npub`, get a `wss://` URL for your own relay. No terminal, no VPS, no domain, no port forwarding, no always-on box at home. The relay lives in your own Cloudflare account.

**Requires a Cloudflare account** (free, no card) **and a GitHub account** (also free) — Cloudflare puts a copy of the code in your Git account and deploys from there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sybenx/bothy)

*Already deployed? See "Keeping it updated" below.*

## Setup

1. Click **Deploy to Cloudflare**. You'll be prompted to create a free Cloudflare account if you don't have one.
2. On **Set up your application**, pick your GitHub account from the **Git account** dropdown. Cloudflare creates a repo there holding your copy. Leave **Create private Git repository** unchecked unless you have a reason — public repos get free GitHub Actions minutes, which the updater uses. Then click **Deploy**.
3. The build takes about 30 seconds. **Refresh the page** when it finishes — the dashboard doesn't update on its own. A **Visit** button appears at the top right; that's your relay.
4. Open that URL, paste your npub into the claim form, and confirm. This step is one-time and permanent; see "Ownership" below.
5. Copy the `wss://` URL from the admin page into your nostr client's relay list.

No dashboard configuration is required.

## Keeping it updated

The "Deploy to Cloudflare" button copies this repo into your GitHub account as an independent repo rather than a fork, so there is no **Sync fork** button and no way to receive changes automatically. GitHub also blocks the Cloudflare app from writing workflow files on your behalf, so your copy arrives without `sync.yml`, the updater workflow. Updates come from the upstream repo, [sybenx/bothy](https://github.com/sybenx/bothy); the two steps below close that gap.

> Cloudflare also supports GitLab, but the updater below is GitHub-only.

[![1: Enable the updater](https://img.shields.io/badge/1-Enable%20the%20updater-555555?style=flat-square)](../../new/main?filename=.github/workflows/sync.yml&value=name%3A%20Sync%20from%20upstream%0A%0Aon%3A%0A%20%20workflow_dispatch%3A%0A%0Apermissions%3A%0A%20%20contents%3A%20write%0A%0Ajobs%3A%0A%20%20sync%3A%0A%20%20%20%20runs-on%3A%20ubuntu-latest%0A%20%20%20%20%23%20The%20%22Deploy%20to%20Cloudflare%22%20button%20clones%20this%20repo%20into%20the%20user%27s%20account%20as%20an%0A%20%20%20%20%23%20independent%20repo%2C%20not%20a%20GitHub%20fork%2C%20so%20this%20workflow%20ships%20inside%20every%20downstream%0A%20%20%20%20%23%20copy%20too.%20Guard%20so%20it%20no-ops%20when%20it%20runs%20in%20the%20upstream%20repo%20itself.%0A%20%20%20%20if%3A%20github.repository%20%21%3D%20%27sybenx%2Fbothy%27%0A%20%20%20%20steps%3A%0A%20%20%20%20%20%20-%20name%3A%20Checkout%0A%20%20%20%20%20%20%20%20uses%3A%20actions%2Fcheckout%40v6%0A%20%20%20%20%20%20%20%20with%3A%0A%20%20%20%20%20%20%20%20%20%20fetch-depth%3A%200%0A%0A%20%20%20%20%20%20-%20name%3A%20Configure%20git%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.name%20%22github-actions%5Bbot%5D%22%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.email%20%22github-actions%5Bbot%5D%40users.noreply.github.com%22%0A%0A%20%20%20%20%20%20-%20name%3A%20Fetch%20upstream%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20remote%20add%20upstream%20https%3A%2F%2Fgithub.com%2Fsybenx%2Fbothy.git%0A%20%20%20%20%20%20%20%20%20%20git%20fetch%20upstream%20main%0A%0A%20%20%20%20%20%20-%20name%3A%20Pull%20in%20upstream%20files%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20upstream%2Fmain%20--%20.%0A%0A%20%20%20%20%20%20-%20name%3A%20Restore%20local%20config%0A%20%20%20%20%20%20%20%20%23%20wrangler.jsonc%20holds%20the%20D1%2FKV%2FR2%20IDs%20Cloudflare%20provisioned%20for%20this%20deployment%2C%0A%20%20%20%20%20%20%20%20%23%20and%20.github%2F%20holds%20this%20workflow%20itself%20%E2%80%94%20neither%20must%20ever%20be%20overwritten%20by%20upstream.%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20HEAD%20--%20wrangler.jsonc%20.github%2F%0A%0A%20%20%20%20%20%20-%20name%3A%20Stage%20deletions%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20diff%20--diff-filter%3DD%20--name-only%20HEAD%20upstream%2Fmain%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20grep%20-v%20%27%5E%5C.github%2F%27%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20xargs%20-r%20git%20rm%20--%0A%0A%20%20%20%20%20%20-%20name%3A%20Commit%20and%20push%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20if%20git%20diff%20--quiet%20%26%26%20git%20diff%20--cached%20--quiet%3B%20then%0A%20%20%20%20%20%20%20%20%20%20%20%20echo%20%22Already%20up%20to%20date%20with%20upstream.%22%0A%20%20%20%20%20%20%20%20%20%20%20%20exit%200%0A%20%20%20%20%20%20%20%20%20%20fi%0A%20%20%20%20%20%20%20%20%20%20git%20add%20-A%0A%20%20%20%20%20%20%20%20%20%20git%20commit%20-m%20%22Sync%20from%20upstream%20%28sybenx%2Fbothy%29%22%0A%20%20%20%20%20%20%20%20%20%20git%20push%20origin%20HEAD%3A%24%7B%7B%20github.ref_name%20%7D%7D%0A)
[![2: Check for updates](https://img.shields.io/badge/2-Check%20for%20updates-555555?style=flat-square)](../../actions/workflows/sync.yml)

**Enable the updater** opens GitHub's web editor with `sync.yml` pre-filled; commit it.
**Check for updates**, whenever you want the latest: open the workflow, click **Run workflow**, leave the branch as `main`, then click the green **Run workflow** button. It takes under a minute, and Cloudflare redeploys automatically.

Running it pulls in this repo's files, restores your own `wrangler.jsonc` and `.github/` untouched (those hold your Cloudflare resource IDs and this workflow itself), and pushes the result straight to your default branch. Cloudflare notices the push and redeploys automatically — usually within a minute or two.

Your relay stays claimed and your events survive; deploying never resets anything (see "Resetting" below for what actually does). After it redeploys, hard-refresh the admin page in your browser (`Cmd+Shift+R` / `Ctrl+Shift+R`) — the page's static assets can stick around in your browser's cache otherwise.

To check whether a deploy went through, open your Worker in the Cloudflare dashboard and look at its **Deployments** tab.

If you deployed manually instead of via the button (you have the code checked out locally), update the same way you would any git project, then run `npx wrangler deploy`.

<details>
<summary>Prefer the terminal?</summary>

```bash
git remote add upstream https://github.com/sybenx/bothy.git
git fetch upstream
git checkout upstream/main -- .
git checkout HEAD -- wrangler.jsonc
git status
git commit -m "Sync from upstream"
git push
```

</details>

### Rate limiting (recommended)

This relay's read path is intentionally public (gift-wrapped DMs are the one exception — see "Inbox mode" below), so it's worth adding a free Cloudflare rate-limiting rule against abusive traffic: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** for your zone and add a rule capping requests per IP to your Worker's route. The relay enforces its own per-connection and per-IP limits regardless, but an edge rule catches abuse before it reaches the Worker at all.

## Ownership

The first person to submit their pubkey through the claim form owns the relay, permanently — this is "trust on first use" (TOFU). There's no signature check on the claim itself: every event is verified against its own signature regardless of who owns the relay, so a wrong claim can't be used to forge anything. The worst case of someone else claiming your relay first is that it archives a stranger's public notes at your expense; you can recover by deleting the Worker and deploying again.

If you want to skip the claim flow entirely and fix ownership at deploy time instead, set the `OWNER_PUBKEY` environment variable (hex, not npub) in your Worker's settings. This disables the claim endpoint outright.

## Configuration

The deploy button only asks for a project name. Everything else is an optional variable you can add later in the Cloudflare dashboard (**Workers & Pages → your worker → Settings → Variables**) if you want it:

| Var | Purpose |
|---|---|
| `OWNER_PUBKEY` | Fix ownership at deploy time instead of claiming (hex, not npub). Disables the claim endpoint. |
| `RELAY_NAME` / `RELAY_DESCRIPTION` / `RELAY_ICON` | Override the NIP-11 name/description/icon. Name and icon default to your claimed profile's kind-0 name/picture; description defaults to a generic string. |
| `ALLOW_FOLLOWS` | On by default: writes from your kind-3 follow list are accepted. The cache updates immediately when you publish a new contact list or mute list to this relay; hourly cron is just the fallback for when it arrived some other way. Set to `false` to disable and go back to owner-only writes. |

If your Worker is connected to a GitHub repo, Cloudflare may sync `wrangler.jsonc`'s config on every deploy, which can overwrite a variable you added in the dashboard by hand — worth knowing if a dashboard-added variable seems to reset after a deploy.

## Resetting

**Redeploying does *not* reset ownership.** Running `wrangler deploy` again (or re-clicking the deploy button) ships new code against the *same* storage — your events and your claim both survive. This trips people up because the instinct after "I want to start over" is to redeploy.

To actually reset a relay: **delete the Worker** from the Cloudflare dashboard (Workers & Pages → your worker → Settings → Delete) and deploy a fresh one. There is no in-place "unclaim" — Durable Object storage is tied to the Worker.

## Inbox mode (gift-wrapped DMs)

This relay also accepts [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift wraps addressed to you, from anyone — the one exception to "only the owner can write." It's the write path a client needs if you publish a `kind:10050` DM relay list naming this relay; bothy itself never publishes that list for you, so nothing changes unless you deliberately turn your relay into a DM inbox by signing one.

Reading them back is restricted to you: an unauthenticated query for gift wraps gets a [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH challenge instead of results, so a stranger can't use your relay to count or time-correlate your incoming DMs. You can delete a gift wrap the same way you'd delete any note ([NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)), and [NIP-62](https://github.com/nostr-protocol/nips/blob/master/62.md) "Request to Vanish" support means either you or a message's sender can ask for it to be permanently purged.

**Worth knowing:** Cloudflare terminates the TLS connection in front of this relay, so it necessarily sees the `p` tag (who a gift wrap is addressed to), the arrival time, and the sender's IP address, the same as any other Worker traffic. On a personal relay the `p` tag is always you, so that part leaks nothing new; the sender IPs, though, belong to other people sending you mail through infrastructure that you chose.

## Who can write here

By default, bothy accepts events from two kinds of author: you (the owner), and the people you follow. Not strangers. It works by reading the follow list (kind 3) you've already published — bothy doesn't ask you to maintain a separate allowlist, it just uses the one your nostr client already keeps.

Muting someone in your normal nostr client revokes their write access here too, as soon as that mute list reaches this relay (or within the hour, via cron, if it reached you some other way first). This only sees *public* mutes — the plain-text `p` tags in a NIP-51 mute list. Private mutes are encrypted to a key only your client holds, so bothy has no way to read those; it can only act on what's public.

Why this is the default rather than a limitation: bothy is meant to be one of the 2-4 relays your NIP-65 relay list already tells clients to keep, not your only relay. Pair it with a permissive public relay and you get both — your own filtered archive of people you actually follow, plus a general-purpose inbox that already does the spam filtering you'd otherwise have to build yourself. A reply from someone you don't follow isn't lost; it still lands on your other relay, and on the sender's own.

If you'd rather bothy only ever accept your own writes, set `ALLOW_FOLLOWS=false` (see "Configuration" below). NIP-11 advertises `restricted_writes: true` either way, so well-behaved clients know not to bother trying before they publish.

The admin page at your relay's URL is public — anyone with the link can see relay stats, your follow count, and your mute count. Never the follow or mute list itself, only the counts.

This is one rung of a documented ladder — see [docs/rungs.md](docs/rungs.md) for the full progression from owner-only writes up to the open-relay case bothy deliberately refuses to become.

## HTTP endpoints

- `GET /api/stats` — relay stats for the admin page. Returns `{ claimed, ownerPubkey, totalEvents, events24h, storageBytes, rowsWrittenEstimate24h, backfill, icon, writePolicy, followCount, followsRefreshedAt, muteCount }`.
- `POST /api/claim` — TOFU claim; body `{ pubkey }` (npub or hex). See "Ownership" above.
- `GET /live` — unauthenticated, push-only WebSocket for the admin page's live feed (max 5 connections, 10-minute lifetime); sends `{ kind, created_at, id }` per stored event, never gift wraps.
- Any path, with header `Accept: application/nostr+json` — the [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) relay information document.

## Choices, not requirements

The NIPs leave some behavior unspecified. Where they do, here's what this relay chose and why:

- Kinds outside the replaceable/ephemeral/addressable ranges (45–999, ≥40000) are undefined by NIP-01. Bothy stores them like regular events rather than rejecting them or guessing at intent.
- NIP-62 vanish requests bypass the owner-only write gate entirely. The spec requires this regardless of write-restriction status — a vanish request's authority comes from a user erasing their own data, not from write permission.
- A vanish request itself is never stored as a row. NIP-62 says relays MAY keep it for bookkeeping, not MUST; bothy pays no row cost for the request, only for whatever it deletes.
- Gift wraps are never sent over the live feed, redacted or not. The admin page has no way to authenticate a viewer, so every viewer is treated as permanently unauthenticated — the same posture NIP-42 enforces for gift wrap reads elsewhere.
- The NIP-42 gift-wrap read gate decides by asking storage directly — re-running the incoming filter restricted to `kinds: [1059]` — rather than reasoning about which filter shapes could leak a gift wrap. An earlier, cheaper version tried the latter and missed that an `ids`-only filter naming a known gift wrap id slipped through ungated.
- `ids`/`authors` filters don't support prefix matching. NIP-01 says relays MAY support it; this one doesn't.
- NIP-42's AUTH `created_at` drift window (600 seconds) isn't specified by the NIP. Bothy picked a number matching the ~10 minute convention other relays use.

## What this is not

This project deliberately does not do: payments/zaps, multi-region scaling, NIP-05 hosting, media uploads, moderation tooling, or a public write mode. Public writes sit at the top of a documented ladder ([docs/rungs.md](docs/rungs.md)) rather than being an unexplained refusal — see "Who can write here" above for the rungs bothy does implement. See `CLAUDE.md` for the full list and reasoning — most feature requests are already ruled out there.

## Attribution

[Nosflare](https://github.com/Spl0itable/nosflare) by Spl0itable is prior art that proved a nostr relay works on Workers + Durable Objects, and was a useful reference for NIP-01 filter-matching edge cases while building this. bothy is an original implementation, with no code shared between the two projects.

## Development

```bash
npm install
npm run dev        # wrangler dev, local DO with SQLite
npm run test       # protocol conformance + budget regression
npm run typecheck
npm run deploy      # wrangler deploy
```

See `CLAUDE.md` for architecture, the free-tier budget this project is built against, and the working conventions for this repo.

## Removing it

Two things must be deleted:

- **The Worker** — Cloudflare dashboard → Workers & Pages → your project → Settings → delete. This takes the relay offline.
- **The GitHub repo** Cloudflare created — its Settings → Danger Zone → Delete this repository.

Deleting only the repo leaves the relay running; deleting only the Worker leaves the repo behind.

## License

MIT.
