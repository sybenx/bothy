# bothy

[![Release](https://img.shields.io/github/v/tag/sybenx/bothy?style=for-the-badge)](../../tags)

A single-user nostr relay that runs on the Cloudflare free tier and deploys in one click.

A bothy is a shelter in the Scottish highlands that someone built and left unlocked for whoever needs it. Cloudflare's free tier is a bit like that, and this is a relay that runs in it.

You click the button, paste your `npub`, and get a `wss://` URL for your own relay. There is no terminal to use, no VPS to rent, no domain to register, and no always-on machine to keep running at home. The relay lives in your own Cloudflare account.

**Requires a Cloudflare account** (free, no card) **and a GitHub account** (also free) — Cloudflare puts a copy of the code in your Git account and deploys from there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sybenx/bothy)

If you have already deployed and want to pull in the latest changes, see "Keeping it updated" below.

## Setup

1. Click **Deploy to Cloudflare**. You'll be prompted to create a free Cloudflare account if you don't have one.
2. On **Set up your application**, pick your GitHub account from the **Git account** dropdown. Cloudflare creates a repo there holding your copy. Leave **Create private Git repository** unchecked unless you have a reason — public repos get free GitHub Actions minutes, which the updater uses. Then click **Deploy**.
3. The build takes about 30 seconds. **Refresh the page** when it finishes — the dashboard doesn't update on its own. A **Visit** button appears at the top right; that's your relay.
4. Open that URL, paste your npub into the claim form, and confirm. This step is one-time and permanent; see "Ownership and lifecycle" below.
5. Copy the `wss://` URL from the admin page into your nostr client's relay list.

No dashboard configuration is required.

## Keeping it updated

The deploy button copies this repo into your GitHub account as an independent repo, not a fork, so there is no automatic way to receive upstream changes. The two badges below set that up.

[![1: Enable the updater](https://img.shields.io/badge/1-Enable%20the%20updater-555555?style=flat-square)](../../new/main?filename=.github/workflows/sync.yml&value=name%3A%20Sync%20from%20upstream%0A%0Aon%3A%0A%20%20workflow_dispatch%3A%0A%0Apermissions%3A%0A%20%20contents%3A%20write%0A%0Ajobs%3A%0A%20%20sync%3A%0A%20%20%20%20runs-on%3A%20ubuntu-latest%0A%20%20%20%20%23%20The%20%22Deploy%20to%20Cloudflare%22%20button%20clones%20this%20repo%20into%20the%20user%27s%20account%20as%20an%0A%20%20%20%20%23%20independent%20repo%2C%20not%20a%20GitHub%20fork%2C%20so%20this%20workflow%20ships%20inside%20every%20downstream%0A%20%20%20%20%23%20copy%20too.%20Guard%20so%20it%20no-ops%20when%20it%20runs%20in%20the%20upstream%20repo%20itself.%0A%20%20%20%20if%3A%20github.repository%20%21%3D%20%27sybenx%2Fbothy%27%0A%20%20%20%20steps%3A%0A%20%20%20%20%20%20-%20name%3A%20Checkout%0A%20%20%20%20%20%20%20%20uses%3A%20actions%2Fcheckout%40v6%0A%20%20%20%20%20%20%20%20with%3A%0A%20%20%20%20%20%20%20%20%20%20fetch-depth%3A%200%0A%0A%20%20%20%20%20%20-%20name%3A%20Configure%20git%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.name%20%22github-actions%5Bbot%5D%22%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.email%20%22github-actions%5Bbot%5D%40users.noreply.github.com%22%0A%0A%20%20%20%20%20%20-%20name%3A%20Fetch%20upstream%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20remote%20add%20upstream%20https%3A%2F%2Fgithub.com%2Fsybenx%2Fbothy.git%0A%20%20%20%20%20%20%20%20%20%20git%20fetch%20upstream%20main%0A%0A%20%20%20%20%20%20-%20name%3A%20Pull%20in%20upstream%20files%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20upstream%2Fmain%20--%20.%0A%0A%20%20%20%20%20%20-%20name%3A%20Restore%20local%20config%0A%20%20%20%20%20%20%20%20%23%20wrangler.jsonc%20holds%20the%20D1%2FKV%2FR2%20IDs%20Cloudflare%20provisioned%20for%20this%20deployment%2C%0A%20%20%20%20%20%20%20%20%23%20and%20.github%2F%20holds%20this%20workflow%20itself%20%E2%80%94%20neither%20must%20ever%20be%20overwritten%20by%20upstream.%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20HEAD%20--%20wrangler.jsonc%20.github%2F%0A%0A%20%20%20%20%20%20-%20name%3A%20Stage%20deletions%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20diff%20--diff-filter%3DD%20--name-only%20HEAD%20upstream%2Fmain%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20grep%20-v%20%27%5E%5C.github%2F%27%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20xargs%20-r%20git%20rm%20--%0A%0A%20%20%20%20%20%20-%20name%3A%20Commit%20and%20push%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20if%20git%20diff%20--quiet%20%26%26%20git%20diff%20--cached%20--quiet%3B%20then%0A%20%20%20%20%20%20%20%20%20%20%20%20echo%20%22Already%20up%20to%20date%20with%20upstream.%22%0A%20%20%20%20%20%20%20%20%20%20%20%20exit%200%0A%20%20%20%20%20%20%20%20%20%20fi%0A%20%20%20%20%20%20%20%20%20%20git%20add%20-A%0A%20%20%20%20%20%20%20%20%20%20git%20commit%20-m%20%22Sync%20from%20upstream%20%28sybenx%2Fbothy%29%22%0A%20%20%20%20%20%20%20%20%20%20git%20push%20origin%20HEAD%3A%24%7B%7B%20github.ref_name%20%7D%7D%0A)
[![2: Check for updates](https://img.shields.io/badge/2-Check%20for%20updates-555555?style=flat-square)](../../actions/workflows/sync.yml)

**Enable the updater** opens GitHub's web editor with `sync.yml` pre-filled; commit it. Then, whenever you want the latest changes, click **Check for updates**, click **Run workflow**, leave the branch as `main`, and click the green **Run workflow** button. Cloudflare redeploys automatically within a minute or two. Your relay stays claimed and your events survive a redeploy.

If you deployed manually instead of via the button, update the same way you would any git project:

```bash
git remote add upstream https://github.com/sybenx/bothy.git
git fetch upstream
git checkout upstream/main -- .
git checkout HEAD -- wrangler.jsonc
git commit -m "Sync from upstream"
git push
npx wrangler deploy
```

## Ownership and lifecycle

The first person to submit their pubkey through the claim form owns the relay, permanently. This is "trust on first use" (TOFU): there's no signature check on the claim itself, but every event is still verified against its own signature regardless of who owns the relay, so a wrong claim can't be used to forge anything. If someone else claims your relay before you do, the worst case is that it archives a stranger's public notes at your expense; you can recover by deleting the Worker and deploying again. If you want to skip the claim flow entirely, set the `OWNER_PUBKEY` environment variable (hex, not npub) at deploy time; this disables the claim endpoint outright.

Redeploying does not reset ownership or storage. Running `wrangler deploy` again, or re-clicking the deploy button, ships new code against the same storage, so your events and your claim both survive. To actually reset a relay, delete the Worker from the Cloudflare dashboard (Workers & Pages → your worker → Settings → Delete) and deploy a fresh one. There is no in-place "unclaim," since Durable Object storage is tied to the Worker.

To remove the relay entirely, delete two things: the Worker (Workers & Pages → your project → Settings → Delete), which takes the relay offline, and the GitHub repo Cloudflare created (its Settings → Danger Zone → Delete this repository). Deleting only the repo leaves the relay running; deleting only the Worker leaves the repo behind.

## Configuration

The deploy button only asks for a project name. Everything else is an optional variable you can add later in the Cloudflare dashboard (**Workers & Pages → your worker → Settings → Variables**) if you want it:

| Var | Purpose |
|---|---|
| `OWNER_PUBKEY` | Fix ownership at deploy time instead of claiming (hex, not npub). Disables the claim endpoint. |
| `RELAY_NAME` / `RELAY_DESCRIPTION` / `RELAY_ICON` | Set the NIP-11 name/description/icon. These outrank anything set through the management API, which in turn outranks your kind-0 profile — see "Relay management API" below for the full order. |
| `ALLOW_FOLLOWS` | On by default: writes from your kind-3 follow list are accepted. The cache updates immediately when you publish a new contact list to this relay; hourly cron is just the fallback for when it arrived some other way. Set to `false` to disable and go back to owner-only writes. |

If your Worker is connected to a GitHub repo, Cloudflare may sync `wrangler.jsonc`'s config on every deploy, which can overwrite a variable you added in the dashboard by hand — worth knowing if a dashboard-added variable seems to reset after a deploy.

This relay's read path is intentionally public, so it is worth adding a free Cloudflare rate-limiting rule against abusive traffic: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** for your zone and cap requests per IP to your Worker's route. The relay enforces its own per-connection and per-IP limits regardless, but an edge rule catches abuse before it reaches the Worker at all.

## Inbox mode (gift-wrapped DMs)

This relay also accepts [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift wraps addressed to you, from anyone — the one exception to "only the owner can write." It's the write path a client needs if you publish a `kind:10050` DM relay list naming this relay; bothy itself never publishes that list for you, so nothing changes unless you deliberately turn your relay into a DM inbox by signing one.

Reading them back is restricted to you: an unauthenticated query for gift wraps gets a [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH challenge instead of results, so a stranger can't use your relay to count or time-correlate your incoming DMs. You can delete a gift wrap the same way you'd delete any note ([NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)), and [NIP-62](https://github.com/nostr-protocol/nips/blob/master/62.md) "Request to Vanish" support means either you or a message's sender can ask for it to be permanently purged.

**Worth knowing:** Cloudflare terminates the TLS connection in front of this relay, so it necessarily sees the `p` tag (who a gift wrap is addressed to), the arrival time, and the sender's IP address, the same as any other Worker traffic. On a personal relay the `p` tag is always you, so that part leaks nothing new; the sender IPs, though, belong to other people sending you mail through infrastructure that you chose.

## Who can write here

By default, bothy accepts events from two kinds of author: you (the owner), and the people you follow. Not strangers. It works by reading the follow list (kind 3) you've already published — bothy doesn't ask you to maintain a separate allowlist, it just uses the one your nostr client already keeps.

Why this is the default rather than a limitation: bothy is meant to be one of the 2-4 relays your NIP-65 relay list already tells clients to keep, not your only relay. Pair it with a permissive public relay and you get both — your own filtered archive of people you actually follow, plus a general-purpose inbox that already does the spam filtering you'd otherwise have to build yourself. A reply from someone you don't follow isn't lost; it still lands on your other relay, and on the sender's own.

If you'd rather bothy only ever accept your own writes, set `ALLOW_FOLLOWS=false` (see "Configuration" above). NIP-11 advertises `restricted_writes: true` either way, so well-behaved clients know not to bother trying before they publish.

The admin page at your relay's URL is public — anyone with the link can see relay stats and your follow count. Never the follow list itself, only the count.

This is one rung of a documented ladder — see [docs/rungs.md](docs/rungs.md) for the full progression from owner-only writes up to the open-relay case bothy deliberately refuses to become.

## Relay management API

bothy implements [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md), the relay management API. It lets you ban an event, block an IP address, or change the relay's name, description and icon, without redeploying and without touching the Cloudflare dashboard. There is no web interface for it, deliberately: the admin page stays a read-only status page that is safe to leave public, and every management command is a signed request you send from the command line.

The tool to send them with is [`nak`](https://github.com/fiatjaf/nak), whose `admin` subcommand speaks NIP-86. The shape of every command is the same — the method, your secret key, whatever parameters the method takes, and your relay's host last:

```bash
nak admin supportedmethods --sec <your nsec> your-relay.workers.dev
```

Start there. `supportedmethods` returns exactly what this relay implements, which is the honest answer to what you can do with it, and `nak admin --help` lists the flags each method takes. Every request is authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the relay owner's key — the same key you claimed the relay with. Nothing else is accepted, and an unsigned or wrongly signed request gets a 401.

What this relay implements: `banevent` and `allowevent` and `listbannedevents`; `banpubkey`, `unbanpubkey` and `listbannedpubkeys`; `allowpubkey`, `unallowpubkey` and `listallowedpubkeys`; `blockip` and `unblockip` and `listblockedips`; `changerelayname`, `changerelaydescription` and `changerelayicon`. What it does not: the kind allowlist, because bothy stores every kind on purpose; and the moderation queue, because bothy has nothing to report events into.

Banning an event tombstones its id, so the event is refused if it arrives again — including from a client re-sending it and from backfill pulling it out of another relay's history. You can ban an id you don't hold yet, and it will be refused on arrival. `allowevent` reverses this and is the only thing in bothy that lifts a tombstone.

Banning a pubkey refuses every future write from it, checked on the same write path as the follow list — a banned pubkey is refused even if it's also someone you follow. `unbanpubkey` lifts the ban. Separately, `allowpubkey` grants write access to a specific pubkey you don't follow, without opening writes any wider than that one key; `unallowpubkey` revokes it. Banning and allowing are independent: allowing a pubkey never overrides a ban on the same key. Both accept an npub or hex pubkey.

Blocking an IP address is checked once, when a WebSocket connection opens, and never again. It never applies to the management API itself, so blocking your own address cannot lock you out of the command that unblocks it. Because blocking the address you are calling from is nonetheless the easiest way to surprise yourself, the first attempt refuses and tells you the exact confirmation string to pass as the reason; a second call carrying that string goes through.

### Setting the name, description and icon

Each of the three resolves in the same order, from most to least authoritative:

1. The environment variable (`RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`), if you set one in the Cloudflare dashboard.
2. The value stored through `changerelayname`, `changerelaydescription` or `changerelayicon`.
3. Your kind-0 profile — its `name`, `about` and `picture`.
4. A built-in default.

When a name comes from your kind-0 profile it is derived rather than chosen, so it reads possessively: a profile name of "Aaron" becomes "Aaron's relay". A name you set yourself, by either of the first two routes, is used exactly as you wrote it.

If an environment variable is set, a `change*` call still stores your value and tells you that the variable is currently winning. Nothing is silently discarded, and the stored value takes effect the moment you clear the variable.

NIP-86 defines no way to unset a value, so bothy uses a convention: **passing an empty string clears the stored value**, falling through to your kind-0 profile and then to the built-in default. Every successful `change*` response says so, and points you at the NIP-11 document as the place to read back what is actually in effect:

```bash
curl -H "Accept: application/nostr+json" https://your-relay.workers.dev
```

The effective name also appears on the admin page, since NIP-86 has no `getrelayname` to pair with `changerelayname`.

## HTTP endpoints

- `GET /api/stats` — relay stats for the admin page. Returns `{ claimed, ownerPubkey, totalEvents, events24h, ingested24h, storageBytes, rowsWrittenEstimate24h, backfill, icon, relayName, writePolicy, followCount, followsRefreshedAt }`. `events24h` counts events by their own timestamp, which is what you posted; `ingested24h` counts what this relay actually took in, backfill included. During a backfill those differ by orders of magnitude.
- `POST /api/claim` — TOFU claim; body `{ pubkey }` (npub or hex). See "Ownership and lifecycle" above.
- `GET /live` — unauthenticated, push-only WebSocket for the admin page's live feed (max 5 connections, 10-minute lifetime); sends `{ kind, created_at, id }` per stored event, never gift wraps.
- Any path, with header `Accept: application/nostr+json` — the [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) relay information document.
- `POST /`, with header `Content-Type: application/nostr+json+rpc` — the [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md) management API, authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the owner. See "Relay management API" above.

## Choices, not requirements

The NIPs leave some behavior unspecified. Two choices are worth knowing if you're building a client against this relay:

- `ids`/`authors` filters don't support prefix matching. NIP-01 says relays MAY support it; this one doesn't.
- NIP-42's AUTH `created_at` drift window is 600 seconds. This isn't specified by the NIP; bothy picked a number matching the ~10 minute convention other relays use.
- NIP-86 defines no way to unset a relay name, description or icon. bothy treats an empty string as the unset operation, which falls back to your kind-0 profile and then to a built-in default.

## What this is not

This project deliberately does not do: payments/zaps, multi-region scaling, NIP-05 hosting, media uploads, community moderation tooling, or a public write mode. The NIP-86 management API is the owner administering their own relay, not moderation tooling in the community sense — there are no moderator roles, no invite system, and no report queue. Public writes sit at the top of a documented ladder ([docs/rungs.md](docs/rungs.md)) rather than being an unexplained refusal — see "Who can write here" above for the rungs bothy does implement. See `CLAUDE.md` for the full list and reasoning — most feature requests are already ruled out there.

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

## License

MIT.
