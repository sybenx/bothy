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
| `ALLOW_FOLLOWS` | On by default: writes from your kind-3 follow list are accepted. The cache updates immediately when you publish a new contact list to this relay; hourly cron is just the fallback for when it arrived some other way. Set to `false` to disable and go back to owner-only writes. |
| `EPHEMERAL_CHAT` | What the relay does about group chat expiring (see "Group chat is ephemeral" below). Unset, it only *reports* each hour what it would delete, deletes nothing, and hides nothing — so you can watch it be right before it acts. Set it to `on` to let it act. Set it to `off` to remove the behaviour entirely. |
| `UPDATE_CHECK` | On by default: the relay asks this repo what the current release is (one request, cached for six hours, made by the Worker rather than by your browser) so the admin page can say when a newer one exists. Set it to `off` and the relay never makes that request; the footer then simply shows no notice. |

One more piece of configuration is **a secret rather than a variable**, and the difference matters:

| Secret | Purpose |
|---|---|
| `VAPID_PRIVATE_KEY` | Turns on push notifications (see "Push notifications" below). The base64url 32-byte P-256 key any web-push tool will generate for you. |

Set it with `npx wrangler secret put VAPID_PRIVATE_KEY` rather than in the dashboard's variables list. A secret is never read back out of your config on deploy, which the paragraph below is about; a private key that a repository could overwrite is not a private key. Unset it — or never set it — and the relay simply has no push, which is a supported state rather than a broken one.

If your Worker is connected to a GitHub repo, Cloudflare may sync `wrangler.jsonc`'s config on every deploy, which can overwrite a variable you added in the dashboard by hand — worth knowing if a dashboard-added variable seems to reset after a deploy.

This relay's read path is intentionally public, so it is worth adding a free Cloudflare rate-limiting rule against abusive traffic: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** for your zone and cap requests per IP to your Worker's route. The relay enforces its own per-connection and per-IP limits regardless, but an edge rule catches abuse before it reaches the Worker at all.

## Inbox mode (gift-wrapped DMs)

This relay also accepts [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift wraps addressed to you, from anyone, regardless of who else is allowed to write here — see "Who can write here" below for that policy. It's the write path a client needs if you publish a `kind:10050` DM relay list naming this relay; bothy itself never publishes that list for you, so nothing changes unless you deliberately turn your relay into a DM inbox by signing one.

Reading them back is restricted to you. A query that names kind 1059 gets a [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH challenge instead of results; a query that doesn't name a kind is answered normally, with the gift wraps simply absent from what comes back. The second half matters as much as the first: refusing a query only when it would have matched a gift wrap makes the refusal itself the answer, and a stranger sliding a time window across your relay could count and time-correlate your incoming DMs from the refusals alone, without ever mentioning kind 1059. Leaving them out answers the same way whether your inbox is full or empty. You can delete a gift wrap the same way you'd delete any note ([NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)), and [NIP-62](https://github.com/nostr-protocol/nips/blob/master/62.md) "Request to Vanish" support means either you or a message's sender can ask for it to be permanently purged.

A gift wrap carrying an `h` group tag is refused outright. A wrap is mail addressed to you by `p` tag, so a group tag on one names nothing — and since this is the one write path open to anyone, accepting it would have let a stranger drop an event into the private group's feed without being a member of it.

**Worth knowing:** Cloudflare terminates the TLS connection in front of this relay, so it necessarily sees the `p` tag (who a gift wrap is addressed to), the arrival time, and the sender's IP address, the same as any other Worker traffic. On a personal relay the `p` tag is always you, so that part leaks nothing new; the sender IPs, though, belong to other people sending you mail through infrastructure that you chose.

## One group, and it stays out of public view

bothy hosts a single [NIP-29](https://github.com/nostr-protocol/nips/blob/master/29.md) group, with the id `_`, and you are its only admin. There is no group creation step — NIP-29 doesn't have one, and with exactly one group there is nothing to name — so the group simply exists, and you give it a name and a picture by publishing a `kind:9002` edit-metadata event to it.

**Everything in it is private.** If an event carries an `h` tag — the tag NIP-29 uses to scope an event to a group — bothy stores it apart from everything else and leaves it out of every unauthenticated read. Any kind can carry that tag: a note, a reaction, a long-form post. The same goes for the group's own state events (`kind:39000`/`39001`/`39002`), which bothy generates and signs with the relay's own key (the `self` pubkey on its NIP-11 document, which is what a client verifies them against): those are the group's metadata, its admin list and its **member list**, so they are exactly what a private group is trying not to publish.

Reading any of it works the way gift wraps do. A query that names the group (`{"#h":["_"]}`, or a `kinds` naming one of the state events) gets a [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH challenge; a query that doesn't name one is answered normally with the group's events simply absent — because a refusal that only happens when there was something to refuse is itself an answer. The same omission covers the live feed the admin page opens and the counts on the stats page, so a group's traffic doesn't show up as a number ticking upward for anyone watching the public page. "Authenticated" means you or a member: whoever the group admitted on the write side reads it back, checked against the same member list, so a NIP-42-capable client authenticates once and sees the group's history and its live messages. Someone who authenticates and is *not* a member gets the same nothing a stranger does.

**With one exception, and it is deliberate: a member cannot read your unused invite codes.** A `kind:9009` create-invite carries its code in a tag and lives in the group like anything else, and a code is a bearer token — reading one is as good as being handed it, so a member who could read them could invite whoever they liked. Those events are yours alone, on stored reads and on live pushes both, and they are left out rather than refused, so a member cannot even count how many invites are outstanding. The live feed is unchanged by any of this: it has no way to authenticate anybody, so it still announces nothing from the group at all.

**Adding and removing people.** Membership is two nested lists: `allowed_pubkeys` is permission to write to this relay at all, and group membership is permission to write to the group on top of that. Publishing a `kind:9000` put-user event adds someone to both; `kind:9001` remove-user takes them out of the group and takes back only the write access the group itself granted — if you had separately allowed that pubkey by hand through `allowpubkey`, they keep it. Both are owner-only; both are ordinary signed events you publish from your client.

**Invites.** You can also hand someone a link instead of asking for their npub first. Publishing a `kind:9009` create-invite event carrying a `["code", "<something>"]` tag registers an invite code; whoever presents it in a `kind:9021` join request is admitted to both lists, exactly as a put-user would have added them. That is what makes onboarding work for someone who doesn't have an npub until they click — the code is a bearer token, so whoever presents it first gets in.

Three policies, all of them things NIP-29 leaves to the relay:

- **Single use.** One code admits one pubkey, and then it's spent. Send a second person a second code.
- **Expiry is mandatory.** Seven days by default, thirty at most. Add a NIP-40 `["expiration", "<unix seconds>"]` tag to your `kind:9009` to pick something shorter; there is no never-expiring invite, because a link you've forgotten issuing is a link you'll never think to revoke.
- **Codes must be at least 16 characters.** Length is not entropy and this relay can't check entropy — have your client generate a random one. Guessing is bounded by a per-address throttle of five join requests a minute.

The group still advertises itself as `closed`, and that is now exactly right rather than a placeholder: NIP-29 defines `closed` as "join requests are not honored unless they include an invite code", which is precisely what this is. `open` would be the lie.

A join request that is refused — spent code, expired code, revoked code, code that never existed — always comes back with the same message, which tells the person to ask for a new link and nothing else. Four different refusals would let a stranger test guesses one at a time and learn from which complaint came back, and any refusal naming a real code confirms that this relay hosts a group somebody was invited to. You get the distinction instead, through `listunusedinvites` and `revokeinvite` (see "Relay management API" below) and in the relay's log, where every refused join names its reason.

The link itself is your client's business, not the relay's. bothy stores and checks codes; how a code gets into a URL somebody can click is up to whatever you're using to send it.

**Worth knowing:** the stats page's storage figure and its rows-written figure both still move when anything is stored, group events included. The first is unavoidable, and the second is deliberate — it is your budget meter, and it would be worse for it to under-report what your relay actually spent today. And membership changes are not free: rewriting the member list costs roughly four rows written per member, so a twenty-person group spends about 120 rows of your 100,000/day allowance each time somebody joins or leaves — 109 when the person joins with an invite, since the join request itself is never stored. Issuing an invite costs 14. At most 64 invites can be outstanding at once, which is also the bound on how much of a day's allowance a burst of redemptions can reach.

## Push notifications

A relay can reach a phone that has no page open; a page cannot. That is the whole of what this does, and it is off unless you turn it on.

Setting `VAPID_PRIVATE_KEY` (above) makes the relay publish the public half of that keypair as `push_key` on its NIP-11 document. A client that finds one — [hearth](https://github.com/sybenx/hearth) is the one this was built for — can then ask its browser for a push subscription and register it with the relay over the management API. From then on the relay wakes that device when a message arrives in the group, and when somebody arrives at the voice call.

Without a key there is no `push_key`, so no client ever asks, no device endpoint is ever stored, and a client that raises its own notifications while it is open goes on doing exactly that. Nothing errors and nothing is missing; the relay simply never learns which devices you own.

**A notification says which room and what kind of thing happened, and nothing else.** Not the message, not who sent it. It travels through Apple's or Google's push service to reach the phone, and the contents of the room are not theirs to hold — anybody who wants to know what was said opens the client and reads it from the relay. The room name is the one thing that does travel, and it is already public: it is the NIP-11 name anybody can fetch without authenticating.

Two management methods carry this, and they are the only two in the whole API that a group member may call rather than only you: `subscribepush` registers a device, `unsubscribepush` removes one. **The subscription belongs to whoever signed the request**, never to whatever a request body claims, so one member cannot register a device against another member's name or quietly unhook their phone. Each pubkey may hold four endpoints — a phone, a laptop, a home screen install and a browser tab are four different devices — and a fifth registration evicts the oldest rather than being turned away, because browsers rotate their endpoints on their own schedule and the dead ones would otherwise fill the allowance.

You are not pushed about your own message, and nobody is pushed while their socket is open: they are already looking at the room, and two notifications for one message is worse than one.

The relay holds a push for a few seconds before sending it, so a handful of messages typed in the same breath wake a phone once rather than five times. A fan-out wider than 40 devices continues on the next tick, since Cloudflare's free plan allows 50 outbound requests per invocation; past 160 devices for one notification the rest are dropped and the count is written to the Worker log, because news goes stale and a queue that retried forever would eventually wake somebody about something half an hour old. When a push service says an endpoint is gone for good, the row goes with it.

Presence is the part with a cost worth knowing about. Clients heartbeat every five seconds while somebody is in a call, and the relay has to tell an arrival from a heartbeat to know whether a notification is owed. It does that without storing every beat: the watermark is written at most once every 40 seconds per person, which is derived from the beat rate and the budget rather than picked, and an hour of a ten-person call costs about 900 of the day's 100,000 writes. The trade is that the stored watermark resolves presence to about 45 seconds, so somebody whose connection drops and comes back inside that window is treated as having been there all along — which is right, because a reconnect is not an arrival. Leaving deliberately says so, and coming back after that is announced however soon it is.

## Who can write here

By default, bothy accepts events from two kinds of author: you (the owner), and the people you follow. Not strangers. It works by reading the follow list (kind 3) you've already published — bothy doesn't ask you to maintain a separate allowlist, it just uses the one your nostr client already keeps.

Why this is the default rather than a limitation: bothy is meant to be one of the 2-4 relays your NIP-65 relay list already tells clients to keep, not your only relay. Pair it with a permissive public relay and you get both — your own filtered archive of people you actually follow, plus a general-purpose inbox that already does the spam filtering you'd otherwise have to build yourself. A reply from someone you don't follow isn't lost; it still lands on your other relay, and on the sender's own.

Following someone is not unlimited trust. Anyone writing here is capped at 64KB per event and 20 events a minute, and writes from anyone but you stop once the relay is half full — so an account that gets compromised or goes haywire slows to something you'll notice and can revoke (unfollow, or `banpubkey` through the management API) long before it can fill your storage or spend a day's write budget. All three limits are adjustable; see "Configuration" above.

If you'd rather bothy only ever accept your own writes, set `ALLOW_FOLLOWS=false` (see "Configuration" above). NIP-11 advertises `restricted_writes: true` either way, so well-behaved clients know not to bother trying before they publish.

The admin page at your relay's URL is public — anyone with the link can see relay stats and your follow count. Never the follow list itself, only the count.

This is one rung of a documented ladder — see [docs/rungs.md](docs/rungs.md) for the full progression from owner-only writes up to the open-relay case bothy deliberately refuses to become.

## Group chat is ephemeral

The group's chat exists for the conversation it was part of, and is then deleted — not hidden, not archived. Your own notes, your backfilled history, your gift wraps, reactions and the group's membership are all untouched; this is about the talk and nothing else.

The rules:

- **A conversation ends when the room has been empty for about two hours.** Everything said during it goes when it goes.
- **A message sent while somebody else was there belongs to that conversation.**
- **A message sent to an empty room is a note, not speech.** It waits for the next conversation, for as long as that takes. Nothing expires it: a note has not been read yet, and mail doesn't vanish because the person it was addressed to is away. If you want a note back, delete it the ordinary way — publish a NIP-09 kind-5 naming it, which any client can do.
- **Arriving partway through shows you the last few minutes**, not the whole session. Enough to know what's being talked about, not enough to replace asking.

The relay is where this has to live, because it's the only party that sees everyone at once.

**It ships watching rather than acting.** With `EPHEMERAL_CHAT` unset — which is how it arrives — the relay works out once an hour exactly what it would delete, writes that to its log, and then deletes nothing and withholds nothing. Watch it for a few days: in the Cloudflare dashboard, open your Worker and look at Logs (or run `npx wrangler tail`) for lines beginning `ephemeral chat`. When you're satisfied, add `EPHEMERAL_CHAT` with the value `on` in the same Variables screen as everything above.

One thing to expect the first time you turn it on: a relay that has been collecting chat until now loses all of it at the end of the first real conversation the room has afterwards, in one go, since that conversation's cutoff covers everything before it too. The reporting mode will have told you the number in advance.

## Relay management API

bothy implements [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md), the relay management API. It lets you ban an event, block an IP address, or change the relay's name, description and icon, without redeploying and without touching the Cloudflare dashboard. There is no web interface for it, deliberately: the admin page stays a read-only status page that is safe to leave public, and every management command is a signed request you send from the command line.

The tool to send them with is [`nak`](https://github.com/fiatjaf/nak), whose `admin` subcommand speaks NIP-86. The shape of every command is the same — the method, your secret key, whatever parameters the method takes, and your relay's host last:

```bash
nak admin supportedmethods --sec <your nsec> your-relay.workers.dev
```

Start there. `supportedmethods` returns exactly what this relay implements, which is the honest answer to what you can do with it, and `nak admin --help` lists the flags each method takes. Every request is authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the relay owner's key — the same key you claimed the relay with. Nothing else is accepted, and an unsigned or wrongly signed request gets a 401.

What this relay implements: `banevent` and `allowevent` and `listbannedevents`; `banpubkey`, `unbanpubkey` and `listbannedpubkeys`; `allowpubkey`, `unallowpubkey` and `listallowedpubkeys`; `blockip` and `unblockip` and `listblockedips`; `changerelayname`, `changerelaydescription` and `changerelayicon`; `listunusedinvites` and `revokeinvite`; and `subscribepush` and `unsubscribepush`. What it does not: the kind allowlist, because bothy stores every kind on purpose; and the moderation queue, because bothy has nothing to report events into.

The endpoint sends CORS headers and answers a preflight, so a client hosted somewhere other than the relay can call it from a browser. That weakens nothing: every call is a signed NIP-98 event, there is no cookie or session for a cross-origin request to borrow, and an unauthenticated preflight reveals only that the endpoint exists — which the NIP-11 document already advertises to anybody. Without it the API is reachable only from a page the relay itself served, which is not where most clients live.

`listunusedinvites`, `revokeinvite`, `subscribepush` and `unsubscribepush` are bothy's own, not NIP-86's. The last two are described under "Push notifications" above; the first two — the spec has no invite methods, so these are an extension in the same spirit as the empty-string unset convention below. `listunusedinvites` returns every code that can still be redeemed right now, with when it was created and when it lapses; codes that are spent, revoked or expired are left out, because they are not links you can still do anything about. `revokeinvite` takes a code and kills it. Unlike a refused join request, both of these tell you exactly what happened: whether the code was already used (and it will not erase who used it), already revoked, or never issued at all. You are the person who created the code, so there is nothing to keep from you.

Banning an event tombstones its id, so the event is refused if it arrives again — including from a client re-sending it and from backfill pulling it out of another relay's history. You can ban an id you don't hold yet, and it will be refused on arrival. `allowevent` reverses this and is the only thing in bothy that lifts a tombstone.

Banning a pubkey refuses every future write from it, checked on the same write path as the follow list — a banned pubkey is refused even if it's also someone you follow. `unbanpubkey` lifts the ban. Separately, `allowpubkey` grants write access to a specific pubkey you don't follow, without opening writes any wider than that one key; `unallowpubkey` revokes it. Banning and allowing are independent: allowing a pubkey never overrides a ban on the same key. Both accept an npub or hex pubkey. `allowpubkey` also outranks the group: if the pubkey already had write access because you added them to the group, calling it by hand makes that access yours rather than the group's, and removing them from the group afterwards leaves it in place.

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

- `GET /api/stats` — relay stats for the admin page. Returns `{ version, claimed, ownerPubkey, totalEvents, events24h, ingested24h, rowsWrittenToday, storageBytes, storageBytesLimit, dailyRowsWrittenLimit, dailyRowsReadLimit, backfill, icon, relayName, writePolicy, followCount, countAudit, followsListAt, vanishing, reads }`. `events24h` counts events by their own timestamp, which is what you posted; `ingested24h` counts what this relay actually took in, backfill included. During a backfill those differ by orders of magnitude. `vanishing` is a count, a progress total and an age — never the pubkeys that asked, since this endpoint is public and naming them would publish exactly the list a vanish request exists to remove someone from.
  Every figure here is a maintained counter, exact and current as of the request — nothing on this document is cached or dated. `events24h` and `ingested24h` are windowed in whole hours, so each spans 24–25 hours rather than exactly 24; `rowsWrittenToday` is exact, since a UTC day starts on a whole hour.
  `rowsWrittenToday` means rows written, all of them: event rows and their index entries, tag rows, tombstones, counter updates, the follow-list rebuild, NIP-86 calls, backfill bookkeeping. It is measured rather than estimated, and it reads slightly high, because a removal is charged the pessimistic figure Cloudflare's cursor cannot confirm — see CLAUDE.md "The budget". There used to be two timestamps here, `snapshotAt` and `liveAt`, dating a six-hour cache over the counts that walked a table and a five-minute cache over these last two; both caches were removed as each figure became a counter.
- `POST /api/claim` — TOFU claim; body `{ pubkey }` (npub or hex). See "Ownership and lifecycle" above.
- `GET /api/profile?pubkey=<hex>` — the claim form's courtesy profile preview: it looks your kind-0 up on a couple of well-known relays so you can see the name and avatar attached to a pubkey before binding the relay to it permanently. **This is a setup endpoint and it is only reachable during setup** — once the relay is claimed it returns 404, because it exists to guard one irreversible step and there is no reason to leave a path that opens outbound connections to third-party relays permanently open to anybody. Results are cached for five minutes.
- `GET /live` — unauthenticated, push-only WebSocket for the admin page's live feed (max 5 connections, 10-minute lifetime); sends `{ kind, created_at, id }` per stored event, never gift wraps.
- Any path, with header `Accept: application/nostr+json` — the [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) relay information document. It reports the relay's name, description and icon, along with `pubkey` (yours, once the relay is claimed), `contact` (the `website` from your kind-0 profile, if you have one) and `push_key` (the public half of your VAPID keypair, if you configured one). All three are omitted rather than left empty when there is nothing to report.
- `POST /`, with header `Content-Type: application/nostr+json+rpc` — the [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md) management API, authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the owner. See "Relay management API" above.

Every endpoint above that reaches the relay's storage is rate limited per IP: 60 requests a minute shared across all of them and the WebSocket connection itself, and 10 a minute for `/api/profile`, which is tighter because it is the one that reaches out to other people's relays. Over the limit you get a `429` with a `Retry-After`. The admin page itself is a static file and is never rate limited — if the relay is refusing you, the page that says so still loads. Raising these means editing the `ratelimits` block in `wrangler.jsonc` and redeploying; there is no environment variable for them, because unlike the write-path caps they cost nothing to leave in place.

## Choices, not requirements

The NIPs leave some behavior unspecified. Two choices are worth knowing if you're building a client against this relay:

- `ids`/`authors` filters don't support prefix matching. NIP-01 says relays MAY support it; this one doesn't.
- NIP-42's AUTH `created_at` drift window is 600 seconds. This isn't specified by the NIP; bothy picked a number matching the ~10 minute convention other relays use.
- NIP-86 defines no way to unset a relay name, description or icon. bothy treats an empty string as the unset operation, which falls back to your kind-0 profile and then to a built-in default.
- No NIP covers web push, so `push_key`, `subscribepush` and `unsubscribepush` are bothy's own names for it, chosen to say what a client does with them rather than to carry a vendor prefix. See "Push notifications" above.
- NIP-29 says nothing about how long an invite code lives, how many may exist, or how a bad one is refused. bothy makes expiry mandatory (seven days by default, thirty at most), makes every code single use, requires at least 16 characters, allows 64 outstanding at once, and answers every kind of bad code with one identical refusal. See "One group, and it stays out of public view" above.

## What this is not

This project deliberately does not do: payments/zaps, multi-region scaling, NIP-05 hosting, media uploads, community moderation tooling, multiple groups, or a public write mode. Group support is one group with one admin (see "One group, and it stays out of public view" above): invites, join requests and member-side reads work, but there are no moderator roles beyond you and no report queue. The NIP-86 management API is the owner administering their own relay, not moderation tooling in the community sense. Public writes sit at the top of a documented ladder ([docs/rungs.md](docs/rungs.md)) rather than being an unexplained refusal — see "Who can write here" above for the rungs bothy does implement. See `CLAUDE.md` for the full list and reasoning — most feature requests are already ruled out there.

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
