# bothy

A single-user nostr relay that runs on the Cloudflare free tier and deploys in one click.

A bothy is a small unlocked shelter in the Scottish highlands — free, unowned, maintained by whoever passes through. This is that, for your notes.

Click the button, paste your `npub`, get a `wss://` URL for your own relay. No terminal, no VPS, no domain, no port forwarding, no always-on box at home. The relay lives in your own Cloudflare account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sybenx/bothy)

## Setup

1. Click **Deploy to Cloudflare** above. If you don't have a Cloudflare account yet, it'll prompt you to make one (free).
2. Wait for the build to finish. You'll land on a `*.workers.dev` URL.
3. Open that URL, paste your `npub` (or hex pubkey) into the claim form, and confirm. This is a one-time, permanent step — see "Ownership" below.
4. Copy the `wss://` URL from the admin page into your nostr client's relay list.

That's it. No dashboard configuration required.

### Rate limiting (recommended)

This relay's read path is intentionally public (gift-wrapped DMs are the one exception — see "Inbox mode" below), so it's worth adding a free Cloudflare rate-limiting rule against abusive traffic: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** for your zone and add a rule capping requests per IP to your Worker's route. The relay enforces its own per-connection and per-IP limits regardless, but an edge rule catches abuse before it reaches the Worker at all.

## Ownership

The first person to submit their pubkey through the claim form owns the relay, permanently — this is "trust on first use" (TOFU). There's no signature check on the claim itself: every event is verified against its own signature regardless of who owns the relay, so a wrong claim can't be used to forge anything. The worst case of someone else claiming your relay first is that it archives a stranger's public notes at your expense — recoverable by deleting the Worker and deploying again.

If you want to skip the claim flow entirely and fix ownership at deploy time instead, set the `OWNER_PUBKEY` environment variable (hex, not npub) in your Worker's settings. This disables the claim endpoint outright.

## Configuration

The deploy button only asks for a project name. Everything else is an optional variable you can add later in the Cloudflare dashboard (**Workers & Pages → your worker → Settings → Variables**) if you want it:

| Var | Purpose |
|---|---|
| `OWNER_PUBKEY` | Fix ownership at deploy time instead of claiming (hex, not npub). Disables the claim endpoint. |
| `RELAY_NAME` / `RELAY_DESCRIPTION` / `RELAY_ICON` | Override the NIP-11 name/description/icon. Name and icon default to your claimed profile's kind-0 name/picture; description defaults to a generic string. |
| `ALLOW_FOLLOWS` | Set to `true` to also accept writes from your kind-3 follow list, refreshed hourly from your own most recent contact list already stored on this relay. |

If your Worker is connected to a GitHub repo, Cloudflare may sync `wrangler.jsonc`'s config on every deploy, which can overwrite a variable you added in the dashboard by hand — worth knowing if a dashboard-added variable seems to reset after a deploy.

## Resetting

**Redeploying does *not* reset ownership.** Running `wrangler deploy` again (or re-clicking the deploy button) ships new code against the *same* storage — your events and your claim both survive. This trips people up because the instinct after "I want to start over" is to redeploy.

To actually reset a relay: **delete the Worker** from the Cloudflare dashboard (Workers & Pages → your worker → Settings → Delete) and deploy a fresh one. There is no in-place "unclaim" — Durable Object storage is tied to the Worker.

## Inbox mode (gift-wrapped DMs)

This relay also accepts [NIP-59](https://github.com/nostr-protocol/nips/blob/master/59.md) gift wraps addressed to you, from anyone — the one exception to "only the owner can write." It's the write path a client needs if you publish a `kind:10050` DM relay list naming this relay; bothy itself never publishes that list for you, so nothing changes unless you deliberately turn your relay into a DM inbox by signing one.

Reading them back is restricted to you: an unauthenticated query for gift wraps gets a [NIP-42](https://github.com/nostr-protocol/nips/blob/master/42.md) AUTH challenge instead of results, so a stranger can't use your relay to count or time-correlate your incoming DMs. You can delete a gift wrap the same way you'd delete any note ([NIP-09](https://github.com/nostr-protocol/nips/blob/master/09.md)), and [NIP-62](https://github.com/nostr-protocol/nips/blob/master/62.md) "Request to Vanish" support means either you or a message's sender can ask for it to be permanently purged.

**Worth knowing:** Cloudflare terminates the TLS connection in front of this relay, so it necessarily sees the `p` tag (who a gift wrap is addressed to), the arrival time, and the sender's IP address, the same as any other Worker traffic. On a personal relay the `p` tag is always you, so that part leaks nothing new — but the sender IPs belong to other people, sending you mail through infrastructure you chose, not them.

## Choices, not requirements

The NIPs leave some behavior unspecified. Where they do, here's what this relay chose and why — not what the spec required:

- Kinds outside the replaceable/ephemeral/addressable ranges (45–999, ≥40000) are undefined by NIP-01. Bothy stores them like regular events rather than rejecting them or guessing at intent.
- NIP-62 vanish requests bypass the owner-only write gate entirely. The spec requires this regardless of write-restriction status — a vanish request's authority comes from a user erasing their own data, not from write permission.
- A vanish request itself is never stored as a row. NIP-62 says relays MAY keep it for bookkeeping, not MUST; bothy pays no row cost for the request, only for whatever it deletes.
- Gift wraps are never sent over the live feed, redacted or not. The admin page has no way to authenticate a viewer, so every viewer is treated as permanently unauthenticated — the same posture NIP-42 enforces for gift wrap reads elsewhere.
- The NIP-42 gift-wrap read gate decides by asking storage directly — re-running the incoming filter restricted to `kinds: [1059]` — rather than reasoning about which filter shapes could leak a gift wrap. An earlier, cheaper version tried the latter and missed that an `ids`-only filter naming a known gift wrap id slipped through ungated.
- `ids`/`authors` filters don't support prefix matching. NIP-01 says relays MAY support it; this one doesn't.
- NIP-42's AUTH `created_at` drift window (600 seconds) isn't specified by the NIP. Bothy picked a number matching the ~10 minute convention other relays use.

## What this is not

This project deliberately does not do: payments/zaps, multi-region scaling, NIP-05 hosting, media uploads, moderation tooling, or a public write mode. See `CLAUDE.md` for the full list and reasoning — most feature requests are already ruled out there.

## Attribution

[Nosflare](https://github.com/Spl0itable/nosflare) by Spl0itable is prior art that proved a nostr relay works on Workers + Durable Objects, and was a useful reference for NIP-01 filter-matching edge cases while building this. bothy is an original implementation, not a fork — no code is shared between the two projects.

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
