# R2 as a back room (design only, not built)

A home without a box of its own (no Keykin Storage) still needs somewhere
for chat media, short video and history backups. This is how bothy could use
Cloudflare R2 for that without ever breaking a deploy or causing a surprise
bill. Internal, like [principles.md](principles.md); nothing here is built.
Written 2026-11-21 for bothy 0.26.0.

## What Cloudflare says (checked 2026-11-21)

- **Free allowance**: 10 GB-month of Standard storage, 1 million Class A
  operations (writes, lists) and 10 million Class B operations (reads) a
  month, egress free. Beyond it: $0.015 per GB-month, $4.50 per million
  Class A, $0.36 per million Class B. Deletes are free.
  (developers.cloudflare.com/r2/pricing)
- **The allowance is per Cloudflare ACCOUNT**, shared by every bucket and
  every project in it. Aaron's account already uses part of it for other
  projects, so bothy must never assume any of it is its own.
- **Enabling R2**: an account needs an R2 subscription, added through a
  checkout flow in the dashboard (developers.cloudflare.com/r2/get-started).
  The docs do not say whether a card is required; third-party guides and a
  2025 status incident report that a payment method is asked for at that
  step. Treat it as: **may need a card**. So R2 is an optional upgrade,
  never part of the default deploy.
- **Creating the bucket**: Wrangler provisions an R2 bucket automatically
  for a binding with no bucket name, on `wrangler deploy` and on a deploy
  from the dashboard or GitHub (developers.cloudflare.com/workers/wrangler/
  configuration, "Automatic provisioning"). It still needs the account's R2
  subscription; without one the deploy fails. That is why the binding can
  never be in upstream `wrangler.jsonc`: a sync would break every
  downstream deploy whose owner has not enabled R2.
- **No spending cap**: Cloudflare documents no hard cap on R2 spending,
  unlike Workers and Durable Objects, which stop at the Free plan's limits.
  So bothy's own budget and hard stop (below) is the only protection.
- **Request size**: a Worker on a Free or Pro zone accepts request bodies up
  to 100 MB (developers.cloudflare.com/workers/platform/limits). Uploads
  are streamed straight to R2, never buffered (the Worker has 128 MB of
  memory), so the practical ceiling for one video is just under 100 MB.

## Shape

### Opt-in only

- Not in upstream `wrangler.jsonc`, ever. An owner who wants it enables R2
  on their account, adds the binding in their own deploy (Aaron's fork keeps
  its own `wrangler.jsonc`), and sets a cap. Two steps, both in the README,
  both reversible.
- Absent binding or absent cap means off: no NIP-11 advertisement, no
  routes, nothing to call. The same rule as `FCM_SERVICE_ACCOUNT` and
  `VAPID_PRIVATE_KEY`.
- Behind the photo store's interface (src/photos.ts `PhotoStore`), widened
  from "one photo per pubkey" to "blobs per pubkey, by kind". The routes do
  not change; a home with R2 serves Blossom from it, and one without keeps
  its 250 MB of profile photos in the Durable Object.

### The caps, all enforced by bothy itself

bothy must never rely on Cloudflare to stop it. It counts its own use and
refuses at its own caps, in its own SQLite:

| What | Setting | Conservative default | At the cap |
|---|---|---|---|
| Bytes stored | `BACKROOM_BYTES` (required; no default means off) | the owner must choose; the README suggests 2 GB | uploads refused, `blocked: this home's back room is full` |
| Bytes per member | `BACKROOM_BYTES_PER_MEMBER` | 10% of the total | that member's uploads refused |
| Writes per month (Class A) | `BACKROOM_WRITES_PER_MONTH` | 100,000 (10% of the free allowance) | uploads refused until the 1st |
| Reads per month (Class B) | `BACKROOM_READS_PER_MONTH` | 1,000,000 (10% of the free allowance) | blob reads redirect to "try later", mail unaffected |
| One upload | `BACKROOM_MAX_BLOB_BYTES` | 25 MB; never above 95 MB | 413 |

- **Bytes** are counted on every put and delete in a `backroom_usage` table
  (per pubkey and `*`), as `mail_usage` is for mail. An object is only
  counted once its put succeeds; a failed put costs nothing but is still
  counted as a write.
- **Operations** are counted per calendar month in a `backroom_ops` row
  (month, writes, reads), incremented before the call is made, so a crash
  between counting and calling over-counts and never under-counts.
- **Reads are the risk**: a popular image fetched by strangers spends Class
  B operations. Blob reads are rate-limited per IP (a free binding, like
  `RATE_LIMIT_PHOTOS`) and served with `Cache-Control: immutable`.
  Members-only reads (NIP-98 or a short signed URL) are the stricter option
  if the monthly read cap is ever reached in practice.
- **Never a surprise bill**: the defaults are a tenth of the free
  allowance, so even an account already using most of it stays inside it.
  An owner who raises them is choosing to pay, and the admin page shows use
  against each cap, in bytes and operations, with the dollar figure beyond
  the free allowance worked out from the prices above.

### What goes in it

- **Chat media**: images and short video members attach to messages. Each
  blob belongs to its uploader and counts against their share. Removal and
  `eraseme` delete their blobs, with removal's 14-day grace and erasure at
  once (deletes are free).
- **History backups**: each member's encrypted backup, one object per
  member, replaced in place. The relay cannot read it. Counted against the
  member's share.
- **Not** profile photos, which stay in the Durable Object (small, always
  up, and already capped), unless the owner turns the DO photo store off.

### Retention depends on it

Shortening how long bothy keeps delivered mail (the 30-days-and-signed-in
rule settled with the DMs goal session) may only switch on when a back
room, R2 here or Keykin Storage, holds the members' history backups. bothy
checks that, not the owner's memory: retention refuses to turn on while
neither `storage` (setstorage) nor an R2 back room is configured, and says
why.

## Open questions for Aaron

1. Is a card on the account acceptable for homes that want this? If not,
   R2 stays a power-user option and Keykin Storage is the default back room.
2. Reads: public by hash, like profile photos today, or members only?
3. Should a home with R2 still keep profile photos in the Durable Object?
   (The recommendation is yes: they are what an app shows first.)
