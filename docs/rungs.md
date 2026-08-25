# The write ladder

A relay's write policy as a ladder of rungs, from most closed to most open.
Each rung is defined by *who may write* and *what bounds the volume*.

1. **Owner only.** Accepts only events signed by the relay's owner.
   Bounded by: the owner's own posting rate.

2. **Owner + addressed mail.** Adds sealed/encrypted messages from anyone,
   addressed to the owner. Bounded by: per-message size, storage reserved
   for this class, and a per-sender rate limit.

3. **Owner's follows may write.** Adds any event signed by a pubkey in the
   owner's published contact list. Bounded by: the size of that list.

4. **Anyone, if it concerns the owner.** Adds any author, but the event
   must reference or address the owner. Bounded by: how many people
   mention the owner.

--- the cliff ---

5. **Open relay.** Accepts anything from anyone.
   Bounded by: nothing.

## Why the cliff sits between 4 and 5

Rungs 1-4 each have a bound tied to a real-world quantity. Rung 5 has
none. That is a difference in kind, not degree: rungs 1-4 all sit in a
similar, bounded cost regime, while rung 5's resource use is unbounded.
The ladder is not a smooth gradient of expense — it is a run of bounded
rungs and then a cliff.

Note the ladder is monotonic in *who*, not in *volume*: an earlier rung
can admit fewer people to write anything at all, while a later rung
admits everyone but only to write things addressed to the owner. By the
dimension that costs resources, the narrower-audience rung is not always
the cheaper one.

## The filter ladder underneath it

Opening a rung raises the question of how to close it again on an
individual. Filters sort by what they need to know, and that ordering
cuts across the rungs above:

1. **Free** — derived from something the owner already published.
   Read from local storage the relay already has. No outbound
   connection needed.

2. **Cheap** — derived from the event itself. Kind, size, tags, tag
   count, proof-of-work. Already in hand at validation time.

3. **Expensive** — derived from facts about the *author* that the event
   does not carry. Profile presence, domain verification, blocklists,
   web-of-trust scores. These require fetching data about the author,
   which means an outbound connection made at write time.

Tier 3 is expensive for architectural reasons as much as quota reasons:
whether a relay can afford it depends on whether its write path is even
able to make outbound connections.
