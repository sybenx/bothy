# The key management specification, and what bothy has to do with it

An assessment of [QR_SECRET_TRANSFER.md](https://github.com/sybenx/nostr-key-management)
(QRST 1.4-draft) and NOSTR_KEY_MANAGEMENT.md (NKM 9.2-draft) at commit `646b6d7`,
read from the position of the relay being asked to implement them. It is written
to answer one question — what, if anything, bothy should become for these specs —
and to be worth keeping afterwards as the record of what bothy will and will not
do about them, in the same way [rungs.md](rungs.md) is the record of the write
policy rather than a decision about it.

The short answer is that bothy already fills two roles the specification names,
should fill a third that costs a table and two management methods, and should not
fill the two large ones — the blob store of §4.2 and the co-signer of §7.6 —
because one of them contradicts a promise this project makes in prose today and
the other rests on a requirement the substrate cannot satisfy at all. The
reasoning is below, in that order.

---

## 1. Every role the specification has for a relay

The specification is not written at relays. Its actors are devices, a server, and
a transport; a relay appears only as the transport, and the transport is
deliberately something nobody operates for the purpose. So most of what follows is
a role bothy *could* take rather than one it is asked for, and the two that are
genuinely asked for are the two smallest.

### 1.1 The relay that makes absence establishable (§2.4)

bothy already does this, and it is the only place in either document where a
relay under the user's own control is named as load-bearing rather than
interchangeable.

§2.4 covers the device that restores a synced copy of the nsec from iCloud
Keychain or Block Store and then self-enrolls. Before it self-enrolls it has to
know whether an active threshold record exists, because a restored nsec on a key
that has since been split is a stale full copy that must be quarantined rather
than used. The dangerous branch is *absence*: a device that fetches nothing
concludes there is no threshold record and self-enrolls with a whole key. So the
section says absence "is only established after querying a relay the user controls
or pays for, or otherwise after a 24-hour retry window; a withholding relay can
manufacture absence, and absence is what unlocks self-enrollment with a full key."

A bothy is a relay the user controls. The epoch record is a kind-30242 addressable
event signed by the owner's own key, so it passes `isAllowedWriter` as an ordinary
owner write and is served back by an ordinary REQ. Nothing has to be built. What
this costs bothy is nothing and what it is worth is a day of waiting removed from
a device restore, which is the difference between "your other device will be
usable tomorrow" and "your other device is usable".

The only thing worth saying about it is that it is a reason for the relay to stay
reachable, which bothy already has plenty of.

### 1.2 Carrying the device list and the epoch record (§7.1, §7.4)

Also already true, also for free. The device list is kind 30242 with `d =
"devices"`, the epoch record is kind 30242 with `d = "frost"`, both addressable,
both signed by the owner's key — or, once threshold mode is active, by the group
key, which *is* the owner's pubkey, since FROST produces a signature that verifies
against `pubkey(nsec)` and nothing on the wire distinguishes it from a signature
the owner made alone. Either way `isAllowedWriter` sees the owner and admits it,
and `storeEvent`'s addressable branch replaces the previous version in place
keyed by `(pubkey, kind, d)`.

Two details are worth stating rather than discovering later. The `d` tag is a
single letter, so it is indexed, so `{"authors":[owner],"kinds":[30242],"#d":
["frost"]}` is served from an index at the ordinary cost. And 30242 is outside
`isGroupMetadataKind`'s 39000–39005 range and carries no `h` tag, so it lands in
the public partition and is readable unauthenticated. That is correct — the
contents are NIP-44 encrypted to the owner or under the group secret — but it does
mean the *existence* and the *update timing* of the device list are public on a
bothy, and the epoch record's `["epoch", counter]` tag is plaintext by design.
NKM §5 already concedes the shape of this ("Permanent `#p = E.pub` subscriptions
let a relay count devices and see per-device timing under a stable key. Not
mitigated"), and a relay the user owns is the least bad place for it, but it is
not nothing: an observer polling a bothy learns when its owner last changed
devices or rotated. bothy publishes no counter that would make this cheaper than
polling, which is the same reasoning that keeps the group partition off
`/api/stats`.

### 1.3 Carrying §7 gift wraps addressed to the owner's devices (§7.1, §7.17)

This is the first role that needs code, and it is the one worth doing.

Every §7 message is a NIP-59 gift wrap: `KEY_SHARE`, `SHARE_ACK`,
`OFFLINE_REQUEST`, `KEY_ROTATE`, `APPROVAL`, `DISABLE`, `DISABLE_ACK`,
`RECOVERY_NOTICE`, `AUDIT_DIGEST`, `ALERT`, `EPOCH_FINALIZED` — kinds 24305 to
24319, all rumors, all sealed and wrapped, all reaching the wire as kind 1059 and
nothing else. §7.1 says each device "subscribes to `#p = E.pub` permanently for §7
wraps", and §7.17 gives those wraps `expiration = now + 30 days` rather than the
ten-minute transfer TTL, so a device offline for a fortnight still finds its
rotation delta waiting.

bothy refuses both halves of this today, and refuses them deliberately. On the
write side, `handleGiftWrap` requires the wrap to p-tag the owner:

```
if (!pTagValues(event.tags).includes(owner)) {
  ok(ws, event.id, false, "restricted: gift wrap is not addressed to this relay's owner");
```

An `E.pub` is a per-device enrollment key, generated at install, distinct from the
owner's identity key and from the QRST burner. It is not the owner, so a
`KEY_SHARE` addressed to it is refused. On the read side, `mayReadGiftWraps =
authedAsOwner`, so a device that completes NIP-42 AUTH as `E.pub` and sends
`{"kinds":[1059],"#p":[E.pub]}` gets `restricted: not allowed to read gift wraps`.
Both refusals are correct for what bothy is today and both have to move for this
role to exist.

**How the relay learns which pubkeys the devices are.** Not from the device list:
kind 30242 is encrypted, in base mode to the owner's own pubkey and in threshold
mode under a group secret distributed with the shares, and bothy holds neither
key. There is no derivation, no plaintext tag carrying `E.pub` values, and there
must not be one — a plaintext member list on a public addressable event is the
device enumeration §5 already regrets. So the relay is told, or it does not know.

Three ways to tell it, and only one of them survives reading.

A pair of NIP-86 methods — call them `adddevice` and `removedevice`, with
`listdevices` — authenticated by a NIP-98 event signed by the owner, exactly as
every other management call is. The owner's client is the one party that holds the
device list in plaintext, so it is the one party that can say what is on it, and
NIP-98 already proves it is the owner saying so. This is the answer. It costs a
`device_pubkeys` table (pubkey primary key, a label, an added-at), two rows per
device written once, one indexed row read on the paths that consult it, and two
entries in `SUPPORTED_METHODS`. It sits beside `allowed_pubkeys` rather than
inside it, because the two lists mean different things: `allowed_pubkeys` grants
relay-wide *write* access, and a device that may receive mail has no business
gaining that. Conflating them would hand every enrolled device the write authority
`isAllowedWriter` guards, which is a strictly larger grant than the one being
asked for.

A general rule — "an AUTH'd pubkey may read wraps addressed to itself" — is the
tempting one and it is a cliff. It sounds like a read-side change, but it is not:
the write gate refuses a wrap not addressed to the owner, so the rule only does
anything if the write gate widens to accept a wrap addressed to *anyone*. That is
not rung 2 of [rungs.md](rungs.md), which is "owner + addressed mail" and is
bounded by "storage reserved for this class"; it is a public gift-wrap inbox for
the whole world, bounded by how many strangers decide to use this deployment as
one. The ladder's own test applies: rungs 1 to 4 each have a bound tied to a
real-world quantity, and "how many people would like a free encrypted mailbox" is
not one. The read-side half is fine on its own — telling an authenticated pubkey
about mail addressed to it leaks nothing — but there is nothing for it to read
without the write-side half, and the write-side half is the cliff.

Following the kind-3 follow list, the way `ALLOW_FOLLOWS` widens writes, does not
work either: a device's `E.pub` is not a person and would never be in a contact
list, and putting it in one would publish the device enumeration to everyone.

So: an owner-declared list, over NIP-86. The rung this lands on is **rung 2 with
the addressee set widened from one pubkey to a handful the owner names**. Anyone
may still write, the event must still be addressed mail, and the volume is still
bounded by the gift wrap storage cap and the per-IP throttle. The set of valid
addressees grows from one to perhaps five, which multiplies nothing, because the
cap that binds is a total and not a per-recipient allowance.

**What it costs on the read path.** `mayReadGiftWraps` becomes "the owner, or a
registered device", and the filter check has to gain a condition it does not have:
a filter naming kind 1059 is admissible only if every `#p` value it names is the
authenticated pubkey itself. A registered device asking for its own mail is
served; a registered device asking for the owner's mail, or for another device's,
is refused exactly as an anonymous client is. The omission path (`filters.ts
excludeGiftWraps`) does not have to change at all: a device always names the kind,
so it never takes the kindless path, and a kindless query from a device having its
own wraps omitted is harmless. This keeps the omit-don't-refuse doctrine intact
where it matters — the unauthenticated path, where refusal was the leak — and puts
an ordinary refusal on a path where the client has already said what it wants.

**What it costs on the write path.** One extra membership lookup on a gift wrap
whose `p` tag is not the owner, and nothing at all on the common one, if the
owner is checked first.

**The cost that is not obvious, and that has to be fixed first.** §7 wraps carry a
30-day expiration, and bothy does not delete expired events — `filters.ts` hides
them from every query, and nothing sweeps them. `storage.ts giftWrapCount`, which
backs the `maxGiftWraps` cap, counts every kind-1059 row in both partitions with
no expiration predicate. So an expired wrap occupies the inbox cap permanently.
At the defaults that cap is 2,048 wraps, derived in `limits.ts maxGiftWraps` as
`min(MAX_FILTER_ROWS_READ / ROWS_READ_PER_MATCH, GIFT_WRAP_STORAGE_SHARE /
maxEventBytes)` = `min(5,000, 128MB / 64KB)`. Today nothing exercises this,
because ordinary NIP-59 DMs carry no expiration and hearth's transfers
deliberately do not use a bothy. §7 traffic would exercise it on day one, and the
failure is not graceful: once the count reaches the cap, `handleGiftWrap` answers
`blocked: gift wrap inbox storage is full` to *every* new wrap, which includes the
owner's actual direct messages. A relay that took on device mail and thereby
stopped accepting the owner's mail would have made itself worse at the thing it
was already for.

This is a bothy defect that reading the specification found, and it wants fixing
whether or not any of the rest happens: an expired gift wrap should be removed by
the cron tick, or at minimum excluded from `giftWrapCount`. Removal is the right
one — hiding a row while still counting it against a cap is a cost with no
benefit, and `deleteEventRow` already exists and already does the accounting.

**Which §7 traffic should travel this way, and which should not.** Control traffic
is small and bursty and belongs here: an activation issues one `KEY_SHARE` per
device, a rotation one `KEY_ROTATE` per device, and each is ACKed. Five devices,
a rotation a month, plus a daily `AUDIT_DIGEST` to each trusted device, is on the
order of a hundred wraps in a thirty-day window against a 2,048 cap. Signing
rounds are a different quantity entirely, and §7.6 offers them over relays as an
alternative to HTTPS. A gift-wrapped signing round is two stored wraps — request
and response — at a charged cost of 16 rows each for a wrap carrying one `p` tag,
so 32 rows written per signature, and both rows sit in the inbox for 30 days. Fifty
signed events a day is 1,500 wraps standing at any moment and 1,600 rows written a
day; two hundred a day overflows the cap in under a fortnight. §7.6 already says
HTTPS is tried first, and on this substrate that ordering is right for a reason
the spec does not give: over an open WebSocket a relay round costs no Cloudflare
request at all but costs rows and inbox, while an HTTPS round costs one request
and no rows. The request allowance is 100,000 a day and the row allowance is
100,000 a day, but the rows are shared with everything the relay stores forever
and the requests are not.

The line to draw, then, is that bothy carries §7 *control* traffic and does not
advertise itself as a carrier for signing rounds. Nothing in the protocol lets a
relay enforce that — a wrap is opaque — so it is a statement about what the
capacity is sized for, not a rule.

### 1.4 The QRST transfer path (QRST §11)

hearth's `keyxfer.js` says a bothy is the wrong carrier for this, in a comment
that is right and should stay:

> Not the group's relay. A bothy hands a kind 1059 to its owner and to nobody
> else, and refuses a subscription naming that kind from anyone else at all, so a
> burner subscribed there would sit in silence until it expired.

That is an accurate description of the code. It is worth adding that the
conclusion survives §1.3 above, which is the change that might look like it
undoes it. A QRST burner cannot be a registered device: the burner is generated at
the moment the QR is shown, exists for ten minutes, and is destroyed. Registering
one would mean a management call per transfer, which is a round trip in the middle
of a ceremony, and it would mean the relay learning that a pairing is happening
and when — the metadata QRST §15 is careful to point out an operator can already
derive when it carries both halves, and which there is no reason to hand over on
purpose.

The deeper reason is T2. QRST §3's transport contract requires that "neither party
holds an identity, credential, or relationship with the transport operator.
Nothing is provisioned to begin a session." bothy is a relay whose entire premise
is that there *is* such a relationship, and it publishes that fact:
`limitation.restricted_writes` is `true` on its NIP-11 document. A relay that
satisfies T2 is a public relay, and the specification is explicit that this is the
point — "the secret moves over public relays. You do not run a server, you do not
register with one." A relay you run is the wrong shape for a mechanism whose value
proposition is not running one.

**What QRST asks of bothy anyway.** Two things, and one of them is worth doing.

QRST §11.6 says clients "MUST read `max_message_length` and `max_content_length`
from NIP-11 during the §11.3 probe and skip relays that cannot carry the declared
profile's maximum." bothy publishes `max_message_length` (derived from
`maxEventBytes`, and omitted entirely when that cap is disabled) and deliberately
does not publish `max_content_length`, on the stated principle that "advertising
an unenforced limit is worse than advertising none". That principle is right and
should not be abandoned to satisfy a spec. But it does expose a hole in §11.6,
which says what to do when the fields are present and small and says nothing about
the far more common case where they are absent — see "QRST §11.6 does not say what
an absent NIP-11 limit means" in §4.
bothy's own document is a live example of the case: one field present, the other
principledly absent.

QRST §11.5 says that if a relay returns `auth-required`, the client authenticates
with its burner under NIP-42. bothy implements NIP-42 and would issue the
challenge, and the burner would authenticate successfully, and the subscription
would still be refused — because the refusal was never about being unauthenticated,
it was about not being the owner. §11.5 has no rule for that, which is the spec
issue "QRST §11.5 says what to do when a relay demands AUTH, not when AUTH does
not suffice" in §4.

§11.3's probe would get this right if a client ran one: bothy accepts the socket
and refuses the REQ, so "a WebSocket open and `REQ` accepted" fails, and the relay
is correctly judged unusable. hearth does not probe, deliberately and with its
reasons written down. That is hearth's call and it is defensible, but it means the
one mechanism in QRST that would automatically keep a bothy out of a transfer's
relay set is not running in the client most likely to be pointed at one.

### 1.5 The bounce page host (QRST §11.2a)

Not on the list of candidates and worth adding, because it is the one QRST role a
bothy is actually well shaped for, and it is nearly free.

QRST §11.2 makes the pairing address an `https` link with every parameter in the
fragment, and §11.2a explains that the primary path never visits the host at all —
a client whose own camera reads the code parses the fragment and pairs directly.
`<host>` matters only when the platform camera app scans the code and opens a
browser. The landing page "SHOULD be a bounce page: it reads its own fragment,
opens the associated app where App/Universal Links are set up, and otherwise
offers the parameters as copyable text… Because the fragment never reaches the
server, the page can be entirely static, and the host it runs on learns nothing."

Every bothy already serves a copy of hearth as a static asset, and static assets
on this deployment are free, unmetered, and never touch the Durable Object. A
bounce page is a static file with the same properties. The transfer still runs
over public relays; the host contributes a URL and learns nothing, by construction
— which is the same argument §11.2a makes for why the role is safe to hand to
anybody.

The reason this is a role and not merely a possibility is that the alternative is
worse. A QRST implementation needs *some* host in its `https` link, and the
project's own answer is a canonical copy hosted separately. A group whose relay is
down and whose canonical copy is blocked has no host; a group whose members each
have a bothy has several. It costs a file in `public/` and no Worker code.

### 1.6 The §4.2 blob store

`PUT /v1/backup`, `GET /v1/salt`, `POST /v1/recover`. One encrypted backup per
identity, keyed by `SHA-256(npub)`. The client holds a content key `CK`, encrypts
the nsec under it once and forever, and wraps `CK` independently under each
enrolled recovery factor — a passphrase always, a passkey by default where a
platform authenticator returns a PRF value. The server holds `k_srv`, a random 32
bytes generated client-side, which is XORed into the wrapping key derivation and
keys the two HMAC verifiers, and which is what makes a leak of the data store
alone unbreakable.

This is buildable here. It is three routes on a Worker that already has routes, a
handful of rows in a Durable Object that already has SQLite, and the only
cryptography on the server side is `HMAC-SHA256` in constant time — the expensive
half, scrypt at `log_n = 18`, runs on the client. The 24-hour hold on the
passphrase branch is a stored timestamp and a cron tick, both of which exist. The
`RECOVERY_NOTICE` (kind 24316) to registered devices needs §1.3's device list and
an outbound publish, or — more interestingly — bothy's existing web push, which is
already an alarm-driven outbound HTTPS request to registered devices and is
already the mechanism for telling somebody something happened while they were not
looking.

Three things it cannot do, and the first is the one that matters.

**The two-store separation is not available.** §4.2 says the server "stores
`salt_pw`, `blob`, and the verifiers in the data store, and `k_srv` in a separate
secret store, never in the same table as `blob`", and the property claimed for it
is that "a leak of the data store alone is unbreakable". Two tables in one Durable
Object satisfies the letter and not the property: the two would fail together in
every scenario that matters, because the thing that leaks is the object, or the
account. bothy has exactly one store by design — `wrangler.jsonc` forbids a KV
migration, and a KV namespace binding would need a provisioned resource, which
breaks the rule that a clean deploy asks for nothing but a project name. A second
Durable Object is the same account and the same compromise. So a bothy blob store
would be a blob store whose headline security property is downgraded from "a leak
of the data store alone is unbreakable" to "a leak reduces to the strength of the
weakest enrolled factor", which is §4.2's *both*-stores case. That is survivable
where the factor is a passkey's 32 bytes of platform entropy and is not where it
is a six-word phrase, and §4.2 already tells the user in so many words that "if
this server is ever hacked, this is the only thing protecting your key." It would
simply be true earlier than the spec intends.

**The unknown-npub indistinguishability is unachievable single-tenant.** `GET
/v1/salt` returns, for unknown npubs, `HMAC(server_secret, npub)` truncated to 16
bytes, so that a caller cannot tell a registered identity from an unregistered
one. A bothy serves exactly one identity, and publishes it: the owner's pubkey is
`pubkey` on the NIP-11 document and is on `/api/stats`. Anyone who can ask
`/v1/salt` already knows which npub is the real one. The property is not weakened
here, it is absent, and the same is true of any self-hosted server — which §7.2
"supports and recommends". That is a defect in the specification rather than in
bothy, and it is filed in §4 as "§4.2's unknown-npub indistinguishability assumes
a multi-tenant server".

**It changes what a compromise of this relay costs.** Today the worst case for a
bothy is the owner's public notes, their gift-wrap envelopes with contents
unreadable, and the group's history. With §4.2 on it, the worst case includes an
encrypted copy of the owner's identity key, openable by a passphrase, in a system
where the two stores that were supposed to be independent are not. That is a
different category of thing to be holding, and it should be a decision made in
those words rather than arrived at by adding three routes.

### 1.7 The §7.6 co-signer

`POST /v1/sign` and `POST /v1/ecdh`, with the same requests also accepted as gift
wraps between `E.pub` and `S.pub`. The relay would hold share 1 of a two-of-two
FROST split of the owner's identity key, and every signature the owner's devices
produce would pass through it.

What it involves, honestly costed:

The admission checks are cheap and bothy-shaped. "The co-signer MUST refuse any
request whose `E.pub` is absent from the current epoch's member list, is not
`admitted`, or is revoked" is one indexed row, the same shape as `isGroupMember`.
The restricted-requester kind allowlist (0, 1, 3, 5, 6, 7, 13, 16, 30023) is an
integer set membership test, and the kind-5 rule — refuse a deletion whose `e` or
`a` tags reference any kind-30242 coordinate — is a tag scan over an event the
relay is holding in memory anyway. Per-kind additional factors are configuration.
None of this is hard.

The FROST is hard. There is no established, audited FROST-over-BIP-340
implementation in JavaScript; `@noble/curves` gives the curve and the Schnorr
primitives and not the threshold protocol, and IMPLEMENTATION.md §8 says so
plainly and proposes compiling `frost-secp256k1-tr` — Rust, Zcash Foundation — to
WebAssembly. On the CPU question that path is fine and better than expected: the
10ms figure in CLAUDE.md's budget is the *Worker's* limit, and a Durable Object
gets 30 seconds of active CPU per request, reset on each incoming request or
WebSocket message (developers.cloudflare.com/durable-objects/platform/limits/,
checked 2026-09-02). A FROST partial signature is a hash, a couple of scalar
multiplications and a scalar mul-add; it is not close to any of these ceilings.
The problem is the build. Cloudflare builds this repository from `main` with no
Rust toolchain, so the WASM would have to be committed as a binary artifact — a
few hundred kilobytes of opaque bytes in a project whose entire review model is
that a person can read it — and it would sit beside a convention that says
"`@noble/curves` + `@noble/hashes` only — no second crypto dependency". It also
has to be instantiated on every wake from hibernation, and this relay wakes on the
order of seventy times per cron interval, which is a cost nobody has measured.

The budget is not the blocker, which is worth saying because it is the thing one
expects to be. Over HTTPS a signing round is one Cloudflare request and, if the
round structure is chosen well, one round trip: the device sends its own round-one
commitment together with the unsigned event, the server generates its nonce,
computes the group commitment and the challenge, returns its commitment and its
signature share, and the device aggregates. The audit log §7.13 requires is one or
two rows. So a signature costs about one request and two rows. §7.13's own hard
ceiling of 500 ECDH responses per hour per requester is 12,000 a day, which is 12%
of the request allowance and 24% of the rows-written allowance — it fits, with
room. Over relays instead of HTTPS it does not fit, for the reasons in §1.3.

What blocks it is in §2, and it is not a budget.

### 1.8 The §7.13 audit surface

Only meaningful alongside §1.7, but worth costing separately because it is the
part that is a *storage* commitment rather than a compute one. Every co-signer
"keeps a per-requester log of signing and ECDH rounds (kind, timestamp, peer
pubkey for ECDH)", sends a daily `AUDIT_DIGEST`, and enforces two rate rules that
each need history: an alert when a restricted requester exceeds both an absolute
floor and "five times its trailing-week hourly median", and a cumulative cap of
"200 distinct *recurring* peers per rolling 7 days". A trailing-week hourly median
needs 168 hourly counts per requester, which is small. The recurring-peer cap
needs the distinct peer pubkeys themselves, for seven days, which is not: at the
500-per-hour ceiling it is up to 84,000 rows, and at any realistic rate it is a
seven-day rolling record of every pubkey the owner exchanged messages with.

That record is the reason this role is not neutral, and it is picked up in §2.5.

### 1.9 §7.2 server enrollment and §7.8 replica issuance

§7.2's enrollment is a QR the server displays, in "QRST's `https` fragment form",
carrying `S.npub` and the HTTPS base URL. On bothy that is a static page and a
value from `/api/stats` — trivial, and only meaningful if §1.6 or §1.7 exists.
It also does not parse under QRST's own rules — see "The §7.2 server-enrollment QR
is rejected by QRST's own URI rules" in §4.

§7.8 has an existing server wrap share 1 directly to a new server's `S.pub` on a
gift-wrapped instruction from a trusted device. §7.9 step 2 similarly has the
server release the rotation delta `2r` to each admitted device, and §4.2's
recovery hold has the server send `RECOVERY_NOTICE` to registered devices. All
three are the server *publishing* a gift wrap, which on a relay means an outbound
WebSocket, which is the one thing this Durable Object must never open — an
outbound socket pins the object in memory for as long as it stays open, which is
the whole reason `profile-lookup.ts` and `backfill-worker.ts` live in the Worker.
The available shapes are a Worker-side publish on the hourly cron, which is too
slow for a rotation the user is watching, or delivery over the already-open
WebSocket to a device that happens to be connected, which works only for devices
that are. None of this is unsolvable and all of it is friction the spec does not
know it is creating, because it assumes a server that can open a connection when
it likes.

---

## 2. Where the specification collides with what bothy is

### 2.1 §7.9 step 4 cannot be satisfied on this substrate, at all

This is the finding that decides the co-signer question, so it goes first.

Rotation is what makes revocation real. §7.9 tier 1 revokes a device's `E` so it
can no longer ask the co-signer for anything, and tier 2 moves the surviving
members onto a new polynomial so that the revoked device's retained share 2 no
longer pairs with share 1. The whole construction rests on step 4:

> **The server MUST destroy the old-epoch share 1** — overwrite and verify, with
> no retained version history, snapshot, backup or log line. A revoked device's
> retained share 2 plus a surviving old share 1 is the key, so a store that keeps
> prior versions silently defeats rotation. On Cloudflare KV or a Durable Object
> this is not automatic; the rotation journal MUST record the overwrite and its
> verification.

"Not automatic" understates it. A SQLite-backed Durable Object has point-in-time
recovery built into the platform: Cloudflare retains a durable log of changes and
exposes `getCurrentBookmark()`, `getBookmarkForTime()` and
`onNextSessionRestoreBookmark()` to restore "a Durable Object's embedded SQLite
database to any point in time in the past 30 days", covering the entire database
(developers.cloudflare.com/durable-objects/api/storage-api/, checked 2026-09-02).
There is no documented way to opt out, no way to exclude a table, and no way for
the object to decline it — the object itself holds the API that performs the
restore, and so does anybody with access to the Cloudflare account.

So on bothy, an overwrite of share 1 is not a destruction. For thirty days
afterwards the old share 1 is recoverable by anyone who can reach the account, and
a revoked device's retained share 2 plus that recovered share 1 is the key. The
requirement is not merely inconvenient here; it is unsatisfiable, and the property
it exists to provide — that rotation neutralises a retained share — does not hold
on this substrate for thirty days after every rotation. That is precisely the
window in which a device was revoked because something went wrong.

Writing the rotation journal entry the spec also demands would produce a truthful
record of an overwrite that did not destroy anything, which is worse than no
record.

This is not a thing that gets better with effort. It is a property of the storage
engine, and the only escape is a different one — which on Workers Free is no
escape, since SQLite-backed Durable Objects are the only backend the plan
provisions.

### 2.2 §7.2's rule against holding both indices does not cover the shape bothy is

§7.2 says "a machine MUST NOT hold both indices" and gives the case: a machine
that runs the server holds share 1, and if it also enrolls as a device it holds
share 2, and the pair is the key. §7.12 then names the compounding case — a server
holding both share 1 and the backup blob, plus a weak passphrase and no passkey
factor, is the key — and requires only that "the client MUST offer at
second-server enrollment to place the blob on a different host than share 1".

A bothy that were both blob store and co-signer would be exactly §7.12's case, and
the spec permits it. Whether the permission is good enough for a relay whose pitch
is that it is the user's own is a real question and I think the answer is no, for
a reason that is specific to the deployment shape rather than to the spec. The
separation §7.12 asks for is a *second host*, and a one-click single-deployment
product is the software least able to make a second host attractive: the person
who deployed a bothy did so precisely because they did not want to stand up
infrastructure, and telling them that the safe configuration requires standing up
a second one is telling them the safe configuration is the one they declined. The
offer would be made, honestly, and declined, honestly, and the resulting
deployment would be the one §7.12 describes as the key.

There is a second collision here that the spec does not name at all, and it is
sharper. bothy serves the client. `public/` is served from `env.ASSETS` on the
same origin as everything else, hearth is a static page, and hearth's own
documentation says "Every bothy serves a copy, so any relay a person can reach
will give them the app." A browser device holds share 2 in IndexedDB under a
non-extractable wrapping key (§2.3), and that key protects nothing against the
origin: §2.3 says so — "`W` decrypts the nsec silently, so a hostile script on the
origin is not stopped by the passkey." So a co-signer that also serves the client
code to a browser device holds share 1 and can obtain share 2 whenever it likes,
by serving one different line of JavaScript to one visitor. That is §7.13's
hostile-origin case and §7.2's both-indices case arriving together, through a path
neither section's rule mentions, and no separation of *hosts* fixes it while one
of the two hosts is the origin. Filed in §4 as "§7.2's both-indices rule does not
cover a co-signer that serves the client".

### 2.3 The write policy, and which parts of it the new traffic trips

Taking the traffic in turn.

Kind-30242 device lists and epoch records are owner-signed and pass
`isAllowedWriter` unchanged. They are replaceable-in-place addressables, so they
cost a removal and an insert each time, and the epoch record changes only on
rotation.

§7 gift wraps addressed to `E.pub` are refused by `handleGiftWrap`'s recipient
check, which is §1.3's whole subject. They are *not* tripped by the follows gate,
the per-pubkey throttle or the storage share, because the gift wrap path is
dispatched above `isAllowedWriter` entirely and pays its own three caps instead —
the per-IP gift wrap throttle at five per minute, the `maxGiftWraps` count, and
`MAX_EVENT_BYTES`. The per-IP throttle is worth a look: five gift wraps per minute
per connection is generous for mail and tight for a burst, and an activation that
issues `KEY_SHARE` to five devices from one client in one second is five wraps in
one window, which fits with nothing to spare. A rotation is the same shape. It
would work and it would be one device away from not working.

The refusal of `h`-tagged gift wraps is not tripped and should stay exactly as it
is. No §7 message has any use for a group tag, and the refusal is what stops the
gift wrap path — which is dispatched above both write gates — from writing into
the group partition unauthorized.

The ephemeral-kind exemption is not reached. Every §7 kind is in the ephemeral
range 24305–24319, and this is a good place to be precise about what that means:
those kinds are *rumors*, and a rumor never appears on the wire. What bothy sees
is kind 1059, which is regular and stored. The ephemeral range was chosen so that
a rumor leaked unwrapped is dropped rather than kept, which is a property about
accidents, not about what the relay handles day to day. So the exemption from the
per-pubkey throttle that ephemeral kinds enjoy does not apply to any of this
traffic, and the throttle's exemption logic does not need to change.

A co-signer, if one existed, would be signing events on the owner's behalf and
those events would be published by the device, so they arrive at this or another
relay as ordinary owner writes. Nothing new there.

### 2.4 The free-tier budget

Covered in the costings above; collected here because the question was asked
directly and the answer is not the expected one.

A co-signer *fits*. One request and about two rows per signature, against 100,000
requests and 100,000 rows a day, with §7.13's hard ceiling of 12,000 ECDH
responses a day landing at roughly 12% and 24% of those. The blob store fits with
room to spare — three routes, a handful of rows, one small blob. Device-mail
carriage fits provided expired wraps are actually removed, which they are not
today. The one thing that does not fit is signing rounds carried as gift wraps
over the relay, at 32 charged rows a signature and 30 days of inbox occupancy
each, and §7.6 already prefers HTTPS.

The budget also has a shape the spec does not know about, and it is worth naming
because it inverts an assumption. §7.6's "Nothing reachable: … The client shows
**Will post when your server is reachable**" treats unreachability as a network
event. On Workers Free it is also a *clock* event: the allowances reset at 00:00
UTC and are per account rather than per Worker, which is why `exhaustion.ts`
exists at all — it was written after a live outage whose only symptom was an admin
page that loaded the word "bothy" and no numbers. A co-signer on this plan is a
co-signer that can stop for the rest of the day because something else in the same
Cloudflare account spent the allowance, and §5's declared availability cost ("No
reachable co-signer means no signing") would then mean the owner cannot post until
midnight. That is a much worse failure than a relay that cannot serve reads, and
it is the same failure the whole project already treats as a first-class visible
state rather than a surprise.

### 2.5 The audit log is the promise this project already made in the other direction

hearth's documentation, describing what a bothy does and does not hold:

> Direct messages between two members are encrypted end to end and are not stored
> on the group's relay at all. … This means the group's owner cannot read them and
> cannot see who is talking to whom, and the option to do either does not exist
> rather than being declined.

§7.6 requires that "every event a device signs is visible in plaintext to the
co-signer, including DM envelopes", §7.6a requires that the server see the peer
pubkey `P` of every conversation key derived, and §7.13 requires that both be
logged per requester and retained long enough to compute a trailing-week median
and a seven-day distinct-peer count. A bothy running as co-signer would hold, on
the relay, a rolling seven-day record of exactly who its owner is talking to.

The option would exist. That sentence would have to be rewritten, and the honest
rewrite is not a smaller claim — it is the opposite claim. This is the collision I
would weigh most heavily after §2.1, because §2.1 is a fact about Cloudflare that
might change and this one is a fact about what the software is for.

It is worth being fair to the spec here: the log is not gratuitous. §7.13 is the
answer to the hostile-origin problem, and the rate rules it enforces are the only
thing standing between an admitted browser device and reading every DM the owner
has ever received. The log exists because the co-signer is the one party that can
see the pattern. That is a good argument and it does not stop being one because
bothy finds the conclusion unwelcome; it is a reason the co-signer role is
coherent somewhere, and a reason it is not coherent here.

### 2.6 Ownership, single tenancy, and whether the relay identity can be S

bothy is single-owner and TOFU-claimed, and a co-signer serves one identity's
devices, so the arities match. What does not match is smaller and specific:

§4.2 keys everything by `SHA-256(npub)` and defines a behaviour for unknown npubs,
which is a multi-tenant design; on a single-owner relay it is decorative (§1.6).
§7.1 and §7.9 repeatedly offer "a trusted device **or the server console**" as the
party that admits a device, revokes an `E`, or initiates a rotation. bothy has no
console and should not grow one — the admin page is a claim form, a stats display
and a live feed, and "What it refuses to be" resists exactly this kind of growth.
Every one of those is an alternative rather than a requirement, so nothing breaks,
but it is a reminder that the server the spec pictures is an operated service with
an operator sitting at it, and bothy is a thing somebody deployed once.

**Whether `S` can be the relay identity: no, and the reason is containment rather
than key hygiene.** `src/relay-identity.ts` holds one keypair, generated at
schema-init, published as `self` on NIP-11 and `relayPubkey` on `/api/stats`, and
used for exactly one thing: `signAsRelay`, which "is handed a 32-byte hash and
returns a signature", and the secret half "never leaves that file". Being `S`
would require that key to perform ECDH, because every §7 request may arrive as a
gift wrap sealed to `S.pub` and unsealing one is `ECDH(S.sec, ephemeral)`. That
widens `relay-identity.ts` from a function that signs a hash to a module that
decrypts, and it makes one key the identity that says "this relay generated this
group event" *and* the holder of a share of its owner's identity. The first is
verified by every hearth client against the NIP-11 document; the second must never
be usable by anybody. Compromising one compromises both, and the blast radius of a
group-metadata signing key is a group, while the blast radius of `S` is an
identity.

So `S` is a separate keypair if it exists at all — which, given §2.1 and §2.5, it
should not.

---

## 3. What bothy should do

Nothing about the co-signer, now or later. Something small and bounded about
carriage, and the two roles it already fills should be written down rather than
discovered again.

### Stage 0 — say what is already true

bothy today is a relay a user controls that carries kind-30242 device lists and
epoch records with no change, and is therefore the relay §2.4 names as the one
against which absence can be established. That is a real role in the
specification, it is filled, and nobody knows it. It belongs in the README beside
the existing statement that a member who wants their direct messages held
somewhere they control runs their own bothy, because it is the same sentence about
a different kind of message. No code.

### Stage 1 — fix the expired gift wrap accounting — **done**

Independent of everything else and worth doing on its own merits. An expired
kind-1059 event was hidden from every read and still counted against
`maxGiftWraps`, so the inbox cap filled permanently with rows nothing would ever
serve, and a full inbox refuses the owner's real mail. `storage.ts
sweepExpiredGiftWraps` now removes them on the cron tick through `deleteEventRow`,
which already does the counter and partition accounting. No tombstone: the event's
own signed `expiration` tag is what refuses the replay, so there is nothing for a
`deleted_ids` row to add. Five rows written to remove a wrap against twelve to
store it, and a tick with nothing to do walks the stored wraps once — bounded by
the inbox cap rather than by the table — to establish it. See CLAUDE.md
"The budget" and `test/nip59-giftwrap.test.ts`.

This was the only change here that was a bug fix rather than a decision, which is
why it went ahead of the rest.

### Stage 2 — carriage of §7 control traffic for the owner's own devices

Two NIP-86 methods and a table, as costed in §1.3: the owner registers the
`E.pub` of each of their devices, `handleGiftWrap` accepts a wrap addressed to a
registered device as well as to the owner, and a filter naming kind 1059 is
admitted when every `#p` value it names is the authenticated pubkey and that
pubkey is the owner or a registered device. It stays on rung 2 — anyone may write,
addressed mail only, bounded by the same storage cap and per-IP throttle — with
the addressee set widened from one pubkey to a list the owner writes. It
contradicts nothing in "What it refuses to be", which rules out public writes,
multiple groups, moderation tooling and a dozen other things and says nothing
about who the owner's mail may be addressed to.

It should be built only if somebody is actually going to use it, which today means
only if hearth grows a device list, and it should not be built speculatively
against a draft whose event kinds are unregistered. The specification says so
itself: "Review is more useful than deployment at this stage."

Two details to get right when it is built. The per-IP gift wrap throttle at five
per minute is exactly the size of a five-device activation burst and should be
looked at with a real device count in hand. And the read-gate widening has to be
mirrored in `broadcast()`, for the reason CLAUDE.md already gives about every
other read gate: a subscription registered before an event arrives is never
re-examined by the REQ-time gate, so a permission widened in one place and not the
other silently pushes events to sockets the gate would have refused.

### Stage 3 — the bounce page, if hearth wants one

A static file in `public/` that reads its own fragment and offers the parameters
as copyable text. Free, learns nothing by construction, and gives a group whose
canonical hearth copy is unreachable a host of its own. This is hearth's decision
more than bothy's; bothy's part is a file.

### Not the blob store, and not now

It is buildable and it is small and I would still not build it here, for two
reasons that compound. The two-store separation §4.2 rests on is unavailable on
this substrate, so the deployment would advertise a backup whose stated
unbreakable-on-single-leak property does not hold — and the place that property
degrades to is "the strength of the weakest enrolled factor", which for a user who
declines the passkey is a passphrase. And it changes the worst case of a bothy
compromise from "the owner's public notes and unreadable envelopes" to "an
encrypted copy of the owner's identity key". Neither is disqualifying on its own.
Together they are a different product with the same name, and the honest way to
have this is a separate Worker that does one thing, which is also what
`IMPLEMENTATION.md` §1 already says the server half is: "NKM §7 is two deliverables
— a client and a reference server — and the honest framing is 'run this, then
enable that,' not 'install this.'"

If the answer later becomes yes, the thing to build is `@qrst/server`'s Worker
target as its own deployment, not a route on a relay.

### Not the co-signer, and not later either

The staged answer would be "co-signer much later", and I do not think that is the
right answer, because the two reasons are not the kind that get resolved by
waiting.

§7.9 step 4 requires the destruction of the old-epoch share 1 with no retained
version history, and a SQLite-backed Durable Object retains thirty days of
point-in-time history over the whole database with no way to opt out. Rotation is
the mechanism that makes revoking a device mean something, and on this substrate
it would not mean it for thirty days after each use. That is not a limit to be
engineered around; it is the storage engine, and the only backend Workers Free
provisions.

And §7.13's audit surface would put on this relay a rolling seven-day record of
who its owner talks to, which is the exact thing this project's documentation says
the relay does not hold and cannot be asked to hold. The log is well argued for
where a co-signer belongs — it is the only defence against an admitted hostile
origin — which is a reason the role is coherent somewhere and not here.

Underneath both, the shape is wrong in a way worth naming plainly. bothy is a
relay: it carries what its owner and their friends say, and its failure mode is
that some messages are unavailable for a while. A co-signer is a chokepoint on the
owner's ability to exist: its failure mode is that the owner cannot post, and its
compromise mode is share 1 in the hands of whoever holds the account that also
serves the code holding share 2. Putting the second thing inside the first means
the relay's ordinary failures — an exhausted allowance, a bad deploy, a Durable
Object that will not wake — become failures of the owner's identity. The
specification is right that a co-signer is strictly better than a remote signer.
It does not follow that the relay is the right place to put one, and this relay's
own documentation of what it refuses to be is a list of exactly this kind of
reasoning.

If a co-signer is wanted, it is a second Worker in a second Cloudflare account,
which is also what §7.2's independence argument and §7.12's separation offer are
both pushing toward.

---

## 4. Specification issues

Drafted in the format `SPEC_ISSUES.md` prescribes. The entries above the FROST
set are still drafts, held for review before anything is committed to that
repository. **The ten FROST entries, beginning with "`t = 3` is offered by §7.18",
have been filed** in `sybenx/nostr-key-management`'s `SPEC_ISSUES.md` under Open,
and the copies here are the working record rather than the live ones — a change
to one of them belongs there.

One entry was rewritten on filing. "§7.6 does not specify the round structure of
a signing request" and "§7.18 mandates two-round signing where §7.6's fix proposes
one" were two halves of one question, and the second leaned on the first being
present. They were merged into a single filed entry, "The signing round structure
is unspecified in §7.6 and two rounds in §7.18", which supersedes the §7.6 draft
below.

### The §7.2 server-enrollment QR is rejected by QRST's own URI rules

**Document:** NOSTR_KEY_MANAGEMENT.md (and QR_SECRET_TRANSFER.md)
**Section:** NKM §7.2 step 1; QRST §11.2
**Kind:** suspected error

NKM §7.2 step 1 has the server display a QR "in QRST's `https` fragment form
(QRST §11.2)":

```
https://<host>/qrst#v=1&mode=server&npub=<S.npub>&url=<https base url>
```

QRST §11.2 defines that form as
`#v=1&mode=<offer|request>&p=<profile-id>&npub=<npub>[&relay=…][&origin=…]`,
states that `p` is "REQUIRED; it is hashed into the SAS (§6), so an optional field
would need a canonical encoding for its absence and two implementations would
choose differently", and then requires that "A client MUST reject URIs with
unknown `v`, missing `mode`, or missing `p`".

The §7.2 URI has no `p`, and carries a `url` parameter §11.2 does not define. A
client that implements §11.2's parser as written MUST reject it. §11.2 does allow
that "Profiles MAY register additional `mode` values", but `mode=server` is
registered by NKM §7.2 rather than by a profile, and with no `p` there is no
profile in the URI to have registered it — the escape hatch cannot be reached from
this URI.

This breaks the first step of server enrollment for any implementation that shares
one URI parser between the transfer flows and the enrollment flow, which is the
obvious way to write it, and it breaks it in the direction that looks like a
malformed QR rather than like a specification disagreement.

**Proposed fix:** QRST §11.2 should state that `p` is REQUIRED for `mode=offer`
and `mode=request` and that a `mode` value registered outside this specification
defines its own required parameters, and should replace "A client MUST reject URIs
with unknown `v`, missing `mode`, or missing `p`" with "A client MUST reject URIs
with unknown `v` or missing `mode`, and MUST reject a URI whose `mode` is `offer`
or `request` and which is missing `p`. A client that does not recognise a `mode`
value MUST reject the URI and say which mode it did not recognise." NKM §7.2 step
1 should additionally state that the enrollment URI carries `mode=server`, `npub`
and `url`, that `p` is absent because no payload moves, and that `url` MUST be an
`https` origin with no path component.

### `GET /v1/salt`'s factor list identifies passphrase-only accounts

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §4.2
**Kind:** suspected error

§4.2 defines:

```
GET  /v1/salt?npub=…   → { salt_pw, log_n, factors: ["pw"] | ["pw","prf"] }
     for unknown npubs returns HMAC(server_secret, npub) truncated to 16 B, always log_n = 18,
     always factors ["pw","prf"] — a factor list that varied would signal non-existence
```

The stated intent is that a varying factor list would signal non-existence. As
written it signals existence, which is worse. An unknown npub *always* receives
`["pw","prf"]`. A registered npub with only a passphrase factor receives `["pw"]`.
So the response `["pw"]` is returned only for npubs that are registered, and it
identifies precisely the population whose backup is protected by a single
guessable factor — the population §4.2's rate limits, delay and generated-phrase
rule all exist to protect. An attacker enumerating npubs against a server learns,
in one unauthenticated request each and with no rate limit that helps, which of
them are registered *and* have no passkey.

The passkey-by-default rule makes this the minority case, which makes the signal
more useful rather than less.

**Proposed fix:** §4.2 should specify that `GET /v1/salt` returns the constant
`factors: ["pw","prf"]` for every npub, registered or not, and that the client
attempts the passkey factor where a platform authenticator returns a PRF value and
falls back to the passphrase otherwise, treating a failed `/v1/recover` under the
PRF-derived `K_auth` as "this factor is not enrolled" rather than as an error. The
sentence "a factor list that varied would signal non-existence" should be replaced
with "the list is constant because a list reflecting the enrolled factors would
identify accounts with a single factor."

### §4.2 defines no challenge endpoint for the `PUT /v1/backup` signature

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §4.2 (and §7.2 step 3)
**Kind:** ambiguity

§4.2 gives `PUT /v1/backup` the authorization "Schnorr sig over a server challenge
by the user's key (base mode) or by a trusted `E.pub` on the current device list
(threshold mode)". No endpoint is defined for obtaining that challenge, no format
is given for it, no lifetime, and no rule binds it to the request it authorises —
so an implementer must invent all four. Two implementations will invent
differently and a client will not be able to upload a blob to a server it did not
ship with, which is the exact interoperability failure `SPEC_ISSUES.md` exists to
catch. It matters at §7.2 step 3, the first thing a client does against a newly
enrolled server, so a mismatch surfaces at enrollment rather than at recovery.

**Proposed fix:** §4.2 should add `GET /v1/challenge?npub=… → { challenge, expires
}`, where `challenge` is at least 16 bytes of server randomness rendered as
lowercase hex and `expires` is a Unix timestamp at most 300 seconds ahead; and
should specify that `PUT /v1/backup` carries the challenge and a BIP-340 signature
over `SHA-256("nkm-backup-v1" || challenge || SHA-256(canonical request body))`,
that a server MUST reject a challenge it did not issue, that it MUST NOT accept
one twice, and that it MUST reject one that has expired. Alternatively, and
preferably, §4.2 should require NIP-98 authorization over the request instead,
which is already specified elsewhere, needs no round trip, and binds method, URL
and body without a new endpoint.

### §7.6 does not specify the round structure of a signing request

*Superseded on filing — see the note at the head of this section.*

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.6 (and §7.6a)
**Kind:** ambiguity

§7.6 says "the requester sends the **full unsigned event**, not a digest; the
co-signer serialises and hashes it itself", that "requests carry the requester's
`E.pub` signature", and that they travel "gift-wrapped between `E.pub` and `S.pub`
over relays or `<url>/v1/sign` over HTTPS". It does not say how many messages a
signature takes.

FROST per RFC 9591 is a two-round protocol: commitments, then signature shares.
There are two coherent readings and they do not interoperate. In the first, the
device is the coordinator: it asks the server for a round-one commitment, computes
the binding factor, the group commitment and the challenge, and asks again for the
server's signature share — two round trips, and the server must persist a nonce
between them. In the second, the server is the coordinator: the device sends its
own commitment with the event, and the server returns its commitment and its share
together — one round trip, and no server-side nonce state.

The choice is not cosmetic. The two-round reading requires the server to store a
signing nonce and to guarantee it is used at most once, because a FROST nonce
reused across two different messages discloses the signer's share; the one-round
reading has no such state and no such hazard. A specification that leaves the
round structure to the implementer has left that hazard to the implementer too,
without naming it.

**Proposed fix:** §7.6 should specify the one-round form as normative — "A signing
request carries the full unsigned event and the requester's round-one commitment
pair `(D_2, E_2)`. The co-signer generates its own nonces, computes the binding
factors, the group commitment and the challenge per RFC 9591, and responds with
its commitment pair `(D_1, E_1)` and its signature share `z_1`. The requester
computes its own share and aggregates. A co-signer MUST NOT retain a signing nonce
between requests, and MUST generate fresh nonces for every request" — and should
add, alongside it, "A co-signer that implements a two-round form MUST persist each
issued nonce, MUST refuse a second use of one, and MUST discard it after a bounded
lifetime; nonce reuse across two distinct messages discloses share 1." §7.6a
should state the same for `/v1/ecdh`, which is already one round.

### §7.2's both-indices rule does not cover a co-signer that serves the client

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.2 (and §7.12, §7.13, §2.3)
**Kind:** suspected error

§7.2 requires that "a machine MUST NOT hold both indices", and the case it gives
is a machine that runs the server and also enrolls as a device. §7.12 extends the
concern to a server holding both share 1 and the backup blob. Neither addresses
the case where the co-signer's operator also serves the client code to an enrolled
browser device.

§2.3 establishes that a browser device's share is protected against the origin by
nothing: "`W` decrypts the nsec silently, so a hostile script on the origin is not
stopped by the passkey", and §7.13 builds on this, noting that a hostile origin
"is the client on that device". A co-signer served from the same origin as the
client therefore holds share 1 and can obtain share 2 at any time by serving
different JavaScript to one visitor — silently, to one chosen person, with no
protocol step to log or refuse. That is §7.12's "server compromise plus any one
device share is the key" reached in a single act by a single party, and no amount
of host separation for the *blob* addresses it, because the second index is
obtained through the origin rather than stored on it.

The configuration is not exotic. A self-hosted server that also serves the web
client from the same domain is the obvious way to deploy one, and §7.2 recommends
self-hosting.

**Proposed fix:** §7.2 should extend the rule: "A machine MUST NOT hold both
indices. A server MUST NOT be enrolled as a co-signer for a `restricted` device
whose origin it serves: a party that serves the client code to a browser device
can obtain that device's share at will, so serving the origin and holding share 1
is holding both indices. Where a user enrolls a server whose base URL shares an
origin with the client they are running, the client MUST refuse and say why."
§7.13 should add to the hostile-device section: "A co-signer that serves the
client's origin is not a mitigation for this case but an instance of it; its
audit surface records requests made by an attacker who no longer needs to make
any."

### QRST §11.5 says what to do when a relay demands AUTH, not when AUTH does not suffice

**Document:** QR_SECRET_TRANSFER.md
**Section:** §11.5 (and §11.3)
**Kind:** ambiguity

§11.5 says "If a relay returns `auth-required`, the client authenticates with its
**burner** under NIP-42." It does not say what a client does when the relay
answers a subscription with `auth-required`, accepts the burner's NIP-42
authentication, and then refuses the subscription anyway.

This is not hypothetical. A single-user relay that gates kind-1059 reads on being
the relay's owner will do exactly this: the socket opens, the `AUTH` challenge is
issued, the burner authenticates successfully, and the `REQ` naming kind 1059 is
answered `CLOSED` with a restriction that authenticating differently cannot lift.
A client that treats a successful NIP-42 exchange as "this relay now works" will
believe it is subscribed and will never receive a message. Since a QR carries at
most four relays (§11.2) and the receiving party's subscription is how every
message reaches it, one such relay in the list silently reduces the transfer's
transport set with no signal to either party — and the failure appears as a
transfer that times out at ten minutes.

§11.3 partly covers this by making the probe "a WebSocket open and `REQ`
accepted", which such a relay fails; but §11.3 also makes the probe advisory
rather than selective, so a client is required to keep re-attempting a relay the
probe rejected.

**Proposed fix:** §11.5 should add: "A relay that refuses the subscription after
a successful NIP-42 authentication cannot carry this session. The client MUST drop
it from the session's relay set, MUST NOT re-attempt it for the remainder of the
session, and MUST surface that fewer relays are carrying the session than the QR
named. Where no relay in the set can carry the subscription, the session has no
transport and §11.3's failure path applies." §11.3's advisory-probe rule should be
amended to say that it applies to relays that are unreachable, and not to relays
that are reachable and have refused.

### QRST §11.6 does not say what an absent NIP-11 limit means

**Document:** QR_SECRET_TRANSFER.md
**Section:** §11.6 (and §4 P1, §11.3)
**Kind:** ambiguity

§11.6 says "Clients MUST read `max_message_length` and `max_content_length` from
NIP-11 during the §11.3 probe and skip relays that cannot carry the declared
profile's maximum", and §4 P1 says a profile declaring a larger maximum than the
2048-byte default requires clients to "read the transport's advertised limits
during the §11.3 probe and MUST skip operators that cannot carry the declared
maximum".

Neither says what an absent field means, and absent is the common case. §11.6 says
so itself about one of the two: "8196 is the *example* value printed in NIP-11
rather than a measured default; strfry's stock configuration sets no content cap,
and deployed enforcement is unmeasured." Relays also omit a limit deliberately —
a relay that publishes only the limits it actually enforces, on the ground that
advertising an unenforced limit is worse than advertising none, will publish
`max_message_length` and no `max_content_length`. A client must then choose
between "absent means unlimited, use this relay" and "absent means unknown, skip
it", and the two choices produce implementations that select disjoint relay sets
from the same list. The conservative reading is worse than the permissive one:
skipping every relay that omits `max_content_length` skips most relays, and §11.3
would then report no transport for a transfer that would have worked.

**Proposed fix:** §11.6 should add: "An absent `max_message_length` or
`max_content_length` MUST be read as no advertised limit, and the relay MUST NOT
be skipped on that basis. A client MUST skip a relay only where the field is
present and smaller than the expansion of the declared maximum (§4, P1). Where a
publish is rejected for size by a relay that advertised no limit, the client MUST
drop that relay from the session's relay set and continue with the remainder."

### §4.2's unknown-npub indistinguishability assumes a multi-tenant server

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §4.2 (and §7.2)
**Kind:** suspected error

§4.2 requires that `GET /v1/salt` return a plausible salt for unknown npubs, and
that `/recover` give "unknown npubs the same response time and shape as a wrong
secret". Both requirements exist to prevent a caller from learning whether a given
identity is registered with a given server.

§7.2 says self-hosting "is supported and recommended", and a self-hosted server
serves one identity. The property is then unobtainable by construction: a server
with one registered npub cannot hide which one it is, because there is one, and in
the Nostr deployments this is written for the operator's identity is typically
published by the same host — a relay's NIP-11 document carries `pubkey`, and a
personal server's domain is chosen by and named after its operator. Following the
requirement costs a server-secret HMAC and delivers nothing on precisely the
deployment the specification recommends.

The requirement is correct for a shared server. It is the absence of any statement
distinguishing the two cases that is the defect: an implementer of a single-tenant
server will either implement a property that does not hold and believe it does, or
omit it and be non-conforming.

**Proposed fix:** §4.2 should add: "These indistinguishability requirements bind a
server holding backups for more than one identity. A single-tenant server cannot
provide them — with one registered npub there is nothing to hide — and MUST state
so on its enrollment screen rather than implementing a measure that does not
achieve it. A single-tenant server MUST still apply the rate limits and the
constant-time comparison of this section, which bound guessing rather than
enumeration."

### §7.9 step 4 names a substrate on which its requirement cannot be met

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.9 step 4 (and §7.11, §7.12)
**Kind:** suspected error

§7.9 step 4 requires that "the server MUST destroy the old-epoch share 1 — overwrite
and verify, with no retained version history, snapshot, backup or log line", and
adds "On Cloudflare KV or a Durable Object this is not automatic; the rotation
journal MUST record the overwrite and its verification."

"Not automatic" implies the requirement is achievable with effort on those
platforms. On a SQLite-backed Durable Object it is not achievable at all.
Cloudflare retains a durable log of every change and exposes point-in-time
recovery over the entire database — `getCurrentBookmark()`,
`getBookmarkForTime()`, `onNextSessionRestoreBookmark()`, restoring "to any point
in time in the past 30 days"
(developers.cloudflare.com/durable-objects/api/storage-api/, checked 2026-09-02).
There is no documented way to disable it, exclude a table from it, or decline it,
and the object itself holds the API that performs the restore. An overwrite is
therefore not a destruction: for thirty days the old share 1 is recoverable by
anyone with access to the account, and §7.9's own sentence applies — "a revoked
device's retained share 2 plus a surviving old share 1 is the key". Rotation does
not neutralise a retained share on this platform, and a rotation journal recording
the overwrite would be a truthful record of an ineffective act.

The same reasoning applies to any managed store with retention the operator does
not control, which is most of them.

**Proposed fix:** §7.9 step 4 should be amended to require a declaration rather
than an unachievable act: "The server MUST destroy the old-epoch share 1 —
overwrite and verify — and MUST NOT itself retain version history, snapshots,
backups or log lines of it. Where the underlying store retains history the server
cannot disable, destruction is not achievable and the server MUST declare a
`share_retention` window: the period after a rotation during which the old share 1
remains recoverable from the platform. A server that declares a non-zero
`share_retention` MUST report it at enrollment, and the client MUST state on the
device-removal screen that rotation does not neutralise the removed device's share
until that period has elapsed, and MUST offer Re-split (§7.11) as the immediate
remedy." §7.11 should add that Re-split, not rotation, is the correct response to
a device removal on a server declaring a non-zero `share_retention`, since
Re-split draws a fresh `a_1` and severs the link to every old share rather than
relying on the old share 1 being gone.

### `K_auth` is bound to the server's base URL, so changing the URL bricks recovery

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §4.2 (and §7.10 step 1)
**Kind:** suspected error

§4.2 derives both authentication keys with the server's base URL as HKDF info:

```
K_auth_pw   = HKDF-SHA256(K_pw[32..64], salt = "auth-v1",     info = server base url)
K_auth_prf  = HKDF-SHA256(prf,          salt = "prf-auth-v1", info = server base url)
```

The verifiers the server stores are HMACs over these values, so a client
presenting a `K_auth` derived from a *different* base URL will not match, and
recovery fails with the same response as a wrong passphrase. A server that changes
its address therefore invalidates every enrolled factor for every identity it
holds, silently, and the failure appears only at recovery — the one moment the
backup exists for, and the moment at which no other copy is left.

This is not a rare event for the deployment shape §7.2 recommends. A self-hosted
server starts on a platform-assigned hostname and moves to a custom domain, or
moves between hosts, or gains TLS and changes scheme. §7.10 step 1 already
anticipates that a user may not remember the URL and offers a published
`backup-hint` tag; that hint solves finding the server and does not solve the
derivation, because a user who reaches the server at its new address still derives
the wrong `K_auth`.

Binding to the URL does buy something — it stops a `K_auth` captured by one server
being replayed against another — but a stable server identifier buys the same
thing without the failure mode, and §7.2 already gives every server one: `S`.

**Proposed fix:** §4.2 should replace `info = server base url` with `info = S.pub
hex` in both derivations, and should state: "The server identifier and not its
address, so that a server that changes address does not invalidate every enrolled
factor. `S.pub` is fixed at enrollment (§7.2) and is carried in the enrollment QR,
so a client that has enrolled always holds it." §7.10 step 1 should add that a
client recovering against a server whose address has changed MUST use the enrolled
`S.pub`, and that a server MUST publish `S.pub` at a well-known unauthenticated
path so a client holding only the URL can recover the identifier. For servers
already deployed under the URL binding, §4.2 should permit accepting either
derivation during a stated migration period and re-storing the verifier on the
next successful `/v1/backup`.

### §7.13 sets no retention bound on the audit log

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.13 (and §7.6a, §5)
**Kind:** ambiguity

§7.13 requires that "every co-signer keeps a per-requester log of signing and ECDH
rounds (kind, timestamp, peer pubkey for ECDH)", and defines two rules over
history: an alert threshold at "five times its trailing-week hourly median", and a
cumulative cap of "200 distinct *recurring* peers per rolling 7 days". Neither the
log's retention period nor any requirement to delete it is stated.

The rules imply seven days. Nothing says seven days is the maximum, and the
natural implementation — a table of rounds, appended to — retains everything
forever, because nothing tells the implementer to delete. §5 lists what the server
sees ("the peer pubkey of every conversation key it helps derive") as a property of
the mode; it does not say the server keeps it, and a reader would not conclude from
§5 that enabling co-signer mode creates a permanent record of the user's
correspondents on a machine that is, by §7.12's own scenario, expected to be
breached eventually. For NIP-04/44 those peer pubkeys are the social graph.

**Proposed fix:** §7.13 should add: "The per-requester log exists to enforce the
thresholds of this section and for the `AUDIT_DIGEST`. A co-signer MUST delete log
entries older than 30 days, and MUST NOT retain ECDH peer pubkeys beyond the 7-day
window the recurring-peer cap is computed over; counts and medians MAY be retained
as aggregates carrying no peer identity. A co-signer MUST state its retention
period at enrollment." §5's co-signer property list should gain: "The co-signer
retains a record of the peers the user derives conversation keys with, for the
period §7.13 requires. For NIP-04/44 that is the user's correspondent list, held
on the server, and a breach of the server discloses it."

### `t = 3` is offered by §7.18 and the epoch record cannot express it

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.18 (and §7.4, §7.9)
**Kind:** suspected error

§7.18 says "`t = 2` by default. A user with three or more independent trusted
devices MAY choose `t = 3`", and gives the share check as
"`share_i·G == group_pub + commitment·i` (§7.4's check generalised from the
co-signer's fixed `·2`)". The generalisation is over the *index* only. Everything
else in §7.4 is degree-1 and stays degree-1:

- The epoch record's content is `{epoch, t, group_pub, commitment: a_1·G, ...}` —
  one commitment. A `t = 3` polynomial is `f(x) = a_0 + a_1·x + a_2·x²` and its
  verifiable sharing needs `a_1·G` **and** `a_2·G`. There is no field for the
  second, so a `t = 3` member has nothing to verify its share against.
- The check itself is wrong at `t = 3`. It should be
  `share_i·G == group_pub + commitment_1·i + commitment_2·i²`. As written a member
  at `t = 3` either rejects a correct share or, if it skips the check, accepts a
  malformed one — and §7.5 makes that check the only thing standing between a
  mis-dealt share and a wiped nsec.
- §7.9's rotation delta is `δ(x) = r·x`, which re-randomises `a_1` and leaves
  `a_2` untouched for the lifetime of the key. At `t = 3` a rotation therefore
  rotates one of the two secret coefficients, and `commitment' = commitment + r·G`
  updates the one commitment the record has room for.
- §7.18's "Adding a device" has "two existing admitted devices each compute their
  Lagrange-weighted contribution to `f(k)`". At `t = 3` two contributions do not
  determine `f(k)`; three are needed.

The mode that `t = 3` exists for — "surviving any two devices being compromised" —
is the one where these matter most, and a client that implements §7.18 literally
ships a `t = 3` option that does not work.

**Proposed fix:** §7.4's epoch record should carry `commitments: [a_1·G, …,
a_{t−1}·G]` in place of the scalar `commitment`, and state the check as
`share_i·G == group_pub + Σ_{j=1}^{t−1} commitments[j]·i^j`, noting that at `t = 2`
this is the existing single-term form. §7.9 should give the delta as
`δ(x) = Σ_{j=1}^{t−1} r_j·x^j` with every `r_j` fresh and `δ(0) = 0`, and
`commitments'[j] = commitments[j] + r_j·G`. §7.18's "Adding a device" step 1 should
read "any `t` existing admitted devices". Alternatively, if `t = 3` is not intended
to be supported in this draft, §7.18 should say `t = 2` is fixed and give the
`t > 2` generalisation as future work.

### §5's "one lost device alone is inert" holds only after revocation

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §5 (device quorum), §7.18, §7.13
**Kind:** suspected error

§5 states for device quorum: "One lost device alone is inert — no honest device
will co-sign with a revoked `E` — until a second is taken." The clause after the
dash is the condition, and it is doing all the work: the device is inert once
**revoked**. Before revocation — which is to say for the whole period between a
compromise and the user noticing one — an unrevoked hostile device is the opposite
of inert. Every honest peer will complete a signing round for it, and §7.18 makes
ECDH "the same one round between two devices", so it will also complete decryption
rounds.

In co-signer mode this case is bounded, and §7.13 says exactly why the bounds are
real: the kind allowlist, the rate alerts, the 200-recurring-peer cap and the
500/hour ceiling "are enforceable rather than advisory because no device can answer
a round for another (§7.6)". §7.18 inverts that premise — every device answers
rounds for every other — and carries no replacement. It has no allowlist (there
are no `restricted` members, so the allowlist has no one to apply to), no rate
cap, no audit digest, and no requirement that the co-signing device show its user
anything or ask.

So the immediate exposure from one compromised device in a quorum is not the one
§5 and §7.18 name. Both name reconstruction ("a second compromised or colluding
device is the key"). The exposure that arrives first, needs no second device, and
is subject to no ceiling is posting as the user and reading every DM the user has
ever received — the same worst case §7.13 assigns to a hostile *restricted* origin
under a co-signer, minus every control that section relies on.

**Proposed fix:** §5's device-quorum list should replace the "inert" bullet with:
"**One compromised device signs and decrypts without limit until it is revoked.**
Honest peers answer its rounds; there is no server to refuse them, no allowlist, no
rate ceiling and no audit. A second compromised device additionally yields the key.
Revocation is the only control and it is forward-only, so the mode's safety depends
on the user noticing." §7.18's Signing paragraph should add: "A co-signing device
MUST apply §7.13's cumulative and hard ECDH ceilings to each peer `E.pub` it
answers for, MUST keep the same per-peer log, and MUST send the daily
`AUDIT_DIGEST` (kind 24317) to the other members. Because a device is not
continuously reachable these are per-peer-pair rather than global, and the section
should say so: they bound one hostile pairing, not the aggregate."

### §7.4's parity handling and the named ciphersuite's parity handling are two answers to one question

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.4 (and §7.5, §7.15)
**Kind:** ambiguity

§7.4 names the ciphersuite as "FROST per RFC 9591 with the secp256k1 Taproot
variant as implemented by `frost-secp256k1-tr`" and, in the same list item,
specifies parity handling of its own: "If `pubkey(nsec)` has odd y, the dealer uses
`a_0 = n − nsec` so the group key is even-y. On reconstruction the result is
`n − nsec` for an odd-y key; the client MUST re-negate before storing or
exporting."

`frost-secp256k1-tr` handles BIP-340's x-only negation itself — that is what the
`-tr` variant is for; it conditionally negates the group element and signers'
contributions at signing time so that signatures verify under an even-y x-only
group key. The specification therefore names two independent solutions to the same
problem and does not say which one is authoritative. An implementer who applies
both deals shares from a pre-negated `a_0` and then hands them to a library that
negates again. The result is a group key that is not the user's npub.

The failure mode is the reason this is worth fixing rather than leaving to
judgement. It is silent, it affects only odd-y keys so it passes roughly half of
casual testing, and it is discovered *after* §7.5 step 5 has wiped the local nsec
and every synced copy. Recovery is the §4.2 backup, if one was taken.

The choice also has a visible consequence: dealing from the raw `nsec` and letting
the ciphersuite own parity makes reconstruction yield `nsec` directly, at which
point §7.4's re-negation MUST and its restatement in §7.15 are wrong rather than
merely redundant.

**Proposed fix:** §7.4 should state one and delete the other. The narrower change
is to keep the dealer's negation and require the ciphersuite be driven with its own
parity handling in the configuration where the group key is used untweaked and
unmodified — which is also worth stating explicitly, since the crate's default is
to sign against the untweaked group key and NKM wants no BIP-341 tweak. The
cleaner change is: "The dealer sets `a_0 = nsec` unmodified. BIP-340 parity is the
ciphersuite's responsibility: `frost-secp256k1-tr` negates the group element and
signers' contributions as required, and the group key is used untweaked (no
BIP-341 tweak is applied). Reconstruction (§7.15) yields `nsec` directly and no
re-negation is performed." Either way §6 should gain a vector generated from an
**odd-y** nsec — group key, both shares, the epoch record and one verifying
signature — because that vector is the only thing that catches the wrong choice
before deployment.

*Note in passing, not a defect:* the untweaked group key is documented as
susceptible to a rogue-tweak attack at DKG time. NKM never runs a DKG — §7.5 is a
trusted dealer holding the whole nsec — so the caveat does not apply here, and the
dealer model is what makes untweaked use safe. Worth a sentence in §7.4 so a
reviewer who finds the caveat does not have to re-derive that.

### §7.9 step 4 is written for one server and the model has many

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.9 step 4 (and §7.4, §7.8, §7.2)
**Kind:** suspected error

§7.4 establishes that "every enrolled server holds a replica of share 1" and that
any number of servers is one share. §7.9 step 4 then says "**The server MUST
destroy the old-epoch share 1** — overwrite and verify, with no retained version
history, snapshot, backup or log line", and gives the reason: "A revoked device's
retained share 2 plus a surviving old share 1 is the key."

Singular. With `k` enrolled servers there are `k` copies of the old share 1, and
the property rotation exists to provide holds only if **every one** of them is
destroyed. The section provides no mechanism for that:

- Rotation's acknowledgement is `SHARE_ACK` (kind 24306) from *devices* applying
  their delta (step 3). No server acknowledges anything, so nothing distinguishes
  a rotation where every replica destroyed its old share from one where a replica
  was unreachable.
- Nothing says what an unreachable replica does when it returns. It holds a share 1
  on a dead polynomial and has missed `r`. If it later receives `r` and applies it
  it will be correct — and will have held the old share throughout the window that
  matters. If it is instead re-issued the current share 1 under §7.8, the section
  does not say the old one must be destroyed first.
- Nothing bounds `k`, and §7.2's advice against a second server from one operator
  is about *independence*, not about copies.

The compounding case is the ordinary one rather than an exotic one: a user revokes
a device *because* something went wrong, rotation reports success, and one replica
that happened to be down retains a share 1 that pairs with the retained share 2 for
as long as it stays down.

**Proposed fix:** §7.9 should add a server-side acknowledgement and gate completion
on it: "Every enrolled server MUST reply `SHARE_ACK {epoch}` after applying the
delta and destroying and verifying the overwrite of its old-epoch share 1. **A
rotation MUST NOT be reported complete until every enrolled server has acked.** A
server that has not acked within 24 hours is marked `stale` in the epoch record, is
refused as a co-signer by clients from that moment, and the lock (§7.16) shows
amber naming it. Re-admitting a stale replica is §7.8 issuance of the *current*
share 1 conditioned on the replica destroying and verifying the overwrite of every
prior share it holds — never a delta, which would leave the old share in place."
§7.2 should add that each additional server is an additional copy of share 1 and
therefore an additional place it can be stolen from, at an unchanged `t`.

### §7.8 releases share 1 on one device's authority; §7.14 releases the same share on two

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.8 (and §7.14, §7.1, §7.13)
**Kind:** suspected error

§7.14 Offline mode issues a device "a replica of **share 1**", and gates it
carefully: an `OFFLINE_REQUEST` to every other trusted device, an explicit tap on
one of them, a named prompt ("*Laptop* wants to hold your full key offline"), an
entry in the epoch record, and — where two-device approval is on — an `APPROVAL`.
The care is warranted: a holder of share 1 and share 2 is the key.

§7.8 issues the identical payload to a new *server*: "An existing server, on a
gift-wrapped instruction from a trusted device, wraps share 1 directly to the new
server's `S.pub`." One instruction, one device, no second approval, no prior epoch
record entry, no `APPROVAL` even where two-device approval is on, and no ceiling
on how many times it may happen.

The issuing server cannot supply the missing check itself, because `S.pub` and
`E.pub` are both secp256k1 public keys and the instruction is what asserts which
one this is. A hostile trusted device generates a fresh keypair, calls it a server,
and receives share 1 — at which point it holds both indices and is the key. §7.11
treats a lost trusted device as a Re-split case, which is right, but Re-split is
what the user does *after* noticing, and this path leaves nothing to notice with:
§7.13's audit log is a record of "signing and ECDH rounds", so an issuance appears
in it not at all.

The asymmetry is the finding. The same act — putting a replica of share 1 into a
new pair of hands — is two-device-gated and logged when the recipient is called a
device, and ungated and unlogged when the recipient is called a server.

**Proposed fix:** §7.8 should read: "Replica issuance requires an `APPROVAL` (kind
24311) from a second trusted device naming the target `S.pub`, on the same terms as
§7.14, and is available only where two or more trusted devices exist. The new
`S.pub` MUST appear in the current epoch's member list before any share is wrapped
to it, so the issuance is visible to every member and to the user's devices screen.
A co-signer MUST record every replica issuance in its §7.13 log and MUST include
issuances in the daily `AUDIT_DIGEST`. Clients SHOULD cap enrolled servers and MUST
show the count on the devices screen." §7.13's list of what a hostile *restricted*
device cannot do already excludes issuance; the section should add that a hostile
*trusted* device can, and that this is what the second approval is for.

### §7.15 disable and §7.14 Offline mode have no device-quorum meaning

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.18 (and §7.15, §7.14, §7.16, §7.5a)
**Kind:** suspected error

§7.18 says the device-quorum mode "shares §7.1 enrollment, §7.4's ciphersuite and
epoch records, and §4 backup, and differs as below", and the differences it lists
are parameters, activation, signing, adding a device, revocation, recovery and
security. §7.15 is not among them, so it applies as written — and as written it
cannot be performed:

> the device collects share 1 from a server (with an `APPROVAL` where two-device
> approval is on)

There is no server; §7.18 says so ("No index is reserved for a server; there is
none"). Step 1 has the same problem: "**Servers MUST delete share 1** and every
device MUST delete its share". A client implementing §7.18 has no defined way to
turn threshold signing off, which is the operation a user reaches for when the mode
is not working out — and §7.11 Re-split is defined as "§7.15 disable plus §7.5
re-activation", so device removal in the lost case inherits the gap.

§7.14 Offline mode has the mirror problem. Its mechanism is issuing the requester a
replica of share 1. In a quorum every index is unique, so the equivalent — handing
a second device's share to the requester — breaks the uniqueness invariant §7.18
states, and would leave two devices holding one index with no record of it. §7.16
accordingly lists an "Offline mode" lock state that is unreachable in this mode,
and §7.5a's keep-key option has the same difficulty.

**Proposed fix:** §7.18 should add to its list of differences: "**Disabling
(§7.15).** A trusted device collects `t − 1` other members' shares, reconstructs,
and stores the nsec per §2.1 before anything else; step 0's pre-rotation runs
jointly among the members that will remain. `DISABLE` (kind 24314) goes to every
member and every member deletes its share, `CK` and the group secret; no server
step applies. **Offline mode (§7.14) and keep-key (§7.5a) do not apply.** A device
that must sign with nothing else reachable cannot be served by this mode; that is
what §7.3 option B is for, and the §7.16 lock never shows the Offline state here."

### Rotation is automatic after revocation but not after enrollment, where the exposure is larger

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.9 (and §7.7, §7.18 "Adding a device")
**Kind:** design disagreement

§7.7 is candid that admission does not close the enrollment channel: "That
admission gates *signing*, not *reconstruction*: an intercepted share plus one
other share (share 1, §7.12) is the key, and revocation does not undo a
reconstruction. So the enrollment channel is load-bearing." §7.18 inherits this and
makes it worse — an intercepted unique share needs one more share of any index, and
the mode's own security note says a second device is the key.

§7.9 then lists when rotation happens by itself: "Automatic rotation runs on device
revocation, Offline-mode exit and after §7.10 recovery." Enrollment is not on the
list, although it is the moment at which a share crosses a channel the relay,
the server and the specification all agree is the weakest link in the design.

A rotation immediately after enrollment closes it almost entirely. The share is
issued on the current polynomial, the transfer completes, and the members —
including the new one, which is now an enrolled member reachable over an
authenticated `E.pub` — apply a delta. An intercepted copy of the transferred share
is dead from that point, so the enrollment channel is load-bearing for the duration
of one rotation rather than for the life of the key. The cost is one rotation per
device added, which is the same operation the same list already performs on every
device *removed*, and the surviving members are online in the enrollment case by
construction.

This is a design disagreement rather than an error: §7.7's statement is accurate
and the residual is disclosed. But the fix is one line in a list that already
exists, and it converts a permanent exposure into a bounded one.

**Proposed fix:** §7.9's last line should read "Automatic rotation runs on device
revocation, **device addition (§7.7, §7.18)**, Offline-mode exit and after §7.10
recovery." §7.7's paragraph should then end: "The enrollment channel is
load-bearing until the follow-on rotation completes, after which an intercepted
copy of the transferred share is on a dead polynomial. A client MUST NOT report
enrollment complete, and the lock (§7.16) MUST remain amber, until it has." §7.18's
"Adding a device" step 2 should carry the same sentence.

### §7.18 mandates two-round signing where §7.6's fix proposes one

*Merged with the §7.6 entry above on filing — see the note at the head of this
section.*

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.18 Signing (and §7.6)
**Kind:** ambiguity

This is the companion to "§7.6 does not specify the round structure of a signing
request" above, and it points the other way. §7.6 says nothing about round
structure; §7.18 says "Any two admitted, unrevoked devices run **the two-round
FROST signing of RFC 9591** with each other directly."

If §7.6 is settled as one round — the requester sends its own commitment with the
event, the co-signer returns its commitment and its share together, and no signing
nonce is ever persisted — then the two modes have different round structures for no
stated reason, and the mode that persists a nonce between rounds is the one where
that nonce sits on a phone rather than on a server. A phone is the worse host for
it: it is likelier to be restored from a backup, and a FROST nonce reused across
two distinct messages discloses the signer's share, which in a quorum is a unique
point rather than a replica.

The one-round form is available here for the same reason it is available in §7.6:
the initiator knows the message, so it can send `(event, D_i, E_i)` and the
responder can compute the binding factors, the group commitment and the challenge
and return `(D_j, E_j, z_j)` in one reply.

**Proposed fix:** §7.18's Signing paragraph should read "run the one-round exchange
of §7.6 with each other directly, the initiator as Coordinator, combining with
Lagrange coefficients over their indices," and inherit §7.6's nonce rule verbatim.
If the two-round form is retained for either mode, the corresponding section MUST
carry the nonce-persistence requirements proposed against §7.6 — persist, refuse a
second use, discard after a bounded lifetime — and say that the hazard is
disclosure of the signer's share.

### §7.18 does not forbid reusing a removed device's index

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.18 (Parameters, Adding a device)
**Kind:** ambiguity

"Each device holds a **unique** index `i ≥ 1`, never a replica … Indices are
assigned by the activating device and recorded per member in the epoch record."
Nothing says an index retired by a removal may not be assigned again, and the
obvious implementation — smallest free index — reuses it immediately.

Uniqueness is stated as a property of the current member set, and that is the
property signing needs. But a share is a `(index, scalar)` pair that outlives the
membership, and a removed device keeps its copy. Reuse means two holders of one
index across two polynomials, which is not directly exploitable while §7.18's rule
that revocation is always rotation is honoured, but which makes every reasoning
step about "the device at index 3" ambiguous — including the epoch record's own
history, an audit digest naming an index, and any recovery or forensic question
asked after the fact.

**Proposed fix:** §7.18's Parameters should add: "Indices are assigned
monotonically and are never reused. An index retired by a removal is retired
permanently; the epoch record retains retired indices so that a share presented at
one can be recognised as stale rather than as a member's."

### The replica scheme is the only flat-FROST way to say "a server and a device", and that is not stated

**Document:** NOSTR_KEY_MANAGEMENT.md
**Section:** §7.4 (and §7.2, §7.12)
**Kind:** design disagreement

§7.4 asserts the replica architecture — server at index 1, every device at index 2,
"replicas share an index and never combine", "the only valid signing pair is server
+ device" — and §7.2 argues its consequence socially: "Two servers from one
operator are one server … a second Cloudflare deployment adds availability and no
independence." Both are correct. Neither says *why* the scheme has to look like
this, and the reason is worth a paragraph because it also bounds what a reader may
reasonably ask for next.

FROST's access structure is a flat threshold: any `t` of `n` shares reconstruct,
and the scheme cannot express "at least one from set A **and** at least one from
set B", which is what "a server and a device" is. Replication is the encoding that
makes a flat threshold behave like that conjunction — collapse each class to one
share and set `t = 2` — and with the named ciphersuite it is the only one. The
alternative that would give genuine multi-server independence is a nested sharing:
split `nsec = s_A + s_B` additively, Shamir `s_A` among servers at `t_A` and `s_B`
among devices at `t_B`, so that `t_A` servers and `t_B` devices are jointly
required. That is not RFC 9591, is not in `frost-secp256k1-tr`, and would be a
construction this project would own rather than cite.

Two things follow that the document currently leaves the reader to work out. Adding
servers cannot raise the threshold — `t` is fixed at 2 by the conjunction — so each
additional server is an additional copy of share 1 at unchanged difficulty, which
means the probability that share 1 is stolen grows with the number of servers while
the protection it buys does not. And a user asking the natural question — "can I
require two of my three servers?" — is asking for something the ciphersuite cannot
do, which is a better answer than the one §7.2's independence argument implies,
which sounds like a matter of operator diversity.

**Proposed fix:** §7.4 should preface the index list with: "FROST's access
structure is a flat threshold, so 'a server **and** a device' cannot be expressed
as `t`-of-`n` directly. Replication is the encoding: each class collapses to one
share, `t = 2`, and the conjunction falls out. A structure requiring `t_A` of the
servers and `t_B` of the devices would need a nested sharing outside RFC 9591 and
is not offered." §7.2's "two servers from one operator are one server" paragraph
should add: "Independence is not the only cost. Because all servers replicate share
1, each additional server is an additional place share 1 can be stolen from while
`t` stays at 2. Servers buy availability and are paid for in exposure; enroll the
fewest that meet your availability need."

---

## 5. What I cannot answer without you

**Is hearth going to grow a device list at all?** Everything in §1.3 is
speculative without one. Stage 2 is a table and two management methods in service
of a client feature that does not exist and may never; built early it is code
maintained against a draft whose event kinds are explicitly unregistered.

**Do you intend bothy to be a `@qrst/server` target, or to stay out of that
repository's plans entirely?** IMPLEMENTATION.md §9 item 4 asks whether the §7
server "is in scope for you at all", and item 5 asks what relationship the library
has to the existing client. My answer to the co-signer question assumes bothy is
not that server. If the plan is that bothy *is* the reference server, then §2.1 and
§2.5 are objections to the plan rather than to a proposal, and you would want to
hear them in that frame.

**Whose specification is this?** Both repositories are yours as far as I can tell,
which changes what a spec issue is for. Filed against somebody else's spec, §4's
entries are requests. Filed against your own, they are a to-do list, and two of
them (the `/v1/salt` factor list, and `K_auth`'s binding to the base URL) are
things I would fix before
anybody implements against the draft rather than filing.

**Would you accept the co-signer as a separate Worker in a separate Cloudflare
account?** My recommendation is "not in bothy", not "not at all", and the two are
easy to conflate. A standalone co-signer avoids §2.5 entirely (it is not a relay
and holds no promise about not seeing correspondents), avoids §2.2's origin
problem if it serves no client, and still runs into §2.1 — so it would want a
storage backend with controllable retention, which on Cloudflare probably means
not a Durable Object.

**How much do you weigh the thirty-day PITR window?** I have treated it as
decisive. A counter-argument exists and I do not find it convincing but you might:
the window only matters against an adversary who already has the Cloudflare
account, and such an adversary can serve modified client code tomorrow anyway. My
reason for rejecting that is that it proves too much — it would excuse any
server-side failure on a platform the owner controls — and that §7.9's whole
construction is written to make a *revoked device* harmless, which is a different
adversary from the account holder.

**Is `EPHEMERAL_CHAT`'s reporting-mode pattern the shape you would want for any of
this?** The one thing I did not consider is whether a carriage change should ship
in a mode that reports what it would accept without accepting it. It fits this
project's habits and I could not see what it would be measuring here, since the
question is not "how much would this cost" but "should the relay hold this at all".

**Do you want the two roles bothy already fills written into the README, or left
in this document?** §2.4's "a relay the user controls" is a genuine, filled,
undocumented role and it is the sort of thing the README's existing sentence about
direct messages already gestures at. But it is also a claim about an external
draft, and the README does not currently make claims about drafts.

---

## Appendix — figures used, and which of them I checked

Checked live against Cloudflare's documentation on 2026-09-02, per this project's
convention of verifying platform limits rather than trusting a cached number:
Workers Free at 100,000 requests/day, 10ms CPU per request, 50 subrequests per
request; SQLite-backed Durable Objects at 30 seconds of active CPU per request,
100 bound parameters per query, and point-in-time recovery over the whole database
for the past 30 days.

Taken from this repository without re-measuring: the rows-written formula (9 + 3
per single-letter tag measured, 12 + 4 charged), `MAX_FILTER_ROWS_READ` = 10,000,
`MAX_EVENT_BYTES` = 64KB, `GIFT_WRAP_STORAGE_SHARE` = one fortieth of 5GB, and the
resulting `maxGiftWraps` of 2,048 at the defaults.

One number in CLAUDE.md may want checking and is outside this assessment's scope:
"The budget" states 5GB of SQLite storage per Durable Object, while the limits page
read today describes the Free plan as 1GB per object within a 5GB account-wide cap.
`STORAGE_BYTES_LIMIT` is 5GB, so `NON_OWNER_STORAGE_SHARE_LIMIT` and
`GIFT_WRAP_STORAGE_SHARE` are both derived from the larger figure. If the per-object
limit is really 1GB the caps are five times looser than intended, and the gift wrap
inbox cap in particular would be sized against storage the object cannot have. I did
not verify this beyond one documentation read and it should not be acted on
without one.
