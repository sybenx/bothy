# bothy

A single-user nostr relay that deploys in one click and runs on the Cloudflare Workers free tier. Paste an npub, get a `wss://` URL, done — no terminal, no VPS, no domain.

## What it is

- One Worker ([src/index.ts](src/index.ts)) routes requests: NIP-86 on `Content-Type: application/nostr+json+rpc` (checked first — that string contains `application/nostr+json`, so checking NIP-11 first would swallow it), NIP-11 on `Accept: application/nostr+json`, WebSocket upgrades to the Durable Object, `/api/claim`, `/api/stats`, `/api/profile` (a setup endpoint: it answers only while the relay is unclaimed, and 404s once it is), everything else to the static `public/` admin page. Every route that reaches the Durable Object is rate limited per IP by Cloudflare's Rate Limiting binding before the Worker's own code runs; static assets are not.
- Exactly one Durable Object (`Relay`, [src/relay.ts](src/relay.ts)), addressed by `idFromName("relay")`. SQLite-backed. All protocol state, storage, and subscriptions live here.
- WebSocket Hibernation API throughout (`acceptWebSocket`, `webSocketMessage`/`webSocketClose`/`alarm`), `setWebSocketAutoResponse` for ping/pong. The Durable Object must never open an outbound connection — doing so breaks hibernation. The Worker owns every outbound connection (claim-time profile lookup, backfill fetches) on the DO's behalf.
- TOFU ownership: unclaimed until `POST /api/claim` binds a pubkey, permanently, with no signature required (`OWNER_PUBKEY` env var skips this and disables the endpoint). Every event is still signature-verified regardless of owner.
- Writes are owner-gated, with two exceptions: `ALLOW_FOLLOWS` (opt-out, on unless set to `"false"`) also accepts the owner's kind-3 follow list (cached from the owner's own stored contact list, refreshed immediately when the owner publishes a new one to this relay, with hourly cron as the fallback for when it arrived some other way — never fetched per event); kind-1059 gift wraps (NIP-59) are accepted from anyone, p-tag-addressed to the owner, gated by their own storage cap and per-IP throttle on top of the general write caps below. [docs/rungs.md](docs/rungs.md) describes this kind of escalation generically, in terms of who may write and what bounds the volume — bothy implements rung 3 (follows may write) with kind-1059 gift wraps layered in as an instance of rung 2 (addressed mail). NIP-29 invites are not a rung: the ladder classifies WHO may write, and an invite enrols one named individual into the allowlist rung 1 already describes — bounded by the owner's issuance rate and `MAX_OUTSTANDING_INVITES`, not by a new class of writer.
- Gift wrap reads require NIP-42 AUTH as the p-tagged recipient, and the gate is **omission, not refusal**: a filter naming kind 1059 is refused from `f.kinds` alone with no storage access, and a filter that names no `kinds` is answered normally with the kind-1059 rows dropped from the query (`filters.ts excludeGiftWraps`). It used to decide by probing storage — re-run the filter restricted to 1059, refuse if anything came back — and that made the refusal itself the answer: an unauthenticated `{"#p":[owner],"since":S,"until":U,"limit":1}` said `auth-required` when a wrap fell inside the window and `EOSE` when none did, so bisecting since/until yielded exact arrival windows and an exact inbox count without ever naming 1059. Refusal leaks; omission does not. In SQL and never in memory afterwards, because a client asking for 20 and receiving 8 has counted the wraps in its own window.
- NIP-29 group events — any event carrying an `h` tag, of any kind, PLUS the relay-generated 39000-series, which carries a `d` tag and no `h` ([src/groups.ts](src/groups.ts)) — are held in a separate PARTITION of `events`/`event_tags` (`is_group`) and omitted from every unauthenticated read. Kind-agnostic, because NIP-29 scopes a group by that tag and not by a kind range: a kind-1 note, a kind-7 reaction and a kind-30023 post are all group events if they name a group. The exclusion covers four surfaces, not one — REQ results, `broadcast()` (a subscription registered before an event arrives is never re-examined by the REQ-time gate, which is why gift wraps gate there separately too), `liveBroadcast()` (the `/live` feed has no authentication at all), and the public counters on `/api/stats` (polling `totalEvents` while holding a `/live` socket dates every arrival to the second — the same shape the gift wrap review found). Same omit-don't-refuse rule as gift wraps: a filter that NAMES a group (`{"#h":[...]}`) is refused with `auth-required` from the filter alone, and a filter that does not is answered normally with the group's rows omitted. Reads are gated on the same `group_members` list the write side is gated on (`relay.ts handleReqInner`, mirrored in `broadcast()`): the owner, or a member. That was an asymmetry for two releases — a member could write to the group and could not read it back, which made the group unusable by anyone but the owner — and closing it needed the invite hole below closed FIRST, in that order, because widening a read gate over a partition holding bearer tokens hands them out. The 39000-series was the hole in that partition, and it was open for exactly one release: `isGroupEvent` tested the `h` tag, and NIP-29 puts the group id of the relay-generated events in a `d` tag "instead of the `h` tag" — so kind-39001 (the admin list) and kind-39002 (the member list), the two events that enumerate the group's membership in `p` tags, carried no `h`, landed in the PUBLIC partition, and were served to any unauthenticated client that asked. The exclusion covered every event in the group except the list of who was in it. `isGroupMetadataKind` closes it by KIND, over the whole 39000–39005 range, and not by `d` tag: `d` is the generic addressable identifier every kind in 30000–39999 carries, so it names a group only in that range and cannot be the test. `filterNamesGroup` widens the same way — a filter naming one of those kinds is refused from `kinds` alone, exactly as a filter naming 1059 is, while a filter naming only `#d` is answered by omission, since refusing on `d` would refuse reads of unrelated addressable kinds that happen to share an identifier. The exclusion is a partition seek, not a post-filter: `is_group` is carried as partial index PAIRS (`WHERE is_group = 0` / `= 1`) rather than as a widened key column, because a widened key column changes the plan of every query that does not name it — measured, the owner's own authenticated `{"#p":[owner],"kinds":[1059]}` read went from 601 rows to 204,701 under a widened index, against 567 under partial pairs (see `src/groups.ts` and `schema.ts INDEXES` for the full reasoning and measurements).
- NIP-29 group WRITES ([src/nip29.ts](src/nip29.ts)): one group, id `_` (`groups.ts TOP_LEVEL_GROUP_ID`), owner as sole admin. Kinds 9000 put-user, 9001 remove-user, 9002 edit-metadata and 9009 create-invite are implemented; the rest of NIP-29's 9000–9020 moderation range is refused BY NAME rather than stored as an inert group note, since a kind-9005 delete-event answered `["OK", id, true]` that deletes nothing is worse than a refusal. Kind 9007 create-group is deliberately absent: NIP-29 has no creation step ("what happens is just that relays will create rules around some specific ids"), and with one group whose id is a constant there is nothing to create — 9002 edit-metadata is what brings the group's metadata into being. The group id is enforced on moderation events only, where it selects what gets mutated; ordinary `h`-tagged traffic naming some other id is still partitioned and still gated by the one member list, because deciding what a group IS belongs at the partition and not at the write gate.
- **NIP-29 invites** (kind 9009 create-invite, kind 9021 join request). An invite code is a BEARER TOKEN — the relay cannot authenticate who will present it, which is the point: an invite link has to work for somebody whose npub does not exist until they click it. So the controls are lifetime, count, guessability and guess rate, all in `limits.ts`: single use (one code admits one pubkey, spent thereafter), mandatory expiry (7 days by default, 30 at most, refused rather than clamped when a `kind:9009` asks for longer, since a clamped invite is a link the client goes on describing wrongly), a 16-character minimum (the only guessing floor a relay can enforce over a code it did not generate — length is not entropy, and the per-IP throttle of 5 join requests/minute is what actually bounds the deliberate case), and `MAX_OUTSTANDING_INVITES` = 64, which bounds the NIP-86 list rather than the owner. A code this relay has ever issued is never reissued: an upsert would hand its original redeemer a second admission and overwrite the only record of who it let in. Redeeming writes BOTH nested lists, `source = 'invite'`, so a 9001 remove-user reclaims it exactly as it reclaims a put-user's grant.
- **The join request is the third path dispatched above both write gates**, necessarily — somebody joining is by definition not in `allowed_pubkeys`, so `isAllowedWriter` would refuse the one event whose whole purpose is getting them past it. It therefore owes the group partition what the other two owe it, and pays the same way NIP-62 vanish does: **nothing is stored**. A kind-9021 carries an `h` tag, so storing one would put a stranger's event into the group partition through a path no group authorization gates — the gift wrap defect below, rebuilt. The only event a successful join produces is this relay's own regenerated kind-39002, which is the canonical record of the membership anyway. Signature verification runs BEFORE the invite lookup, inverting this project's cheapest-first convention on purpose: refusing a bad code ahead of a bad signature would let a caller offer guesses under junk signatures and tell a real code from a fake one by which complaint came back.
- **A refused join says one thing, whatever went wrong.** Spent, expired, revoked and unknown are four different states and all four get `JOIN_REFUSAL_MESSAGE` verbatim — "spent" or "expired" would confirm the code was REAL, which confirms this relay hosts a group somebody was invited to, and "unknown" against a guess confirms the opposite; either way the refusal becomes a one-bit oracle tested a guess at a time, which is exactly what the gift wrap read gate was before it stopped deciding by probing storage. A request naming another group id, and one carrying no code at all, get the same string too: answering "wrong group id" would confirm which id this relay does host. The owner gets the distinction through a channel a stranger cannot read — a `console.warn` naming the reason (with the code truncated to 12 characters and `JSON.stringify`d, since it is attacker-chosen text going into a log) and the two NIP-86 methods. What is NOT hidden is timing: a known code costs one row read more than an unknown one before the same refusal. Levelling that with a dummy read would be defending against an adversary who can already do better by other means.
- **`closed` stays on the generated kind-39000, and the note predicting its removal is what changed.** It was read as "join requests are ignored"; NIP-29's own sentence is "If a group is `closed`, join requests are not honored unless they include an invite code", which is precisely what this relay now does. Invite-only IS the closed group; `open` would be the tag that lies.
- **Two nested lists.** `allowed_pubkeys` is the outer one (relay-wide write access, what `ownership.ts isAllowedWriter` consults); `group_members` is the inner one (permission to write an `h`-tagged event, on top of that). `relay.ts handleEventInner` calls `nip29.ts authorizeGroupWrite` UNDER the relay-wide gate, never beside it, and three integer comparisons return early for any event that is neither group-scoped nor moderation, so ordinary writes pay nothing. `allowed_pubkeys.source` is `owner` or `invite`: put-user and a redeemed kind-9021 both write the row a new member needs as `invite`, remove-user deletes only `invite` rows, and a NIP-86 `allowpubkey` on an existing row PROMOTES it to `owner` — an explicit act outranks the group's bookkeeping, and the promotion is one-way. Without that column remove-user would have two options and both are wrong: revoke a grant the owner made deliberately, or let every ex-member keep writing forever.
- **The relay signing its own events** is new to this codebase, and the rule is: bypass the GATE, never the BOOKKEEPING. A relay-generated 39000/39001/39002 never enters `handleEventInner` — there is nobody to authorize — but it goes through `storage.ts storeEvent`, the same function every client write reaches, so it pays the maintained counters, both hour buckets, the stamped `row_cost`, the `is_group` partition and the addressable-replacement rule exactly as any other event does. There is no second insert path and there must never be one: half of `storeEvent` reimplemented is half of the budget accounting missing, and the accounting is the part nothing would notice was wrong. `test/nip29-groups.test.ts` asserts it by running the daily counter audit — which recounts the table rather than trusting the counters — over a relay whose only events are relay-generated. The secret key stays behind `relay-identity.ts signAsRelay`, which is handed a 32-byte hash and returns a signature; `nip29.ts` builds the event and computes its id through the same `validate.ts computeEventId` every client event goes through, so these verify like any other event.
- The three are regenerated only when their own content changes, compared tag-by-tag before writing — the same measure-before-writing rule `ownership.ts refreshFollows` applies to the follow cache and for the same reason: a membership change touches neither the admin list nor the metadata, and rewriting all three anyway would delete and re-insert two unchanged addressable events every time. Each regeneration is stamped `max(now, previous + 1)` rather than `now`, because NIP-01 breaks a `created_at` tie on an addressable event by LOWEST id — two membership changes in the same wall-clock second would otherwise produce a member list that loses to the one it replaces about half the time, and lose SILENTLY, since `storeEvent` reports success with `stored: null`. The generated 39000 carries the operator's `name`/`picture`/`banner`/`about` from the triggering 9002 (or forward from the previous document, so an unrelated regeneration cannot blank the group's name) and then the policy tags `private`/`restricted`/`hidden`/`closed`, which are facts about what this relay enforces rather than preferences a 9002 expresses. `closed` is the one expected to come off, when invites land.
- **Web push** ([src/push.ts](src/push.ts)), off unless `VAPID_PRIVATE_KEY` is set as a Cloudflare SECRET. The public half of that keypair is derived from the secret rather than configured beside it (two configured halves can disagree; a derived one cannot) and published as `push_key` on the NIP-11 document; unset means no `push_key`, which means no client subscribes, which means no subscription rows, no outbox rows and no alarm — the degradation path hearth's `reference/push.md` describes, and a supported state rather than an error. RFC 8291 encryption and RFC 8292 VAPID are written against `crypto.subtle` directly: every npm package for this is Node-shaped (`require("crypto")`, `crypto.createECDH()`, `require("https")`) and none of it runs on workerd, while ECDH P-256, HKDF-SHA256, AES-128-GCM and ES256 all do — natively, which also matters on a 10ms CPU budget. The single exception is deriving a public key from a bare private scalar, which WebCrypto cannot do at all (`importKey` wants the x and y being derived), so `p256.getPublicKey` does that one line and everything else is the platform. A payload carries the room name and `"message"`/`"voice"` and NOTHING else — not the message, not the sender: it travels through Apple's or Google's push service, and the room name is the only part already public (it is the NIP-11 `name`). `subscribepush`/`unsubscribepush` bind a device to the pubkey the NIP-98 signature PROVED and never to one the body offers, and they are the only two NIP-86 methods a group member may call rather than only the owner (`nip86.ts MEMBER_CALLABLE_METHODS`) — a member who could not call them could not be notified, which would make push owner-only in a room built for a group.
- **The fan-out runs in the Durable Object's alarm**, which is the one place in this object that reaches the network, and it is not the exception to "the DO opens no outbound connection" it looks like. That rule exists because an outbound WEBSOCKET pins the object in memory for as long as it stays open — up to fifteen minutes, which is why `profile-lookup.ts` and `backfill-worker.ts` both live in the Worker. An HTTPS request that completes does not, and an alarm is a brief billed wake the platform schedules against a hibernated object and lets hibernate again, exactly as the live feed's lifetime alarm already does. There is also no Worker-side alternative: nothing in the Worker runs when a WebSocket message arrives, and the hourly cron is three orders of magnitude too slow for a notification.
- **Group chat is ephemeral** ([src/storage.ts](src/storage.ts) `sweepChat`, the `limits.ts` block beginning `CONVERSATION_IDLE_SECONDS`). A conversation among friends is remembered rather than reread, and writing it down permanently turns talk into a record and changes what it was — the voice calls this relay carries have always worked that way and nobody expects to replay one, while the text beside them had been quietly claiming a different status nobody decided on. So kind-9 chat in the group expires: not hidden, not archived, deleted. Four rules. **A conversation ends when the room has been empty for `CONVERSATION_IDLE_SECONDS`** (two hours — long enough that dinner does not end it, short enough that an evening ends when the evening does), and everything said during it goes with it. **A message sent while somebody else was present belongs to that conversation.** **A message sent to an empty room is a note rather than speech**: it waits for the next conversation instead of expiring unseen, for as long as that takes — there is deliberately NO ceiling on a note, because speech is ephemeral for having been heard and a note has not been heard yet, and mail does not vanish because the person it was addressed to is away. The sender takes a note back the same way they take anything back, with a NIP-09 kind-5, which `applyDeletion` already honours across the group partition by primary key. **Somebody arriving partway through sees the last `CHAT_BACKLOG_SECONDS`** (five minutes), not the whole session — enough to know what is being talked about, not enough to replace asking.
- **The whole of that is two integers and an index seek**, which is the part worth defending. The obvious shape for "which conversation does this message belong to" is a per-message column or a side table, and both cost rows written per message to record something the clock already knows. `chat_state.last_occupied_at` is the last second at which `MIN_ROOM_OCCUPANTS` (two) distinct group readers held a socket at once, and it is simultaneously the thing that decides the conversation has ended and the line between what belonged to it and what did not: everything at or before the watermark is speech, everything after it is a note. So the sweep is `WHERE kind = 9 AND is_group = 1 AND created_at <= ?` against `idx_events_kind_created_grp`, which exists already and is partial over exactly this partition, and the speech/note rule needs no per-message bookkeeping at all. `chat_state.swept_through` is the second integer: it checkpoints a sweep too large for one cron tick, exactly as `vanishing.cutoff_created_at` does, and it is what `nip29.ts authorizeGroupWrite` compares an incoming chat message against so a member holding their own signed copy cannot replay a finished conversation back into the room.
- **Nothing is tombstoned, and that is the one place this departs from every other removal in the codebase.** A `deleted_ids` row per swept message would leave the relay accumulating two permanent rows for every message it deleted — a record of the conversation outliving the conversation, in a smaller box, which is the thing the feature exists to end. `swept_through` refuses the same replay for every message of every swept conversation at once, for one integer.
- **The relay is the only party that could do this**, which is why it is here and not in a client: it is the only one that sees everyone's presence at once, and a client expiring its own copy would be hiding a transcript this relay still held. `relay.ts groupOccupants` is that seeing — a walk over the object's own live sockets, counting distinct authenticated pubkeys that `handleReqInner`'s read gate already admitted to the group partition, so it costs no storage read at all. Sampled from three places: an accepted group write, a REQ by a group reader, and the cron tick, which is the only one that can see a room full of people sitting quietly. It is throttled as a whole rather than only at its write (`CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS`, 7.5 minutes, a sixteenth of the idle window) — throttling only the write left the watermark unmoved whenever the room held fewer than two people, so the throttle never advanced and every group event walked every socket to re-establish that nobody was there.
- **It ships able to report and not to act.** `EPHEMERAL_CHAT` unset means REPORTING: each cron tick computes exactly what deleting mode would remove, logs it, and stores it in `chat_state.reported_at`/`reported_pending`, while nothing is deleted and nothing is withheld from a read — a relay in this mode behaves precisely as it did before. The exact string `"on"` lets it act; the exact string `"off"` removes the behaviour outright. That inverts this project's usual only-one-exact-string-disables-it shape (`ALLOW_FOLLOWS`, `UPDATE_CHECK`, the write-path caps) on purpose: those guard a safety limit, so turning one OFF is the act that must be spelled out, and here it is the deletion that must be. The numbers go to the log rather than to `/api/stats`, which is public and unauthenticated and which the group partition is kept off — the same channel `handleJoinRequest` uses for its refusal reasons. `/api/stats` carries `chatPolicy`, the mode and no counts, because a mode is configuration and says nothing about what the group holds.
- **The NIP-86 management route sends CORS headers and answers an OPTIONS preflight.** Safe, and the comment in `index.ts` says why so nobody removes it as an oversight: every call is authenticated by a NIP-98 signature over that exact method, URL and body, there is no cookie or session for a cross-origin request to borrow — which is the ambient authority the same-origin policy exists to protect — and an unauthenticated preflight reveals only that the endpoint exists, which the NIP-11 document already advertises unauthenticated on the same URL. Without it the API was reachable only from a page the relay itself served, and hearth is served from GitHub Pages, so every management call from it failed at the browser: the invite listing that had already shipped, and push subscription after it. The preflight is deliberately NOT rate limited — it reaches no Durable Object, and counting it would spend two of an address's sixty per minute for every management call.
- NIP-09 deletion and NIP-62 vanish requests both tombstone ids (`deleted_ids`) so a deleted event — gift wraps especially, since the sender keeps their own signed copy — can't be replayed back into storage.
- Live feed (`/live`) is a separate, unauthenticated, push-only WebSocket channel for the admin page, capped at 5 concurrent connections and a 10-minute server-enforced lifetime (DO alarm). Never sends gift wraps or event content, only kind/time/truncated id.
- NIP-86 relay management API: `banevent`/`allowevent`/`listbannedevents`, `banpubkey`/`unbanpubkey`/`listbannedpubkeys`, `allowpubkey`/`unallowpubkey`/`listallowedpubkeys`, `blockip`/`unblockip`/`listblockedips`, `changerelayname`/`changerelaydescription`/`changerelayicon`, `listunusedinvites`/`revokeinvite`, and `subscribepush`/`unsubscribepush`, plus `supportedmethods`. Authenticated by a NIP-98 event ([src/nip98.ts](src/nip98.ts)) signed by the owner, with the `payload` tag required rather than optional; verification runs in the Worker so a forged request costs no DO time, and storage mutations go to the DO by RPC (`Relay.manage`). Phase one shipped only the methods that cost nothing on the per-event write path; phase two (`banpubkey`/`allowpubkey`) is the one addition that does, landed only once a metrics baseline existed to compare against — see CLAUDE.md "The budget". The kind allowlist methods answer with an explanation rather than a generic unknown-method error, since bothy stores every kind deliberately. `listunusedinvites`/`revokeinvite` are bothy's own — NIP-86 defines no invite methods — and they are the deliberate MIRROR of the join path's uniform refusal: here the caller is the owner, authenticated by a NIP-98 signature over this exact request, so spent, already-revoked and never-issued are each named in full. There is no creation method to match them: an invite is created by publishing a kind-9009, which is a signed part of the group's history, and a second way in over HTTP would put one act on two paths with only one of them recorded in the group.
- `banevent` writes both a `banned_events` row and a `deleted_ids` tombstone: the ban is what the operator reads back, the tombstone is what actually refuses a re-send or a backfill replay. `listbannedevents` reads `banned_events`, never `deleted_ids` — the latter holds NIP-09 and NIP-62 deletions too. `allowevent` is the one place in the codebase that deletes a tombstone.
- `banpubkey`/`allowpubkey` are two independent lists (`banned_pubkeys`/`allowed_pubkeys`), not opposite ends of one — unlike `allowevent`, `unbanpubkey` and `unallowpubkey` each just delete their own row. `ownership.ts isAllowedWriter` checks `banned_pubkeys` before the follows lookup, unconditionally for every non-owner write, so a banned pubkey is refused even if it's also a follow; it checks `allowed_pubkeys` only on the path already about to reject (owner-only mode, or "not a follow"), so that lookup costs nothing on the common accept path. The owner's own pubkey can never be banned — `banpubkey` refuses the call outright rather than accepting it and having no effect.
- IP blocks are checked exactly once per WebSocket connection in `Relay.fetch`, never per message, and never on the management endpoint — blocking your own address must not lock you out of the API that unblocks it. Blocking the caller's own address refuses once and names an exact confirmation string to pass back as the reason.
- The NIP-11 document also carries `pubkey` (the owner's, from `getOwnerPubkey` — omitted while unclaimed) and `contact` (the owner's kind-0 `website`, omitted if absent). Neither has an environment-variable or NIP-86 rung: name/description/icon do because an operator may want the relay to present differently from the person, and a contact address has no such split. `website` and not `nip05` or `lud16` — see `resolveContact`.
- The relay has its own signing keypair, generated once at schema-init time and unrelated to `pubkey`/`OWNER_PUBKEY` above — see [src/relay-identity.ts](src/relay-identity.ts). NIP-29 requires 39000-series group metadata events to be "signed by the relay keypair directly"; `src/nip29.ts` is what does that signing. The public half is `self` on the NIP-11 document — the standard field for it (nips/11.md "Self"), and the one NIP-29 points a client at for verifying 39000-series events — and `relayPubkey` on `/api/stats`, both unconditionally present (unlike `pubkey`, this doesn't depend on claim status). It shipped for one release as `relay_pubkey`, a name of our own invention, which was harmless while nothing signed anything and became a conformance bug the moment `nip29.ts` started generating events. The secret half is never exposed anywhere — not `/api/stats`, not NIP-11, not NIP-86, not a log line.
- Relay name, description and icon resolve through one chain in [src/nip11.ts](src/nip11.ts): environment variable, then stored value (NIP-86 `change*`), then the owner's kind-0 (`name`/`about`/`picture`), then a hardcoded default. A `change*` call under a set environment variable still stores the value and says the variable is winning — store and warn, never silently discard. An empty string clears the stored value; NIP-86 defines no unset operation, so this is bothy's convention and is documented in the README. Every successful `change*` response carries an error-field note teaching that escape hatch and pointing at the NIP-11 document as the readback. A name derived from the owner's kind-0 renders possessively ("Aaron's relay", always `'s`); a chosen name from any other rung is used verbatim. `resolveName` backs both the NIP-11 document and `/api/stats`, so the two can never disagree.
- One-shot backfill pulls the owner's own historical events from their kind-10002 write relays, resumable across cron ticks, reserving at most half the daily rows-written budget so it never competes with the owner's live traffic.

## What it refuses to be

No more than one group. Membership is created by the owner publishing a put-user, by a stranger redeeming an invite the owner issued (kind 9009/9021), or by hand through NIP-86 `allowpubkey` for the outer list — and no other way: no self-service join without a code, no request queue for an uninvited kind-9021 to wait in (there is no moderator to hold it for, so it is refused rather than held), no roles beyond the single owner-admin (no kind-39003, because one role every admin has and no moderation event can grant is not information a client can act on), no per-group read scoping (membership is one relay-wide list, so a member reads every partitioned event this relay holds rather than one group's worth), no member-readable invite codes (a kind-9009 is owner-only inside a partition members otherwise read in full), no group deletion or event pinning (kinds 9008/9010), no subgroups, no timeline references, no LiveKit, no payments/zaps, no multi-region/D1/read-replica scaling, no NIP-05 hosting, no media/blossom uploads, no community moderation tooling (no moderator roles, no invite system, no report queue — the NIP-86 management API is the owner administering their own relay, which is a different thing), no public write mode, no continuous multi-relay sync (backfill is one-shot only). See [README.md](README.md) "What this is not".

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and declared nowhere in `wrangler.jsonc`'s `vars` block — a clean deploy must ask for nothing but a project name. The `ratelimits` block is the one binding added to `wrangler.jsonc` since, and it fits that rule: its namespace ids are ours to pick, nothing is provisioned, and nothing is prompted for. Both bindings are still read as `env.X?.limit(...)` — the Cloudflare docs do not state which plans the binding is available on (checked 2026-08-27), so an absent binding means "allowed" rather than an exception on every request. Env vars, all added by hand in the Cloudflare dashboard if wanted: `OWNER_PUBKEY`, `RELAY_NAME`, `RELAY_DESCRIPTION`, `RELAY_ICON`, `ALLOW_FOLLOWS`, `UPDATE_CHECK`, `MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUBKEY_PER_MINUTE`, `NON_OWNER_STORAGE_BYTES`. See [src/env.d.ts](src/env.d.ts).

`VAPID_PRIVATE_KEY` is the one piece of configuration that is a SECRET and not a var, and the distinction is the point rather than a convention. `wrangler.jsonc` declares no `vars` block precisely because a git-connected Worker may sync vars from that config on deploy and overwrite what was set in the dashboard — for a private key that would mean the repository silently deciding what it is. `wrangler secret put VAPID_PRIVATE_KEY` is the only way in, secrets are never synced from config, and the key is therefore incapable of reaching the repository or `wrangler.jsonc`. It is read the same defensive way as every var (`env.X ?? fallback`), and a value that does not decode to a valid 32-byte P-256 scalar is logged once and treated as unset — the same behaviour as no key at all, which is a supported state.

The three identity variables sit at the top of the resolution chain described above — they outrank a value stored through NIP-86, which outranks the owner's kind-0.

`MAX_EVENT_BYTES`, `MAX_EVENTS_PER_PUBKEY_PER_MINUTE` and `NON_OWNER_STORAGE_BYTES` are the write-path abuse caps; each takes a number or the exact string `"off"`. What bounds a follow, and the before/after arithmetic, is in CLAUDE.md "The budget".

`EPHEMERAL_CHAT` is the one variable whose default is neither on nor off but *watch*. Unset, the relay reports each hour what it would delete and deletes nothing; `"on"` lets it act and clamps group chat reads to the horizon; `"off"` removes the behaviour entirely. See "What it is" above for why the shape is inverted from every other variable here, and "The budget" for what turning it on costs.

`ALLOW_FOLLOWS` defaults to on; must be set to the literal string `"false"` to disable it and fall back to owner-only writes. When on, the owner's kind-3 follow list gates writes. The cache refreshes immediately when the owner publishes a new contact list to this relay; hourly cron is the fallback for when it arrived some other way (backfill, or a client that published it elsewhere first).

`UPDATE_CHECK` defaults to on and takes the exact string `"off"` to disable, the same shape as the write-path caps. On, the Worker asks upstream what the current release is when `/api/stats` is served (`upstream-version.ts`, cached six hours per isolate) so the admin page can show a `v… available` note; off, it never makes that request and the note never appears. It is the read side of README.md "Keeping it updated", and it exists because the updater is opt-in by construction: nothing else in this project would ever tell an owner who did not commit `sync.yml` that a release happened.

Redeploying does not reset ownership or storage — DO storage survives `wrangler deploy`. Resetting requires deleting the Worker.

[.github/workflows/sync.yml](.github/workflows/sync.yml) is how a downstream copy pulls in upstream changes — the deploy button clones this repo as an independent repo, not a fork, so there is no Sync fork button and nothing happens by itself. It is scheduled (weekly, `cron: "23 6 * * 1"`) as well as `workflow_dispatch`, and that is deliberate: committing the file IS enabling auto-update, because a switch that has to be found and clicked again every time is not one a button-deploy user will keep using. It no-ops in `sybenx/bothy` itself via the job-level `if` guard, so upstream's own Actions minutes are never spent on it.

The `git checkout HEAD -- wrangler.jsonc .github/` step is load-bearing — it restores the user's own Cloudflare resource IDs and this workflow after the upstream checkout overwrites them; don't remove or reorder it. The `.github/` half is not merely policy: `GITHUB_TOKEN` cannot push a change to a file under `.github/workflows/` (GitHub refuses the push outright), so a sync that tried to carry a newer workflow downstream would fail at the push rather than at the checkout. The consequence is that the workflow a downstream copy commits is the one it keeps forever — it has to be right when it ships, and a fix to it reaches existing deployments only if their owners re-commit it by hand.

The copy Cloudflare creates arrives without `.github/workflows/`, which is why README.md hands the file over as a GitHub "new file" URL carrying the whole workflow in its `?value=` parameter. That URL is generated, never hand-edited: `npm run sync-badge` rewrites it from the file, and `node scripts/sync-badge.mjs --check` exits non-zero when the two have drifted. Edit `sync.yml`, then run it — otherwise every new deployment enables a version of the updater that no longer exists here.

## The budget

Everything here runs on the Cloudflare Workers free tier, and the ceilings are
what shape the design. Per day, per account: **100,000 rows written**,
**5,000,000 rows read**, 5GB of SQLite storage per Durable Object, 10ms of
Worker CPU per request. Allowances reset at 00:00 UTC. Rows written and rows
read are the two that bind; storage and CPU are not close.

Every figure below is asserted by the suite — [test/hibernation.test.ts](test/hibernation.test.ts)
for rows written, [test/read-cost.test.ts](test/read-cost.test.ts) for rows read —
so the tests are the record and a change that moves one fails rather than
drifting. The one cost the suite cannot assert is schnorr verification, because
the workerd test harness does not expose isolate CPU time; that number and its
caveat sit on `verifySignature` in [src/validate.ts](src/validate.ts). Below,
**E** is rows in `events` and **T** is rows in `event_tags` (≈ 5E for real notes,
which carry about five single-letter tags each).

### Rows written, per stored event

```
measured   9 + 3 × (single-letter tag count)
charged   12 + 4 × (single-letter tag count)   <- deliberately high, see below
```

Six for the event row: one base row, one for the implicit unique index behind
`id TEXT PRIMARY KEY` (a TEXT primary key is not a rowid alias), and one for each
of the four declared indexes on `events`. Three more for the maintained counters
(`maintained_counts`, `event_hour_counts` and `ingest_hour_counts`, all unindexed or
rowid-aliased, so one row apiece). Three per indexed tag row: the row and its two
indexes. A bare note costs 9, a reply carrying `#e` and `#p` costs 15, a real note
carrying about five tags costs 24. A delete is a write too, so a replacement or a
NIP-09 deletion costs this shape again, plus 2 for a tombstone.

`eventRowCost` charges more than an event costs, on purpose. The three
REQ-serving indexes on `events` and the tag lookup index are declared as
partial PAIRS keyed on `is_group` (one half over the public partition, one
over the group partition), and a stored row satisfies exactly one half of
each pair — so it pays one index entry per pair, exactly what the single
index it replaced cost. `EVENT_BASE_ROW_COST` is
`2 + indexesOn("events").length` and counts the halves separately, so a real
five-tag note is charged 32 and spends 24.

Left wrong, because every consumer of that number is a GUARD and an
over-estimate makes each of them stricter rather than looser:
`BACKFILL_PAGE_SIZE` fetches smaller pages, `VANISH_BATCH_SIZE` drains fewer
events per tick, `hasBackfillHeadroom` stops sooner, and the `row_cost`
stamped on each row reads high. Slower, never overrunning — the same
direction `eventRemovalBudget` is deliberately wrong in.
[test/hibernation.test.ts](test/hibernation.test.ts) pins the measured cost,
the charged cost and the gap between them, so the wrongness cannot drift and
a fix cannot land quietly. The one place it is NOT safe is
`auditMaintainedCounts`' rows-written check, which is a floor: a floor above
what the meter can report is a daily false alarm, so that one comparison
converts the stamped sum back through `eventRowCostMeasured`. When the
derivation is fixed, the two become equal and that arithmetic goes with it.

The three counter rows are the price of `/api/stats` no longer scanning or
sampling anything at all — 3 rows written per event against ~1,100 events/day
here, so ~3,300 of 100,000, to remove a ~3E read that grew without bound
(`totalEvents`, `events24h`) and two window scans behind a five-minute cache
(`ingested24h`, `rowsWrittenToday`). `schema.ts EVENT_COUNTER_ROW_COST` declares
it and `eventRowCost` folds it in, so backfill's page sizing, the vanish drain's
pacing and the admin page's budget bar all see it; a counter cost paid at the
write site but hidden from those guards would be the same shape of error that
made `estimateRowsWrittenSince` wrong by 45x.

The third row does double duty, and that is why it is affordable. It is the
ingest-hour bucket behind `ingested24h`, and it is also where the **measured**
rows-written total lands: `read-metrics.ts` wraps `SqlStorage` once in the Relay
constructor, so every cursor's `rowsWritten` accumulates without any query being
instrumented by hand, and `insertEventRow` folds the running total into the
bucket UPDATE it was already issuing. Measuring what the relay writes therefore
costs nothing on the path that dominates the budget. Only writes with no bucket
of their own — cron ticks, the follow rebuild, NIP-86 calls — pay a row to land
their total (`storage.ts settleRowsWritten`), on the order of thirty a day.

A wrapper rather than per-path reporting, deliberately: a path that must remember
to report is a path that will eventually forget, and nothing catches it. This
codebase has that history — `BACKFILL_PAGE_SIZE` was hand-maintained and silently
wrong three times. The wrapper can mis-attribute an hour; it cannot be forgotten.

**Where the count lands is the correctness property.** The accumulator is
instance memory, and this relay wakes ~70 times per cron interval, so a flush on
a timer or one deferred to the next tick would lose roughly 98% of the count —
and lose more of it the quieter the relay is, which is the failure mode nobody
would notice. Every Durable Object entry point therefore lands its own total
before returning (`relay.ts metered`).

**Removals are accounted explicitly, on top of the wrapper.** `SqlStorageCursor`
reports index maintenance on INSERT but not on DELETE, so a wrapper-only figure
undercounts every removal, which is the wrong direction for a budget meter.
`deleteEventRow` adds `eventRemovalBudget` — the pessimistic figure the vanish
drain is already paced against — over what the cursor reported, accepting the
double-count of the portion the cursor did see. Leaning high is the call
`schema.ts` already made for the drain, and it is made here for the same reason.

Prediction and measurement stay separate. `eventRowCost` answers "what will this
cost" before doing it, which is what sizes backfill pages and paces the vanish
drain; the wrapper answers "what did we spend". Neither feeds the other —
`estimateRowsWrittenSince` survives as backfill's headroom guard alone, where
seeing only event writes is correct, since deletion traffic is bounded by its own
reserved share.

`schema.ts eventRowCost` derives this from `INDEXES` rather than restating it, so
adding an index updates the admin page, backfill's headroom guard and
`BACKFILL_PAGE_SIZE`'s sizing at once. `events.row_cost` stamps the figure at
insert time so `estimateRowsWrittenSince` can sum a column.

### Rows written, per NIP-29 membership change

Measured (`test/nip29-groups.test.ts`), at a 21-member list going to 22:

```
the kind-9000 itself      9 + 3 x 2 tags (`h`, `p`)                  15
group_members row         1 base + 1 PK index                         2
allowed_pubkeys row       1 base + 1 PK index                         2
removing the old 39002    22 tag rows + 1 event row + 3 counters      26
storing the new 39002     9 + 3 x 23 tags                             78
                                                                    ---
                                                                    123
```

The kind-39002 member list dominates, and it is **replaced in place, not
accumulated** — it is an addressable kind, so `storeEvent`'s addressable
branch removes the previous version keyed by (pubkey, kind, `d`). No
tombstone: a replacement is not a deletion. It grows at 3 rows per member
on the insert and 1 on the removal, so **~4 rows per member per membership
change on top of a fixed ~45**. A twenty-person group churns ~123 rows per
change; a two-hundred-person one would churn ~845. Against the 100,000/day
ceiling that is ~800 membership changes a day at twenty members and ~118 at
two hundred — which was written down as the number to look at before this
grew a self-service join path, since a join path is what turns "the owner
occasionally adds somebody" into a rate strangers choose. It has now grown
one, and the section below is that arithmetic.

The kind-39000 metadata and kind-39001 admin list are NOT in that figure:
neither changed, so neither was rewritten. Regenerating all three on every
membership change would have added ~60 rows to it for no change in content.
Re-adding a member who is already in the group costs 15 — the moderation
event, which is part of the group's canonical history, and nothing else.

### Rows written, per invite and per join

Measured (`test/nip29-invites.test.ts`), against the same 21-member list:

```
issuing an invite (kind 9009)
  the kind-9009 itself      9 + 3 x 1 indexed tag (`h`)                12
  group_invites row         1 base + 1 PK index                         2
  regeneration              nothing changed                             0
                                                                      ---
                                                                       14

redeeming one (kind 9021)
  the kind-9021 itself      NOT STORED                                  0
  spending the invite       1 row updated in place                      1
  group_members row         1 base + 1 PK index                         2
  allowed_pubkeys row       1 base + 1 PK index                         2
  removing the old 39002    22 tag rows + 1 event row + 3 counters      26
  storing the new 39002     9 + 3 x 23 tags                            78
                                                                      ---
                                                                      109
```

The kind-9009 costs 12 and not 15 because `code` is a multi-character tag
name and `event_tags` indexes single letters only — the code lives in the
event body, where a reader entitled to the group partition can see it and
no tag filter can be pointed at it.

A join is CHEAPER than the put-user it replaces (109 against 123): the 15
rows a kind-9000 spends on its own event row and tags become the 1 row the
invite spends marking itself spent, because the request is never stored.
The member list dominates either way, so the ~4 rows per member per
membership change holds unchanged. What is new is who chooses the rate, and
`MAX_OUTSTANDING_INVITES` is what bounds it: 64 live invites redeemed all at
once is ~7,000 rows, ~7% of the daily ceiling. A refused join writes **0**.

### Rows written, per push and per hour of a call

Measured (`test/push.test.ts`, and derived in `limits.ts`):

```
one message notification, however many devices it reaches
  the kind-9 itself           9 + 3 x 1 indexed tag (`h`)             12
  queueing it                 1 outbox row + 1 PK index                2
  scheduling the alarm        setAlarm                                 1
  clearing the outbox row     base + index                             2
                                                                     ---
                                                                      17

each further message inside the coalescing window
  the kind-9 itself                                                    12
  folding it into the queued row (1 row updated in place)                1
                                                                     ---
                                                                      13

registering a device (subscribepush)   1 base + 1 PK index              2
disposing of a 404/410 endpoint        base + index                     2
a successful push                      0, or 1 once a day per endpoint
a refused push                                                          0
```

The fan-out writes NOTHING per endpoint on the ordinary path, so a
notification reaching sixty devices costs the same 17 rows as one reaching
one. That is the second place the presence lesson had to be applied:
`push_subscriptions.last_ok_at` is the field reference/push.md asks for
("when it was last seen working"), and refreshing it on every successful
send would have been one row per device per notification — thousands a day
to maintain a column whose only conceivable reader is a sweep of
long-dead endpoints. It is refreshed at most once a day per endpoint
(`limits.ts PUSH_LAST_OK_INTERVAL_SECONDS`), which is far finer than that
reader would need, and the disposal that actually matters does not wait
for it at all: a 404 or 410 deletes the row on the spot.

What sixty devices costs is SUBREQUESTS, which is a different ceiling and
is bounded separately — see below.

Presence is the one that could have been ruinous and is not. hearth beats
every five seconds while somebody is in a call, so a stored beat would be
a row write every five seconds per participant:

```
ten people in a call, one hour, one write per beat        72,000 rows
ten people in a call, one hour, as written                   900 rows
```

That is 0.9% of the day's ceiling against 72% of it. The interval is
derived rather than chosen (`limits.ts PRESENCE_WRITE_INTERVAL_SECONDS`):
one percent of `DAILY_ROWS_WRITTEN_LIMIT` per hour, divided by a ten-person
reference call, is one write per 36 seconds, rounded UP to a whole
heartbeat because a write that would land between beats does not happen
until the next one — 8 beats, 40 seconds. `PRESENCE_STALE_SECONDS` then
falls out of that: a live row is refreshed on the first beat at or after
the interval, so it is never older than the interval plus one beat, and
45 seconds is therefore exactly the boundary between "has been beating all
along" and "arrived". Seven beats in eight cost nothing at all, answered
from the in-memory tier (`relay.ts presenceWrites`); the eighth costs one
read and one write.

The cost of that coarseness is stated where it is paid: the stored tier
resolves presence at 45 seconds rather than hearth's 13, so somebody whose
connection drops and comes back inside 45 seconds of an EVICTION is
treated as having been there all along and is not announced twice. That is
the right direction to be wrong in — a reconnect is not an arrival, and
announcing one would be a quieter version of the twelve-a-minute noise the
whole design exists to avoid. A deliberate `{"status":"leave"}` beat
clears the row, so leaving and coming straight back IS announced.

### Subrequests, which is the ceiling the fan-out actually hits

Rows are not what bounds a push. Workers Free allows **50 subrequests per
invocation** (developers.cloudflare.com/workers/platform/limits/, checked
2026-08-30) and every push is one outbound HTTPS request. Twenty members
with a phone, a laptop and a home-screen install each is sixty endpoints,
so a fan-out written inline inside the request that stored the message
starts failing at exactly the group size this was built for — and fails at
the fifty-first request rather than the first, which is a partial delivery
nobody notices rather than an error.

The bound, derived in `limits.ts`:

```
WORKER_SUBREQUEST_LIMIT                 50   platform, Workers Free
PUSH_SUBREQUEST_RESERVE                 10   left unspent
MAX_PUSHES_PER_TICK                     40   one alarm invocation
PUSH_MAX_TICKS                           4   invocations one notification may span
MAX_PUSH_ENDPOINTS_PER_NOTIFICATION    160   = 40 members at the 4-device cap
```

Endpoints past `MAX_PUSHES_PER_TICK` are DEFERRED, not dropped: the outbox
row carries a cursor (ordered by endpoint, which survives a subscription
being added or removed mid-fan-out where a rowid offset would not) and the
alarm reschedules itself immediately. Endpoints past
`MAX_PUSH_ENDPOINTS_PER_NOTIFICATION` ARE dropped, and dropped loudly — a
`console.warn` naming the reason and the count, because a notification is
news, news goes stale, and a queue that stopped quietly would be
indistinguishable from one that finished. Raising the ceiling means
raising `PUSH_MAX_TICKS` and accepting the extra staleness, which is a
decision with a cost rather than a number to nudge.

### Rows written, per swept conversation

Measured (`test/ephemeral-chat.test.ts`), for a kind-9 carrying its one
`h` tag:

```
storing one chat message      9 base + 3 x 1 tag                     12
removing it again
  the `h` tag row                                                     1
  the event row                                                       1
  the three maintained counters                                       3
  a tombstone                                          deliberately   0
                                                                    ---
                                                                      5
one sweep's checkpoint, however many messages it removed               1
```

**Five rows to remove a message, against twelve to store it**, and that
asymmetry is why this path has no daily share of the ceiling. Backfill and
the vanish drain are paced against a share of the day because their volume
is chosen by somebody else — a stranger's request, a relay list of unknown
size. Every message this sweep removes was written by this relay first, and
writing one costs more than removing it does, so a day's sweeping can never
exceed a day's chat ingest and a day's chat ingest is already inside the
ceiling or the relay had a larger problem. A conversation of three hundred
messages costs **~1,500 rows to remove, 1.5% of the day**, having cost
~3,600 to store.

What IS needed is a per-tick ceiling, so a large accumulated backlog — the
first live sweep after an observation period, most obviously — drains
across ticks rather than being attempted at once. `CHAT_SWEEP_BATCH_SIZE`
is five percent of the day per tick, which at the charged cost of a
two-tag message is **250 messages**: an ordinary evening clears in one or
two ticks, a backlog drains at 6,000 a day, and `chat_state.swept_through`
carries the remainder exactly as `drainVanish` does.

The occupancy watermark costs one row per
`CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS` while the room is occupied — 192
rows a day with somebody in the room around the clock, 0.2% of the
ceiling. A room standing empty with an unread note in it costs **zero**:
the sweep finds a cutoff it has already drained and returns before the
COUNT and before any write. With no ceiling on a note, that is not a rare
state — it is where an unread note lives.

### Rows read, by path

| Path | Rows read |
|---|---|
| REQ filter, `ids` | 1 per id, × combinations |
| Group exclusion, any filter | 0 — it is a partition seek, not a post-filter |
| REQ filter, reader authorised for the group | × 2, one query per partition |
| Any `events` lookup that names no partition | the whole table — see below |
| REQ filter, `#<letter>` tag | ~2 per matching tag row |
| REQ filter served by an index | combinations × (2 × limit + 1) |
| Gift wrap exclusion, tag-driven filter | 0 — bounded by the tag subquery's own LIMIT |
| Gift wrap exclusion, `authors`-pinned filter with no `kinds` | up to the wraps that author holds, ≤ `maxGiftWraps` |
| `estimateRowsWrittenSince` (backfill's headroom guard only) | bounded by today's ingest count, not E (`idx_events_ingested`) |
| `totalEvents` + `followCount` (`readMaintainedCounts`) | 1 for the pair, maintained |
| `events24h` (`countEvents24h`) | ≤ 26 bucket rows, maintained |
| `ingested24h` + `rowsWrittenToday` (`readIngestCounts`) | ≤ 25 bucket rows for the pair, one statement, maintained |
| `followsListAt` | 1 |
| `/api/stats`, any request | ~10 measured, ≤ ~61 bounded; independent of E, F and of the ingest window |
| `auditMaintainedCounts`, once a day | E + F + M + ≤ 51 bucket rows (one scan of `events`, one of `follows`, one of `group_members`) |
| Backfill tick | bounded by today's ingest count (headroom check) + ~2 per event in the page |
| Live write, regular kind | 0–2, plus 3 for the counter updates |
| Presence beat, inside the write interval | 0 — answered from memory, seven beats in eight |
| Presence beat, outside it | 1 for the stored watermark |
| Push fan-out, per alarm tick | 1–2 outbox rows + ≤ `MAX_PUSHES_PER_TICK` subscription rows + 1 per distinct recipient pubkey |
| Push fan-out, no VAPID key | 0 — `vapidKeys` returns before any storage access |
| Replaceable/addressable replacement | ~2 per tag on the replaced event |
| NIP-62 vanish, per event removed | ~2 per tag on that event |
| `giftWrapCount`, per gift wrap accepted | ~0 |
| NIP-29 moderation event | ~3 for the relay's own group state, + the regeneration's own |
| Group write, non-owner | 1 for the membership lookup |
| Group chat write, sweep armed | + 1 for `chat_state` (the replay gate) |
| REQ by a group reader, sweep armed | + 1 for `chat_state` (the horizon) |
| Chat sweep, room in use or already drained | 1 — the state row, then it returns |
| Chat sweep, a conversation to remove | 1 + one index entry per eligible message |
| Occupancy sample, inside the write interval | 0 — one integer comparison, no socket walk |
| REQ, authenticated non-owner | 1 for the membership lookup the read gate runs — 0 if the pubkey is not a member (the seek lands between index entries) |
| REQ, unauthenticated | 0 — both the owner lookup and the membership lookup sit behind `authedPubkey !== undefined` |
| Join request, refused | 1–3 — the owner, the membership, and the invite row if it got that far |
| Join request, accepted | the above + ~3 for the regeneration |
| Cron refreshes | ~7 + 2F |
| WebSocket connect | 1–2 |
| NIP-11 document / NIP-98 owner lookup | 2 |
| `initSchema`, per Durable Object constructor, schema hash matches | 1 |
| `initSchema`, per Durable Object constructor, schema hash mismatch | ~66 |

F is the follow count and M the group's member count. `initSchema` runs in the constructor, so it is paid per
wake from hibernation, not once per deploy — which is why the row above is
split in two. It used to reconcile the full `TABLES`/`INDEXES` declaration
unconditionally on every wake: measured live, 55 rows read/wake, ~94,000
rows/day at the relay's wake rate, to redeclare a schema that had not changed
since the wake before. It now instead compares one stored row — a hash of
the declaration (`schema.ts computeSchemaHash`) against the hash the
database was last reconciled to (`schema_meta`) — and only runs the reconcile
pass on a mismatch: a real schema change, or the first wake after upgrading
to this. The hash is derived from every field `reconcileColumns` and
`createIndexSql` act on, not hand-maintained, so a changed column or index
cannot silently skip its own migration; and it is written only after the
reconcile completes without throwing, so a migration that dies partway
leaves the previous hash in place for the next wake to retry rather than
being mistaken for one that finished. See the header comment on `initSchema`
in [src/schema.ts](src/schema.ts).

The partition is what makes the group exclusion affordable, and it imposes a
rule: SQLite uses a partial index only for a query whose `WHERE` implies the
index's predicate, so **every query against `events`/`event_tags` names a
partition** or reads the table. Measured at 50,000 group events, `SELECT id
FROM events WHERE pubkey = ? AND kind = ?`: 2 rows pinned, 2 rows run once per
partition (`storage.ts acrossScopes`), **51,500** with no pin. A post-filter
instead of a partition would have cost 1,090 rows on a
`{"kinds":[1],"limit":20}` priced at 41, and 26,050 at limit 500 — one REQ
frame over the whole per-REQ cap, invisible to `boundFilter`. Nothing an
unauthenticated client can reach costs more than it did before the partition
existed; an authorised reader (two queries, one per partition) costs at most
2×. See `src/groups.ts` and `schema.ts INDEXES` for the reasoning behind
partial pairs over a widened index, which took the owner's own gift wrap read
from 601 rows to 204,701.

`combinations` is the number of queries `filters.ts expandFilter` runs for a
filter — its `authors` × `kinds` cross-product. The `2` is the index entry plus
the table row it points at. It multiplies **every** access path, the primary key
included: the expansion happens before storage sees the filter, so each expanded
query carries the whole of the rest of it, `id IN (...)` list and all.

### Where the read ceiling actually binds

Two paths used to scale with the accumulated table rather than with traffic,
getting worse as the relay filled whether or not anything else changed. Both
are closed now:

- **The cron floor.** The hourly tick called `estimateRowsWrittenSince` twice
  with no index behind `ingested_at`, so `2E × 24 = 48E` rows/day were spent
  with no client connected at all, reaching 5,000,000 at **E ≈ 104,000**.
  `idx_events_ingested` closed it in v0.7.6 — see that index's own comment in
  [src/schema.ts](src/schema.ts).
- **Removing an event.** Replaceable replacement, NIP-09 deletion and NIP-62
  vanish each scanned `event_tags` in full because no index covered
  `event_id`, costing `5E` per removed event and binding at
  `E × R = 1,000,000`, sooner than the cron floor for any meaningful rate.
  `idx_event_tags_event` closed it in v0.7.3, and the reasoning on
  `deleteEventRow` in [src/storage.ts](src/storage.ts) is why that index is not
  optional: the vanish path that reaches it cannot be gated, throttled or
  revoked, so cost is the only control the relay has over it.

Rows **written** are now the binding side of a vanish, and no index helps there:
removing an event costs its tag rows, its own row and a tombstone.
That is why vanish requests are checkpointed and drained across cron ticks rather
than attempted inside the request — see `beginVanish`/`drainVanish`.

The `/api/stats` snapshot recompute used to be the last path that scaled with E
(~3E + 2F, gated to four refreshes a day behind `STATS_SNAPSHOT_MAX_AGE_MS` for
`12E`/day). **It is gone, and so is the snapshot.** `totalEvents` and
`followCount` are maintained counters in one `maintained_counts` row;
`events24h` is per-`created_at`-hour buckets in `event_hour_counts` summed over
at most 26 keys; `followsListAt` answers from `LIMIT 1`, since every row in
`follows` carries the same value; and `largestNonOwnerAuthor`, an E-row
`GROUP BY` answering a question nothing asked, was deleted. With nothing left
that walked a table, `stats_snapshot`, `STATS_SNAPSHOT_MAX_AGE_MS`,
`refreshStatsSnapshot` and its cron call were a mechanism rationing a cost that
no longer existed, and were removed together.

That is the general lesson, and it is why `limits.ts` records it where costs get
priced: a TTL over an expensive read bounds how often you pay it, not what it
costs, and it survives only as long as nobody makes the read cheap. Reach for the
counter first and the clock second. That lesson then got its second demonstration
one release later: `live_stats`, the five-minute cache over `ingested24h` and
`rowsWrittenToday`, went the same way when those two were bucketed by ingest hour.
**There is no cache on `/api/stats` at all, and no `liveAt` age, because nothing
on the document is stale.**

Buckets rather than a scalar because `events24h` is a **rolling** window: an
event leaves it by the clock moving, with nothing happening to the event, and no
single counter can express that. Keyed by `created_at` and never by
`ingested_at`, which is the whole subtlety — a backfilled note signed in 2021 and
stored this morning belongs in a 2021 bucket, and incrementing "the current hour"
on arrival would have made a backfill look like a posting spree, the mirror image
of the bug `ingested_at` exists to fix. The window is whole hours, so it spans
24–25h rather than exactly 24; it replaced a figure exact to the second and up to
six hours stale, so the number moved closer to the truth, not further.

The one path that still scales with E is `storage.ts auditMaintainedCounts`, and
it is deliberate: once a day the cron tick recounts `events` in a single scan —
producing the total, the `created_at` window, the `ingest_at` window and the
stamped cost in that window, four figures from one pass — and `follows` beside it,
and logs loudly if any counter disagrees. The rows-written check is a **floor**
rather than an equality: the bucket legitimately exceeds the cost of the events
still standing in it, since it also holds deletions, follow rebuilds and NIP-86
calls, but it can never fall below it, and below means the meter lost writes. **Detect only — it
never repairs.** A
counter that silently corrects itself erases the evidence of whatever broke it,
so the drift returns on the next occurrence and is swallowed again, and the only
symptom is a number quietly wrong between repairs. E + F once a day, against the
`12E + 8F`/day the snapshot spent assuming these same numbers, is a quarter of
the cost for an answer that is checked rather than assumed.

A maintained count is only correct if nothing can change the counted table
without passing the counter, and each holds structurally. For `events`:
`storage.ts insertEventRow` and `deleteEventRow` are the only two functions in
the codebase that write to it, the counter writes sit inside them rather than
beside their callers, and every removal path — replaceable replacement, NIP-09,
NIP-62 vanish, NIP-86 `banevent` — reaches them. `deleteEventRow` reads the row's
`created_at` itself rather than taking it from the caller, because `banEvent` can
be handed an id that was never stored and must not decrement a bucket for it — and
it reads `ingested_at` and `row_cost` in the same seek, for the ingest bucket and
the removal's rows-written estimate. For
`follows`: `ownership.ts refreshFollows` is the only function that writes it, and
the counter moves in each of its two write branches — the rebuild and the clear —
rather than at the function's exit, which two early returns on the common path
would otherwise skip. That a refresh finding an unchanged contact list writes zero
rows, counter included, is asserted in `test/follows.test.ts`.

The rest of `/api/stats` scaled with something else, and closing it took two
passes. `ingested24h` and `rowsWrittenToday` both seek `idx_events_ingested`, so
neither grows with E — but both read the ingest *window*, measured live at
853 + 344 rows, ~1,200 per request with the lookups beside them. `GET /api/stats`
is unauthenticated, so **~4,100 requests from anywhere took the whole 5,000,000
rows-read allowance for the rest of the UTC day**, at no cost to the caller — the
same shape as the gift wrap gate probe, an expensive read on the far side of no
gate.

The first pass moved both into a `live_stats` row on a five-minute clock, which
bounded the recompute rate at 288/day however many requests arrived:

```
flood floor = (86,400 / TTL) × 1.5D   (D = events ingested per day)
```

That bounded the request rate and not the cost, and the cost was the term that
grew: at D = 5,000 events/day — an ordinary backfill day — the 288 refreshes
alone were **~2,160,000 rows/day, ~43% of the read ceiling, spent whether or not
anybody loaded the page**.

The second pass removed it. Both figures are now `ingest_hour_counts`, one bucket
row per ingest hour carrying an event count and a rows-written total, read as **at
most 25 rows in one statement**. That table was named here as the next step, with
the caveat that these two were harder than `events24h`: `ingested24h` would want
its own bucket table, and `rowsWrittenToday` is a sum over a window that empties
at 00:00 UTC, which no per-event increment expresses. Both objections dissolved in
the same table — one bucket carries both figures, so the "third row per event" is
the same row as the second, and a UTC day boundary falls on a whole hour, so the
reset is a range start rather than something a counter has to express. It is
*more* exact than the sum it replaced at exactly the moment that matters, 00:01
UTC during a recovery, where the cached figure was two minutes old and describing
the wrong day.

Measured: **10 rows per load** (`test/read-cost.test.ts`), bounded at ~61 —
`maintained_counts`, ≤ 26 `event_hour_counts` rows, ≤ 25 `ingest_hour_counts`
rows and the fixed lookups beside them. The endpoint went from ~4,100 loads/day
before any cache, to ~387,000 with one plus a floor that grew with D, to ~82,000
with no cache and no floor at all. Keyed by ingest time and NOT sharing
`event_hour_counts`: the two tables are the same events viewed through the two
clocks `events.ingested_at` exists to keep apart, and merging them would undo
exactly the distinction that column was added to make.

Traffic-driven paths are bounded by `limits.ts boundFilter`, which admits a REQ
filter only at a limit some index can afford, and by the per-IP message throttle
in `relay.ts`.

Four quantities bound one REQ, and they are four because pricing alone bounds
none of the other three:

- **Rows read per REQ** — `MAX_FILTER_ROWS_READ`, 10,000, divided equally
  among the frame's filters and passed to `boundFilter` as a budget.
  `filterReadCost`
  prices the cheapest access path, and the `ids` path was priced as though the
  filter ran once. It runs `combinations` times: `{"ids":[<one id>],
  "authors":[<5,000 keys>]}` priced at 1 row and read 5,000, while the identical
  filter *without* the id priced at 5,005,000 and was refused at any limit. One
  64-hex string turned a refused filter into a free one. The price is now
  `combinations × ids.length`.
- **Queries per filter** — `MAX_FILTER_COMBINATIONS`, derived as
  `MAX_FILTER_ROWS_READ / (ROWS_READ_PER_MATCH + 1)` = 3,333, which is the bound
  the index path already implied at a limit of 1. Capped *independently* of the
  price, because statements cost CPU whether or not they read rows: those 5,000
  seeks were 71ms of Durable Object time, and no lowered limit removes one of
  them.
- **Filters per REQ** — `MAX_FILTERS_PER_REQ`, 10. `MAX_FILTER_ROWS_READ` was
  enforced per filter while its comment read as a per-message bound; a REQ
  frame carried as many filters as fit, each admitted at the full cap, while
  the per-IP throttle counted the frame once. Measured before the cap: a REQ
  carrying 200 filters was answered with EOSE, and ~540 fit in the 16KiB the
  connection state holds — one frame able to ask for the whole day's rows-read
  allowance. This cap bounds the statement count and keeps the per-filter share
  from thinning to uselessness; the *rows* are bounded by the shared budget
  above.
- **Bound parameters per query** — `MAX_QUERY_BOUND_PARAMS`, 90, checked
  against `filterParamCount` before the halving loop, for the same reason
  `MAX_FILTER_COMBINATIONS` is: rows-read pricing bounds neither `ids.length`
  nor a `#<letter>` tag's value count, and a lowered `limit` shrinks neither
  either. A live deployment hit this directly — `{"ids":[<enough ids>]}` with
  no `authors`/`kinds` priced at one row per id, so it passed
  `MAX_FILTER_ROWS_READ` two orders of magnitude before it reached SQLite's
  own 100-bound-parameter ceiling, and the resulting `SQLITE_ERROR` was
  uncaught. See below for the platform limit it bounds.

What none of this bounds is spend over TIME, and it is worth stating rather
than leaving to be rediscovered. The per-IP message throttle
(`relay.ts RATE_LIMIT_MAX_MESSAGES`: 50 per 10s) permits 5 REQs/second, and at
the per-REQ cap that is **50,000 rows/second — the 5,000,000 daily ceiling in
100 seconds from one address**. That was true before these caps and is true
after; they bound what one message costs, not what a connection costs. Closing
it needs a per-connection or per-IP rows-read budget, which this relay does not
have.

A fourth bound is not a budget cap but a platform one. Subscriptions live in the
WebSocket attachment so they survive hibernation, and `serializeAttachment`
throws above 16KiB. Nothing checked it, so an ordinary
`{"authors":[<400 keys>],"kinds":[1]}` — ~26KB serialized, admitted by every cap
above — ran its query, sent its events, and then took an uncaught exception in
place of the EOSE. `MAX_CONN_STATE_BYTES` checks the *would-be* state before
storing it, so an oversized REQ is refused with `CLOSED` and leaves the
subscriptions it could not join intact.

A fifth bound is the same kind: a platform ceiling rather than a budget cap.
Cloudflare's SQLite-backed Durable Object storage refuses any single query
bound with more than 100 parameters
(developers.cloudflare.com/durable-objects/platform/limits/, checked
2026-08-28), and nothing checked it either, on the read path this time rather
than the storage path. `filterReadCost` prices `ids.length` and a tag's value
count by rows read, which is a different quantity from how many `?`
placeholders `buildFilterQuery` binds into one `exec()` call — an `ids`
filter with no `authors`/`kinds` prices at one row per id, so a filter naming
enough ids passed `MAX_FILTER_ROWS_READ` while its parameter count blew past
SQLite's own ceiling. Measured on the live relay: `"too many SQL variables
at offset 517: SQLITE_ERROR"`, uncaught, in place of a clean refusal.
`MAX_QUERY_BOUND_PARAMS` (`limits.ts`, 90 — a margin below the real 100 for
the same reason `MAX_CONN_STATE_BYTES` sits below 16KiB) checks
`filterParamCount`'s count before the query is ever built, refused with
`CLOSED` alongside every other read-abuse rejection above.

### The HTTP side

That message throttle covers WebSocket messages only — it starts counting once
a connection exists, so it never saw a connect-and-drop loop at all, and it saw
no HTTP request of any kind. For most of this project's life **nothing
rate-limited the HTTP endpoints**, and each was defended by its per-request cost
alone against callers who pay nothing per request. Cloudflare's Rate Limiting
binding now bounds them
per IP, declared in `wrangler.jsonc` and applied in `index.ts` (`rateLimited`):
60/minute shared across every HTTP path that wakes the Durable Object, and
10/minute for `/api/profile` alone. It runs in the runtime before the Worker's
code, so a refused request never reaches the object at all — which is the whole
reason for choosing it over a counter of our own, since the only two places such
a counter could live are DO storage (a row write per request, to measure a
request) or isolate memory (which a flood evicts). Static assets are outside it:
they never touch the DO and are free and unmetered.

The per-request cost of each HTTP path, after the pass that added it:

| Path | Reaches the DO? | Outbound? | Rows read | Per-IP limit |
|---|---|---|---|---|
| `GET /` and other static assets | no | no | 0 | none — free and unmetered |
| `GET /api/stats`, live cache warm | yes | no | ~10–36 | 60/min |
| `GET /api/stats`, live cache stale | yes | no | ~2 × today's ingest | 60/min |
| `POST /api/claim`, `OWNER_PUBKEY` set | **no** | **no** | 0 | 60/min |
| `POST /api/claim`, malformed pubkey | no | no | 0 | 60/min |
| `POST /api/claim`, already claimed | yes | **no** | 1–2 | 60/min |
| `POST /api/claim`, unclaimed | yes | 2 sockets, cached | 3–4 | 60/min |
| `GET /api/profile`, claimed | yes | **no** | 1–2 | 10/min |
| `GET /api/profile`, malformed pubkey | no | no | 0 | 10/min |
| `GET /api/profile`, unclaimed, cache hit | yes | no | 1–2 | 10/min |
| `GET /api/profile`, unclaimed, cache miss | yes | 2 sockets | 1–2 | 10/min |
| NIP-11 document | yes | no | 2 | 60/min |
| `OPTIONS` any path (CORS preflight) | **no** | no | 0 | none — reaches no DO |
| `POST /` (NIP-86), auth fails | **no** | no | 0 | 60/min |
| `POST /` (NIP-86), signature valid, not the owner | yes | no | 2 | 60/min |
| `POST /` (NIP-86), authorized | yes | no | 2 + the method's own | 60/min |
| WebSocket upgrade | yes | no | 1–2 | 60/min |
| Rate-limited, any path | no | no | 0 | — |

Four of those rows are the pass itself. `POST /` used to fetch the owner from
the DO *before* looking at the Authorization header, so a POST carrying nothing
but the management content type still woke the object and spent one of the day's
100,000 requests — the same shape as the gift wrap gate probe, an expensive
operation on the far side of no gate. `nip98.ts verifyNip98` no longer knows who
the owner is; `index.ts` asks the DO only once a valid schnorr signature over
this exact request exists. The schnorr verify moving ahead of the owner
comparison inverts that file's old ordering note, and deliberately: the
comparison came first because it was free, and it is not free any more —
obtaining the owner is what costs. ~1.1ms of Worker CPU out of 10ms is the
cheaper of the two.

`POST /api/claim` is the third, and it was the same defect wearing different
clothes: it resolved the pubkey's kind-0 over two outbound WebSockets *before*
anything had established the claim could succeed, so a relay that was going to
answer "already claimed" made two connections on a stranger's behalf to say so —
and unlike the claim itself, that stayed reachable forever. The checks that can
refuse now all run first, in `claim()`'s own order rather than in cost order, so
the status does not depend on which side of the RPC boundary answered.
`claim()` is still the authority: the Durable Object is single-threaded, and the
check-then-write inside it is what actually makes TOFU atomic.

`GET /api/profile` is the last. It is the claim form's courtesy profile preview
and nothing else — a typo guard for a one-time, irreversible setup step — and it
was permanently open, unauthenticated, uncached, and opening two outbound
WebSockets to `relay.damus.io` and `nos.lol` per request. That is worse than an
expensive read, because the cost lands on infrastructure that is not ours and
that this relay depends on: a flood pointed at it made this deployment an
amplifier toward the same two relays backfill and the claim-time lookup use, and
getting throttled or blocked by them for a stranger's traffic is a failure the
relay cannot fix from its own side. It cannot be authenticated — during a TOFU
claim there is by definition no owner to authenticate against — so the available
scope is time rather than identity: it answers while the relay is unclaimed and
404s the moment it is not, which is the same window the claim form is rendered
in. On a claimed relay, which is every relay for all but the first few minutes
of its life, the path no longer reaches the network at all. The kind-0 cache
(`profile-lookup.ts lookupProfileCached`, five minutes, negative results
included, concurrent lookups for one pubkey coalesced) is what keeps even that
window from amplifying. In-isolate rather than `caches.default`, because the
Cache API needs a custom domain and bothy's premise is a one-click deploy that
lands on `workers.dev`.

## Threat model

Reads are public by design and writes are owner-gated, so the two halves are
defended differently. What follows is what the relay actually does, and — more
usefully — what it structurally cannot do.

### What it defends against

- **Unauthorized writes.** TOFU ownership binds one pubkey permanently; every
  event is signature-verified regardless of who sent it. `ALLOW_FOLLOWS` widens
  writes to the owner's kind-3 list and nothing else. NIP-86 `banpubkey` and
  `allowpubkey` adjust that set by hand.
- **Read abuse.** `limits.ts boundFilter` admits a REQ filter only at a limit
  some index can afford, so no filter can scan the table — at a price that now
  includes the query count on every access path, and under a separate cap on
  that count, since statements cost CPU that rows-read pricing cannot see. Plus
  a cap on filters per REQ, a per-connection subscription cap, a bound on the
  connection state a subscription may hold open, a cap on how many SQL bound
  parameters one filter's query may need, and a per-IP message throttle. On the HTTP
  side, Cloudflare's Rate Limiting binding bounds every path that wakes the
  Durable Object, per IP, before the Worker's code runs; underneath it
  `/api/stats` is still defended by cost. **Every figure it reports is maintained
  rather than computed**, so no request walks a table, reads a window, or misses
  a cache — there is no cache left, and a load costs ~10 rows.
- **Being made into an amplifier.** `/api/profile` is the only path whose cost
  lands on somebody else's infrastructure — two outbound WebSockets to
  well-known relays per uncached miss. It is scoped to the pre-claim window,
  cached, and rate limited at a sixth of everything else.
- **Write abuse from an authorized writer.** `MAX_EVENT_BYTES` bounds the
  permanent damage one event can do; a per-pubkey rate limit bounds how fast;
  `NON_OWNER_STORAGE_BYTES` reserves half the 5GB ceiling for the owner. Gift
  wraps carry their own count cap and per-IP throttle on top.
- **Group disclosure.** Events carrying an `h` tag — and the
  relay-generated 39000-series, which carries a `d` tag instead and so
  had to be recognised by kind, the admin and member lists being exactly
  what a private group must not publish — live in their own
  partition of `events` and are omitted from every unauthenticated read, on
  all four surfaces that reach one: REQ results, the push to already-open
  subscriptions, the `/live` feed, and the public counters on `/api/stats`.
  A filter naming a group is refused from the filter alone; one that does
  not is answered with the rows omitted, so the answer does not depend on
  what the group holds. The exclusion is a partition seek rather than a
  post-filter, so it costs nothing and no filter can be shaped to read past
  it. Who gets past it is the owner or a member, checked against the same
  `group_members` list the write gate uses — one indexed row, paid only by
  a client that has completed AUTH and is not the owner.
- **Invite codes, from the members of the group holding them.** A kind-9009
  create-invite carries its code in a `code` tag and lives in the group
  partition, so widening group reads to members would have handed every
  member every unused code — and a code is a bearer token, so reading one
  is as good as being handed it. Members would have been able to mint
  memberships, and owner-only invites would have stopped being owner-only
  with no line of the write path changing. kind-9009 is therefore
  owner-only INSIDE a partition members otherwise read in full
  (`filters.ts excludeInvites`, and `broadcast()` for the push, since a
  code reaches a standing `{"kinds":[9009]}` subscription the moment the
  owner publishes one). Withheld by omission and never by refusal, which
  is where it parts company with the partition around it: the only reader
  entitled to a 9009 is the owner, so refusing everyone else would put a
  new signal on the unauthenticated path, where `{"kinds":[9009]}` is
  answered with a plain EOSE. Not even the COUNT is readable — the rows
  are gone before the `LIMIT` applies, for the reason gift wrap omission
  happens in SQL and never in memory.
- **Injection INTO the group, by the paths that skip both write gates.**
  A kind-1059 gift wrap carrying an `h` tag used to land in the group
  partition without passing `authorizeGroupWrite` at all, since gift
  wraps are dispatched above both gates and `storeEvent` partitions on
  the tag alone. It was documented as harmless on the grounds that it
  wrote INTO the partition rather than out of it, which described the
  wrong audience: an authenticated reader of that partition receives the
  injected event, so it was unauthenticated injection into a private
  group's feed, bounded by nothing but the gift wrap caps. Now refused
  outright — a wrap addressed by `p` tag to one recipient has no
  meaningful use for a group tag, so there was no legitimate case to
  preserve — and refused by `isGroupEvent`, the same predicate the
  partition uses, so the two cannot drift into a rule that refuses one
  shape while the partition catches another. The other two gate-skipping
  paths store no event at all (NIP-62 vanish, kind-9021 join), which is
  why neither has the equivalent hole.
- **Invite abuse.** An invite code is a bearer token this relay cannot
  authenticate, so it is bounded on four axes at once: single use, a
  mandatory expiry, a length floor, and a per-IP throttle on join
  requests. Every refusal is identical on the wire, so the refusal cannot
  be used as an oracle for testing guesses, and the schnorr verify runs
  ahead of the invite lookup so a junk signature cannot be used as one
  either.
- **Gift wrap disclosure.** Reads of kind-1059 require NIP-42 AUTH as the
  p-tagged recipient. A filter naming 1059 is refused from `kinds` alone; a
  filter that names no kinds is served with the wraps omitted. The gate
  answers the same way whether or not the inbox holds anything, which the
  storage probe it replaced could not — that probe's refusal was a one-bit
  read of the owner's inbox per REQ, bisectable into exact arrival times and
  an exact count.
- **A push telling somebody something the room did not.** A payload
  carries the room's name and the word `message` or `voice`, and nothing
  else — not the message, not the sender's name. It passes through
  Apple's or Google's infrastructure to reach a phone, so the rule is that
  nothing in it may be anything that infrastructure should not hold; the
  room name is admissible only because it is already the NIP-11 `name`
  any client fetches unauthenticated. The payload is also RFC 8291
  encrypted to the subscription's own keys, which the push service does
  not have, so this is belt as well as braces — but the rule is about
  what is put in, not about what the encryption hides.
- **A device registered against somebody else's name.** `subscribepush`
  binds the endpoint to the pubkey the NIP-98 signature PROVED, and the
  request body has no field for a pubkey at all. `unsubscribepush` is
  scoped to the signer for the mirror-image reason: an endpoint is not a
  secret to anybody who has seen a fan-out, and quietly turning somebody's
  notifications off is a subtler kind of damage than turning them on.
  Widening the management gate to members is scoped to exactly these two
  methods (`nip86.ts MEMBER_CALLABLE_METHODS`), checked in that order —
  the method name first, because it is free, and membership second,
  because it costs a round trip — so a stranger's signature over
  `banpubkey` still costs what it did before push existed.
- **A conversation outliving itself.** The group's kind-9 chat is removed
  once the room has been empty for `CONVERSATION_IDLE_SECONDS`, by a
  partition seek rather than a scan, and a member holding their own signed
  copy cannot put it back: `nip29.ts authorizeGroupWrite` refuses a chat
  message at or before `chat_state.swept_through`, which is what stands in
  for the tombstone this path deliberately does not write. What is
  removed is scoped to one kind in one partition — the owner's own notes,
  backfilled history, gift wraps, reactions, the relay-generated
  39000-series and the moderation events that produced it are all
  untouched, and `test/ephemeral-chat.test.ts` asserts each of them
  surviving a sweep that takes the chat beside them.
- **Replay of deleted events.** `deleted_ids` tombstones every id removed by
  NIP-09, NIP-62 or `banevent`, so a sender holding a signed copy cannot put it
  back.
- **Self-inflicted lockout.** An event dated far in the future would freeze a
  replaceable kind permanently — including the kind-3 that gates writes — so
  `MAX_CREATED_AT_FUTURE_SECONDS` refuses it.
- **Connection-level abuse.** NIP-86 `blockip`, checked once per WebSocket
  connection and never on the management endpoint, so blocking your own address
  cannot lock you out of the API that unblocks it.

### What it structurally cannot defend against

- **NIP-62 vanish.** The spec binds write-restricted relays to honour a vanish
  "regardless of the user's status", so the path is dispatched before the write
  gate and pays none of the abuse caps. It cannot be gated, it cannot be
  throttled below "eventually completes", and it cannot be revoked — `banpubkey`
  and unfollowing both act through `isAllowedWriter`, which this path never
  calls, so an ex-follow keeps both their stored events and the ability to
  trigger it. Cost is the only available control, which is why
  `idx_event_tags_event` exists, why the drain is checkpointed, and why the
  path now pays two reads before its first write: `hasVanishTargets` (a vanish
  over an empty set is complete when it is asked, and used to cost 4 rows
  written to record and immediately forget) and `pendingVanishCutoff` (a signed
  vanish is replayable forever by anyone who has seen it, and each replay used
  to re-checkpoint and take another drain batch). What cannot be gated is
  *honouring* the request; paying rows to honour one with nothing to do is not
  the same thing. `/api/stats` reports how many are still draining — a count,
  a progress total and an age, never the pubkeys: the endpoint is public and
  unauthenticated, and itemising the rows published exactly which identities
  had asked this relay to erase them.
- **Coarse channels around the group counters.** `/api/stats` publishes only
  the public half of every count, but `storageBytes` grows with every stored
  event whatever partition it is in, `rowsWrittenToday` is deliberately whole
  (it is the owner's budget meter, and a budget figure that under-reports the
  day's spend is worse than one that leaks traffic shape), and the `reads`
  diagnostic moves with group REQs. All three are coarser than a per-event
  counter and all three remain.
- **Which group a member reads.** Membership is one relay-wide list and
  the partition is id-agnostic, so a pubkey admitted to the group reads
  every `h`-tagged event this relay holds, whatever id it names. With one
  group that is a distinction without a difference; it stops being one the
  moment there are two, which is why "no more than one group" is in "What
  it refuses to be" rather than left as an implementation detail.
- **A member who was let into the group and not into the relay.** The two
  nested lists are two tables and two writes, and `nip29.ts applyModeration`
  is the only thing that writes both. If they come apart, the outer gate
  refuses the member's events with a message about follows that names no
  group at all — cause and effect with nothing connecting them.
  `storage.ts auditMaintainedCounts` checks the containment once a day and
  logs it, detect-only like everything else there: repairing it would mean
  that function granting relay write access on the strength of a row it has
  just decided it cannot trust. What it STORES in `last_drift` is a count,
  never the pubkeys — `/api/stats` reads that column back and is public.
- **What a push service learns.** Registering an endpoint tells this
  relay which devices a member has, and pushing to one tells Apple or
  Google that this deployment sent that device something, when. The
  payload is encrypted and says nothing, but the timing and the pairing
  are theirs by construction and no relay can prevent it. That is why
  push is something a person turns on rather than something a client does
  on their behalf, and why a relay that never advertises a `push_key`
  never learns any of it (reference/push.md "What it costs").
- **A duplicate presence notification after an eviction.** The stored
  watermark resolves presence at 45 seconds where hearth resolves it at
  13, so somebody who drops and returns across an eviction inside that
  window is not announced — correct — while somebody who genuinely leaves
  and returns just outside it is announced again. Both are the coarseness
  the write interval buys, and the alternative is a row write every five
  seconds per participant.
- **A push that never arrives.** A 429 or a 5xx from a push service
  leaves the row alone and the notification simply misses that device;
  there is no retry queue, because a retried notification is stale by the
  time it lands and a queue with no age bound is the thing
  `MAX_PUSH_ENDPOINTS_PER_NOTIFICATION` exists to prevent. The failure is
  logged, not swallowed.
- **Anyone reading anything that is not a gift wrap.** There is no read
  authentication and none is planned; a personal relay's contents are as public
  as the notes in it.
- **An invited member, once they are in.** Redeeming an invite writes the
  OUTER list as well as the inner one, because the outer list is what
  `isAllowedWriter` consults and a member without that row is a member
  whose events are refused. So handing somebody an invite link hands them
  relay-wide write access, not only group write access — bounded by the
  same caps every other writer pays, revocable the same two ways (kind-9001
  remove-user, NIP-86 `banpubkey`), and worth stating plainly because the
  link reads like an invitation to one room.
- **A tab left open overnight.** Occupancy is an open, authenticated,
  group-subscribed socket, and that is not merely the implementation but
  the best definition available to a relay: somebody sitting quietly with
  the room open is present — that is the case the cron sample exists to
  catch — and no signal reaching this object separates them from somebody
  who went home without closing anything. So a room holding two abandoned
  tabs never empties, its conversation never ends, and its chat
  accumulates for as long as that lasts. An earlier draft bounded this
  with a ceiling on how long any message could live; the ceiling was wrong
  for a different reason (it expired notes nobody had read yet) and its
  removal leaves this failure mode with nothing under it. It is the
  honest one to keep: the alternative is deleting a conversation out from
  under people the relay has every reason to believe are still in it.
- **A chat message that lies about its `created_at`.** The sweep and the
  horizon both measure `created_at`, because that is the column
  `idx_events_kind_created_grp` is keyed on and the only one that makes
  either a seek rather than a scan. A member can therefore date a message
  slightly forward to outlive its conversation by that much, bounded by
  `MAX_CREATED_AT_FUTURE_SECONDS`, or backward to have it swept early.
  Writers in the group partition are members by construction, a message
  lying about its timestamp is already misordered in every client that
  renders it, and the next conversation's cutoff collects it regardless.
- **A dangling reaction.** The sweep takes kind 9 and nothing else, so a
  kind-7 reaction to a swept message outlives the message it points at.
  Widening the scope past the group's talk is a larger decision than a
  tidy one, and `groups.ts GROUP_CHAT_KIND` is the single place it would
  be widened.
- **A compromised follow.** Follows are trusted with writes. The caps bound what
  one can cost, they do not prevent it, and the owner is expected to notice and
  revoke.
- **In-memory limits across eviction.** The per-IP, per-pubkey and gift wrap
  throttles are held in memory so they cost no rows to enforce. A Durable Object
  that hibernates loses them, so an attacker who paces themselves around
  eviction gets a fresh window. This is a deliberate trade, not an oversight.
- **The owner.** Nothing here defends the relay against its own owner, and the
  storage and rate caps deliberately exempt them.
- **Account-wide exhaustion.** The Cloudflare ceilings are per account, not per
  Worker. Another Worker in the same account can consume them, and when they are
  consumed every Durable Object path fails at once — see `src/exhaustion.ts`
  for how that is made visible rather than silent.

## Architecture map

- [src/index.ts](src/index.ts) — Worker entry: routing, `/api/*`, `scheduled()` cron dispatch.
- [src/relay.ts](src/relay.ts) — the `Relay` Durable Object: connection lifecycle, NIP-01 message handling, live feed, alarm.
- [src/relay-stub.ts](src/relay-stub.ts) — the one `idFromName("relay")` accessor, shared so nothing else can shard it.
- [src/storage.ts](src/storage.ts) / [src/schema.ts](src/schema.ts) — SQLite schema and all read/write queries, including the row-cost accounting. `storage.ts` states the partition rule once, above its first use, and every lookup below obeys it: pin `is_group` to one value, or run once per value; a lookup that names neither reads the whole table. `insertEventRow`/`deleteEventRow` stamp the partition onto the event row, its tag rows and both halves of every maintained counter, so "what an event is" and "what gets stored about it" stay the same lines of code. `events.ingested_at` is wall-clock write time and must never be conflated with `created_at`: rows-written accounting and backfill's headroom guard both measure `ingested_at`, because a backfilled event's `created_at` is years old and measuring that made backfill's own writes invisible to the guard restraining them. A column, not a counter table — a counter costs a row write per event, a column costs nothing. The same argument added `events.row_cost` in v0.7.2: each event's rows-written cost is stamped at insert time so `estimateRowsWrittenSince` sums a column instead of rebuilding the figure from a `LEFT JOIN event_tags` with no index behind it, which read every tag row in the table to answer a question about the 24h window. The same argument runs the other way for `maintained_counts`/`event_hour_counts`, which DO pay a row write per event: there the alternative was a read that grew without bound, so 2 fixed rows against an event already costing 6 to 21 is the cheaper side. See CLAUDE.md "The budget". `sweepChat`/`chatSweepCutoff`/`chatHorizon` are ephemeral group chat, and the whole of their state is one `chat_state` row: the sweep is a range over `idx_events_kind_created_grp`, so a conversation is two integers rather than a column on every message. They are the one removal path in this file that calls `deleteEventRow` rather than `deleteAndTombstone` deliberately — see "What it is".
- [src/filters.ts](src/filters.ts) — REQ filter parsing, SQL query building, in-memory match testing for live broadcast, `FilterQueryOptions.excludeGiftWraps` (the NIP-42 read gate, expressed as omission — see "What it is"), `FilterQueryOptions.excludeInvites` (the same shape one level in: kind-9009 create-invite is owner-only inside a partition members read, and unlike the gift wrap exclusion it is applied whatever the filter's `kinds` says, because a filter naming 9009 is answered by omission rather than refused), `FilterQueryOptions.scope`/`tagScanDivisor` (the group partition: every query this file builds pins `is_group`, tag subqueries included, and a reader entitled to both partitions runs the filter twice with the tag scan budget split between them rather than paid twice), and `expandFilter`, which splits one filter into the cross-product of its `authors` × `kinds` singletons. That split is what lets an index serve `ORDER BY created_at DESC LIMIT n`: a key column pinned to one value arrives sorted, `kind IN (1, 7)` does not, so a multi-kind filter defeats an index as thoroughly as no index at all. `storage.ts queryFilter` re-merges and re-slices to `limit`, so the split is invisible on the wire.
- [src/nostr.ts](src/nostr.ts) — wire types and kind-range classifiers (replaceable/ephemeral/addressable).
- [src/validate.ts](src/validate.ts) — event id computation and schnorr signature verification (`@noble/curves`).
- [src/ownership.ts](src/ownership.ts) — owner pubkey resolution, TOFU claim, follow-list cache, profile/icon refresh. `getOwnerPubkey` runs `OWNER_PUBKEY` through `normalizePubkey` like every other pubkey boundary in the project, memoised on the raw string because it sits on the write path. It did not, and returned the variable verbatim while every comparison target is lowercase hex — so an operator setting an npub (the form every client shows them) got a relay where the owner could not write, could not read their own gift wraps, and could not be addressed by one, silently. A malformed value now resolves to null, which reads as unclaimed and is visible; `index.ts` still gates `/api/claim` on the variable being *set*, so this fails closed rather than reopening TOFU.
- [src/relay-identity.ts](src/relay-identity.ts) — this relay's own signing keypair, distinct from the owner's pubkey and from `OWNER_PUBKEY`. NIP-29 requires 39000-series group metadata events to be "signed by the relay keypair directly," and `src/nip29.ts` is the only caller of `signAsRelay`. Generated once, at schema-init time (`schema.ts` `seedRelayIdentity`) rather than at claim — `claim()` is skipped entirely under `OWNER_PUBKEY` (`relay.ts`), and this identity has to exist under that mode too, the same reason `follows.fetched_at` lives off the `owner` table rather than on it. Exposed as `self` on the NIP-11 document (nips/11.md's own field for a relay identity independent of its administrator, and the one NIP-29 names) and `relayPubkey` on `/api/stats`, both always present since it doesn't depend on claim status; the secret key is read only by `signAsRelay`, which is handed a 32-byte hash and returns a signature, and never leaves that file.
- [src/groups.ts](src/groups.ts) — what makes an event a group event (an `h` tag on any kind, or a kind in the relay-generated 39000–39005 range, which names its group in `d` and would otherwise fall right through the `h` test), the id of the one group this relay hosts, the two scopes of the `is_group` partition, and `acrossScopes`, the once-per-partition form every lookup that is not about one partition in particular has to take. Also `filterNamesGroup`, which is what lets the read gate tell "this client asked for a group" from "this client asked for something the group happens to be in" without touching storage, and `CREATE_INVITE_KIND` — the one group kind the group's own members may not read, named here rather than in `nip29.ts` because the read gate is what needs it and `filters.ts → nip29.ts → limits.ts → filters.ts` is a cycle. `GROUP_CHAT_KIND` moved here from `push.ts` for the identical reason — the read gate has to clamp it to the chat horizon, and `filters.ts → push.ts → limits.ts → filters.ts` is the same cycle wearing a different hat — so the one kind that expires is named where both the read side and the sweep can reach it, and `push.ts` re-exports it.
- [src/host.ts](src/host.ts) — this deployment's own host, learned from request traffic; lets backfill skip self-seeding.
- [src/pubkey.ts](src/pubkey.ts) / [src/bech32.ts](src/bech32.ts) — npub/hex normalization.
- [src/profile-lookup.ts](src/profile-lookup.ts) — best-effort kind-0 lookup from well-known relays, runs in the Worker only, plus the isolate-local cache in front of it (`lookupProfileCached`). The cache is not `caches.default`: the Cache API needs a custom domain (developers.cloudflare.com/workers/runtime-apis/cache/, checked 2026-08-27) and bothy deploys to `workers.dev`, so it would silently no-op on the deployment shape this project exists for. Negative results are cached and concurrent lookups for one pubkey are coalesced — without both, the cache would miss on exactly the traffic it exists to absorb.
- [src/upstream-version.ts](src/upstream-version.ts) — the "a newer bothy exists" check behind `/api/stats`'s `latestVersion`/`updateAvailable`, plus the isolate-local cache in front of it, the same shape and for the same `caches.default`-needs-a-custom-domain reason as `profile-lookup.ts`. Runs in the Worker and never in the Durable Object: an outbound request from there costs duration and blocks hibernation, and this is a courtesy notice on an unauthenticated read path. Reads `version` out of upstream's `package.json` on `main` — the same field the running relay reports about itself (CLAUDE.md "Release step"), so the two sides of the comparison cannot drift — over raw.githubusercontent rather than api.github.com, whose 60/hour unauthenticated limit is keyed to an outbound IP this Worker shares with every other Worker in its colo. Failures are cached too, on a shorter TTL, and answer null; null is "no answer", never "up to date", and every consumer renders it as no notice at all. Costs zero rows written and zero rows read — nothing about it is stored. `UPDATE_CHECK=off` turns it off outright.
- [src/backfill.ts](src/backfill.ts) / [src/backfill-worker.ts](src/backfill-worker.ts) — backfill state machine (DO-side, pure) and outbound fetch orchestration (Worker-side).
- [src/limits.ts](src/limits.ts) — every numeric abuse/budget cap in the project, each commented with what it bounds. The presence block derives its write interval from hearth's own heartbeat period and this relay's rows-written ceiling rather than declaring one, and derives the staleness threshold from the interval, so the two cannot drift into a combination that reads a live participant as an arrival; the push block derives its per-tick bound from Workers Free's 50-subrequest ceiling and its per-notification bound from that. The invite block (`INVITE_DEFAULT_TTL_SECONDS`, `INVITE_MAX_TTL_SECONDS`, `MIN_INVITE_CODE_LENGTH`, `MAX_OUTSTANDING_INVITES`, `MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW`) is five caps around one word: a bearer token the relay cannot authenticate leaves only lifetime, count, guessability and guess rate to bound, and each constant is one of those. The three write-path caps (event size, per-pubkey rate, non-owner storage share) are enforced in `relay.ts acceptEvent` before id/signature verification, exempt the owner from two of the three, and are each raisable or disablable by env var — disabled only by the exact string `"off"`, never by any truthy value. Also `boundFilter`, the read-abuse guard: it prices a REQ filter (`combinations × (2 × limit + 1)` on an index path, `combinations × ids.length` on the primary key, where `combinations` comes from `expandFilter` itself) against the index set declared in `schema.ts`, clamps the limit until the query is affordable, and refuses what no limit can fix — plus `MAX_FILTER_COMBINATIONS`, which refuses on query count alone, ahead of the price, because a lowered limit removes rows and never statements, and `MAX_QUERY_BOUND_PARAMS`, which refuses on the number of `?` placeholders the query would bind, ahead of the price, because a lowered limit removes neither `ids.length` nor a tag's value count — the shape a live filter naming enough ids exploited to pass `MAX_FILTER_ROWS_READ` while still exceeding SQLite's own 100-bound-parameter ceiling and crashing with an uncaught `SQLITE_ERROR`. It replaced `isUnconstrainedFilter`, which asked whether a field was *present* rather than what the query *cost* and so admitted the two shapes that read the whole table. The chat block (`CONVERSATION_IDLE_SECONDS`, `CHAT_BACKLOG_SECONDS`, `MIN_ROOM_OCCUPANTS`, `CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS`, `CHAT_SWEEP_BATCH_SIZE`, `chatMode`) is one constant per rule, with the write interval derived from the idle window it has to resolve against rather than from a share of the budget — the opposite way round from the presence block above it, and stated as such, because presence is written per participant against a five-second beat while this is one row for the whole room. It also carries, at length, the constant that is NOT there: the ceiling on how long an undelivered note may wait, argued out of existence where a reader will come looking for it. The one cap NOT declared here is the HTTP rate limit: Cloudflare's runtime enforces it from `wrangler.jsonc` before any of this code runs, so a number here would be decorative and could silently disagree with the one in force — `limits.ts` carries the pointer and the reasoning instead.
- [src/exhaustion.ts](src/exhaustion.ts) — classifies a Cloudflare free-tier allowance being consumed and names which one; `index.ts` wraps both `fetch` and `scheduled` with it. Exists because the last outage's only symptom was an admin page that loaded the word "bothy" and no numbers — `public/` is served from `env.ASSETS` and never touches the DO, so the one part still working was the part that proved nothing. Matching is substring signatures against error text Cloudflare does not document as stable, so it fails useful rather than silent: the raw message is always logged, the resource name only added when a signature matches. Non-exhaustion errors are logged and rethrown, never converted into a quiet 503.
- [src/read-metrics.ts](src/read-metrics.ts) — **diagnostic, and expected to be removed**: in-memory attribution of rows *read* to the code path that caused them, surfaced as `reads` on `/api/stats`. Added after the live relay exhausted the 5,000,000 rows-read/day allowance under ordinary operation and nothing here could say which path spent it. Counters live in memory, never in storage — a counter costing a row write to measure a row read repeats the mistake CLAUDE.md "The budget" already rejected — so they reset on eviction and describe proportions, not daily totals. Every `SqlStorage` access in the DO goes through `instrumentSql`, so a query can be mislabelled into `unattributed` but never missed. See CLAUDE.md "The budget" for the per-call costs and the arithmetic against the ceiling.
- [src/nip11.ts](src/nip11.ts) — relay info document, and the name/description/icon resolution chain shared with `/api/stats`.
- [src/nip29.ts](src/nip29.ts) — group writes: the moderation events a client may send (`authorizeGroupWrite`, called by `relay.ts handleEventInner` under the relay-wide gate), and the 39000-series state this relay generates and signs in response (`applyModeration`, called by `acceptEvent` exactly where a kind-5 reaches `applyDeletion`, because the moderation event is itself part of the group's canonical history and is stored before it is acted on). Holds the two-nested-lists rule in full. Everything it writes goes through `storage.ts storeEvent` — the gate is what a relay-signed event skips, not the bookkeeping. Also `handleJoinRequest`, the kind-9021 admission path, which is the one function here reached by a pubkey the relay has never authorized: it stores nothing, refuses everything with one identical message (`JOIN_REFUSAL_MESSAGE` — four distinguishable refusals would be an oracle for testing guesses), and logs the real reason where only the owner can read it. `authorizeCreateInvite` beside it holds the kind-9009 policy, refusing rather than clamping, so a client is never told `true` about a lifetime the relay did not grant.
- [src/push.ts](src/push.ts) — web push: the VAPID keypair (one secret, public half derived), RFC 8291 aes128gcm encryption, RFC 8292 VAPID authorization, and one send. Written against `crypto.subtle` rather than a library, because every npm package for this is Node-shaped and none of it runs on workerd, while all four primitives are native here — see the header comment for what was checked and the one line `@noble` still does. Also names the two kinds worth a notification: NIP-29's kind-9 chat, and hearth's own kind-25051 call presence, which has no NIP. `sendPush` is the only outbound request this Durable Object ever makes, and it is made from the alarm; see CLAUDE.md "What it is" for why that does not break hibernation and why the Worker cannot do it instead.
- [src/nip86.ts](src/nip86.ts) — management API method dispatch (runs in the DO; touches storage, opens nothing).
- [src/nip98.ts](src/nip98.ts) — HTTP auth verification for the management API (runs in the Worker only). Deliberately does not know who the owner is: establishing that costs a Durable Object round trip, which is the most expensive thing an unauthenticated caller can provoke on this path, so `verifyNip98` answers only what the request itself can answer and `index.ts` asks the DO afterwards (`ownerReason`).
- [public/index.html](public/index.html) — the static admin page (claim form, stats, live feed).
- [scripts/sync-badge.mjs](scripts/sync-badge.mjs) — regenerates README.md's updater badge from `.github/workflows/sync.yml`, so the URL-encoded copy of the workflow in the README is derived rather than maintained. Outside `tsconfig`'s `include` and outside the deploy: a repo chore, not part of the Worker.

## Conventions

- TypeScript strict mode, no `any` in the event-handling path.
- `@noble/curves` + `@noble/hashes` only — no second crypto dependency.
- Protocol errors go back as `["OK", id, false, "reason: message"]` or `["CLOSED", subid, "reason: message"]` with the NIP-01 machine-readable prefix (`invalid:`, `restricted:`, `blocked:`, `rate-limited:`, `auth-required:`, `duplicate:`). Never fail silently.
- Comments explain *why*, especially anything hibernation- or budget-related — most modules carry inline notes on their row-write cost or CPU cost and point at CLAUDE.md "The budget" for the measured baseline.
- Cheapest/most-certain rejections run before expensive ones on every write path: ownership check and tombstone check both precede schnorr verification.
- Indexes are declared once, as data, in `schema.ts INDEXES`, and three things read that declaration: `limits.ts boundFilter` (which filters are affordable), `schema.ts eventRowCost` (what an event costs to write), and `limits.ts BACKFILL_PAGE_SIZE`/`VANISH_BATCH_SIZE` (how much work fits in a cron tick). Seven on `events` — `(pubkey, kind, created_at)`, `(kind, created_at)` and `(pubkey, created_at)`, each declared TWICE as a partial pair (`WHERE is_group = 0` / `= 1`), plus `(ingested_at)` covering `row_cost` — and three on `event_tags` — `(tag_name, tag_value, created_at)` as a partial pair, and `(event_id)`. A row satisfies one half of each pair, so a pair costs one row written per stored row, exactly what the single index it replaced cost; `eventRowCost` counts the halves separately and therefore over-charges, deliberately (see "The budget"). An index whose DEFINITION changes must change its NAME — `CREATE INDEX IF NOT EXISTS` will not redefine one and reports no error — and `initSchema` then drops whatever the declaration no longer carries. Adding another index therefore changes both the guard and the write accounting on its own; what it must NOT change silently is the measured baseline, so re-run `test/hibernation.test.ts`'s rows-written assertions and update the schema.ts comment and CLAUDE.md "The budget". Every accepted read filter must be answerable from one of these — that is enforced by cost, not by requiring a particular field.
- Verify Cloudflare's own platform limits against live docs before relying on a number in a file — they change between compatibility dates. CLAUDE.md "The budget" cites the source and date at each point of use rather than assuming a cached number still holds.
- Pin dependency versions; don't float to `latest` mid-project.
- Commit directly to `main`. Never create a branch, and never open a pull
  request — this repository has one contributor, and every branch created so
  far has ended up either a stale leftover or a deploy that silently didn't
  happen. Cloudflare builds from `main`; work on any other branch does not
  reach the relay.

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

1. **Protocol conformance** — NIP-01 REQ/EVENT/CLOSE/EOSE, filters, replaceable/addressable/ephemeral storage rules, NIP-09/40/42/59/62, and NIP-86/98 management. Reject paths are asserted as carefully as accept paths.
2. **Budget/hibernation regression** — [test/hibernation.test.ts](test/hibernation.test.ts) asserts the object becomes eligible to hibernate after the last message, and pins the per-event rows-written cost against a real `SqlStorageCursor.rowsWritten`; [test/nip29-groups.test.ts](test/nip29-groups.test.ts) pins the per-membership-change cost the same way; [test/read-cost.test.ts](test/read-cost.test.ts) pins rows read per query shape; [test/push.test.ts](test/push.test.ts) pins that twelve presence heartbeats write zero rows on the presence path and that one fan-out spends no more than one invocation's subrequest allowance. That last file also decrypts a real push body back to its payload rather than asserting the encryption's shape — RFC 8291 has several places where a wrong constant produces a body that is well-formed and undecryptable, and every one of them looks like success from inside the relay. [test/ephemeral-chat.test.ts](test/ephemeral-chat.test.ts) pins what it costs to sweep a conversation, and pins the two figures that make the absence of a daily share defensible: five rows to remove a message against twelve to store it, and zero for a tick that finds nothing to do. These assertions are the budget baseline — there is no separate file of recorded numbers to fall out of step with them.

See [docs/test-notes.md](docs/test-notes.md) for suite layout, fixture rationale, and the couple of places tests drop below the wire protocol to real storage (documented exceptions, not the norm).

## Release step

`package.json`'s `version` is the single source of truth, imported directly (`resolveJsonModule`) into NIP-11's `version` field and `/api/stats`, which the admin page displays. Never hardcode the version string elsewhere. Cutting a release means bumping `package.json`'s `version` to match the release tag — every release must do this, or the deployed relay reports the wrong version.

The version bumps whenever the deployed code differs from the last tag — full stop. Not "when the change is significant," not "when it's more than display": those judgment calls have already produced three builds reporting a version whose tag didn't contain them. If `main` has moved past the tag at all, the number moves.

Tags must be annotated (`git tag -a`), never lightweight (`git tag`). `git push` with `--follow-tags` — the form this project's push workflow uses — only pushes annotated tags; a lightweight one is silently skipped, so the tag exists locally, `git ls-remote --tags origin` shows nothing, and nobody notices until they go looking for a release that was never actually pushed. This happened to v0.7.9: `git tag` made a lightweight tag, the push skipped it, and by the time it was caught `main` had moved a commit past it (a docs-only commit, but the tag still has to name the commit that is actually deployed) — fixed by deleting the local tag and recreating it annotated at the right commit before pushing. Verify a tag actually reached the remote with `git ls-remote --tags origin <tag>` rather than trusting that the push succeeded.

## Attribution

MIT licensed, original implementation. See [README.md](README.md) "Attribution" for the full statement and the rule for any reference reading (Nosflare, khatru, haven, strfry): read to understand the protocol, never paste.
