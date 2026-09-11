# Design principles

What we hold a change to bothy against. Internal: this is for the people
building the relay, not for the people running one, and it is not
rendered on the site. Its sibling is [rungs.md](rungs.md), which does
the same job for the write policy alone.

Each section states the principle, then what it means here. "Here" is
the handful of surfaces a person actually meets: the admin page, the
management commands and what they answer, the README, the refusal a
client shows them, the environment variables, and the NIP-11 document.

## Most advanced yet acceptable

People take on something new only as far as it is anchored in something
they already know. Go as far as they will still accept, and no further.
The familiar form goes on the outside; the new thing goes inside it; one
new idea per surface. This is the principle the rest of this document
serves, and it is the one nostr as a whole most often fails: a newcomer
is handed a key, an address, a server and a vocabulary all at once, with
nothing familiar to hold any of them by.

**For bothy.** One rule, with three faces.

- *Words.* Every noun a person meets maps to one they already own:
  address, key, inbox, mail, notes, server. The nostr word appears once,
  beside the familiar one, where the person's client will show it
  ("your address, the `npub`"), and never as the only name for a thing.
- *Steps.* Every step looks like one they have done elsewhere: install,
  sign in, share a link. The deploy button is installing. The claim is
  signing in. The `wss://` URL is your address, and copying it into a
  client is sharing it.
- *The thing itself.* "Your own relay" is presented as a familiar thing,
  your own archive and your own inbox, with the relay as what makes it
  work. A newcomer finishes setup without having learned what a relay
  is, and learns it later if they want to.

The rule: one unfamiliar idea per surface, and it is the one the person
came for. A page, a step or a sentence that asks them to accept two is
not done.

## Interface

### Clarity, deference, depth

Text is legible, controls are precise, and everything on screen has a
purpose. The interface helps people understand the content and never
competes with it. Layering and motion convey where things are and what
matters more.

**For bothy.** The admin page is a status page. It shows what the relay is
doing and nothing that exists to be looked at. If a line does not change a
decision the owner might make in the next minute, it does not belong on
the page.

### Consistency

People learn a thing once and expect it to hold everywhere. The same
word for the same concept, the same place for the same control, the same
behaviour for the same gesture.

**For bothy.** One name per thing, used identically on the admin page, in
the command that changes it, in the response the command gives, on
`/api/stats` and in the README. `follows` is `follows` in all six places.
When a name changes, it changes in all six in the same commit.

### Feedback and forgiveness

Every action gets an immediate, visible response. Actions are reversible,
and the few that are not are made hard to do by accident, with one
warning that says exactly what will happen.

**For bothy.** Every write is answered with `OK` and a reason. Every
management call answers with a result and, where it matters, what is now
in force. The irreversible actions are known and each gets exactly one
confirmation: blocking your own address, opening the relay to everyone,
and the claim. One confirmation, never two, and the confirmation names
the consequence rather than asking "are you sure".

### Sensible defaults and progressive disclosure

Avoid a setting where the right value can be inferred. Make the default
the choice most people want. Put the rest where it is found when needed
and not before: the common thing first, the rest revealed as the person
goes looking.

**For bothy.** A fresh deploy asks for one thing, a project name. The
default write policy is the one we recommend, not a placeholder to be
configured. Environment variables exist for the operator who needs them
and are listed in a table, not in the setup steps. The management API is
documented after the relay already works.

### Perceived stability

The interface does not move or change shape under the person. Controls
stay where they were; things that looked one way yesterday look that way
today.

**For bothy.** Field names on `/api/stats`, management method names,
environment variable names and stored settings are stable once shipped.
Renaming one is a migration, with a line in the README saying what to set
instead, the way the `ALLOW_FOLLOWS` line does.

## Product

### Saying no

Progress is made by removing things. A product is defined as much by
what it leaves out as by what it does, and leaving something out is a
decision made on purpose, not a gap.

**For bothy.** "What it refuses to be" in CLAUDE.md is a feature of the
product, not a list of missing work. Each entry is a decision. A request
for something on that list is answered with the decision, in the product
itself where possible: the kind allowlist methods explain why they are
absent instead of saying "unknown method".

### One way to do a thing

One control for one action. No aliases, no shortcuts that duplicate a
longer path, no two names for the same setting.

**For bothy.** One command per action. `changewritepolicy` takes a name;
it does not also take a number. There is one environment variable for the
write policy, not two that mean the same thing. Where an older way existed,
it is removed and documented as removed rather than kept as a synonym.

### Hide the mechanism, show the outcome

Internals stay off the surface. The person sees what the thing does for
them, not how it does it.

**For bothy.** The owner sees "You and the 336 people you follow can
publish here." They do not see the ladder, the rung, the follow cache, the
partition, or the name of the command that would change it. Internal
vocabulary (rung, partition, scope, budget) stays in code comments,
CLAUDE.md and the docs folder. If a user-facing string needs an internal
word to make sense, the string is wrong.

### Simplicity is refinement, not the starting point

Simplicity is what is left after every unnecessary part has been
removed, which is slower and harder than adding. Most of the work is in
the smallest details.

**For bothy.** A feature is done when its public surface fits in one
sentence. If explaining it to the owner takes a paragraph, it is not done;
the paragraph is the list of what still has to be removed. The admin page
line for the write policy went from four sentences to one, and the one is
the design.

### It just works

The thing does the right thing without being told, inferring what it can
from what the person has already done.

**For bothy.** The relay claims itself from a pasted npub. The follow list
comes from the kind-3 the owner's client already publishes; nobody
maintains a second list. Backfill starts from the relay list the owner
already has. Nothing asks for information the network already holds.

## Writing

### Plain language, second person, verbs

Choose simple, plain language. Avoid jargon. Write to the person as
"you". Label actions with verbs. Keep every word that is necessary and no
others. Feature names are capitalised consistently and never used as
verbs.

**For bothy.** User-facing text is written to "you". No NIP numbers on the
admin page; "encrypted mail" rather than "kind-1059 gift wraps" where the
person is not a developer. The README's headings are things you do or
things that are true, and its paragraphs are instructions. Reasoning goes
in code comments and the docs folder, never in the README unless it is a
choice the owner would want to know they are making.

### Errors say what would have worked

An error names the boundary that refused the action and what would have
been accepted. Interjections ("oops") are unnecessary and sound
insincere. If language alone cannot address an error that many people
will hit, the interaction is what needs rethinking.

**For bothy.** A refusal on the wire names the boundary that refused it:
"only the owner and people they follow can publish here", "may carry at
most 32 indexed tags". A management error names the accepted values. If a
refusal keeps happening to people who meant well, the fix is in the
design, not in a longer message.

### Say what is now true

After an action, show the new state rather than narrating the action.

**For bothy.** A `change*` response ends by stating what is now in force,
because that is the question the owner has. The admin page shows the
current state and never a history of how it got there.

## Engineering

### One owner

Every feature and every decision has a single owner. Not a committee,
not two people sharing it.

**For bothy.** One contributor, one `main`, no branches and no pull
requests. Every decision has an owner because there is only one. A
change made by an assistant is still that person's decision, made before
the work, not discovered after it.

### Ship when it is right; never advertise the half-built

What ships is finished; what is not finished is not mentioned. Public
code does not change this: the code can be open while the claims wait
for the thing to work.

**For bothy.** The code is public; the claims are not made until the thing
works. Group support is in the tree, tested, and paused behind a switch
that defaults off, and the README says so in two sentences. A feature can
land before it is claimed. It is never claimed before it lands.

### Open source, decided direction

Input is welcome and the direction is not up for vote. Proposals are
public; the owner decides, and decides against the vision and coherence
of the whole.

**For bothy.** A change is judged against this document and
[rungs.md](rungs.md). A contribution that adds a second way to do
something, or puts a mechanism on the surface, is declined with a pointer
here rather than merged with a caveat.

### Small, whole changes

Each release is complete in itself. A feature is either in or out; it is
not half in with a flag to finish it later.

**For bothy.** One commit per decision. A commit that changes behaviour
bumps the version. A switch that defaults off is a shipped decision to
pause, not a way to merge something unfinished.

### Compatibility is a discipline

Old things keep working across years of change, and when something has
to break, say so a release ahead.

**For bothy.** A stored setting, a stats field, a command name or an
environment variable, once shipped, keeps working or is replaced with a
documented line saying what to use instead. Storage survives every
deploy. Nothing an existing relay relies on changes silently.

## The checklist

Before a change lands, each of these gets a one-word answer, and the
answer to every one is no.

1. Does any surface ask the person to accept more than one unfamiliar
   thing, or use a nostr word where a familiar one would do?
2. Does the person see a mechanism (a rung, a cache, a partition, a kind
   number) where they should see an outcome?
3. Is there now more than one way to do this thing?
4. Is the default a placeholder rather than the recommendation?
5. Does an error say what went wrong without saying what would have
   worked?
6. Does an irreversible action have zero confirmations, or two?
7. Does the README explain a reason where it should give an instruction?
8. Does the admin page show something that changes no decision?
9. Does a name differ between the page, the command, the response, the
   stats and the README?
10. Is anything claimed that does not yet work?
11. Does anything an existing relay relies on change without a migration
    line?
