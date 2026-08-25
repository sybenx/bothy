# The write ladder

Bothy's write policy as a ladder of rungs, from most closed to most open.
Each rung is defined by *who may write* and *what bounds the volume*.

1. **Outbox only.** Accepts owner-signed events and nothing else.
   Bounded by: the owner's own posting rate. Status: the base case.

2. **Outbox + sealed mail.** Adds kind-1059 gift wraps (NIP-59) from
   anyone, p-tagged to the owner. Bounded by: MAX_GIFT_WRAPS (2000),
   64KB/event, 5 per minute per IP. Status: **shipped — bothy today.**

3. **Follows may write.** Adds any event signed by a pubkey in the
   owner's kind-3 contact list. Bounded by: follow-list size.
   Status: built, off by default behind ALLOW_FOLLOWS.

4. **Anyone, if it concerns the owner.** Adds any author, but the event
   must p-tag the owner. Bounded by: how many people mention you.
   Status: not built. `handleGiftWrap`'s gate generalizes to it.

--- the cliff ---

5. **Open relay.** Accepts anything from anyone.
   Bounded by: nothing. Status: refused on free tier.

## Why the cliff sits between 4 and 5

Rungs 1-4 each have a bound tied to a real-world quantity. Rung 5 has
none. That is a difference in kind, not degree: rungs 1-4 all sit in the
same cost regime with a wide margin, and rung 5 exceeds the free tier in
minutes. The ladder is not a gradient of expense — it is four cheap rungs
and a cliff.

Rows-written is the only ceiling that binds (100,000/day, ~5-9 rows per
event, so roughly 11,000-20,000 events/day). Requests, duration, reads
and storage all have slack. Incoming WebSocket messages bill at 20:1.

Note the ladder is monotonic in *who*, not in *volume*: rung 3 lets a few
hundred people write anything, rung 4 lets everyone write only things
addressed to the owner. By the dimension that costs money, rung 4 is the
narrower door.

## The filter ladder underneath it

Opening a rung raises the question of how to close it again on an
individual. Filters sort by what they need to know, and that ordering
cuts across the rungs above:

1. **Free** — derived from something the owner already published.
   Follows (kind 3), trusted-provider declarations (kind 10040). Read
   from local storage on the existing cron. No outbound connection.

2. **Cheap** — derived from the event itself. Kind, size, p-tag, tag
   count, proof-of-work (NIP-13). Already in hand at validation time.

3. **Expensive** — derived from facts about the *author* that the event
   does not carry. NIP-05 presence, NIP-05 verification, domain
   blocklists, web-of-trust scores. All require the author's kind-0 or an
   HTTPS fetch, which means an outbound connection, which the Durable
   Object cannot make without breaking hibernation.

Tier 3 is expensive for architectural reasons, not quota reasons. That is
why the ladder stops where it does.
