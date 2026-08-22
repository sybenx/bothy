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

This relay's read path is intentionally public (see "Reads are public" below), so it's worth adding a free Cloudflare rate-limiting rule against abusive traffic: in the Cloudflare dashboard, go to **Security → WAF → Rate limiting rules** for your zone and add a rule capping requests per IP to your Worker's route. The relay enforces its own per-connection and per-IP limits regardless, but an edge rule catches abuse before it reaches the Worker at all.

## Ownership

The first person to submit their pubkey through the claim form owns the relay, permanently — this is "trust on first use" (TOFU). There's no signature check on the claim itself: every event is verified against its own signature regardless of who owns the relay, so a wrong claim can't be used to forge anything. The worst case of someone else claiming your relay first is that it archives a stranger's public notes at your expense — recoverable by deleting the Worker and deploying again.

If you want to skip the claim flow entirely and fix ownership at deploy time instead, set the `OWNER_PUBKEY` environment variable (hex, not npub) in your Worker's settings. This disables the claim endpoint outright.

## Resetting

**Redeploying does *not* reset ownership.** Running `wrangler deploy` again (or re-clicking the deploy button) ships new code against the *same* storage — your events and your claim both survive. This trips people up because the instinct after "I want to start over" is to redeploy.

To actually reset a relay: **delete the Worker** from the Cloudflare dashboard (Workers & Pages → your worker → Settings → Delete) and deploy a fresh one. There is no in-place "unclaim" — Durable Object storage is tied to the Worker.

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
