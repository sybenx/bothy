# Key management: what bothy will and will not hold

Record of an assessment (2026-09-05) of QR_SECRET_TRANSFER (QRST 1.4-draft) and
NOSTR_KEY_MANAGEMENT (NKM 9.2-draft) at sybenx/nostr-key-management `646b6d7`,
from the relay's side. The full assessment and its spec-issue drafts are in git
history (`git show 5d9ce47:docs/key-management.md`); spec feedback lives in that
repository's issues, not here.

## Roles bothy already fills, with no code

- **The relay "the user controls" (NKM §2.4).** A restored device checks for a
  threshold record before self-enrolling; absence is trustworthy only from a
  relay the user controls. A bothy is one.
- **Carrier for the device list and epoch record** (kind 30242, owner-signed,
  addressable). They pass the write gate as owner writes and land in the public
  partition: contents are encrypted, but their existence and update times are
  visible to anyone who polls.

## Decisions

- **No key material in bothy: no blob store (NKM §4.2), no co-signer (§7.6).**
  - SQLite-backed Durable Objects keep 30 days of point-in-time recovery over
    the whole database, with no opt-out (Cloudflare storage API docs, checked
    2026-09-02). An overwrite is not a destruction, so rotation (§7.9 step 4)
    cannot neutralise a revoked device's share, and no secret here can be
    promised destroyed.
  - bothy has one store, so §4.2's split between data store and secret store is
    impossible; a leak falls back to the weakest recovery factor.
  - A co-signer's audit log (§7.13) is a rolling record of who the owner talks
    to, which this project says the relay does not hold.
  - It would turn relay failures (allowance exhausted until 00:00 UTC, a bad
    deploy) into "the owner cannot post", and the origin holding share 1 also
    serves page JS, so it could obtain share 2 from a browser device.
  - If wanted, it is a separate Worker, ideally in a separate account, on a
    backend with controllable retention.
- **The relay identity key (`relay-identity.ts`) stays sign-only.** It must not
  become the co-signer key `S` or gain ECDH: its compromise should cost a group's
  metadata, never a share of the owner's identity.
- **bothy is not a QRST transport.** Gift wraps are owner-only both ways, and
  QRST's T2 requires a transport with no relationship to either party. A signed
  QRST-style claim was tried and dropped because no signer app implements it;
  the QR claim that shipped carries only the owner's npub.
- **Expired gift wraps are deleted** (`storage.ts sweepExpiredGiftWraps`).
  Found by this assessment: they had been filling `maxGiftWraps` permanently.

## Open

- **Device mail (not built; only if hearth grows a device list).** The owner
  registers device pubkeys over NIP-86 in a table separate from
  `allowed_pubkeys` (which grants writes). `handleGiftWrap` accepts wraps
  addressed to them; a kind-1059 filter is admitted only when every `#p` is the
  authenticated pubkey; mirror the gate in `broadcast()`. Revisit the gift
  wrap limits (5 a minute per address, 120 per signed-in member) against a
  real device count. Carry
  control traffic only: signing rounds as gift wraps cost ~32 charged rows each
  and occupy the inbox for 30 days.
- **README note** on the "relay the user controls" role: not written, because
  the README makes no claims about drafts.
- **Point-in-time recovery also covers swept chat and expired gift wraps:**
  "deleted" means unrecoverable by clients, not by the account holder for 30
  days.
- **Storage ceiling:** one 2026-09-02 reading of the limits page gave 1GB per
  Durable Object on Free, against `limits.ts STORAGE_BYTES_LIMIT` = 5GB. Verify
  before relying on the gift wrap and non-owner storage shares.
