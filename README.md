# bothy

[![Release](https://img.shields.io/github/v/tag/sybenx/bothy?style=for-the-badge)](../../tags)

A personal Nostr relay that runs as a Cloudflare Worker with Durable Object storage, inside the free tier. It has one owner, who can invite members.

It deploys from the button below into the deployer's own Cloudflare account, and the owner claims it by pasting an `npub`. The result is a `wss://` URL. No server, domain or dashboard configuration is involved.

The name is the Scottish word for an unlocked shelter left for whoever needs it.

**Requires a Cloudflare account** (free, no card) **and a GitHub account** (also free) — Cloudflare puts a copy of the code in your Git account and deploys from there.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sybenx/bothy)

If you have already deployed, see "Keeping it updated" below. 

## Setup

1. Click **Deploy to Cloudflare**. You'll be prompted to create a free Cloudflare account if you don't have one.
2. On **Set up your application**, pick your GitHub account from the **Git account** dropdown. Cloudflare creates a repo there holding your copy. Leave **Create private Git repository** unchecked unless you have a reason — public repos get free GitHub Actions minutes, which the updater uses. Then click **Deploy**.
3. The build takes about 30 seconds. **Refresh the page** when it finishes — the dashboard doesn't update on its own. A **Visit** button appears at the top right; that's your relay.
4. Open that URL, paste your npub into the claim form, and confirm. This step is one-time and permanent; see "Ownership and lifecycle" below.
5. Copy the `wss://` URL from the admin page into your nostr client's relay list.

No dashboard configuration is required.

## Keeping it updated

The deploy button copies this repo into your GitHub account as an independent repo, not a fork, so nothing pulls in upstream changes on its own, and the copy arrives without the workflow that would. The badge below is that workflow: commit the file it hands you and your relay updates itself from then on.

[![Turn on auto-update](https://img.shields.io/badge/Turn%20on%20auto--update-555555?style=flat-square)](../../new/main?filename=.github/workflows/sync.yml&value=name%3A%20Sync%20from%20upstream%0A%0Aon%3A%0A%20%20%23%20Weekly%2C%20which%20is%20what%20makes%20committing%20this%20file%20the%20whole%20of%20turning%0A%20%20%23%20auto-update%20on%3A%20there%20is%20no%20second%20switch%20to%20find%20and%20nothing%20to%20come%0A%20%20%23%20back%20and%20click.%20Monday%20morning%20UTC%2C%20at%20a%20minute%20nowhere%20near%20the%20top%0A%20%20%23%20of%20the%20hour%20--%20GitHub%20runs%20scheduled%20jobs%20on%20a%20shared%20queue%20and%20delays%0A%20%20%23%20the%20ones%20piled%20onto%20%3A00%20%28docs.github.com%2Factions%2Freference%2Fworkflows-and-actions%2Fevents-that-trigger-workflows%2C%0A%20%20%23%20checked%202026-08-31%29.%0A%20%20%23%0A%20%20%23%20A%20run%20against%20an%20unchanged%20upstream%20pushes%20nothing%20and%20redeploys%0A%20%20%23%20nothing%20%28see%20%22Commit%20and%20push%22%20below%29%2C%20so%20the%20cost%20of%20the%20cadence%20is%0A%20%20%23%20roughly%20a%20minute%20of%20Actions%20time%20a%20week%2C%20free%20on%20public%20repos.%0A%20%20%23%0A%20%20%23%20Worth%20knowing%3A%20GitHub%20disables%20scheduled%20workflows%20in%20a%20repository%0A%20%20%23%20with%2060%20days%20of%20no%20activity%20and%20emails%20the%20owner%2C%20so%20a%20relay%20left%0A%20%20%23%20entirely%20alone%20can%20stop%20checking.%20A%20sync%20that%20lands%20a%20commit%20is%0A%20%20%23%20itself%20activity%2C%20so%20this%20only%20bites%20when%20upstream%20has%20also%20been%0A%20%20%23%20quiet%20--%20and%20re-enabling%20is%20one%20button%20on%20the%20Actions%20tab.%0A%20%20schedule%3A%0A%20%20%20%20-%20cron%3A%20%2223%206%20%2A%20%2A%201%22%0A%0A%20%20%23%20Kept%20beside%20the%20schedule%2C%20not%20replaced%20by%20it%3A%20this%20is%20the%20%22check%20now%22%0A%20%20%23%20button%20for%20someone%20who%20has%20just%20read%20about%20a%20fix%20and%20does%20not%20want%20to%0A%20%20%23%20wait%20until%20Monday.%0A%20%20workflow_dispatch%3A%0A%0Apermissions%3A%0A%20%20contents%3A%20write%0A%0Ajobs%3A%0A%20%20sync%3A%0A%20%20%20%20runs-on%3A%20ubuntu-latest%0A%20%20%20%20%23%20The%20%22Deploy%20to%20Cloudflare%22%20button%20clones%20this%20repo%20into%20the%20user%27s%20account%20as%20an%0A%20%20%20%20%23%20independent%20repo%2C%20not%20a%20GitHub%20fork%2C%20so%20this%20workflow%20ships%20inside%20every%20downstream%0A%20%20%20%20%23%20copy%20too.%20Guard%20so%20it%20no-ops%20when%20it%20runs%20in%20the%20upstream%20repo%20itself.%0A%20%20%20%20if%3A%20github.repository%20%21%3D%20%27sybenx%2Fbothy%27%0A%20%20%20%20steps%3A%0A%20%20%20%20%20%20-%20name%3A%20Checkout%0A%20%20%20%20%20%20%20%20uses%3A%20actions%2Fcheckout%40v6%0A%20%20%20%20%20%20%20%20with%3A%0A%20%20%20%20%20%20%20%20%20%20fetch-depth%3A%200%0A%0A%20%20%20%20%20%20-%20name%3A%20Configure%20git%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.name%20%22github-actions%5Bbot%5D%22%0A%20%20%20%20%20%20%20%20%20%20git%20config%20user.email%20%22github-actions%5Bbot%5D%40users.noreply.github.com%22%0A%0A%20%20%20%20%20%20-%20name%3A%20Fetch%20upstream%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20remote%20add%20upstream%20https%3A%2F%2Fgithub.com%2Fsybenx%2Fbothy.git%0A%20%20%20%20%20%20%20%20%20%20git%20fetch%20upstream%20main%0A%0A%20%20%20%20%20%20-%20name%3A%20Pull%20in%20upstream%20files%0A%20%20%20%20%20%20%20%20run%3A%20git%20checkout%20upstream%2Fmain%20--%20.%0A%0A%20%20%20%20%20%20-%20name%3A%20Restore%20local%20config%0A%20%20%20%20%20%20%20%20%23%20wrangler.jsonc%20holds%20the%20D1%2FKV%2FR2%20IDs%20Cloudflare%20provisioned%20for%20this%20deployment%2C%0A%20%20%20%20%20%20%20%20%23%20and%20.github%2F%20holds%20this%20workflow%20itself%20%E2%80%94%20neither%20must%20ever%20be%20overwritten%20by%20upstream.%0A%20%20%20%20%20%20%20%20%23%20git%20restore%20also%20drops%20workflow%20files%20that%20are%20new%20upstream%20%28the%20push%20token%20cannot%20write%20workflows%29.%0A%20%20%20%20%20%20%20%20run%3A%20git%20restore%20--source%3DHEAD%20--staged%20--worktree%20--%20wrangler.jsonc%20.github%2F%0A%0A%20%20%20%20%20%20-%20name%3A%20Stage%20deletions%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20git%20diff%20--diff-filter%3DD%20--name-only%20HEAD%20upstream%2Fmain%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20grep%20-v%20%27%5E%5C.github%2F%27%20%5C%0A%20%20%20%20%20%20%20%20%20%20%20%20%7C%20xargs%20-r%20git%20rm%20--%0A%0A%20%20%20%20%20%20-%20name%3A%20Commit%20and%20push%0A%20%20%20%20%20%20%20%20run%3A%20%7C%0A%20%20%20%20%20%20%20%20%20%20if%20git%20diff%20--quiet%20%26%26%20git%20diff%20--cached%20--quiet%3B%20then%0A%20%20%20%20%20%20%20%20%20%20%20%20echo%20%22Already%20up%20to%20date%20with%20upstream.%22%0A%20%20%20%20%20%20%20%20%20%20%20%20exit%200%0A%20%20%20%20%20%20%20%20%20%20fi%0A%20%20%20%20%20%20%20%20%20%20git%20add%20-A%0A%20%20%20%20%20%20%20%20%20%20git%20commit%20-m%20%22Sync%20from%20upstream%20%28sybenx%2Fbothy%29%22%0A%20%20%20%20%20%20%20%20%20%20git%20push%20origin%20HEAD%3A%24%7B%7B%20github.ref_name%20%7D%7D%0A)

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

**bothy holds no key material and never will.** Neither claim path below asks for or ever sees a secret key.

There are two ways to claim a relay:

- **Paste your pubkey.** The first person to submit one through the claim form owns the relay, permanently. This is "trust on first use" (TOFU): there's no signature check on the claim itself, but every event is still verified against its own signature regardless of who owns the relay, so a wrong claim can't be used to forge anything. If someone else claims your relay before you do, the worst case is that it archives a stranger's public notes at your expense; you can recover by deleting the Worker and deploying again.
- **Scan the QR with your phone.** Your npub usually lives on your phone, not your computer, so the admin page can show a QR instead. Scan it with your phone's camera and the same page opens there, carrying a short-lived, single-use code. Paste your npub (every Nostr app has a "copy npub" button), or let the page fetch it: on Android it offers your signer app (Amber, via [NIP-55](https://github.com/nostr-protocol/nips/blob/master/55.md)), and in a browser with a Nostr extension it uses that ([NIP-07](https://github.com/nostr-protocol/nips/blob/master/07.md)). The page on your computer notices the claim and reloads. This is the same trust-on-first-use claim as pasting — the code tells your computer that *its* QR was the one used, it doesn't prove anything about the key.

Both paths are permanent and irreversible the same way: whichever pubkey ends up as the owner, that's the owner for good, short of deleting the Worker (see below). If you want to skip the claim flow entirely, set the `OWNER_PUBKEY` environment variable at deploy time (`npub1...` or lowercase hex, normalized the same way the claim form normalizes what you paste into it); this disables every claim endpoint outright.

Claiming also starts a one-time backfill of your history: bothy looks up the relays your own kind-10002 list already names as ones you publish to, resolving that list via a couple of well-known relays, then pulls your past notes in from them automatically, a page at a time on each hourly cron tick, until it's caught up. This needs no action from you and stops once it's done; the admin page shows its progress.

Redeploying does not reset ownership or storage. Running `wrangler deploy` again, or re-clicking the deploy button, ships new code against the same storage, so your events and your claim both survive. To actually reset a relay, delete the Worker from the Cloudflare dashboard (Workers & Pages → your worker → Settings → Delete) and deploy a fresh one. There is no in-place "unclaim," since Durable Object storage is tied to the Worker.

To remove the relay entirely, delete two things: the Worker (Workers & Pages → your project → Settings → Delete), which takes the relay offline, and the GitHub repo Cloudflare created (its Settings → Danger Zone → Delete this repository). Deleting only the repo leaves the relay running; deleting only the Worker leaves the repo behind.

## Moving to a new bothy

A bothy can't be moved to another Cloudflare account: its storage stays with the Worker. To move, deploy a fresh bothy, claim it with the same key, and copy events across with [nak](https://github.com/fiatjaf/nak). bothy doesn't speak negentropy (NIP-77), so `nak sync` won't work. Instead, you export with `nak req` and import with `nak event`.

You don't strictly need to copy your own notes: claiming starts a backfill from the relays in your relay list. Copy them anyway if the old bothy is the only place some of them live. What only the old bothy holds is your follows' notes, mentions of you and your encrypted mail.

```bash
OLD=wss://old-relay.workers.dev
NEW=wss://new-relay.workers.dev
ME=<your hex pubkey>
export NOSTR_SECRET_KEY=<your nsec>   # nak signs the AUTH for your mail with it

# 1. Export. Mail is read separately: a filter that doesn't name kind 1059
#    is answered without your mail rather than asking you to log in.
nak req --paginate -a $ME $OLD > mine.jsonl
nak req -a $ME -k 3 $OLD \
  | jq -c '[.tags[] | select(.[0] == "p") | .[1]] | _nwise(100) | {authors: .}' \
  | nak req --paginate $OLD > follows.jsonl
nak req --paginate -p $ME $OLD | cat follows.jsonl - | awk '!seen[$0]++' > others.jsonl
nak req --paginate --auth -k 1059 -p $ME $OLD > mail.jsonl

# 2. Import, slowly enough to stay under bothy's limits:
#    50 messages per 10 seconds from one address, 20 events a minute from
#    anyone who isn't you, and 5 pieces of mail a minute.
pace() { while IFS= read -r line; do printf '%s\n' "$line"; sleep "$1"; done; }
pace 0.25 < mine.jsonl   | nak event $NEW   # first: it carries your follow list
pace 3    < others.jsonl | nak event $NEW
pace 12   < mail.jsonl   | nak event $NEW
```

Things to know:

- **Order matters.** Your own events go first because they include your follow list (kind 3). The new relay accepts your follows' events only once it has that list.
- **Strangers' other posts are refused.** Under the default `mentions` policy, a post from someone you don't follow is kept only if it mentions or replies to you; anything else of theirs comes back `restricted:`.
- **Spread it over days.** Each event costs about 30 of the 100,000 rows the free plan lets you write per day. Past roughly 2,000 events, split the files (`split -l 2000 others.jsonl others-`) and import one part a day.
- **It's safe to re-run.** An event the new relay already has is acknowledged and not stored twice, so you can simply run a step again.
- **Mail is slow.** At 5 a minute, a full inbox takes hours.
- **Run it from a terminal.** nak reads a filter from stdin when stdin isn't a terminal, so in a script, add `< /dev/null` to the `nak req` lines that take no input.

## Configuration

The deploy button only asks for a project name. Everything else is an optional variable you can add later in the Cloudflare dashboard (**Workers & Pages → your worker → Settings → Variables**) if you want it:

| Var | Purpose |
|---|---|
| `OWNER_PUBKEY` | Fix ownership at deploy time instead of claiming (`npub1...` or lowercase hex). Disables every claim endpoint. |
| `RELAY_NAME` / `RELAY_DESCRIPTION` / `RELAY_ICON` | Set the NIP-11 name/description/icon. These outrank anything set through the management API, which in turn outranks your kind-0 profile — see "Relay management API" below for the full order. |
| `MAX_EVENT_BYTES` | Largest event this relay will accept, JSON-serialized, for everyone including you. Defaults to `65536` (64KB) — generous for any real note, including long-form. Raise it to a number, or set it to `off` to remove the cap. |
| `MAX_EVENTS_PER_PUBKEY_PER_MINUTE` | How fast any one non-owner pubkey may publish. Defaults to `20`/minute — far above human posting rates, slow enough that a runaway follow takes hours rather than minutes to spend the daily write budget. You are never throttled. Raise it to a number, or set it to `off`. |
| `MAX_GIFT_WRAPS_PER_IP_PER_MINUTE` | How much mail (gift wraps) one address may send a minute when it has not signed in as you or a member: strangers writing to your inbox. Defaults to `5`. Over it, a connection that has not signed in is asked to (NIP-42), so a member's app that sent before signing in can sign in and carry on. Raise it to a number, or set it to `off`. |
| `MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE` | How much mail you or any one member may send a minute from connections signed in (NIP-42), counted per person whatever their address, so people sharing a home Wi-Fi each get their own. Defaults to `120`: a one-to-one message is two wraps (theirs and the sender's own copy), and reactions, edits and pins are wraps too. At the maximum one person writes roughly 1,500 rows a minute, so this is a bound on a runaway app, not a budget. Raise it to a number, or set it to `off`. |
| `MAX_SIGNALS_PER_MEMBER_PER_MINUTE` | How many signals ("typing…", "seen", call setup; see "Signals" below) you or any one member may send a minute. Defaults to `600`: an app sends one per other person, so typing and seen receipts in a 20-person group come to about that. They are never stored. Raise it to a number, or set it to `off`. |
| `STORAGE_BUDGET_BYTES` | How much the relay may store, in bytes: the base every share below is a part of. Defaults to `1073741824` (1 GB), the smallest reading of Cloudflare's free-plan limit for one Durable Object; the account's 5 GB is shared with anything else on it. Raise it on a paid plan, up to `10737418240` (10 GB). The admin page shows use against it. |
| `NON_OWNER_STORAGE_BYTES` | Point at which writes from anyone but you are refused, reserving the rest of the storage budget for your own archive. Defaults to half of `STORAGE_BUDGET_BYTES`. Raise it to a number, or set it to `off`. |
| `WRITE_POLICY` | Who can publish here: `owner`, `inbox`, `follows`, `mentions`, `network` or `all` (see "Who can write here" below). Set here it outranks the value set through the management API. Unset, the management API's value applies, then the default, `mentions`. |
| `MAIL_STORAGE_BYTES` | How much all stored mail may take, in bytes. Defaults to 30% of `STORAGE_BUDGET_BYTES` (about 300 MB). Set it to `off` to remove this cap; the share reserved for you (`NON_OWNER_STORAGE_BYTES`) still applies. |
| `MAIL_BYTES_PER_MEMBER` | How much mail any one person may have stored here, you included, in bytes. Defaults to a tenth of the mail total (about 30 MB). Set it to `off` to remove it. |
| `NETWORK_MAX_KEYS` | Under the `network` policy, how many of the people your follows follow the relay keeps on its list. Defaults to `40000`. |
| `MEMBER_LIST` | Whether members can see who else is in your home. `members` (the default) lets every member see the list; `hidden` keeps it to you and your admins. |
| `INVITES_PER_MEMBER` | How many people each member may invite. Defaults to `50`. Set it to `off` so only you and your admins make invites. You and your admins are never limited. |
| `INVITE_DEPTH` | How many steps from you invites reach: your own invitees are one step away, and a member this many steps away cannot invite. Defaults to `3`. `off` also keeps invites to you and your admins. |
| `PHOTO_STORAGE_BYTES` | How much all profile photos together may take, in bytes. Defaults to 5% of `STORAGE_BUDGET_BYTES` (about 50 MB). Set it to `off` to store no photos at all. |
| `PHOTO_MAX_BYTES` | The largest one photo may be, in bytes. Defaults to `102400` (100 KB), and can be raised to at most `1048576` (1 MB). |
| `VOUCH` | On by default: members' apps may keep a copy of their key that this relay can open, so someone they trust can let them back in on a new phone, and so can a password manager that cannot lock a copy itself (see "Getting back in with someone's help" and "Getting back in with a password manager" below). Set it to `off` to take no new copies and no requests and to hand nothing over to a password manager; copies already kept stay until the member's app removes them or the member leaves. |
| `UPDATE_CHECK` | On by default: the relay asks this repo what the current release is (one request, cached for six hours, made by the Worker rather than by your browser) so the admin page can say when a newer one exists. Set it to `off` and the relay never makes that request; the footer then simply shows no notice. |

`ALLOW_FOLLOWS` is no longer read. If you had set it to `false`, set `WRITE_POLICY=owner` instead.

If your Worker is connected to a GitHub repo, Cloudflare may sync `wrangler.jsonc`'s config on every deploy, which can overwrite a variable you added in the dashboard by hand — worth knowing if a dashboard-added variable seems to reset after a deploy.

This relay's read path is intentionally public, so it is worth adding a free Cloudflare rate-limiting rule against abusive traffic: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** for your zone and cap requests per IP to your Worker's route. The relay enforces its own per-connection and per-IP limits regardless, but an edge rule catches abuse before it reaches the Worker at all.

## Inbox mode (encrypted mail)

This relay also accepts encrypted mail addressed to you or one of your members (see "Members" below), from anyone ([NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift wraps, kind 1059), under every write policy except `owner` (see "Who can write here" below for that policy). It's the write path a client needs if you publish a `kind:10050` DM relay list naming this relay; bothy itself never publishes that list for you, so nothing changes unless you deliberately turn your relay into a DM inbox by signing one.

Reading them back is restricted to the person they are addressed to: you, or a member asking for their own with `"#p"` set to their pubkey. A query that names kind 1059 gets a [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH challenge instead of results; a query that doesn't name a kind is answered normally, with the gift wraps simply absent from what comes back. The second half matters as much as the first: refusing a query only when it would have matched a gift wrap makes the refusal itself the answer, and a stranger sliding a time window across your relay could count and time-correlate your incoming DMs from the refusals alone, without ever mentioning kind 1059. Leaving them out answers the same way whether your inbox is full or empty. You can delete a gift wrap the same way you'd delete any note ([NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)), and [NIP-62](https://github.com/nostr-protocol/nips/blob/master/62.md) "Request to Vanish" support means either you or a message's sender can ask for it to be permanently purged.

How much mail the relay keeps is measured in bytes. All mail together may take 30% of the relay's storage budget, about 300 MB, and mail for any one person, you included, a tenth of that, about 30 MB: some 10,000 messages of a typical 3 KB each, counting the copy of each message a sender keeps for themselves. When a person's share is full, mail for them is refused with `blocked: the recipient's mailbox on this home is full`; when the whole home is, with `blocked: this home's mailbox is full`. Their apps can show that as it is, and the sender's message still reaches any other relay in the recipient's inbox list. Members can see how full their own mailbox is with `mymailbox`. The other limit is Cloudflare's: each stored message costs about 14 of the 100,000 rows the free tier lets the relay write a day, so a home takes in about 7,000 messages a day before writes stop until midnight UTC.

How fast mail may arrive depends on who sends it. A connection signed in (NIP-42) as you or a member may send 120 a minute, counted per person, so people sharing one home Wi-Fi do not share an allowance. Anyone else gets 5 a minute per address; past that, a connection that has not signed in gets an AUTH challenge with the refusal (`auth-required:`), so a member's app that sent before signing in can sign in and send again, while a stranger who signs in is still counted by address (`rate-limited:`). Both are adjustable (`MAX_GIFT_WRAPS_PER_MEMBER_PER_MINUTE`, `MAX_GIFT_WRAPS_PER_IP_PER_MINUTE`; see "Configuration").

**Worth knowing:** Cloudflare terminates the TLS connection in front of this relay, so it necessarily sees the `p` tag (who a gift wrap is addressed to), the arrival time, and the sender's IP address, the same as any other Worker traffic. On a personal relay the `p` tag is you or a member, so that part says only who has mail; the sender IPs, though, belong to other people sending you mail through infrastructure that you chose.

## Drafts

Drafts ([NIP-37](https://github.com/nostr-protocol/nips/blob/master/37.md), kind 31234) are stored like anything else you or a member publish, but only their author gets them back, and only on a connection signed in ([NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md)) as that author. Nobody else sees them, not even that they exist: not a connection that hasn't signed in, not another member, and not you reading a member's drafts. A query that would match someone else's draft is answered with it left out, never refused, the same as mail above. New drafts go live only to their author's signed-in connections and never appear on the live feed. Under the `mentions` policy, a stranger can't get a draft stored by tagging you in it. So you can list this relay as a private relay (kind 10013) and rely on bothy, not each client, to keep drafts private.

## Members

You can give other people a home here: an inbox for their encrypted mail, and a notification on their phone when some arrives. They need no account, only a key, which any Nostr app (or the friend app) makes for them.

To add someone, make an invite and send them the code. These are bothy's own methods, which `nak admin` does not know, so call them with the `bothy_rpc` function under "Who can write here" below:

```bash
bothy_rpc https://your-relay.workers.dev/ createinvite
```

The answer is the code, how many times it can be used and when it stops working. A code works once and for 7 days unless you ask for more: `createinvite` takes the number of uses (up to 100) and then the lifetime in seconds (up to 30 days). Their app redeems it by calling `redeeminvite` with the code, signed with their own key; that is the one management call anyone can make. `listunusedinvites` shows the codes still waiting, and `revokeinvite` kills one.

Members can invite people too, within limits, so a friend can bring a friend without asking you. Each member may let in 50 people, and invites go 3 steps from you: the people you invite can invite, and so can theirs, but not the people after that. A code counts for everyone it could let in, whether or not they have come yet; revoking a code, or letting it expire, gives back the places nobody used. A member sees and revokes only their own codes, and `myinvites` tells them how many they have left. You and your admins have no limit. Change the numbers with `INVITES_PER_MEMBER` and `INVITE_DEPTH`, or set either to `off` to keep invites to you and your admins. A group's invite link from the DMs app works as an invite too: everyone who opens it joins your home and that group, for up to 30 days or until the group's admin turns it off. When a member made it, it uses one of their places for each person new to your home, and stops letting new people in when they have none left.

Someone who joins by asking through a member's link (see "Join requests" below) is listed as that member's invitee but does not use up one of their invites: you or an admin approved them, so the decision was yours.

Your members are the pubkeys on your allow list, so `listallowedpubkeys` lists them and `unallowpubkey` removes one. `listmembers` shows more: who let each one in, when, and how, plus the people you removed whose mail is still waiting to be deleted, with the date it goes. Who let someone in is whoever made the code they used, or whose link their join request came through, or you; every member has one, so an app can draw the whole tree from it. A member can also publish here, as anyone you `allowpubkey` can.

Each `listmembers` row, current or removed, also says how alive the person looks, from what bothy already keeps for other reasons and nothing new: `lastSeen`, the last day they signed in here (NIP-42), as a UTC day number (days since 1970-01-01, so `lastSeen * 86400` is that day's midnight in Unix seconds), or `null` if never; `push`, `true` if they have any push registration (web push or the Android app); and `waiting`, how many sealed messages (kind 1059 gift wraps) addressed to them are stored here. Removing someone deletes their sign-in day and push registrations, so a removed member shows `null` and `false`, and only `waiting` still counts down as their mail goes. On current members, `inviterUnknown` is `true` when `invitedBy` names you only because nobody else could be named: no inviter was recorded (members from before v0.19.0), or the inviter is no longer a member. It is `false` when the inviter is on record, you included. Each current member's row also has `restore`, how many locked copies of their key they keep here (see "Fingerprint restore" below), `0` for none, so you and your admins can see who would have no way back if they lost their phone, and `restoreBoxReadable`, how many of those are password managers that hand over a copy this relay can open (see "Getting back in with a password manager" below).

Members can see who else is in your home, as in a group, so their app can suggest the people they could message: `homemembers` lists every member and you, and nothing more about them (not who invited whom, when they joined, or who was removed; that stays with you and your admins). To keep the list to yourself and your admins, set `MEMBER_LIST` to `hidden`.

Some members may see where each other's photos were taken. That trust is on for everyone you or an admin let in yourselves (with your own invite, `allowpubkey`, an approved request, or by making them an admin), and off for people who came in on another member's invite. You and your admins can turn it on or off for anyone with `setclose` and their pubkey and `true` or `false`; moving around the tree never changes it. Members' apps ask `areclose` whether the people they are writing to may see a photo's location, and are told yes only when both sides have it. `listmembers` and `myrole` show it. It is about location only: every member uses the home's storage and media alike.

### Admins

An admin is a key that helps you run your members: it can make and revoke invites, answer join requests, see the member list, and add or remove members. It cannot touch anything else: the write policy, bans, blocks, the relay's name, description and icon, or other admins. It is made for a second key of your own, such as the one your messaging app uses, so that key can run your home without being your relay's owner key.

```bash
bothy_rpc https://your-relay.workers.dev/ addadmin '["<their npub>"]'
```

`removeadmin` takes the role away and leaves them a member; `listadmins` lists them. An admin is always a member, with an inbox and notifications, and gets its own message about each join request. An admin cannot remove another admin; only you can. Who an admin lets in is listed as invited by that admin.

Any key can call `myrole` to learn what it is here: `owner`, `admin`, `member` or `none`. The list of admins is not published in the relay information document, because it would tie your second key to your relay for anyone to read.

### A file server for your home

If your home has a separate file server for media and history backups (a Blossom server such as Keykin Storage), tell the relay about it, with its address and the key it signs with:

```bash
bothy_rpc https://your-relay.workers.dev/ setstorage '["https://storage.example/", "<the server'"'"'s npub>"]'
```

Apps then find it in the relay information document as `storage`, beside `blossom`, which stays this relay's own profile photo server. The file server keeps itself in step with your members by calling `memberkeys`, which only its key can call: it answers who may upload (you and your members) and who has left and when, and nothing else, so someone who joins can upload at once and someone removed cannot. `setstorage` with an empty address forgets it, and `getstorage` shows what is set. With a browser signer you can do the same on the admin page, under **File server**: it shows the key you are about to register, so you can check it against the one your file server shows before you sign.

Members' apps can also ask `mailtimes` when this relay stored each of their messages, and with `{"seq": true}` the relay's own running number for each (1, 2, 3, in the order it stored them, never reused), which they use to order messages that carry the same time.

### How your home is used

`homestats` answers, for you and your admins, how much your home is being used, in counts only: members seen today, this week and this month, encrypted messages that arrived each day for two weeks, how many people joined each week for eight weeks and how many of them by invite, how many members get notifications, and what profile photos take. It never says who: not who was seen, not who messaged whom. The admin page shows the same, after you sign a request with your browser signer; without one, use the `bothy_rpc` function below or an app.

To count members seen, the relay keeps one thing per member, the last day they signed in to read their mail, and forgets it when they are removed. A message usually counts twice, once for each side of the conversation. None of this is on `/api/stats`, which anyone can read.

### Join requests

Someone without a code can ask to join instead. Their app calls `requestjoin`, signed with their key, with an optional name and note, and the member whose link they followed, if any. The relay keeps the request for 30 days and sends you a message about it, from the relay's own key: "Robin wants to join your home.", with a link to their profile and what they wrote. `listjoinrequests` shows the requests waiting; `approvejoin` makes the person a member and `declinejoin` turns them down. A declined person who asks again within 30 days is told they were declined, and you are not messaged again. Nothing is sent to them when you answer: their app finds out the next time it checks.

An app can tell a message came from its own home relay: the message is signed by the key the relay publishes as `self` in its relay information document, and a join request carries the tag `["bothy", "joinrequest", "<their pubkey>"]`, so the app can show Approve and Decline buttons on it. Check both. The message is stored on this relay only, so it reaches you where this relay is one of your inbox relays.

Anyone higher up the tree can remove the people below them: a member can call `unallowpubkey` for anyone they invited, or anyone those people invited, but not for themselves (that is `eraseme`), anyone above or beside them, or an admin. You can remove anyone, and your admins anyone but another admin.

When someone who invited others is removed, the remover chooses what happens to those people. By default they stay members, listed as invited by whoever removed them (by you, when you or an admin did it). To remove them too, and everyone they in turn invited, pass `{"invitees": "remove"}` after the pubkey. The answer says what happened to them.

A member can also delete their own account, from their app (`eraseme`). Nothing waits 14 days then: their mail here and their profile photo are deleted at once (a very large mailbox finishes on the next hourly sweep, to stay inside the day's write allowance), their phones stop being notified, and they are no longer a member. The place they took goes back to whoever invited them, the people they invited stay and are listed as invited by that person, and any invites of theirs still waiting stop working. Messages they already sent stay with the people who received them. You cannot erase yourself this way: the relay is your account here.

A removed member's new mail is refused from that moment, and their phones stop being notified. What is already stored for them stays readable to them for 14 days, so their app can collect it and move to another home; then it is deleted. Letting them back in stops the clock.

Notifications need a key of their own. Generate a P-256 private key (32 bytes, base64url) and store it as a secret, never a variable:

```bash
npx wrangler secret put VAPID_PRIVATE_KEY
```

Without it everything above still works, with no notifications. A notification says only that there is a new message: not who sent it, not what it says, and not which conversation it belongs to. It passes through Apple's or Google's push service, and none of that is theirs to see. The relay could not add it anyway, because the mail is sealed.

#### Android notifications

That key covers browsers and home-screen web apps. An Android app that is not a browser gets its notifications through Google's Firebase Cloud Messaging instead, which needs a second, separate setup, and only if you use such an app:

1. In the [Firebase console](https://console.firebase.google.com), open the Firebase project the Android app was built with. It has to be that app's own project: Google delivers only to apps in the project that sends.
2. Go to **Project settings**, then **Service accounts**, and press **Generate new private key**. A JSON file downloads.
3. Store the whole file as a secret, then delete the download:

```bash
npx wrangler secret put FCM_SERVICE_ACCOUNT < path/to/the-key.json
```

The relay information document then shows `"fcm": {"project_id": "..."}`, and the app registers each phone with `subscribefcm`. Each member can register up to 4 Android devices, on top of up to 4 for web push. The message carries the same as a web notification: that there is a new message, and the app's own label for the account, never who or what. Keep the key secret: anyone holding it can send notifications to everyone who uses that app. Without it, nothing changes.

### Profile photos

Members, and you, can keep a profile photo here, so the people in your home load each other's faces from it. It is a [Blossom](https://github.com/hzrd149/blossom) server for that one thing: JPEG, PNG or WebP, up to 100 KB, one photo each (a new one replaces the old), a few uploads a day. Anyone can fetch a stored photo by its hash; nothing lists them. A removed member's photo goes with their mail, after 14 days.

Photos are kept in the relay's own storage, beside your events, so they need no setup and no extra Cloudflare product. All of them together are capped at 5% of the relay's storage budget, about 50 MB; at the cap new uploads are refused and nothing else is affected. The admin page shows how much is used. The apps also put each photo on a public Blossom server, so nothing breaks if this one is full.

### Private profiles

A member's name and photo are for the home, not the public. Their profile (kind 0) is stored here as usual, but served only to a connection signed in (NIP-42) as you, an admin or a member of this home, in stored reads and live alike. Anyone else gets nothing for that person, the same answer as for a key with no profile, so the read cannot be used to test who is a member; a member's profile change does not show on the live feed either. Profiles of people removed and still in their 14 days are for you and your admins only. With `MEMBER_LIST=hidden`, a plain member gets profiles only by naming whose (`authors`), so asking for every profile cannot list the home. Your own profile stays public, as your main identity, and so does anyone's who is not a member. `eraseme` deletes the member's profile, and their own keys' profiles, at once; a removed member's goes with their mail after 14 days. Members may also store a sealed photo (`application/octet-stream`, which the relay cannot read; the key travels inside the profile), one each and size-capped as above; your photo must stay an image. The relay information document shows `"profiles": "members"`, which is how an app knows it may keep a profile here and nowhere else.

### Your own other keys

Someone who uses more than one key, such as a Keykin account that makes one key per app, can let their other keys into the home as their own, without spending an invite. Their app calls `addmykey [<other key>, <proof>]`, signed by the member as usual, where the proof is a kind 21236 event signed by the other key with the tags `["p", "<member's hex key>"]` and `["relay", "https://<this relay>/"]`, made within the last 60 seconds. The proof is checked and thrown away; it is never stored or published. The key joins under the member, as theirs (`source` `"own"` and `invitedBy` the member in `listmembers`, so you and your admins can see it is the same person), at the member's own depth, and it leaves with them: removing the member, or the member's `eraseme`, takes their own keys too, whatever happens to the people they invited. Each member may add 10 (`OWN_KEYS_PER_MEMBER`, or `off` to turn it off). A key you or an admin removed cannot come back this way: the relay remembers it after the 14 days, keeping only a hash of the key and the time, until you let that person back in, call `forgetremoval [<pubkey>]`, or the person erases their own account. Any member can call `myinvitees` to see their own branch of the tree, in the same rows `listmembers` gives you, less when each was last seen, whether they get notifications, how much mail waits and how many locked copies of their key they keep (those stay yours and your admins'): everyone they let in, and everyone those people let in, and their own keys, plus anyone removed from that branch in the last 14 days. Every refusal `addmykey` gives starts with `addmykey:`, so an app can tell it apart from a relay that does not have the call.

### Typing, seen and call setup

Members' apps can send each other short sealed signals: kind 21059, shaped like a gift wrap (a `p` tag to the recipient, content only they can open), for "typing…", "seen" and setting up a call. The relay never stores them. It passes each one, at once, to the recipient's own open connection if they have one signed in and asking for them, and otherwise drops it: no notification, no copy kept. Only a connection signed in (NIP-42) as you or a member may send one, to you or a member; each is at most 16 KB, and each person may send 600 a minute (`MAX_SIGNALS_PER_MEMBER_PER_MINUTE`), apart from the limit on messages. The relay information document shows `"signals": {"v": 1}`.

### Calls

A call starts with a ring: an ordinary gift wrap (kind 1059) to you or a member, from any key, with one extra plain tag, `["ring"]`, and a NIP-40 `expiration` no more than 120 seconds ahead (without one, or with one further out or already past, it is refused with `invalid: a ring must expire within 120 seconds`). The relay keeps it until it expires, so the phone being rung can fetch it like mail, and sends that person's devices a notification of kind `"call"` at once, even if they have the app open, since Android may have frozen it. It is the same notification as for mail, the home's name and the app's label, and replaces it: a ring never also sends a "message" notification. On Android it goes at high priority and lives 30 seconds; on the web it is marked urgent and lives 30 seconds. Rings do not count against the limit on mail; instead an address may send 10 a minute and a person may be rung 6 times a minute. Everything else in the call (answer, connection details, hang up) travels as signals, above. The relay information document shows `"calls": {"v": 1, "ice": [...]}`, the STUN servers the apps use to find a way through (Google's and Cloudflare's for now; a TURN server of the home's own is a later step).

Who can see what: the home learns that a connection sent a ring to a member, and when. It never learns what is in it or which key signed it, and the notification carries neither.

### Fingerprint restore

Members can keep a locked copy of their key here, so a new phone gets their account back with a fingerprint (the DMs app's "fingerprint restore", like WhatsApp's passkey-encrypted backups). The person's passkey app locks the copy on their phone; the relay stores it and cannot open it. Each row belongs to one passkey and is found by the sha256 of its credential id. A member's app calls `vaultput [hash, {"credentialId", "publicKey", "alg", "blob", "label"}]` (the public key as SPKI in base64url, `alg` -7, -8 or -257, the blob a JSON object of at most 1 KB naming the member's own pubkey and this credential), `vaultlist` (their rows with each passkey's public key, without the copies) and `vaultdelete [hash]`, all signed. A new phone, which has no key yet, calls two methods unsigned: `vaultchallenge` for a single-use challenge good for two minutes, then `vaultopen [hash, assertion]` with a passkey assertion over it, for the passkey's RP ID `dms.aaro.cc` from `https://dms.aaro.cc` or the DMs Android apps. Those are built in, so a home needs no setup; `PASSKEY_ORIGINS` (comma-separated) adds more. `vaultopen` answers `{"blob": {...}}`, and every failure, whether a row exists or not, gets the same bytes, `{"error":"not found"}`, after the same work and no sooner than 300 ms, so nobody can find out who has an account here. Limits: 10 rows a person, 2 KB a row, 1% of the storage budget for all of them (`VAULT_STORAGE_BYTES`), 10 challenges and 10 opens a minute per address and 20 opens an hour per row. `eraseme` deletes a member's rows at once; a removed member's rows can still be opened, but not changed, for the 14 days their mail is kept, and then go with it. The relay information document shows `"restore": {"v": 1}`.

### Getting back in with someone's help

When the passkey is lost along with the phone, someone the person trusts can let them back in (the DMs app's "a person vouches"). This needs a copy of the key **this relay can open**: a member's app keeps one with `vouchput [copy]`, the copy being `{"v": 3, "seal": "box", "pubkey", "ct"}`, their key sealed with NIP-44 to this relay's own key (`self` in the relay information document). The relay opens it on the spot and refuses one that isn't the signer's key. `vouchdelete` removes it. `vaultlist` shows it after the passkey rows as `{"seal": "box", "boxReadable": true, "vouch": true, ...}`, and marks every passkey row `"boxReadable": false`. Anyone who gets hold of this relay's storage can open these copies; leave vouching off (`VOUCH=off`) if that is not acceptable for your home.

Who may vouch for a member: the owner and the admins, and up to 5 members they name themselves (`vouchers`, `addvoucher [pubkey]`, `removevoucher [pubkey]`). Nobody is let into an account above their own standing: an admin's account opens only for the owner or the people that admin named, and the owner's only for people the owner named, so an owner who wants this way back has to name someone. Someone who leaves the home stops vouching at once.

A new phone makes a one-time key and calls `vouchask [pubkey, one-time key]` unsigned. It gets `{"token", "code", "expiresAt"}` and shows the six-digit code. The people who may vouch get a message from the relay, and see the request in `vouchrequests` with the same code; one of them checks the code with the person by call or in person and calls `vouchapprove [pubkey, one-time key]` (or `vouchdecline`). The phone asks `vouchstatus [pubkey, one-time key, token]` and hears `waiting`, `approved` (with `releaseAt`), `ready` or `closed`. Once approved, the relay waits 24 hours, then answers `ready` with `{"copy": {"v": 1, "pubkey", "box", "ct"}}`, the key sealed to the one-time key, for the next 24 hours. The account's own devices get a message when the request is made, when it is approved and when the key is handed over; they see it in `myvouch` and can stop it with `vouchcancel` at any point before then. A request closes if the person who approved it leaves the home or stops being an admin before the 24 hours are up. One request is open per account at a time; an unapproved one lapses after 24 hours. `vouchask` answers the same way, after the same 300 ms, whether the account exists here or not, and stores a request only for a member with a copy. A stored request sends messages, and those show in the public counts on `/api/stats`, so someone watching the counts around an ask can tell that a key is a member here with a copy; 3 asks an hour per account and 10 calls a minute per address. Removing a member deletes their copy and closes their request at once; `eraseme` also deletes the record of their past requests. The relay information document shows `"restore": {"v": 1, "vouch": {"v": 1, "box": "<this relay's key>", "wait": 86400}, "noprf": {"v": 1}}`, or `{"v": 1}` with `VOUCH=off`.

### Getting back in with a password manager

Some password managers keep passkeys but cannot lock a copy with them (Bitwarden, for now), so fingerprint restore cannot use them. For those, the passkey signs the person in here instead: after the same checks as `vaultopen`, the relay hands the new phone the member's vouch copy (see above) at once, with nobody to approve it and no wait. That copy is one this relay can open, so this works only while vouching is on; `VOUCH=off` turns both off.

A member's app keeps one with `vaultput [hash, {"credentialId", "publicKey", "alg", "label", "seal": "box"}]`, signed, with no blob. It needs the member's vouch copy: the one already kept here, or one sent along as `"copy"`, which is checked as `vouchput` checks it and kept as their vouch copy. Without one it is refused with `vaultput: a "box" row needs your vouch copy...`, and with `VOUCH=off` with `vaultput: this home does not keep a copy it can open...`. `vaultlist` shows the row like any other, with `"seal": "box"` and `"boxReadable": true` (every other row has `"seal": "passkey"` and `"boxReadable": false`), and `listmembers` counts it in `restore` and again in `restoreBoxReadable`. It counts toward the same 10 rows and the same storage. When the password manager can lock copies later, the app puts the same passkey again with a blob, which replaces the row. `vaultdelete [hash]` removes one; `vouchdelete` removes these rows with the copy they hand over; removing a member deletes them at once with the copy, rather than after 14 days.

A new phone makes a one-time key, as for `vouchask`, and calls `vaultchallenge`. It asks the passkey for an assertion whose challenge is the sha256 of the challenge's bytes followed by the one-time key's 32 bytes, then calls `vaultopen [hash, assertion, one-time key, challenge]` unsigned. It gets `{"copy": {"v": 1, "pubkey", "box", "ct"}}`, the key sealed to the one-time key, exactly as `vouchstatus` hands it over. Because the one-time key is part of what the passkey signed, nobody who sees or replays an assertion can have the copy sealed to a key of their own. Every failure gets the same `{"error":"not found"}` as `vaultopen`, after the same work and the same 300 ms, whether there is no row, the row is the other kind, the assertion is wrong, the one-time key differs or the challenge was used; both forms share `vaultopen`'s limits. The account's own devices get a message, "A new phone got into your account with your password manager. If that wasn't you, tell the person who runs your home.", kept even when their mailbox is full, and see it in `myvouch` among the past requests, with `"why": "noprf"`. That message moves the public counts on `/api/stats`, so someone watching them can tell that a phone just got in this way, not whose account it was. And `/api/stats` `reads` counts one row more when an open names a passkey that has a row here than when it names none, for either form of `vaultopen`, so someone who holds a person's credential id and watches it on a quiet home could tell whether that passkey has a row here. The relay information document shows `"noprf": {"v": 1}` inside `restore` while vouching is on.

### History backup and old messages

Members' apps can back their message history up to your home's file server (see "A file server for your home" above), sealed so only they can read it. Once an app has checked that its backup is complete, it calls `backedup [mailThrough]`, signed by the member, where `mailThrough` is the latest stored time the backup holds, in Unix seconds, as `mailtimes` gives it. The relay keeps that one number per person. It only moves forward and never past the moment of the call, and the answer is what is now kept: `{"watermark": <n>}`. Members, admins and you may call it; anyone else gets 401 `you are not a member of this relay`, and every other refusal starts with `backedup:`. The relay information document shows `"backup": {"v": 1}`.

That number lets you have old messages deleted, so mailboxes do not fill up. It is off unless you turn it on:

```bash
bothy_rpc https://your-relay.workers.dev/ setretention '[true]'
```

Then, every hour, the relay deletes a stored message once it is more than 30 days old and every person it is addressed to is a member whose backup holds it. Your own messages are never deleted. A member whose app never backs up keeps all their mail, as before. Someone you remove keeps theirs for the usual 14 days, and then it goes as it always did; let them back in and their backup time is still there. `setretention '[false]'` turns it off. It cannot be turned on while no file server is set, because the backups would have nowhere to go, and if you disconnect the file server later, nothing more is deleted until you connect one again. `getretention` answers `{on, storage, backedUp, days}`: the switch, whether a file server is set, how many members have a backup, and the 30 days. The admin page shows the same under **File server**, with a button to turn it on or off.

Deleting costs writes, as storing does, so the relay spends at most a quarter of the day's free write allowance on it, and nothing in an hour when half the day's allowance is already spent, so new mail always has room. A home with months of old mail clears it over several days. `eraseme` forgets a member's backup time with the rest of their account.

## Who can write here

Your relay has one write policy, and you choose it:

| Policy | Who can publish |
|---|---|
| `owner` | Only you. |
| `inbox` | You, and anyone sending you or a member encrypted mail (see "Inbox mode" and "Members" above). |
| `follows` | Everything above, plus the people you follow. |
| `mentions` | Everything above, plus anyone whose event mentions or replies to you. An event from someone you don't follow may carry at most 32 indexed tags. **The default.** |
| `network` | Everything above, plus the people your follows follow. |
| `all` | Anyone, any event. |

Each policy includes everything the one above it allows. Whatever the policy, a pubkey you `allowpubkey` can always publish and a pubkey you `banpubkey` never can (see "Relay management API" below).

To change it you call `changewritepolicy`, one of bothy's own management methods. [nak](https://github.com/fiatjaf/nak)'s `nak admin` knows only the standard NIP-86 methods, so this shell function builds the same signed request by hand. It signs with the key in `NOSTR_SECRET_KEY`, which nak reads automatically:

```bash
export NOSTR_SECRET_KEY=<your nsec>
bothy_rpc() {  # bothy_rpc <relay-url> <method> [params-json]
  body="{\"method\":\"$2\",\"params\":${3:-[]}}"
  auth=$(nak event -k 27235 -c '' -t u="$1" -t method=POST \
    -t payload="$(printf %s "$body" | shasum -a 256 | cut -d' ' -f1)" < /dev/null | base64 | tr -d '\n')
  curl -s -X POST -H 'Content-Type: application/nostr+json+rpc' \
    -H "Authorization: Nostr $auth" -d "$body" "$1"; echo
}

bothy_rpc https://your-relay.workers.dev/ changewritepolicy '["mentions"]'
bothy_rpc https://your-relay.workers.dev/ getwritepolicy
```

The URL must be the relay's own `https://` address, because the signature covers it. It takes effect immediately. `getwritepolicy` reads back the policy in force and where it was set. An empty string clears the stored policy and returns to the default. `all` asks you to confirm: the first call refuses and tells you the exact confirmation string to pass as a second parameter. If `WRITE_POLICY` is set in the Cloudflare dashboard it outranks the management API, and `changewritepolicy` tells you so.

Under `network`, the relay gathers your follows' own contact lists, a few each hour, from three public relays, checks every signature, and keeps the people they name on a list of up to 40,000. Nobody can see the list, or which follow brought someone onto it; the admin page shows only how many are on it. It costs about 2 rows written to add a person and 1 a week to keep them, at most a tenth of the day's write allowance: filling the list takes about a week after you switch, and it is rebuilt every week, so someone a follow stops following drops off within about a week. Nothing is gathered under any other policy.

Under `all`, NIP-11 advertises `restricted_writes: false`; under every other policy it is `true`.

By default, then, bothy accepts events from you, your members, the people you follow, and anyone whose event mentions or replies to you. It knows who you follow from the follow list (kind 3) you've already published, so there is no separate allowlist to keep.

This is the default because bothy is meant to be in your NIP-65 relay list, which makes it your inbox. A client sending you a reply delivers it to the relays you read from, so if bothy refused strangers, their replies would never reach you here. Posts from strangers that are not about you are still refused.

Following someone is not unlimited trust. Anyone writing here is capped at 64KB per event and 20 events a minute, and writes from anyone but you stop once the relay is half full — so an account that gets compromised or goes haywire slows to something you'll notice and can revoke (unfollow, or `banpubkey` through the management API) long before it can fill your storage or spend a day's write budget. All three limits are adjustable; see "Configuration" above. The same caps apply to strangers, but they are per pubkey, and new keys cost nothing, so they don't stop someone spamming you from many throwaway keys. For that, `banpubkey` each one through the management API.

The admin page at your relay's URL is public — anyone with the link can see relay stats and your follow count. Never the follow list itself, only the count.

## Relay management API

bothy implements [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md), the relay management API. It lets you ban an event, block an IP address, or change the relay's name, description and icon, without redeploying and without touching the Cloudflare dashboard. There is no web interface for it, deliberately: the admin page stays a read-only status page that is safe to leave public, and every management command is a signed request you send from the command line.

The tool to send them with is [`nak`](https://github.com/fiatjaf/nak), whose `admin` subcommand speaks NIP-86. The shape of every command is the same — the method, your secret key, whatever parameters the method takes, and your relay's host last:

```bash
nak admin supportedmethods --sec <your nsec> your-relay.workers.dev
```

Start there. `supportedmethods` returns exactly what this relay implements, which is the honest answer to what you can do with it, and `nak admin --help` lists the flags each method takes. Every request is authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the relay owner's key, the same key you claimed the relay with. Nothing else is accepted, and an unsigned or wrongly signed request gets a 401. The exceptions are a member's own notification settings (`subscribepush`, `unsubscribepush`, `subscribefcm` and `unsubscribefcm`, signed by the member) `redeeminvite` and `requestjoin` (signed by whoever is joining), `myrole` (any key), the invite methods and `myinvites` for members (within their limits), a member's own `addmykey`, `vaultput`, `vaultlist` and `vaultdelete`, `vaultchallenge` and `vaultopen` (no signature at all: a passkey assertion is the credential), a member's own `vouchput`, `vouchdelete`, `vouchers`, `addvoucher`, `removevoucher`, `vouchrequests`, `vouchapprove`, `vouchdecline`, `myvouch` and `vouchcancel`, `vouchask` and `vouchstatus` (no signature at all: the copy only ever goes to the one-time key a voucher approved), and the member methods an admin may call (see "Admins" above).

What this relay implements: `banevent` and `allowevent` and `listbannedevents`; `banpubkey`, `unbanpubkey` and `listbannedpubkeys`; `allowpubkey`, `unallowpubkey` and `listallowedpubkeys`; `blockip` and `unblockip` and `listblockedips`; `changerelayname`, `changerelaydescription` and `changerelayicon`; and, bothy's own, `changewritepolicy` and `getwritepolicy` (see "Who can write here" above), `createinvite`, `redeeminvite`, `listunusedinvites`, `revokeinvite`, `requestjoin`, `listjoinrequests`, `approvejoin`, `declinejoin`, `listmembers`, `addadmin`, `removeadmin`, `listadmins`, `myrole`, `myinvites`, `homestats`, `setstorage`, `getstorage`, `memberkeys`, `mailtimes`, `mymailbox`, `eraseme`, `homemembers`, `setclose` and `areclose` (see "Members" above), `addmykey`, `forgetremoval` and `myinvitees` (see "Your own other keys" above), `vaultput`, `vaultlist`, `vaultdelete`, `vaultchallenge` and `vaultopen` (see "Fingerprint restore" and "Getting back in with a password manager" above), `vouchput`, `vouchdelete`, `vouchers`, `addvoucher`, `removevoucher`, `vouchrequests`, `vouchapprove`, `vouchdecline`, `myvouch`, `vouchcancel`, `vouchask` and `vouchstatus` (see "Getting back in with someone's help" above), `backedup`, `setretention` and `getretention` (see "History backup and old messages" above), and `subscribepush`, `unsubscribepush`, `subscribefcm` and `unsubscribefcm`. What it does not: the kind allowlist, because bothy stores every kind on purpose; and the moderation queue, because bothy has nothing to report events into.

The endpoint answers cross-origin requests, so a client hosted somewhere other than the relay can call it from a browser.

Banning an event tombstones its id, so the event is refused if it arrives again — including from a client re-sending it and from backfill pulling it out of another relay's history. You can ban an id you don't hold yet, and it will be refused on arrival. `allowevent` reverses this and is the only thing in bothy that lifts a tombstone.

Banning a pubkey refuses every future write from it, checked on the same write path as the follow list — a banned pubkey is refused even if it's also someone you follow. `unbanpubkey` lifts the ban. Separately, `allowpubkey` grants write access to a specific pubkey you don't follow, without opening writes any wider than that one key; `unallowpubkey` revokes it. Banning and allowing are independent: allowing a pubkey never overrides a ban on the same key. `allowpubkey` never changes someone who is already a member (who let them in, how and when stay as they were). For someone removed in the last 14 days it is "Let back in": they return to the same place in the invite tree, with their original join date, and anything that kept their keys out (see "Your own other keys") is forgotten. Only a key that is neither gets a new row, listed as let in by whoever called it. Both accept an npub or hex pubkey.

Blocking an IP address is checked once, when a WebSocket connection opens, and never again. It never applies to the management API itself, so blocking your own address cannot lock you out of the command that unblocks it. Because blocking the address you are calling from is nonetheless the easiest way to surprise yourself, the first attempt refuses and tells you the exact confirmation string to pass as the reason; a second call carrying that string goes through.

### Setting the name, description and icon

Each of the three resolves in the same order, from most to least authoritative:

1. The environment variable (`RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`), if you set one in the Cloudflare dashboard.
2. The value stored through `changerelayname`, `changerelaydescription` or `changerelayicon`.
3. Your kind-0 profile — its `name`, `about` and `picture`.
4. A built-in default. The icon has none: with nothing above it set, the NIP-11 document leaves the icon out.

When a name comes from your kind-0 profile it is derived rather than chosen, so it reads possessively: a profile name of "Aaron" becomes "Aaron's relay". A name you set yourself, by either of the first two routes, is used exactly as you wrote it.

If an environment variable is set, a `change*` call still stores your value and tells you that the variable is currently winning. Nothing is silently discarded, and the stored value takes effect the moment you clear the variable.

NIP-86 defines no way to unset a value, so bothy uses a convention: **passing an empty string clears the stored value**, falling through to your kind-0 profile and then to the built-in default. To read back what is in effect, request the NIP-11 document:

```bash
curl -H "Accept: application/nostr+json" https://your-relay.workers.dev
```

The effective name also appears on the admin page, since NIP-86 has no `getrelayname` to pair with `changerelayname`.

## HTTP endpoints

- `GET /api/stats`: relay stats for the admin page. Returns `{ version, claimed, ownerPubkey, relayPubkey, totalEvents, events24h, ingested24h, rowsWrittenToday, storageBytes, storageBytesLimit, dailyRowsWrittenLimit, dailyRowsReadLimit, backfill, icon, relayName, writePolicy, writePolicySource, groupPolicy, chatPolicy, followCount, memberCount, pushPolicy, photoBytes, photoStorageLimit, countAudit, followsListAt, vanishing, ownerListsThisRelay, reads, writes, reqCache, connections, latestVersion, updateAvailable }`. `relayPubkey` is the relay's own signing key (the NIP-11 `self` field), not yours. `ownerListsThisRelay` says whether your own relay list (kind 10002) already names this relay; the admin page hides the `wss://` copy box once it does. `latestVersion` and `updateAvailable` are the update check described in "Keeping it updated" (`null` and `false` when it is off or failed). `reads`, `writes`, `reqCache` and `connections` are diagnostics held in memory, which start again from zero whenever Cloudflare evicts the relay. `writePolicy` is the write policy in force by name and `writePolicySource` is where it was set (`env`, `stored` or `default`); `groupPolicy` is `on` or `paused`. `memberCount` is how many members you have, `pushPolicy` is `on` or `off` (whether `VAPID_PRIVATE_KEY` is set), and `photoBytes` is what profile photos take against `photoStorageLimit` (`null` when photos are off). `events24h` counts events by their own timestamp, which is what you posted; `ingested24h` counts what this relay actually took in, backfill included. During a backfill those differ by orders of magnitude. `vanishing` is a count, a progress total and an age, never the pubkeys that asked, since this endpoint is public and naming them would publish exactly the list a vanish request exists to remove someone from.
  Every other figure here is a maintained counter, exact and current as of the request — nothing on this document is cached or dated except `latestVersion`, which is cached for six hours. `events24h` and `ingested24h` are windowed in whole hours, so each spans 24–25 hours rather than exactly 24; `rowsWrittenToday` is exact, since a UTC day starts on a whole hour.
  `rowsWrittenToday` counts every row the relay wrote today: event rows and their index entries, tag rows, tombstones, counter updates, the follow-list rebuild, management calls and backfill bookkeeping. It is measured, and it reads slightly high because a removal is charged a pessimistic figure.
- `POST /api/claim` — TOFU claim; body `{ pubkey }` (npub or hex), plus `nonce` when the claim comes from the QR (a code from `/api/claim-nonce`; `410` if it has expired or was already used). See "Ownership and lifecycle" above.
- `POST /api/claim-nonce` — mints a short-lived, single-use code for the QR claim; returns `{ nonce, exp }`. Setup-only: 404s under `OWNER_PUBKEY`, refuses with `409` once claimed.
- `POST /api/claim-signed` — a proof-of-possession claim for signer apps that implement it (none do yet); body is a signed [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH event (kind 22242) naming this relay in its `relay` tag and a code from `/api/claim-nonce` in its `challenge` tag. Answers cross-origin (CORS), since a signer app — not this relay's own admin page — would call it directly, from whatever origin it runs on.
- `GET /api/claim-status?nonce=` — polled by the admin page while a QR is on screen; returns `{ status }` (`pending`, `claimed`, or `claimed-elsewhere` if the relay was claimed some other way while this code was outstanding).
- `GET /api/profile?pubkey=<hex>` — the claim form's courtesy profile preview: it looks your kind-0 up on a couple of well-known relays so you can see the name and avatar attached to a pubkey before binding the relay to it permanently. **This is a setup endpoint and it is only reachable during setup** — once the relay is claimed it returns 404, because it exists to guard one irreversible step and there is no reason to leave a path that opens outbound connections to third-party relays permanently open to anybody. Results are cached for five minutes.
- `GET /live` — unauthenticated, push-only WebSocket for the admin page's live feed (max 5 connections, 10-minute lifetime); sends `{ kind, created_at, id }` per stored event, with `id` cut to its first 8 characters, never gift wraps or drafts.
- Any path, with header `Accept: application/nostr+json` — the [NIP-11](https://github.com/nostr-protocol/nips/blob/master/11.md) relay information document. It reports the relay's name, description and icon, along with `pubkey` (yours, once the relay is claimed), and `contact` (the `website` from your kind-0 profile, if you have one). Both are omitted rather than left empty when there is nothing to report.
- `GET /<sha256>` (optionally with `.jpg`, `.png` or `.webp`), `PUT /upload` and `DELETE /<sha256>`: the profile photo server, a [Blossom](https://github.com/hzrd149/blossom) server for members' photos only (see "Profile photos" above). Fetching is public; uploading and deleting need a Blossom authorization event (kind 24242) naming the photo's hash.
- `POST /`, with header `Content-Type: application/nostr+json+rpc` — the [NIP-86](https://github.com/nostr-protocol/nips/blob/master/86.md) management API, authenticated with a [NIP-98](https://github.com/nostr-protocol/nips/blob/master/98.md) event signed by the owner. See "Relay management API" above.

Every endpoint above that reaches the relay's storage is rate limited per IP: 60 requests a minute shared across all of them and the WebSocket connection itself, and 10 a minute for `/api/profile`, which is tighter because it is the one that reaches out to other people's relays. Fetching profile photos has its own 300 a minute, because an app showing a list of friends loads many at once. Over the limit you get a `429` with a `Retry-After`. The admin page itself is a static file and is never rate limited: if the relay is refusing you, the page that says so still loads. Raising these means editing the `ratelimits` block in `wrangler.jsonc` and redeploying; there is no environment variable for them, because unlike the write-path caps they cost nothing to leave in place.

## Choices, not requirements

The NIPs leave some behavior unspecified. A few choices are worth knowing if you're building a client against this relay:

- `ids`/`authors` filters don't support prefix matching. NIP-01 says relays MAY support it; this one doesn't.
- NIP-42's AUTH `created_at` drift window is 600 seconds. This isn't specified by the NIP; bothy picked a number matching the ~10 minute convention other relays use.
- NIP-86 defines no way to unset a relay name, description or icon. bothy treats an empty string as the unset operation, which falls back to your kind-0 profile and then to a built-in default. `changewritepolicy` follows the same convention.

## What this is not

This project deliberately does not do: payments/zaps, multi-region scaling, NIP-05 hosting, media uploads, or community moderation tooling. The NIP-86 management API is the owner administering their own relay, not moderation tooling in the community sense. The write policies in "Who can write here" follow the ladder described in [docs/rungs.md](docs/rungs.md).

**Group support is paused.** There is code in this relay for NIP-29 groups — as many as the owner creates with a kind-9007 create-group event, with the owner as the only admin of each — with invites, members-only reads and ephemeral chat, and web push to go with it. It is not documented here because it does not yet work well enough to rely on, and it is off unless the `GROUPS` environment variable is set to `on`: a paused relay refuses group writes and does not advertise NIP-29. The code and tests stay; the documentation comes back when it works.

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

## License

MIT.
