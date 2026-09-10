# bothy

[![Release](https://img.shields.io/github/v/tag/sybenx/bothy?style=for-the-badge)](../../tags)

A single-user nostr relay that runs on the Cloudflare free tier and deploys in one click.

A bothy is a shelter in the Scottish highlands that someone built and left unlocked for whoever needs it. Cloudflare's free tier is a bit like that, and this is a relay that runs in it.

You click the button, paste your `npub`, and get a `wss://` URL for your own relay. There is no terminal to use, no VPS to rent, no domain to register, and no always-on machine to keep running at home. The relay lives in your own Cloudflare account.

**Requires a Cloudflare account** (free, no card) **and a GitHub account** (also free) — Cloudflare puts a copy of the code in your Git account and deploys from there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sybenx/bothy)

If you have already deployed, see "Keeping it updated" below for the one file that keeps your copy in step with this one automatically.

## Setup

1. Click **Deploy to Cloudflare**. You'll be prompted to create a free Cloudflare account if you don't have one.
2. On **Set up your application**, pick your GitHub account from the **Git account** dropdown. Cloudflare creates a repo there holding your copy. Leave **Create private Git repository** unchecked unless you have a reason — public repos get free GitHub Actions minutes, which the updater uses. Then click **Deploy**.
3. The build takes about 30 seconds. **Refresh the page** when it finishes — the dashboard doesn't update on its own. A **Visit** button appears at the top right; that's your relay.
4. Open that URL, paste your npub into the claim form, and confirm. This step is one-time and permanent; see "Ownership and lifecycle" below.
5. Copy the `wss://` URL from the admin page into your nostr client's relay list.

No dashboard configuration is required.

## Keeping it updated

The deploy button copies this repo into your GitHub account as an independent repo, not a fork, so nothing pulls in upstream changes on its own, and the copy arrives without the workflow that would. The badge below is that workflow: commit the file it hands you and your relay updates itself from then on.

[![Turn on auto-update](https://img.shields.io/badge/Turn%20on%20auto--update-555555?style=flat-square)](../../new/main?filename=.github/workflows/sync.yml&value=name%3A%20Sync%20from%20upstream%0A%0Aon%3A%0A%20%20%23%20Weekly%2C%20which%20is%20what%20makes%20committing%20this%20file%20the%20whole%20of%20turning%0A%20%20%23%20auto-update%20on%3A%20there%20is%20no%20second%20switch%20to%20find%20and%20nothing%20to%20come%0A%20%20%23%20back%20and%20click.%20Monday%20morning%20UTC%2C%20at%20a%20minute%20nowhere%20near%20the%20top%0A%20%20%23%20of%20the%20hour%20--%20GitHub%20runs%20scheduled%20jobs%20on%20a%20shared%20queue%20and%20delays%0A%20%20%23%20the%20ones%20piled%20onto%20%3A00%20%28docs.github.com%2Factions%2Freference%2Fworkflows-and-actions%2Fevents-that-trigger-workflows%2C%0A%20%20%23%20checked%202026-08-31%29.%0A%20%20%23%0A%20%20%23%20A%20run%20against%20an%20unchanged%20upstream%20pushes%20nothing%20and%20redeploys%0A%20%20%23%20nothing%20%28see%20%22Commit%20and%20push%22%20below%29%2C%20so%20the%20cost%20of%20the%20cadence%20is%0A%20%20%23%20roughly%20a%20minute%20of%20Actions%20time%20a%20week%2C%20free%20on%20public%20repos.%0A%20%20%23%0A%20%20%23%20Worth%20knowing%3A%20GitHub%20disables%20scheduled%20workflows%20in%20a%20repository%0A%20%20%23%20with%2060%20days%20of%20no%20activity%20and%20emails%20the%20owner%2C%20so%20a%20relay%20left%0A%20%20%23%20entirely%20alone%20can%20stop%20checking.%20A%20sync%20that%20lands%20a%20commit%20is%0A%20%20%23%20itself%20activity%2C%20so%20this%20only%20bites%20when%20upstream%20has%20also%20been%0A%20%20%23%20quiet%20--%20and%20re-enabling%20is%20one%20button%20on%20the%20Actions%20tab.%0A%20%20schedule%3A%0A%20%20%20%20-%20cron%3A%20%2223%206%20%2A%20%2A%201%22%0A%0A%20%20%23%20Kept%20beside%20the%20schedule%2C%20not%20replaced%20by%20it%3A%20this%20is%20the%20%22check%20now%22%0A%20%20%23%20button%20for%20someone%20who%20has%20just%20read%20about%20a%20fix%20and%20does%20not%20want%20to%0A%20%20%23%20wait%20until%20Monday.%0A%20%20workflow_dispatch%3A%0A%0Apermissions%3A%0A%20%20contents%3A%20write%0A%0Ajobs%3A%0A%20%20sync%3A%0A%20%20%20%20runs-on%3A%20ubuntu-latest%0A%20%20%20%20%23%20The%20%22Deploy%20to%20Cloudflare%22%20button%20clones%20this%20repo%20into%20the%20user%27s%20account%20as%20an%0A%20%20%20%20%23%20independent%20repo%2C%20not%20a%20GitHub%20fork%2C%20so%20this%20workflow%20ships%20inside%20every%20downstream%0A%20%20%20%20%23%20copy%20too.%20Guard%20so%20it%20no-ops%20when%20it%20runs%20in%20the%20upstream%20repo%20itself.%0A%20%20%20%20if%3A%20github.repository%20%21%3D%20%27sybenx%2Fbothy%27%0A%20%20%20%20steps%3A%0A%20%20%20%20%20%20-%20name%3A%20Checkout%0A%20%20%20%20%20%20%20%20uses%3A%20actions%2Fcheckout%40v6%0A%20%20%20%20%20%20%20%20with%3A%0A%20%20%20%20%20%20%20%20%20%20fetch-depth%3A%200%0A%0A%20%20%20%20%20%20-%20name%3A%20Configure%20git%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.name%20%22github-actions%5Bbot%5D%22%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.email%20%22github-actions%5Bbot%5D%40users.noreply.github.com%22%0A%0A%20%20%20%20%20%20-%20name%3A%20Fetch%20upstream%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20remote%20add%20upstream%20https%3A%2F%2Fgithub.com%2Fsybenx%2Fbothy.git%0A%20%20%20%20%20%20%20%20%20%20git%20fetch%20upstream%20main%0A%0A%20%20%20%20%20%20-%20name%3A%20Pull%20in%20upstream%20files%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20upstream%2Fmain%20--%20.%0A%0A%20%20%20%20%20%20-%20name%3A%20Restore%20local%20config%0A%20%20%20%20%20%20%20%20%23%20wrangler.jsonc%20holds%20the%20D1%2FKV%2FR2%20IDs%20Cloudflare%20provisioned%20for%20this%20deployment%2C%0A%20%20%20%20%20%20%20%20%23%20and%20.github%2F%20holds%20this%20workflow%20itself%20%E2%80%94%20neither%20must%20ever%20be%20overwritten%20by%20upstream.%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20HEAD%20--%20wrangler.jsonc%20.github%2F%0A%0A%20%20%20%20%20%20-%20name%3A%20Stage%20deletions%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20diff%20--diff-filter%3DD%20--name-only%20HEAD%20upstream%2Fmain%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20grep%20-v%20%27%5E%5C.github%2F%27%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20xargs%20-r%20git%20rm%20--%0A%0A%20%20%20%20%20%20-%20name%3A%20Commit%20and%20push%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20if%20git%20diff%20--quiet%20%26%26%20git%20diff%20--cached%20--quiet%3B%20then%0A%20%20%20%20%20%20%20%20%20%20%20%20echo%20%22Already%20up%20to%20date%20with%20upstream.%22%0A%20%20%20%20%20%20%20%20%20%20%20%20exit%200%0A%20%20%20%20%20%20%20%20%20%20fi%0A%20%20%20%20%20%20%20%20%20%20git%20add%20-A%0A%20%20%20%20%20%20%20%20%20%20git%20commit%20-m%20%22Sync%20from%20upstream%20%28sybenx%2Fbothy%29%22%0A%20%20%20%20%20%20%20%20%20%20git%20push%20origin%20HEAD%3A%24%7B%7B%20github.ref_name%20%7D%7D%0A)

It opens GitHub's web editor with `sync.yml` filled in; click **Commit changes** and you're done. Every Monday morning it checks this repo, and if anything changed it commits the new files into your copy, which Cloudflare redeploys within a minute or two. A week where nothing changed upstream commits nothing and redeploys nothing. Your relay stays claimed and your events survive a redeploy.

To pull in a change **right now** rather than waiting for Monday: **Actions → Sync from upstream → Run workflow**, leave the branch as `main`, then the green **Run workflow** button.

To pause it: **Actions → Sync from upstream → ⋯ → Disable workflow**; the same menu turns it back on. To stop for good, delete `.github/workflows/sync.yml`. One thing worth knowing either way: GitHub disables scheduled workflows in a repository that has gone 60 days without activity, and emails you when it does — a sync that lands a commit counts as activity, so this only comes up when this repo has been quiet too.

Whether or not you enable any of that, your relay's admin page tells you when there's a newer release: it compares the version it's running against this repo's and shows a quiet `v… available` note beside its own version in the footer. Set the `UPDATE_CHECK` variable to `off` (see "Configuration" below) if you'd rather it never asked.

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

The first person to submit their pubkey through the claim form owns the relay, permanently. This is "trust on first use" (TOFU): there's no signature check on the claim itself, but every event is still verified against its own signature regardless of who owns the relay, so a wrong claim can't be used to forge anything. If someone else claims your relay before you do, the worst case is that it archives a stranger's public notes at your expense; you can recover by deleting the Worker and deploying again. If you want to skip the claim flow entirely, set the `OWNER_PUBKEY` environment variable at deploy time (`npub1...` or lowercase hex, normalized the same way the claim form normalizes what you paste into it); this disables the claim endpoint outright.

Claiming also starts a one-time backfill of your history: bothy looks up the relays your own kind-10002 list already names as ones you publish to, resolving that list via a couple of well-known relays, then pulls your past notes in from them automatically, a page at a time on each hourly cron tick, until it's caught up. This needs no action from you and stops once it's done; the admin page shows its progress.

Redeploying does not reset ownership or storage. Running `wrangler deploy` again, or re-clicking the deploy button, ships new code against the same storage, so your events and your claim both survive. To actually reset a relay, delete the Worker from the Cloudflare dashboard (Workers & Pages → your worker → Settings → Delete) and deploy a fresh one. There is no in-place "unclaim," since Durable Object storage is tied to the Worker.

To remove the relay entirely, delete two things: the Worker (Workers & Pages → your project → Settings → Delete), which takes the relay offline, and the GitHub repo Cloudflare created (its Settings → Danger Zone → Delete this repository). Deleting only the repo leaves the relay running; deleting only the Worker leaves the repo behind.

## Configuration

The deploy button only asks for a project name. Everything else is an optional variable you can add later in the Cloudflare dashboard (**Workers & Pages → your worker → Settings → Variables**) if you want it:

| Var | Purpose |
|---|---|
| `OWNER_PUBKEY` | Fix ownership at deploy time instead of claiming (`npub1...` or lowercase hex). Disables the claim endpoint. |
| `RELAY_NAME` / `RELAY_DESCRIPTION` / `RELAY_ICON` | Set the NIP-11 name/description/icon. These outrank anything set through the management API, which in turn outranks your kind-0 profile — see "Relay management API" below for the full order. |
| `MAX_EVENT_BYTES` | Largest event this relay will accept, JSON-serialized, for everyone including you. Defaults to `65536` (64KB) — generous for any real note, including long-form. Raise it to a number, or set it to `off` to remove the cap. |
| `MAX_EVENTS_PER_PUBKEY_PER_MINUTE` | How fast any one non-owner pubkey may publish. Defaults to `20`/minute — far above human posting rates, slow enough that a runaway follow takes hours rather than minutes to spend the daily write budget. You are never throttled. Raise it to a number, or set it to `off`. |
| `NON_OWNER_STORAGE_BYTES` | Point at which writes from anyone but you are refused, reserving what's left of the 5GB free-tier ceiling for your own archive. Defaults to `2684354560` (half). Raise it to a number, or set it to `off`. |
| `WRITE_RUNG` | Pin the write policy to a rung of the ladder (see "Who can write here" below): `1`–`4`, or `owner`, `inbox`, `follows`, `mentions`. Set here it outranks whatever was set through the management API. Unset, the stored value applies, and then the default of `3` (follows). |
| `ALLOW_FOLLOWS` | The older way of narrowing writes, kept so existing deployments keep behaving: `false` reads as rung `2` (owner plus mail), which is exactly what it always produced. Prefer `WRITE_RUNG`, which outranks it. |
| `GROUPS` | NIP-29 groups are **paused** unless this is the exact string `on`. Paused, the relay refuses every group-scoped write, moderation event and join request, and stops advertising NIP-29; what is already in the group partition stays readable by the owner and the members on the list. The group code is not documented here yet — see "What this is not". |
| `UPDATE_CHECK` | On by default: the relay asks this repo what the current release is (one request, cached for six hours, made by the Worker rather than by your browser) so the admin page can say when a newer one exists. Set it to `off` and the relay never makes that request; the footer then simply shows no notice. |

If your Worker is connected to a GitHub repo, Cloudflare may sync `wrangler.jsonc`'s config on every deploy, which can overwrite a variable you added in the dashboard by hand — worth knowing if a dashboard-added variable seems to reset after a deploy.

This relay's read path is intentionally public, so it is worth adding a free Cloudflare rate-limiting rule against abusive traffic: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** for your zone and cap requests per IP to your Worker's route. The relay enforces its own per-connection and per-IP limits regardless, but an edge rule catches abuse before it reaches the Worker at all.

## Inbox mode (gift-wrapped DMs)

This relay also accepts [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift wraps addressed to you, from anyone, regardless of who else is allowed to write here — see "Who can write here" below for that policy. It's the write path a client needs if you publish a `kind:10050` DM relay list naming this relay; bothy itself never publishes that list for you, so nothing changes unless you deliberately turn your relay into a DM inbox by signing one.

Reading them back is restricted to you. A query that names kind 1059 gets a [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH challenge instead of results; a query that doesn't name a kind is answered normally, with the gift wraps simply absent from what comes back. The second half matters as much as the first: refusing a query only when it would have matched a gift wrap makes the refusal itself the answer, and a stranger sliding a time window across your relay could count and time-correlate your incoming DMs from the refusals alone, without ever mentioning kind 1059. Leaving them out answers the same way whether your inbox is full or empty. You can delete a gift wrap the same way you'd delete any note ([NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)), and [NIP-62](https://github.com/nostr-protocol/nips/blob/master/62.md) "Request to Vanish" support means either you or a message's sender can ask for it to be permanently purged.

**Worth knowing:** Cloudflare terminates the TLS connection in front of this relay, so it necessarily sees the `p` tag (who a gift wrap is addressed to), the arrival time, and the sender's IP address, the same as any other Worker traffic. On a personal relay the `p` tag is always you, so that part leaks nothing new; the sender IPs, though, belong to other people sending you mail through infrastructure that you chose.

## Who can write here

Write access is a ladder with four rungs, and your relay sits on one of them. Each rung admits everyone the rung below it admits, plus one more class of author — so the number says how open the relay is, and moving it is one command.

| Rung | Name | Who can publish | What bounds the volume |
|---|---|---|---|
| 1 | `owner` | You. | Your own posting rate. |
| 2 | `inbox` | You, plus gift-wrapped mail addressed to you from anyone (see "Inbox mode" above). | Per-message size, a storage share reserved for mail, and a per-sender throttle. |
| 3 | `follows` | Everything above, plus the people in your kind-3 follow list. **The default.** | The size of your follow list. |
| 4 | `mentions` | Everything above, plus anyone at all — if their event mentions you (carries your pubkey in a `p` tag: a reply, a reaction, a mention, a zap). | How many people mention you, with a cap on how many indexed tags a stranger's event may carry so that "anyone" stays a bound on rows and not just on people. |

There is no rung 5. An open relay that accepts anything from anyone is bounded by nothing, and that is a difference in kind rather than degree — see [docs/rungs.md](docs/rungs.md), which this table implements. Ask for it and the management API tells you the same thing.

Two things sit outside the ladder and apply at every rung. A pubkey you name with `allowpubkey` (management API, below) can always write, whatever the rung — that is you deciding by hand, which the ladder document places inside rung 1. A pubkey you `banpubkey` can never write, follow or not, mention or not.

To move the ladder, send the rung as a number or a name:

```bash
nak admin changewritepolicy --sec <your nsec> mentions your-relay.workers.dev
nak admin getwritepolicy --sec <your nsec> your-relay.workers.dev
```

It takes effect on the next event, without a redeploy. An empty string clears the stored rung and falls back to the default; `getwritepolicy` reads back the rung in force and where it came from (the `WRITE_RUNG` variable, the stored value, or the default), and the admin page shows the same line. If you set `WRITE_RUNG` in the Cloudflare dashboard it outranks the stored value, and `changewritepolicy` will still store yours and tell you the variable is winning — nothing is silently discarded.

By default, then, bothy accepts events from two kinds of author: you (the owner), and the people you follow. Not strangers. It works by reading the follow list (kind 3) you've already published — bothy doesn't ask you to maintain a separate allowlist, it just uses the one your nostr client already keeps.

Why this is the default rather than a limitation: bothy is meant to be one of the 2-4 relays your NIP-65 relay list already tells clients to keep, not your only relay. Pair it with a permissive public relay and you get both — your own filtered archive of people you actually follow, plus a general-purpose inbox that already does the spam filtering you'd otherwise have to build yourself. A reply from someone you don't follow isn't lost; it still lands on your other relay, and on the sender's own.

Following someone is not unlimited trust. Anyone writing here is capped at 64KB per event and 20 events a minute, and writes from anyone but you stop once the relay is half full — so an account that gets compromised or goes haywire slows to something you'll notice and can revoke (unfollow, or `banpubkey` through the management API) long before it can fill your storage or spend a day's write budget. All three limits are adjustable; see "Configuration" above.

If you'd rather bothy only ever accept your own writes, move to rung 1 (`changewritepolicy owner`, or `WRITE_RUNG=1`); rung 2 keeps the mail. NIP-11 advertises `restricted_writes: true` at every rung, so well-behaved clients know not to bother trying before they publish.

The admin page at your relay's URL is public — anyone with the link can see relay stats and your follow count. Never the follow list itself, only the count.

The ladder itself is documented generically in [docs/rungs.md](docs/rungs.md), from owner-only writes up to the open-relay case bothy deliberately refuses to become.

## Relay management API

bothy implements [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md), the relay management API. It lets you ban an event, block an IP address, or change the relay's name, description and icon, without redeploying and without touching the Cloudflare dashboard. There is no web interface for it, deliberately: the admin page stays a read-only status page that is safe to leave public, and every management command is a signed request you send from the command line.

The tool to send them with is [`nak`](https://github.com/fiatjaf/nak), whose `admin` subcommand speaks NIP-86. The shape of every command is the same — the method, your secret key, whatever parameters the method takes, and your relay's host last:

```bash
nak admin supportedmethods --sec <your nsec> your-relay.workers.dev
```

Start there. `supportedmethods` returns exactly what this relay implements, which is the honest answer to what you can do with it, and `nak admin --help` lists the flags each method takes. Every request is authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the relay owner's key — the same key you claimed the relay with. Nothing else is accepted, and an unsigned or wrongly signed request gets a 401.

What this relay implements: `banevent` and `allowevent` and `listbannedevents`; `banpubkey`, `unbanpubkey` and `listbannedpubkeys`; `allowpubkey`, `unallowpubkey` and `listallowedpubkeys`; `blockip` and `unblockip` and `listblockedips`; `changerelayname`, `changerelaydescription` and `changerelayicon`; and, bothy's own, `changewritepolicy` and `getwritepolicy` for the write ladder (see "Who can write here" above). What it does not: the kind allowlist, because bothy stores every kind on purpose; and the moderation queue, because bothy has nothing to report events into.

The endpoint sends CORS headers and answers a preflight, so a client hosted somewhere other than the relay can call it from a browser. That weakens nothing: every call is a signed NIP-98 event, there is no cookie or session for a cross-origin request to borrow, and an unauthenticated preflight reveals only that the endpoint exists — which the NIP-11 document already advertises to anybody. Without it the API is reachable only from a page the relay itself served, which is not where most clients live.

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

- `GET /api/stats` — relay stats for the admin page. Returns `{ version, claimed, ownerPubkey, totalEvents, events24h, ingested24h, rowsWrittenToday, storageBytes, storageBytesLimit, dailyRowsWrittenLimit, dailyRowsReadLimit, backfill, icon, relayName, writePolicy, writeRung, writeRungSource, groupPolicy, chatPolicy, followCount, countAudit, followsListAt, vanishing, reads }`. `writePolicy`/`writeRung`/`writeRungSource` are the write ladder's rung in force, its name, and whether it came from `WRITE_RUNG`, the legacy `ALLOW_FOLLOWS`, a stored `changewritepolicy`, or the default; `groupPolicy` is `on` or `paused`. `events24h` counts events by their own timestamp, which is what you posted; `ingested24h` counts what this relay actually took in, backfill included. During a backfill those differ by orders of magnitude. `vanishing` is a count, a progress total and an age — never the pubkeys that asked, since this endpoint is public and naming them would publish exactly the list a vanish request exists to remove someone from.
  Every figure here is a maintained counter, exact and current as of the request — nothing on this document is cached or dated. `events24h` and `ingested24h` are windowed in whole hours, so each spans 24–25 hours rather than exactly 24; `rowsWrittenToday` is exact, since a UTC day starts on a whole hour.
  `rowsWrittenToday` means rows written, all of them: event rows and their index entries, tag rows, tombstones, counter updates, the follow-list rebuild, NIP-86 calls, backfill bookkeeping. It is measured rather than estimated, and it reads slightly high, because a removal is charged the pessimistic figure Cloudflare's cursor cannot confirm — see CLAUDE.md "The budget". There used to be two timestamps here, `snapshotAt` and `liveAt`, dating a six-hour cache over the counts that walked a table and a five-minute cache over these last two; both caches were removed as each figure became a counter.
- `POST /api/claim` — TOFU claim; body `{ pubkey }` (npub or hex). See "Ownership and lifecycle" above.
- `GET /api/profile?pubkey=<hex>` — the claim form's courtesy profile preview: it looks your kind-0 up on a couple of well-known relays so you can see the name and avatar attached to a pubkey before binding the relay to it permanently. **This is a setup endpoint and it is only reachable during setup** — once the relay is claimed it returns 404, because it exists to guard one irreversible step and there is no reason to leave a path that opens outbound connections to third-party relays permanently open to anybody. Results are cached for five minutes.
- `GET /live` — unauthenticated, push-only WebSocket for the admin page's live feed (max 5 connections, 10-minute lifetime); sends `{ kind, created_at, id }` per stored event, never gift wraps.
- Any path, with header `Accept: application/nostr+json` — the [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) relay information document. It reports the relay's name, description and icon, along with `pubkey` (yours, once the relay is claimed), and `contact` (the `website` from your kind-0 profile, if you have one). Both are omitted rather than left empty when there is nothing to report.
- `POST /`, with header `Content-Type: application/nostr+json+rpc` — the [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md) management API, authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the owner. See "Relay management API" above.

Every endpoint above that reaches the relay's storage is rate limited per IP: 60 requests a minute shared across all of them and the WebSocket connection itself, and 10 a minute for `/api/profile`, which is tighter because it is the one that reaches out to other people's relays. Over the limit you get a `429` with a `Retry-After`. The admin page itself is a static file and is never rate limited — if the relay is refusing you, the page that says so still loads. Raising these means editing the `ratelimits` block in `wrangler.jsonc` and redeploying; there is no environment variable for them, because unlike the write-path caps they cost nothing to leave in place.

## Choices, not requirements

The NIPs leave some behavior unspecified. A few choices are worth knowing if you're building a client against this relay:

- `ids`/`authors` filters don't support prefix matching. NIP-01 says relays MAY support it; this one doesn't.
- NIP-42's AUTH `created_at` drift window is 600 seconds. This isn't specified by the NIP; bothy picked a number matching the ~10 minute convention other relays use.
- NIP-86 defines no way to unset a relay name, description or icon. bothy treats an empty string as the unset operation, which falls back to your kind-0 profile and then to a built-in default. `changewritepolicy` follows the same convention.

## What this is not

This project deliberately does not do: payments/zaps, multi-region scaling, NIP-05 hosting, media uploads, community moderation tooling, or a public write mode. The NIP-86 management API is the owner administering their own relay, not moderation tooling in the community sense.

Public writes sit at the top of a documented ladder ([docs/rungs.md](docs/rungs.md)) rather than being an unexplained refusal — see "Who can write here" above for the rungs bothy does implement. See `CLAUDE.md` for the full list and reasoning — most feature requests are already ruled out there.

**Group support is paused.** There is code in this relay for a single NIP-29 group, with invites, private reads and ephemeral chat, and web push to go with it. None of it is documented here, because it does not yet work well enough to rely on — voice is unreliable with the client it was built against and worse with others. It is left out rather than described with a warning attached: a feature documented with a caveat still reads as a feature, and this one should be judged when it works. The code stays and the tests stay, and the relay now matches the stance at runtime: groups are off unless `GROUPS=on` is set (see "Configuration"), and a paused relay refuses group writes and does not advertise NIP-29. The claim comes back with the fix.

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
