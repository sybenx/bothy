# Decisions

Why bothy does what it does, one entry per choice. Internal, like
[principles.md](principles.md); reasoning is allowed here and nowhere
in CLAUDE.md, which describes. The measurements a decision was made
against are in [budget.md](budget.md); what it defends is in
[threat-model.md](threat-model.md). Where a code comment already holds
the argument, the entry here is the short form and the comment is the
canonical copy.

## Route order in the Worker

NIP-86 is matched on `Content-Type: application/nostr+json+rpc` before
NIP-11 is matched on `Accept: application/nostr+json`. That string
contains `application/nostr+json`, so checking NIP-11 first would
swallow every management call.

## The Durable Object opens no outbound connection

An outbound WebSocket pins the object in memory for as long as it stays
open, up to fifteen minutes, which defeats hibernation. So the Worker
owns every outbound connection on the object's behalf: the claim-time
profile lookup and the backfill fetches both live in the Worker.

The push fan-out in the object's alarm is not the exception it looks
like. An HTTPS request that completes does not pin the object, and an
alarm is a brief billed wake the platform schedules against a hibernated
object and lets hibernate again, exactly as the live feed's lifetime
alarm already does. There is also no Worker-side alternative: nothing in
the Worker runs when a WebSocket message arrives, and the hourly cron is
three orders of magnitude too slow for a notification.

## Write policy: cumulative names, resolved once per wake

The five levels are cumulative so the policy is a single value, and the
ordering is internal: nothing that reaches an owner shows a number or
the word "rung". `WRITE_POLICY` in the environment is for an operator
who configures in the dashboard and wants the policy pinned there, where
a stored value cannot quietly override it; the stored value is for the
owner changing it from a client without a redeploy; the default is
`follows`, which is what the relay has shipped with since writes opened
to the owner's contact list. `relay.ts` caches the resolved policy per
instance and clears it after every management call, so the one-row read
is paid once per wake and not once per event.

The follow cache is maintained under every policy, so switching to
`follows` takes effect on the next event rather than on the next cron
tick. `allowpubkey` admits and `banpubkey` refuses under every policy:
the allowlist is not a level, it is who writes regardless of the level.

`changewritepolicy all` needs a confirmation string because opening the
relay to everyone is the one policy change that is easy to type and hard
to notice the consequences of. Same shape as `blockip` on your own
address, and one confirmation, never two.

`exceedsMentionTagCap` applies under `mentions` and not under `all`.
That policy's stated bound is the per-writer caps and nothing else, and
an open relay that refused a stranger's kind-3 contact list, hundreds of
`p` tags and every one of them legitimate, would not be open.

## Gift wrap reads: omission, not refusal

The gate used to decide by probing storage: re-run the filter restricted
to kind 1059 and refuse if anything came back. That made the refusal
itself the answer. An unauthenticated
`{"#p":[owner],"since":S,"until":U,"limit":1}` said `auth-required`
when a wrap fell inside the window and `EOSE` when none did, so
bisecting since/until yielded exact arrival windows and an exact inbox
count without ever naming 1059. Refusal leaks; omission does not. So a
filter naming 1059 is refused from `f.kinds` alone, with no storage
access, and a filter that names no `kinds` is answered normally with
the kind-1059 rows dropped from the query, in SQL and never in memory
afterwards, because a client asking for 20 and receiving 8 has counted
the wraps in its own window.

## The group partition

Group events are held in a separate partition of `events`/`event_tags`
(`is_group`) and omitted from every unauthenticated read. Kind-agnostic,
because NIP-29 scopes a group by the `h` tag and not by a kind range: a
kind-1 note, a kind-7 reaction and a kind-30023 post are all group
events if they name a group.

The exclusion covers four surfaces, not one. REQ results; `broadcast()`,
because a subscription registered before an event arrives is never
re-examined by the REQ-time gate, which is why gift wraps gate there
separately too; `liveBroadcast()`, because the `/live` feed has no
authentication at all; and the public counters on `/api/stats`, because
polling `totalEvents` while holding a `/live` socket dates every arrival
to the second, the same shape the gift wrap review found.

Same omit-don't-refuse rule as gift wraps: a filter that names a group
(`{"#h":[...]}`) is refused from the filter alone, and a filter that
does not is answered normally with the group's rows omitted.

Reads are gated on the same `group_members` list the write side is gated
on. That was an asymmetry for two releases: a member could write to the
group and could not read it back, which made the group unusable by
anyone but the owner. Closing it needed the invite hole (below) closed
first, in that order, because widening a read gate over a partition
holding bearer tokens hands them out.

### The 39000-series hole

`isGroupEvent` tested the `h` tag, and NIP-29 puts the group id of the
relay-generated events in a `d` tag "instead of the `h` tag". So
kind-39001 (the admin list) and kind-39002 (the member list), the two
events that enumerate the group's membership in `p` tags, carried no
`h`, landed in the public partition, and were served to any
unauthenticated client that asked. The exclusion covered every event in
the group except the list of who was in it. Open for exactly one
release. `isGroupMetadataKind` closes it by kind, over the whole
39000–39005 range, and not by `d` tag: `d` is the generic addressable
identifier every kind in 30000–39999 carries, so it names a group only
in that range and cannot be the test. `filterNamesGroup` widens the same
way: a filter naming one of those kinds is refused from `kinds` alone,
while a filter naming only `#d` is answered by omission, since refusing
on `d` would refuse reads of unrelated addressable kinds that happen to
share an identifier.

### Partial index pairs, not a widened key column

The exclusion is a partition seek, not a post-filter. `is_group` is
carried as partial index pairs (`WHERE is_group = 0` / `= 1`) rather than
as a widened key column, because a widened key column changes the plan
of every query that does not name it. Measured, the owner's own
authenticated `{"#p":[owner],"kinds":[1059]}` read went from 601 rows to
204,701 under a widened index, against 567 under partial pairs. The full
reasoning and measurements are on `src/groups.ts` and
`schema.ts INDEXES`.

Every query against `events`/`event_tags` therefore names a partition
or reads the table: SQLite uses a partial index only for a query whose
`WHERE` implies the index's predicate. `storage.ts` states the rule once
above its first use and every lookup below obeys it.

## Group writes: refused by name, and no kind 9007

Kinds 9000, 9001, 9002 and 9009 are implemented; the rest of NIP-29's
9000–9020 moderation range is refused by name rather than stored as an
inert group note, since a kind-9005 delete-event answered
`["OK", id, true]` that deletes nothing is worse than a refusal.

Kind 9007 create-group is deliberately absent. NIP-29 has no creation
step ("what happens is just that relays will create rules around some
specific ids"), and with one group whose id is a constant there is
nothing to create; 9002 edit-metadata is what brings the group's
metadata into being.

The group id is enforced on moderation events only, where it selects
what gets mutated. Ordinary `h`-tagged traffic naming some other id is
still partitioned and still gated by the one member list, because
deciding what a group is belongs at the partition and not at the write
gate.

## Invites are bearer tokens

The relay cannot authenticate who will present an invite code, which is
the point: an invite link has to work for somebody whose npub does not
exist until they click it. So the controls are lifetime, count,
guessability and guess rate. Single use. Mandatory expiry (7 days by
default, 30 at most), refused rather than clamped when a kind-9009 asks
for longer, since a clamped invite is a link the client goes on
describing wrongly. A 16-character minimum, the only guessing floor a
relay can enforce over a code it did not generate; length is not
entropy, and the per-IP throttle of 5 join requests a minute is what
actually bounds the deliberate case. `MAX_OUTSTANDING_INVITES` = 64
bounds the NIP-86 list rather than the owner.

A code this relay has ever issued is never reissued. An upsert would
hand its original redeemer a second admission and overwrite the only
record of who it let in.

Kind-9009 is owner-only inside a partition members otherwise read in
full. A code is a bearer token, so reading one is as good as being
handed it; widening group reads to members would have let every member
mint memberships with no line of the write path changing. Withheld by
omission and never by refusal: the only reader entitled to a 9009 is the
owner, so refusing everyone else would put a new signal on the
unauthenticated path, where `{"kinds":[9009]}` is answered with a plain
EOSE. Not even the count is readable; the rows are gone before the
`LIMIT` applies.

## The join request stores nothing

The join request is dispatched above both write gates, necessarily:
somebody joining is by definition not in `allowed_pubkeys`, so
`isAllowedWriter` would refuse the one event whose whole purpose is
getting them past it. It therefore owes the group partition what the
other gate-skipping paths owe it, and pays the same way NIP-62 vanish
does: nothing is stored. A kind-9021 carries an `h` tag, so storing one
would put a stranger's event into the group partition through a path no
group authorization gates. The only event a successful join produces is
the relay's own regenerated kind-39002, which is the canonical record of
the membership anyway.

Signature verification runs before the invite lookup, inverting the
cheapest-first convention on purpose: refusing a bad code ahead of a bad
signature would let a caller offer guesses under junk signatures and
tell a real code from a fake one by which complaint came back.

The same reasoning refused gift wraps carrying an `h` tag. A kind-1059
used to land in the group partition without passing
`authorizeGroupWrite`, since gift wraps are dispatched above both gates
and `storeEvent` partitions on the tag alone. It was documented as
harmless on the grounds that it wrote into the partition rather than out
of it, which described the wrong audience: an authenticated reader of
that partition receives the injected event. A wrap addressed by `p` tag
to one recipient has no meaningful use for a group tag, so it is refused
outright, by `isGroupEvent`, the same predicate the partition uses, so
the two cannot drift.

## A refused join says one thing

Spent, expired, revoked and unknown are four different states and all
four get `JOIN_REFUSAL_MESSAGE` verbatim. "Spent" or "expired" would
confirm the code was real, which confirms this relay hosts a group
somebody was invited to; "unknown" against a guess confirms the
opposite. Either way the refusal becomes a one-bit oracle tested a guess
at a time, which is exactly what the gift wrap read gate was before it
stopped deciding by probing storage. A request naming another group id,
and one carrying no code at all, get the same string too: answering
"wrong group id" would confirm which id this relay does host. The owner
gets the distinction through a channel a stranger cannot read: a
`console.warn` naming the reason, with the code truncated to 12
characters and `JSON.stringify`d since it is attacker-chosen text going
into a log, and the two NIP-86 invite methods, where the caller is the
owner and spent, already-revoked and never-issued are each named in
full.

What is not hidden is timing: a known code costs one row read more than
an unknown one before the same refusal. Levelling that with a dummy read
would be defending against an adversary who can already do better by
other means.

There is no HTTP method for creating an invite. An invite is created by
publishing a kind-9009, which is a signed part of the group's history,
and a second way in over HTTP would put one act on two paths with only
one of them recorded in the group.

## `closed` stays on the kind-39000

It was read as "join requests are ignored" and predicted to come off
when invites landed. NIP-29's own sentence is "If a group is `closed`,
join requests are not honored unless they include an invite code", which
is precisely what this relay does. Invite-only is the closed group;
`open` would be the tag that lies.

## Two nested lists

`allowed_pubkeys` is the outer list (relay-wide write access, what
`isAllowedWriter` consults); `group_members` is the inner one
(permission to write an `h`-tagged event, on top of that).
`authorizeGroupWrite` is called under the relay-wide gate, never beside
it, and three integer comparisons return early for any event that is
neither group-scoped nor moderation, so ordinary writes pay nothing.

`allowed_pubkeys.source` is `owner` or `invite`. Put-user and a redeemed
join both write the row a new member needs as `invite`; remove-user
deletes only `invite` rows; a NIP-86 `allowpubkey` on an existing row
promotes it to `owner`, one-way, because an explicit act outranks the
group's bookkeeping. Without that column remove-user would have two
options and both are wrong: revoke a grant the owner made deliberately,
or let every ex-member keep writing forever.

Redeeming an invite writes the outer list as well as the inner one,
because a member without that row is a member whose events are refused.
So an invite link hands out relay-wide write access, not only group
write access, bounded by the same caps every writer pays and revocable
the same two ways.

## The relay signs its own events: bypass the gate, never the bookkeeping

A relay-generated 39000/39001/39002 never enters `handleEventInner`,
since there is nobody to authorize, but it goes through
`storage.ts storeEvent`, the same function every client write reaches,
so it pays the maintained counters, both hour buckets, the stamped
`row_cost`, the partition and the addressable-replacement rule exactly
as any other event does. There is no second insert path and there must
never be one: half of `storeEvent` reimplemented is half of the budget
accounting missing, and the accounting is the part nothing would notice
was wrong. `test/nip29-groups.test.ts` asserts it by running the daily
counter audit over a relay whose only events are relay-generated.

The secret key stays behind `relay-identity.ts signAsRelay`, which is
handed a 32-byte hash and returns a signature; `nip29.ts` computes the id
through the same `computeEventId` every client event goes through.

The three are regenerated only when their own content changes, compared
tag-by-tag before writing, the same measure-before-writing rule
`refreshFollows` applies to the follow cache: a membership change
touches neither the admin list nor the metadata, and rewriting all three
anyway would delete and re-insert two unchanged addressable events every
time. Each regeneration is stamped `max(now, previous + 1)` rather than
`now`, because NIP-01 breaks a `created_at` tie on an addressable event
by lowest id; two membership changes in the same second would otherwise
produce a member list that loses to the one it replaces about half the
time, and lose silently, since `storeEvent` reports success with
`stored: null`. The generated 39000 carries the operator's
name/picture/banner/about forward from the previous document, so an
unrelated regeneration cannot blank the group's name, and then the
policy tags `private`/`restricted`/`hidden`/`closed`, which are facts
about what this relay enforces rather than preferences a 9002 expresses.

## The relay identity was `relay_pubkey` for one release

The relay's own keypair is generated at schema-init time rather than at
claim, because `claim()` is skipped entirely under `OWNER_PUBKEY` and the
identity has to exist under that mode too. Its public half shipped for
one release on the NIP-11 document as `relay_pubkey`, a name of our own
invention, which was harmless while nothing signed anything and became a
conformance bug the moment `nip29.ts` started generating events. It is
`self` now, nips/11.md's own field for it and the one NIP-29 points a
client at. On `/api/stats` it stays `relayPubkey`: that document is
bothy's own, every field on it is camel-cased, and a client reading it
is the admin page and not a NIP-11 consumer.

## Web push

Written against `crypto.subtle` directly: every npm package for RFC 8291
and RFC 8292 is Node-shaped (`require("crypto")`, `createECDH()`,
`require("https")`) and none of it runs on workerd, while ECDH P-256,
HKDF-SHA256, AES-128-GCM and ES256 all do, natively, which also matters
on a 10ms CPU budget. The single exception is deriving a public key from
a bare private scalar, which WebCrypto cannot do at all, so
`p256.getPublicKey` does that one line.

The public half is derived from the secret rather than configured
beside it (two configured halves can disagree; a derived one cannot).
Unset means no `push_key`, which means no client subscribes, no
subscription rows, no outbox rows and no alarm: a supported state, not
an error.

A payload carries the room name and `"message"`/`"voice"` and nothing
else. It travels through Apple's or Google's push service, and the room
name is the only part already public (it is the NIP-11 `name`). The
payload is also encrypted to the subscription's own keys, but the rule
is about what is put in, not what the encryption hides.

`subscribepush`/`unsubscribepush` bind a device to the pubkey the NIP-98
signature proved and never to one the body offers, and they are the only
two management methods a group member may call: a member who could not
call them could not be notified. `unsubscribepush` stays callable while
groups are paused, so that pausing never strands a device that
registered before the pause; the off-state is always reachable.

`push_subscriptions.last_ok_at` is refreshed at most once a day per
endpoint. Refreshing it on every successful send would have been one row
per device per notification, thousands a day to maintain a column whose
only reader is a sweep of long-dead endpoints; a 404 or 410 deletes the
row on the spot regardless.

## Ephemeral group chat

A conversation among friends is remembered rather than reread, and
writing it down permanently turns talk into a record and changes what it
was. The voice calls this relay carries have always worked that way and
nobody expects to replay one, while the text beside them had been
quietly claiming a different status nobody decided on. So kind-9 chat in
the group expires: not hidden, not archived, deleted.

Four rules. A conversation ends when the room has been empty for
`CONVERSATION_IDLE_SECONDS` (two hours: long enough that dinner does not
end it, short enough that an evening ends when the evening does), and
everything said during it goes with it. A message sent while somebody
else was present belongs to that conversation. A message sent to an
empty room is a note rather than speech: it waits for the next
conversation instead of expiring unseen, for as long as that takes.
There is deliberately no ceiling on a note, because speech is ephemeral
for having been heard and a note has not been heard yet; the sender
takes a note back with a NIP-09 kind-5. Somebody arriving partway
through sees the last `CHAT_BACKLOG_SECONDS` (five minutes), enough to
know what is being talked about, not enough to replace asking.

### Two integers and an index seek

The obvious shape for "which conversation does this message belong to"
is a per-message column or a side table, and both cost rows written per
message to record something the clock already knows.
`chat_state.last_occupied_at` is the last second at which
`MIN_ROOM_OCCUPANTS` distinct group readers held a socket at once, and it
is simultaneously the thing that decides the conversation has ended and
the line between what belonged to it and what did not: everything at or
before the watermark is speech, everything after it is a note. The sweep
is `WHERE kind = 9 AND is_group = 1 AND created_at <= ?` against
`idx_events_kind_created_grp`, which exists already. `swept_through`
checkpoints a sweep too large for one cron tick, exactly as
`vanishing.cutoff_created_at` does, and is what `authorizeGroupWrite`
compares an incoming chat message against so a member holding their own
signed copy cannot replay a finished conversation.

Nothing is tombstoned, the one place this departs from every other
removal in the codebase. A `deleted_ids` row per swept message would
leave the relay accumulating two permanent rows for every message it
deleted, a record of the conversation outliving the conversation.
`swept_through` refuses the same replay for every message of every swept
conversation at once, for one integer.

The relay is the only party that could do this: it is the only one that
sees everyone's presence at once, and a client expiring its own copy
would be hiding a transcript the relay still held. `groupOccupants` is a
walk over the object's own live sockets, so it costs no storage read.
Sampled from an accepted group write, a REQ by a group reader, and the
cron tick, which is the only one that can see a room full of people
sitting quietly. Throttled as a whole rather than only at its write:
throttling only the write left the watermark unmoved whenever the room
held fewer than two people, so every group event walked every socket to
re-establish that nobody was there.

### It ships able to report and not to act

`EPHEMERAL_CHAT` unset means reporting: each cron tick computes exactly
what deleting mode would remove, logs it, and deletes nothing. The exact
string `"on"` lets it act; `"off"` removes the behaviour outright. That
inverts the usual only-one-exact-string-disables-it shape on purpose:
those guard a safety limit, so turning one off is the act that must be
spelled out, and here it is the deletion that must be. Reporting rather
than off as the default because a feature that ships switched off ships
untested on the only deployment that matters. The numbers go to the log
rather than to `/api/stats`, which is public and which the group
partition is kept off.

## NIP-29 groups are paused by default

The group code stays in the tree and stays tested, and the README
declines to claim it; the `GROUPS` switch makes the relay match that
stance at runtime. Paused means no group-scoped write from anyone, the
owner included, no moderation event and no join request honoured, no
occupancy sampling or chat sweep, no push fan-out, no `push_key` and no
29 on the NIP-11 document, and the group methods omitted from
`supportedmethods`. What is already in the partition stays where it is:
pausing a room is not emptying it. Turning the feature on is what admits
new writers to a partition, so that is the act that must be spelled out.

## CORS on the management route

Safe, and the comment in `index.ts` says why so nobody removes it as an
oversight: every call is authenticated by a NIP-98 signature over that
exact method, URL and body, there is no cookie or session for a
cross-origin request to borrow, which is the ambient authority the
same-origin policy exists to protect, and an unauthenticated preflight
reveals only that the endpoint exists, which the NIP-11 document already
advertises on the same URL. Without it the API was reachable only from a
page the relay itself served, and hearth is served from GitHub Pages.
The preflight is not rate limited: it reaches no Durable Object, and
counting it would spend two of an address's sixty per minute for every
management call.

## Tombstones, and the one place they are lifted

NIP-09 deletion, NIP-62 vanish and NIP-86 `banevent` all tombstone ids
in `deleted_ids`, so a deleted event, gift wraps especially since the
sender keeps their own signed copy, cannot be replayed back into
storage. `banevent` writes both a `banned_events` row and the tombstone:
the ban is what the operator reads back, the tombstone is what refuses a
re-send or a backfill replay. `listbannedevents` reads `banned_events`
and never `deleted_ids`, which holds NIP-09 and NIP-62 deletions too.
`allowevent` is the one place in the codebase that deletes a tombstone.

## An expired gift wrap is deleted, not hidden

NIP-40 expiry means hide for every other kind: `filters.ts` drops an
expired event from every query, and the row then costs storage bytes
that `NON_OWNER_STORAGE_SHARE_LIMIT` already bounds. Kind 1059 is the
exception because it is the one kind capped by count: `giftWrapCount`
counts rows and not mail, so a hidden wrap goes on holding a slot that
no query will ever serve from, and the relay eventually answers "inbox
is full" to the owner's real mail. Teaching `giftWrapCount` about expiry
instead was rejected twice over: the count is answered from an index
without touching the table and `expiration` is on no index, so it would
double a read paid on every accepted wrap, and it would fix only half
the problem, since a dead row costs `excludeGiftWraps` the same skip a
live one does. No tombstone, and the argument is stronger than the chat
sweep's: `acceptEvent` already refuses any event whose `expiration` has
passed, and the tag is covered by the signature, so the event refuses
its own replay forever and for free.

## The live feed never carries content

`/live` is unauthenticated and push-only, capped at 5 concurrent
connections and a 10-minute server-enforced lifetime, and sends only
kind, time and a truncated id. It never sends gift wraps, group events
or content, because it has no authentication to gate any of them on.

## Management API

Phase one shipped only the methods that cost nothing on the per-event
write path; `banpubkey`/`allowpubkey`, the one addition that does, landed
only once a metrics baseline existed to compare against. The kind
allowlist methods answer with an explanation rather than a generic
unknown-method error, since bothy stores every kind deliberately.

`banpubkey`/`allowpubkey` are two independent lists, not opposite ends
of one: `unbanpubkey` and `unallowpubkey` each just delete their own
row. `isAllowedWriter` checks `banned_pubkeys` before the follows lookup,
unconditionally for every non-owner write, so a banned pubkey is refused
even if it is also a follow; it checks `allowed_pubkeys` only on the path
already about to reject, so that lookup costs nothing on the common
accept path. The owner's own pubkey can never be banned; the call is
refused outright rather than accepted with no effect.

IP blocks are checked once per WebSocket connection, never per message,
and never on the management endpoint: blocking your own address must not
lock you out of the API that unblocks it. Blocking the caller's own
address refuses once and names an exact confirmation string.

Verification runs in the Worker so a forged request costs no Durable
Object time, and `verifyNip98` deliberately does not know who the owner
is: obtaining the owner is the most expensive thing an unauthenticated
caller can provoke on this path, so `index.ts` asks the DO only once a
valid schnorr signature over this exact request exists. The `payload`
tag is required rather than optional.

`change*` under a set environment variable still stores the value and
says the variable is winning: store and warn, never silently discard. An
empty string clears the stored value, because NIP-86 defines no unset
operation. A successful response states what was stored and, only when a
variable is outranking it, says so.

## Name, description, icon, and the NIP-11 fields

Name, description and icon each have an environment-variable rung and a
NIP-86 rung because an operator may want the relay to present
differently from the person. `pubkey` and `contact` have neither: a
contact address has no such split. `contact` is the owner's kind-0
`website` and not `nip05` or `lud16`; see `resolveContact`. A name
derived from the owner's kind-0 renders possessively ("Aaron's relay",
always `'s`); a chosen name from any other rung is used verbatim.
`resolveName` backs both the NIP-11 document and `/api/stats`, so the
two can never disagree.

## `/api/stats`

Every figure is a maintained counter rather than a computed one, so no
request walks a table or reads a window, and there is no cache because
nothing on the document is stale. The two lessons behind that are in
[budget.md](budget.md): a TTL over an expensive read bounds how often you
pay it, not what it costs.

`rowsWrittenToday` and the two daily limits stay on the document, and
stay in rows. "Rows" is Cloudflare's own unit, the one the owner sees in
their dashboard, and the figure is the budget meter the admin page
exists to show. It is deliberately whole: it is the owner's budget
meter, and a figure that under-reports the day's spend is worse than one
that leaks traffic shape.

The per-path attribution of reads and writes is not on the document. It
is a diagnostic held in memory, its path names are function names from
this repository, and the page never rendered it; the module-level
snapshots stay for the tests that pin the budget baseline through them.
`groupPolicy` and `chatPolicy` are not on it either: a paused feature's
switches are configuration, and nothing renders them.

`countAudit.drift` is written in plain sentences. The endpoint is public,
and the table and column names that identify which counter drifted are
in the log line beside it, where the person reading them is the one who
can act.

`vanishing` is a count, a progress total and an age, never the pubkeys:
itemising the rows would publish exactly the list a vanish request
exists to remove someone from. Any drift count in `last_drift` is a
number and never the pubkeys, for the same reason.

## Backfill reserves half the day

Backfill pulls the owner's own history from their kind-10002 write
relays, resumable across cron ticks, and reserves at most half the daily
rows-written budget so it never competes with the owner's live traffic.
Its status on the wire is `pending`, `running`, `paused` or `done`; a
pause has one cause, the day's write budget, and resolves itself at 00:00
UTC, so the reason is stated by the page rather than encoded in the
value.

## Configuration

Everything optional is read defensively (`env.X ?? fallback`) and
declared nowhere in `wrangler.jsonc`'s `vars` block, because the deploy
button prompts for every declared var with no notion of "optional" and a
clean deploy must ask for nothing but a project name. The `ratelimits`
block fits that rule: its namespace ids are ours to pick, nothing is
provisioned, and nothing is prompted for. Both bindings are read as
`env.X?.limit(...)` because the Cloudflare docs do not state which plans
the binding is available on (checked 2026-08-27), so an absent binding
means "allowed" rather than an exception on every request.

`VAPID_PRIVATE_KEY` is a secret and not a var, and the distinction is the
point. A git-connected Worker may sync vars from `wrangler.jsonc` on
deploy and overwrite what was set in the dashboard, which for a private
key would mean the repository silently deciding what it is. Secrets are
never synced from config, so the key is incapable of reaching the
repository. A value that does not decode to a valid 32-byte P-256 scalar
is logged once and treated as unset, which is a supported state.

The write-path caps are disabled only by the exact string `off`, never
by any truthy value, because removing a safety cap must be a deliberate,
spelled-out act. A malformed or empty value falls back to the default
rather than resolving to "no limit": a typo in the dashboard should cost
you the override, not the cap. Every switch is read the same way, by
`limits.ts readSwitch`: trimmed and lowercased, so `Off` and `" on"` do
what they look like they do, and an unrecognised non-empty value is
logged once, the way a malformed `WRITE_POLICY` is.

`UPDATE_CHECK` exists because the updater is opt-in by construction:
nothing else in this project would ever tell an owner who did not commit
`sync.yml` that a release happened. The check reads `version` out of
upstream's `package.json` on `main`, the same field the running relay
reports about itself, so the two sides of the comparison cannot drift;
over raw.githubusercontent rather than api.github.com, whose
unauthenticated limit is keyed to an outbound IP this Worker shares with
every other Worker in its colo. Null is "no answer", never "up to date".

Redeploying does not reset ownership or storage. Resetting requires
deleting the Worker.

## The updater workflow

`sync.yml` is scheduled weekly as well as `workflow_dispatch`, and that
is deliberate: committing the file is enabling auto-update, because a
switch that has to be found and clicked again every time is not one a
button-deploy user will keep using. It no-ops in `sybenx/bothy` itself
via the job-level `if` guard.

The `git checkout HEAD -- wrangler.jsonc .github/` step is load-bearing:
it restores the user's own Cloudflare resource ids and the workflow
itself after the upstream checkout overwrites them. The `.github/` half
is not merely policy: `GITHUB_TOKEN` cannot push a change to a file under
`.github/workflows/`, so a sync that tried to carry a newer workflow
downstream would fail at the push. The workflow a downstream copy commits
is therefore the one it keeps forever; a fix reaches existing deployments
only if their owners re-commit it by hand.

The copy Cloudflare creates arrives without `.github/workflows/`, which
is why the README hands the file over as a GitHub "new file" URL carrying
the whole workflow in its `?value=` parameter. That URL is generated by
`npm run sync-badge` and never hand-edited; otherwise every new
deployment enables a version of the updater that no longer exists here.

## Conventions, and why

Cheapest and most certain rejections run first on every write path
(ownership and tombstone checks before schnorr verification) because a
schnorr verify is the one cost the test suite cannot see and the one an
unauthenticated caller can provoke at will. The two documented
inversions, the join request and the NIP-98 path, are each explained in
their own entry above.

Indexes are declared once, as data, in `schema.ts INDEXES`, because
three things derive from that declaration: which filters are affordable,
what an event costs to write, and how much work fits in a cron tick. An
index whose definition changes must change its name: `CREATE INDEX IF
NOT EXISTS` will not redefine one and reports no error.

`initSchema` compares a hash of the declaration against the hash the
database was last reconciled to and runs the reconcile pass only on a
mismatch. It used to reconcile unconditionally on every wake: measured
live, 55 rows read per wake, ~94,000 a day, to redeclare a schema that
had not changed since the wake before. The hash is derived from every
field the reconcile acts on, so a changed column cannot skip its own
migration, and it is written only after the reconcile completes without
throwing.

`events.ingested_at` is wall-clock write time and is never conflated
with `created_at`: a backfilled event's `created_at` is years old, and
measuring that made backfill's own writes invisible to the guard
restraining them. A column and not a counter table, because a column
costs nothing per event. `events.row_cost` is stamped at insert time for
the same reason. The maintained counters run the other way, paying a row
write per event, because there the alternative was a read that grew
without bound.

The maintained counts are correct only because nothing can change a
counted table without passing the counter: `insertEventRow` and
`deleteEventRow` are the only two functions that write `events`, and
`refreshFollows` the only one that writes `follows`. The daily audit
detects and never repairs: a counter that silently corrects itself
erases the evidence of whatever broke it.

`@noble/curves` and `@noble/hashes` only, no second crypto dependency,
and pinned versions throughout.

`getOwnerPubkey` runs `OWNER_PUBKEY` through `normalizePubkey` like every
other pubkey boundary. It did not, and returned the variable verbatim
while every comparison target is lowercase hex, so an operator setting
an npub got a relay where the owner could not write, could not read
their own mail, and could not be addressed by it, silently. A malformed
value now resolves to null, which reads as unclaimed and is visible;
`/api/claim` is still gated on the variable being set, so this fails
closed rather than reopening TOFU. `/api/profile` accepts an npub for
the same reason: it is called with the string the person pasted into the
claim form.

## Commit to `main`, no branches, plan mode first

This repository has one contributor, and every branch created so far has
ended up either a stale leftover or a deploy that silently did not
happen. Cloudflare builds from `main`; work on any other branch does not
reach the relay. The method for a session, and the reason plan mode is
mandatory before any change to `src/`, `public/`, README.md or
CLAUDE.md, is [workflow.md](workflow.md).

## The version bumps whenever `main` moves

Not "when the change is significant", not "when it is more than
display": those judgment calls produced three builds reporting a version
whose tag did not contain them.

Tags are annotated because `git push --follow-tags` only pushes
annotated tags; a lightweight one is silently skipped, so the tag exists
locally, `git ls-remote --tags origin` shows nothing, and nobody notices
until they go looking for a release that was never pushed. This happened
to v0.7.9: `git tag` made a lightweight tag, the push skipped it, and by
the time it was caught `main` had moved a commit past it. Fixed by
deleting the local tag and recreating it annotated at the right commit.
Verify a tag reached the remote with `git ls-remote --tags origin <tag>`
rather than trusting that the push succeeded.
