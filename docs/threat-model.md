# Threat model

What the relay defends against and what it structurally cannot. Internal,
like [principles.md](principles.md); the costs referred to are in
[budget.md](budget.md).

Reads are public by design and writes are owner-gated, so the two halves are
defended differently. What follows is what the relay actually does, and — more
usefully — what it structurally cannot do.

## What it defends against

- **Unauthorized writes.** TOFU ownership binds one pubkey permanently; every
  event is signature-verified regardless of who sent it. The write policy
  (`write-policy.ts`) admits mail, the owner's kind-3 list, events that
  p-tag the owner (tag-capped), or everyone, by the owner's choice; `all`
  is bounded by the per-writer caps only and requires a confirmation string
  to set. NIP-86 `banpubkey` and `allowpubkey` apply under every policy.
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

## What it structurally cannot defend against

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
