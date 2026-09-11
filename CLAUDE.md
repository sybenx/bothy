# bothy

A single-user nostr relay that deploys in one click and runs on the Cloudflare Workers free tier. Paste an npub, get a `wss://` URL, done — no terminal, no VPS, no domain.

This file describes what the relay is and does. The reasoning behind it lives in the documents below and in code comments, never here.

## Documents

- [docs/principles.md](docs/principles.md) — the design principles every change is held against, and the checklist.
- [docs/workflow.md](docs/workflow.md) — how a human and an AI assistant work on this repository: the four stages, the gates, which model does what.
- [docs/rungs.md](docs/rungs.md) — the write-policy ladder, the internal vocabulary behind the five policy names.
- [docs/budget.md](docs/budget.md) — the rows-written and rows-read measurements the suite asserts, and the arithmetic against the free-tier ceilings.
- [docs/threat-model.md](docs/threat-model.md) — what the relay defends against and what it structurally cannot.
- [docs/decisions.md](docs/decisions.md) — why each design choice was made, one entry per choice.
- [docs/test-notes.md](docs/test-notes.md) — suite layout, fixture rationale, and the places tests drop below the wire protocol.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: NIP-86 on `Content-Type: application/nostr+json+rpc` (checked before NIP-11), NIP-11 on `Accept: application/nostr+json`, WebSocket upgrades to the Durable Object, `/api/claim`, `/api/stats`, `/api/profile` (answers only while the relay is unclaimed, 404 once it is), everything else to the static `public/` admin page. Every route that reaches the Durable Object is rate limited per IP by Cloudflare's Rate Limiting binding before the Worker's code runs; static assets and the CORS preflight are not.
- Exactly one Durable Object (`Relay`, [src/relay.ts](src/relay.ts)), addressed by `idFromName("relay")`. SQLite-backed. All protocol state, storage and subscriptions live here.
- WebSocket Hibernation API throughout (`acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`alarm`), `setWebSocketAutoResponse` for ping/pong. The Durable Object opens no outbound WebSocket; the Worker owns the claim-time profile lookup and the backfill fetches. The push fan-out is the object's one outbound HTTPS request and runs in its alarm.
- TOFU ownership: unclaimed until `POST /api/claim` binds a pubkey, permanently, with no signature required. `OWNER_PUBKEY` skips this and disables the endpoint. Every event is signature-verified regardless of owner.
- **Write policy** ([src/write-policy.ts](src/write-policy.ts)): one of five named levels, each including everything the one before it allows. `owner`: only the owner. `inbox`: plus kind-1059 gift wraps (NIP-59) from anyone, p-tagged to the owner, under their own storage cap and per-IP throttle. `follows` (the default): plus the owner's kind-3 follow list, cached from the owner's stored contact list, refreshed when the owner publishes a new one here, with hourly cron as the fallback. `mentions`: plus any author whose event p-tags the owner, at most `MAX_MENTION_EVENT_INDEXED_TAGS` indexed tags per event from a non-follow. `all`: anyone, any event, bounded by the per-writer caps only; NIP-11 reports `restricted_writes: false` under it. Resolved from `WRITE_POLICY`, else the value stored by NIP-86 `changewritepolicy`, else the default; `relay.ts` caches the resolved policy per instance and clears it after every management call. `ownership.ts isAllowedWriter` enforces it. The follow cache is maintained under every policy. NIP-86 `allowpubkey` admits and `banpubkey` refuses under every policy. `changewritepolicy all` refuses until called again with `OPEN_POLICY_CONFIRMATION` as its second parameter.
- Reads of kind 1059 require NIP-42 AUTH as the p-tagged recipient. A filter naming kind 1059 is refused from `f.kinds` alone; a filter naming no `kinds` is answered normally with the kind-1059 rows dropped from the query (`filters.ts excludeGiftWraps`).
- **NIP-29 groups are paused unless `GROUPS` is `on`** (`limits.ts groupsEnabled`). Paused: every event in this relay's own group and every moderation kind is refused with `GROUPS_PAUSED_MESSAGE`, the owner included; a kind-9021 is refused with the same message; the cron tick skips occupancy sampling and the chat sweep; the push alarm sends nothing; NIP-11 lists neither 29 nor `push_key`; `supportedmethods` omits `listunusedinvites`, `revokeinvite` and `subscribepush`, which answer with the paused refusal. `unsubscribepush` keeps working. Stored group rows stay hidden from unauthenticated reads and readable by the owner and members; events tagged into another relay's group are still held to the member list; the schema is unchanged.
- NIP-29 group events — any event carrying an `h` tag, of any kind, plus the relay-generated 39000–39005 kinds, which carry a `d` tag and no `h` ([src/groups.ts](src/groups.ts) `isGroupEvent`, `isGroupMetadataKind`) — are held in a separate partition of `events`/`event_tags` (`is_group`) and omitted from every unauthenticated read on four surfaces: REQ results, `broadcast()`, `liveBroadcast()`, and the public counters on `/api/stats`. A filter that names a group (`{"#h":[...]}` or one of the 39000-series kinds; `groups.ts filterNamesGroup`) is refused with `auth-required`; one that does not is answered with the group's rows omitted. Reads are gated on the same `group_members` list as writes: the owner, or a member (`relay.ts handleReqInner`, mirrored in `broadcast()`). `is_group` is carried as partial index pairs (`WHERE is_group = 0` / `= 1`), and every query against `events`/`event_tags` names a partition or runs once per partition (`groups.ts acrossScopes`).
- NIP-29 group writes ([src/nip29.ts](src/nip29.ts)): one group, id `_` (`groups.ts TOP_LEVEL_GROUP_ID`), owner as sole admin. Kinds 9000 put-user, 9001 remove-user, 9002 edit-metadata and 9009 create-invite are implemented; the rest of the 9000–9020 range is refused by name. There is no kind 9007 create-group. The group id is enforced on moderation events only; `h`-tagged traffic naming another id is partitioned and gated by the one member list.
- NIP-29 invites: kind 9009 creates one, kind 9021 redeems one. Single use, mandatory expiry (7 days by default, 30 at most, refused rather than clamped), a 16-character minimum, `MAX_OUTSTANDING_INVITES` = 64, and 5 join requests per IP per minute, all in `limits.ts`. A code this relay has issued is never reissued. Redeeming writes `group_members` and `allowed_pubkeys` with `source = 'invite'`. Kind-9009 events are readable by the owner only, omitted for everyone else (`filters.ts excludeInvites`, and in `broadcast()`).
- The join request (kind 9021) is dispatched above both write gates and stores nothing; a successful join produces only the relay's regenerated kind-39002. Signature verification runs before the invite lookup. Every refusal, whatever the cause, is `JOIN_REFUSAL_MESSAGE`; the reason goes to a `console.warn` with the code truncated to 12 characters. A gift wrap carrying an `h` tag is refused.
- Two nested lists: `allowed_pubkeys` (relay-wide write access, consulted by `isAllowedWriter`) and `group_members` (permission to write an `h`-tagged event, on top of that). `relay.ts handleEventInner` calls `nip29.ts authorizeGroupWrite` under the relay-wide gate. `allowed_pubkeys.source` is `owner` or `invite`: put-user and a redeemed join write `invite`, remove-user deletes only `invite` rows, and NIP-86 `allowpubkey` on an existing row promotes it to `owner`, one-way.
- The relay signs its own kind-39000/39001/39002 events (`relay-identity.ts signAsRelay`, called only from `nip29.ts`). They skip the write gate and go through `storage.ts storeEvent` like every other event; there is no second insert path. They are regenerated only when their own content changes, compared tag-by-tag, and stamped `max(now, previous + 1)`. The 39000 carries `name`/`picture`/`banner`/`about` forward from the previous document and the policy tags `private`/`restricted`/`hidden`/`closed`.
- **Web push** ([src/push.ts](src/push.ts)), off unless `VAPID_PRIVATE_KEY` is set as a Cloudflare secret. The public half is derived from the secret and published as `push_key` on the NIP-11 document while groups are on. RFC 8291 encryption and RFC 8292 VAPID are written against `crypto.subtle`; `p256.getPublicKey` is the one `@noble` call. A payload carries the room name and `"message"` or `"voice"` and nothing else. `subscribepush`/`unsubscribepush` bind a device to the pubkey the NIP-98 signature proved and are the two management methods a group member may call (`nip86.ts MEMBER_CALLABLE_METHODS`). The fan-out runs in the Durable Object's alarm, at most `MAX_PUSHES_PER_TICK` per tick, deferring the rest and dropping past `MAX_PUSH_ENDPOINTS_PER_NOTIFICATION` with a `console.warn`.
- **Group chat is ephemeral** ([src/storage.ts](src/storage.ts) `sweepChat`; the `limits.ts` block beginning `CONVERSATION_IDLE_SECONDS`). Kind-9 chat in the group is deleted, not hidden. A conversation ends when the room has held fewer than `MIN_ROOM_OCCUPANTS` (two) authenticated group readers for `CONVERSATION_IDLE_SECONDS` (two hours), and everything said during it goes with it. A message sent to an empty room is a note: it waits for the next conversation, with no ceiling. Somebody arriving partway through sees the last `CHAT_BACKLOG_SECONDS` (five minutes). The state is two integers in `chat_state`: `last_occupied_at`, the watermark between speech and notes, and `swept_through`, the checkpoint the sweep resumes from and the replay gate `authorizeGroupWrite` compares a chat message against. Nothing is tombstoned. Occupancy is sampled from an accepted group write, a REQ by a group reader, and the cron tick, throttled to `CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS`. `EPHEMERAL_CHAT` unset means reporting (each tick logs what it would delete and deletes nothing); `on` deletes and clamps group chat reads to the horizon; `off` removes the behaviour. The numbers go to the log, never to `/api/stats`.
- The NIP-86 management route sends CORS headers and answers an OPTIONS preflight; the preflight is not rate limited.
- NIP-09 deletion, NIP-62 vanish and NIP-86 `banevent` tombstone ids in `deleted_ids`. `allowevent` is the one place a tombstone is deleted. Vanish requests are checkpointed and drained across cron ticks (`beginVanish`/`drainVanish`).
- An expired gift wrap is deleted, not hidden (`storage.ts sweepExpiredGiftWraps`, once per cron tick, `GIFT_WRAP_SWEEP_BATCH_SIZE` at a time, oldest first). No tombstone: `acceptEvent` refuses any event whose `expiration` has passed.
- Live feed (`/live`): a separate, unauthenticated, push-only WebSocket for the admin page, capped at 5 concurrent connections and a 10-minute server-enforced lifetime (DO alarm). Sends only kind, time and a truncated id; never gift wraps, group events or content.
- NIP-86 relay management API ([src/nip86.ts](src/nip86.ts)): `banevent`/`allowevent`/`listbannedevents`, `banpubkey`/`unbanpubkey`/`listbannedpubkeys`, `allowpubkey`/`unallowpubkey`/`listallowedpubkeys`, `blockip`/`unblockip`/`listblockedips`, `changerelayname`/`changerelaydescription`/`changerelayicon`, `changewritepolicy`/`getwritepolicy`, `listunusedinvites`/`revokeinvite`, `subscribepush`/`unsubscribepush`, and `supportedmethods`. Authenticated by a NIP-98 event ([src/nip98.ts](src/nip98.ts)) signed by the owner, with the `payload` tag required; verification runs in the Worker, storage mutations go to the DO by RPC (`Relay.manage`). The kind allowlist methods answer with an explanation. `listunusedinvites`/`revokeinvite` are bothy's own and name spent, revoked and never-issued in full.
- `banevent` writes a `banned_events` row and a `deleted_ids` tombstone; `listbannedevents` reads `banned_events` only. `banpubkey`/`allowpubkey` are two independent lists; `isAllowedWriter` checks `banned_pubkeys` before the follows lookup for every non-owner write and `allowed_pubkeys` only on the path about to reject. The owner's pubkey cannot be banned.
- IP blocks are checked once per WebSocket connection in `Relay.fetch`, never per message and never on the management endpoint. Blocking the caller's own address refuses once and names the confirmation string to pass back as the reason.
- The NIP-11 document carries `pubkey` (the owner's, omitted while unclaimed), `contact` (the owner's kind-0 `website`, omitted if absent), `self` (the relay's own signing pubkey, always present) and `push_key` (while groups are on and a VAPID key is set). The relay keypair is generated once at schema-init time ([src/relay-identity.ts](src/relay-identity.ts)); the public half is also `relayPubkey` on `/api/stats`; the secret half is read only by `signAsRelay`.
- Relay name, description and icon resolve through one chain in [src/nip11.ts](src/nip11.ts): environment variable, then stored value (NIP-86 `change*`), then the owner's kind-0 (`name`/`about`/`picture`), then a hardcoded default. A `change*` call under a set environment variable stores the value and says the variable is winning. An empty string clears the stored value. A name derived from the kind-0 renders possessively ("Aaron's relay"); a chosen name is used verbatim. `resolveName` backs both NIP-11 and `/api/stats`.
- `/api/stats` serves maintained counters only: `totalEvents` and `followCount` from `maintained_counts`, `events24h` from `event_hour_counts`, `ingested24h` and `rowsWrittenToday` from `ingest_hour_counts`, with no cache. `countAudit` carries when the daily count check last ran and any drift as plain sentences. `vanishing` is a count, a progress total and an age. `reads` is the in-memory rows-read total since the object last woke and its 24-hour projection.
- One-shot backfill pulls the owner's own historical events from their kind-10002 write relays, resumable across cron ticks, reserving at most half the daily rows-written budget. Its status is `pending`, `running`, `paused` (the day's write budget is spent; resumes at 00:00 UTC) or `done`.

## What it refuses to be

No more than one group. Membership is created by the owner publishing a put-user, by a stranger redeeming an invite the owner issued (kind 9009/9021), or by hand through NIP-86 `allowpubkey` for the outer list — and no other way: no self-service join without a code, no request queue for an uninvited kind-9021 to wait in, no roles beyond the single owner-admin (no kind-39003), no per-group read scoping (membership is one relay-wide list), no member-readable invite codes, no group deletion or event pinning (kinds 9008/9010), no subgroups, no timeline references, no LiveKit, no payments/zaps, no multi-region/D1/read-replica scaling, no NIP-05 hosting, no media/blossom uploads, no community moderation tooling (no moderator roles, no report queue — the NIP-86 management API is the owner administering their own relay, which is a different thing), no continuous multi-relay sync (backfill is one-shot only). See [README.md](README.md) "What this is not".

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s `vars` block; a clean deploy asks for nothing but a project name. The `ratelimits` block is the one binding in `wrangler.jsonc`, read as `env.X?.limit(...)`, with an absent binding meaning "allowed". The variables, all optional and all added by hand in the Cloudflare dashboard, are declared in [src/env.d.ts](src/env.d.ts):

| Variable | Values | Default |
|---|---|---|
| `OWNER_PUBKEY` | `npub1...` or lowercase hex | unset: TOFU claim |
| `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON` | text | unset: NIP-86 value, then kind-0, then built-in |
| `WRITE_POLICY` | `owner`, `inbox`, `follows`, `mentions`, `all` | unset: NIP-86 value, then `follows` |
| `GROUPS` | `on` | paused |
| `EPHEMERAL_CHAT` | `on`, `off` | reporting |
| `UPDATE_CHECK` | `off` | on |
| `MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUBKEY_PER_MINUTE`, `NON_OWNER_STORAGE_BYTES` | a number, or `off` | 65536, 20, 2684354560 |

`VAPID_PRIVATE_KEY` is a Cloudflare secret (`wrangler secret put`), never a var: a base64url 32-byte P-256 scalar. A value that does not decode is logged once and treated as unset.

Every switch is read by `limits.ts readSwitch`: trimmed and lowercased, so `On` and `" off"` are `on` and `off`; a malformed value is logged and ignored. A malformed `WRITE_POLICY` is logged and ignored. `ALLOW_FOLLOWS` is no longer read. The identity variables outrank a value stored through NIP-86, which outranks the owner's kind-0.

Redeploying does not reset ownership or storage. Resetting requires deleting the Worker.

[.github/workflows/sync.yml](.github/workflows/sync.yml) is how a downstream copy pulls in upstream changes, weekly (`cron: "23 6 * * 1"`) and on `workflow_dispatch`; it no-ops in `sybenx/bothy` via the job-level `if` guard. The `git checkout HEAD -- wrangler.jsonc .github/` step restores the user's own Cloudflare resource ids and the workflow itself; do not remove or reorder it. README.md hands the file over as a GitHub "new file" URL generated by `npm run sync-badge`; `node scripts/sync-badge.mjs --check` fails when the two have drifted. Edit `sync.yml`, then run it.

## The budget

Per day, per account on the Workers free tier: 100,000 rows written, 5,000,000 rows read, 5GB of SQLite storage per Durable Object, 10ms of Worker CPU per request, resetting at 00:00 UTC. Rows written and rows read are the two that bind. Every figure is asserted by the suite ([test/hibernation.test.ts](test/hibernation.test.ts) for rows written, [test/read-cost.test.ts](test/read-cost.test.ts) for rows read, and the files named in [docs/budget.md](docs/budget.md)), so the tests are the record and a change that moves a figure fails. The measurements, the per-path costs and the caps derived from them are in [docs/budget.md](docs/budget.md).

## Threat model

Reads are public by design and writes are owner-gated. What the relay defends against, and what it structurally cannot, is in [docs/threat-model.md](docs/threat-model.md).

## Architecture map

- [src/index.ts](src/index.ts) — Worker entry: routing, `/api/*`, `scheduled()` cron dispatch, the exhaustion wrapper, CORS on the management route.
- [src/relay.ts](src/relay.ts) — the `Relay` Durable Object: connection lifecycle, NIP-01 message handling, NIP-42 AUTH, the read gates, live feed, occupancy sampling, the alarm (push drain and live-feed expiry), `getStats`, `manage`.
- [src/relay-stub.ts](src/relay-stub.ts) — the one `idFromName("relay")` accessor.
- [src/storage.ts](src/storage.ts) / [src/schema.ts](src/schema.ts) — SQLite schema and every read/write query: `storeEvent`, `insertEventRow`/`deleteEventRow` (the only writers of `events`), the maintained counters and their daily audit, tombstones, vanish, the chat and gift-wrap sweeps, `initSchema` with its schema hash, `INDEXES` and `eventRowCost`.
- [src/filters.ts](src/filters.ts) — REQ filter parsing, SQL query building, in-memory matching for live broadcast, `excludeGiftWraps`, `excludeInvites`, the partition `scope`, and `expandFilter` (the `authors` × `kinds` cross-product).
- [src/nostr.ts](src/nostr.ts) — wire types and kind-range classifiers.
- [src/validate.ts](src/validate.ts) — event id computation and schnorr signature verification (`@noble/curves`).
- [src/write-policy.ts](src/write-policy.ts) — the five policy names in order, `parsePolicy`, `resolveWritePolicy`, `admitsAtLeast`, the `mentions` p-tag test and its tag cap, `OPEN_POLICY_CONFIRMATION`, `POLICY_DESCRIPTIONS`.
- [src/ownership.ts](src/ownership.ts) — owner pubkey resolution (`getOwnerPubkey`, normalised like every other pubkey boundary), TOFU claim, `isAllowedWriter`, the follow-list cache (`refreshFollows`, the only writer of `follows`), profile refresh.
- [src/relay-identity.ts](src/relay-identity.ts) — the relay's own signing keypair; `signAsRelay` is its only reader of the secret.
- [src/groups.ts](src/groups.ts) — `isGroupEvent`, `isGroupMetadataKind`, `filterNamesGroup`, `TOP_LEVEL_GROUP_ID`, the two partition scopes, `acrossScopes`, `CREATE_INVITE_KIND`, `GROUP_CHAT_KIND`.
- [src/nip29.ts](src/nip29.ts) — group writes: `authorizeGroupWrite`, `applyModeration`, the 39000-series regeneration, `handleJoinRequest`, `authorizeCreateInvite`, `GROUPS_PAUSED_MESSAGE`, `JOIN_REFUSAL_MESSAGE`.
- [src/push.ts](src/push.ts) — VAPID keys, RFC 8291 encryption, RFC 8292 authorization, `sendPush`.
- [src/nip86.ts](src/nip86.ts) — management method dispatch (in the DO), `SUPPORTED_METHODS`, `GROUP_METHODS`, `MEMBER_CALLABLE_METHODS`.
- [src/nip98.ts](src/nip98.ts) — HTTP auth verification for the management API (in the Worker); does not know who the owner is.
- [src/nip11.ts](src/nip11.ts) — the relay information document and the name/description/icon resolution chain shared with `/api/stats`.
- [src/limits.ts](src/limits.ts) — every numeric cap in the project except the HTTP rate limit (which is in `wrangler.jsonc`), `readSwitch`, `groupsEnabled`, `chatMode`, `boundFilter` (prices a REQ filter against `schema.ts INDEXES`, clamps the limit, refuses what no limit can fix, and caps combinations and bound parameters), `BACKFILL_PAGE_SIZE`, `VANISH_BATCH_SIZE`.
- [src/host.ts](src/host.ts) — this deployment's own host, learned from request traffic.
- [src/pubkey.ts](src/pubkey.ts) / [src/bech32.ts](src/bech32.ts) — npub/hex normalisation.
- [src/profile-lookup.ts](src/profile-lookup.ts) — best-effort kind-0 lookup from well-known relays, Worker only, with an isolate-local five-minute cache that stores negative results and coalesces concurrent lookups.
- [src/upstream-version.ts](src/upstream-version.ts) — the newer-release check behind `/api/stats` `latestVersion`/`updateAvailable`, Worker only, cached six hours per isolate; `UPDATE_CHECK=off` disables it.
- [src/backfill.ts](src/backfill.ts) / [src/backfill-worker.ts](src/backfill-worker.ts) — backfill state machine (DO side) and outbound fetch orchestration (Worker side).
- [src/exhaustion.ts](src/exhaustion.ts) — classifies a free-tier allowance being consumed; `index.ts` wraps `fetch` and `scheduled` with it and answers a 503 with `Retry-After`.
- [src/read-metrics.ts](src/read-metrics.ts) — the `SqlStorage` wrapper that meters rows written (permanent, landed by `settleRowsWritten` at every entry point) and attributes rows read per code path (in-memory diagnostic).
- [src/env.d.ts](src/env.d.ts) — the optional environment variables merged onto `Env`.
- [public/index.html](public/index.html) — the static admin page: claim form, status, diagnostics, live feed.
- [scripts/sync-badge.mjs](scripts/sync-badge.mjs) — regenerates README.md's updater badge from `.github/workflows/sync.yml`.

## Conventions

- TypeScript strict mode, no `any` in the event-handling path.
- `@noble/curves` + `@noble/hashes` only; no second crypto dependency. Pin dependency versions.
- Protocol errors go back as `["OK", id, false, "prefix: message"]` or `["CLOSED", subid, "prefix: message"]` with a NIP-01 machine-readable prefix (`invalid:`, `restricted:`, `blocked:`, `rate-limited:`, `auth-required:`, `duplicate:`). Never fail silently. A refusal names the boundary and what would have worked, never a mechanism, a table, a variable name or a kind number the person did not send.
- Comments explain why. Reasoning goes in code comments and `docs/`; CLAUDE.md describes; the README instructs.
- Cheapest and most certain rejections run before expensive ones on every write path: ownership and tombstone checks precede schnorr verification. The two exceptions, the join request and the NIP-98 path, are documented at their sites.
- Indexes are declared once, as data, in `schema.ts INDEXES`; `boundFilter`, `eventRowCost`, `BACKFILL_PAGE_SIZE` and `VANISH_BATCH_SIZE` derive from it. An index whose definition changes must change its name. Adding an index means re-running `test/hibernation.test.ts`'s rows-written assertions and updating the schema.ts comment and [docs/budget.md](docs/budget.md).
- Every query against `events`/`event_tags` pins `is_group` or runs once per partition.
- Every pubkey boundary accepts `npub1...` or hex and normalises through `pubkey.ts`.
- Cloudflare platform limits cited in a file carry the doc URL and the date checked.
- One name per thing, used identically on the admin page, in the command, in its response, on `/api/stats` and in the README. A rename is a migration with a README line saying what to use instead.
- Commit directly to `main`. Never create a branch, and never open a pull request. Cloudflare builds from `main`.
- Plan mode before any change to `src/`, `public/`, README.md or CLAUDE.md: questions batched before the plan, nothing written before the plan is approved, and no push to `main` without the human saying so in that session. Review by a fresh session against `docs/principles.md`. The full method is [docs/workflow.md](docs/workflow.md).

## Commands

```bash
npm install
npm run dev         # wrangler dev, local DO with SQLite
npm run test        # vitest — protocol conformance + budget/hibernation regression
npm run typecheck
npm run deploy       # wrangler deploy
npm run cf-typegen   # regenerate worker-configuration.d.ts
npm run sync-badge   # regenerate README's updater badge from .github/workflows/sync.yml
```

## Testing

Two kinds of assertion live in the same suite ([test/](test)):

1. **Protocol conformance** — NIP-01 REQ/EVENT/CLOSE/EOSE, filters, replaceable/addressable/ephemeral storage rules, NIP-09/40/42/59/62, NIP-29 groups, invites and chat, and NIP-86/98 management. Reject paths are asserted as carefully as accept paths. [test/write-policy.test.ts](test/write-policy.test.ts) covers the write policy level by level; [test/groups-paused.test.ts](test/groups-paused.test.ts) covers what a paused group refuses and leaves alone.
2. **Budget/hibernation regression** — [test/hibernation.test.ts](test/hibernation.test.ts) asserts the object becomes eligible to hibernate after the last message and pins the per-event rows-written cost against a real `SqlStorageCursor.rowsWritten`; [test/nip29-groups.test.ts](test/nip29-groups.test.ts) pins the per-membership-change cost; [test/nip29-invites.test.ts](test/nip29-invites.test.ts) the per-invite and per-join cost; [test/read-cost.test.ts](test/read-cost.test.ts) rows read per query shape; [test/push.test.ts](test/push.test.ts) that twelve presence heartbeats write zero rows and one fan-out fits one invocation's subrequest allowance, and decrypts a real push body; [test/ephemeral-chat.test.ts](test/ephemeral-chat.test.ts) the cost of sweeping a conversation and of a tick with nothing to do; [test/nip59-giftwrap.test.ts](test/nip59-giftwrap.test.ts) the same pair for the expired-gift-wrap sweep. These assertions are the budget baseline; there is no separate file of recorded numbers.

The test bindings set `OWNER_PUBKEY`, `UPDATE_CHECK=off` and `GROUPS=on` (`vitest.config.ts`). See [docs/test-notes.md](docs/test-notes.md) for suite layout and fixture rationale.

## Release step

`package.json`'s `version` is the single source of truth, imported directly into NIP-11's `version` field and `/api/stats`. Never hardcode the version string elsewhere. The version bumps whenever `main` moves past the last tag, and every release bumps it to match the release tag.

Tags are annotated (`git tag -a`), never lightweight, and pushed with `--follow-tags`. Verify a tag reached the remote with `git ls-remote --tags origin <tag>`.

## Attribution

MIT licensed, original implementation. See [README.md](README.md) "Attribution" for the full statement and the rule for any reference reading (Nosflare, khatru, haven, strfry): read to understand the protocol, never paste.
