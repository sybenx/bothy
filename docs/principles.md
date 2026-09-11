# Design principles

What we hold a change to bothy against, drawn from how Apple designs,
writes and ships. Internal: this is for the people building the relay,
not for the people running one, and it is not rendered on the site. Its
sibling is [rungs.md](rungs.md), which does the same job for the write
policy alone.

Each section states Apple's practice and where it comes from, then what it
means here. "Here" is the handful of surfaces a person actually meets:
the admin page, the management commands and what they answer, the README,
the refusal a client shows them, the environment variables, and the NIP-11
document.

## Interface

### Clarity, deference, depth

The three themes the Human Interface Guidelines have used since iOS 7.
Clarity: text is legible, icons are precise, everything on screen has a
purpose. Deference: the interface helps people understand and interact
with the content and never competes with it. Depth: visual layers and
motion convey hierarchy and position.

**For bothy.** The admin page is a status page. It shows what the relay is
doing and nothing that exists to be looked at. If a line does not change a
decision the owner might make in the next minute, it does not belong on
the page.

### Consistency

From the original Macintosh guidelines and still in the HIG: people learn
a thing once and expect it to hold everywhere. The same word for the same
concept, the same place for the same control, the same behaviour for the
same gesture.

**For bothy.** One name per thing, used identically on the admin page, in
the command that changes it, in the response the command gives, on
`/api/stats` and in the README. `follows` is `follows` in all six places.
When a name changes, it changes in all six in the same commit.

### Feedback and forgiveness

Two more of the classic principles. Feedback: every action gets an
immediate, visible response. Forgiveness: actions are reversible, and the
few that are not are made hard to do by accident, with one warning that
says exactly what will happen.

**For bothy.** Every write is answered with `OK` and a reason. Every
management call answers with a result and, where it matters, what is now
in force. The irreversible actions are known and each gets exactly one
confirmation: blocking your own address, opening the relay to everyone,
and the claim. One confirmation, never two, and the confirmation names
the consequence rather than asking "are you sure".

### Sensible defaults and progressive disclosure

The HIG's guidance on settings is to avoid them where the app can infer
the right value, to make the default the choice most people want, and to
put the rest where it is found when needed and not before. Show the
common thing first; reveal the rest as the person goes looking.

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

Jobs: "We make progress by eliminating things." Apple's products are
defined as much by what they leave out as by what they do, and leaving
something out is a decision made on purpose, not a gap.

**For bothy.** "What it refuses to be" in CLAUDE.md is a feature of the
product, not a list of missing work. Each entry is a decision. A request
for something on that list is answered with the decision, in the product
itself where possible: the kind allowlist methods explain why they are
absent instead of saying "unknown method".

### One way to do a thing

Apple ships one control for one action. No aliases, no shortcuts that
duplicate a longer path, no two names for the same setting.

**For bothy.** One command per action. `changewritepolicy` takes a name;
it does not also take a number. There is one environment variable for the
write policy, not two that mean the same thing. Where an older way existed,
it is removed and documented as removed rather than kept as a synonym.

### Hide the mechanism, show the outcome

Apple does not put its internals on the surface. macOS does not list the
commands Terminal accepts on the desktop; a phone does not tell you which
radio it is using. The person sees what the thing does for them.

**For bothy.** The owner sees "You and the 336 people you follow can
publish here." They do not see the ladder, the rung, the follow cache, the
partition, or the name of the command that would change it. Internal
vocabulary (rung, partition, scope, budget) stays in code comments,
CLAUDE.md and the docs folder. If a user-facing string needs an internal
word to make sense, the string is wrong.

### Simplicity is refinement, not the starting point

Ive's account of Apple's process: simplicity is what is left after every
unnecessary part has been removed, which is slower and harder than
adding. "So much of what we do is worry about the smallest of details."

**For bothy.** A feature is done when its public surface fits in one
sentence. If explaining it to the owner takes a paragraph, it is not done;
the paragraph is the list of what still has to be removed. The admin page
line for the write policy went from four sentences to one, and the one is
the design.

### It just works

The thing does the right thing without being told. Apple's products
infer what they can from what the person has already done.

**For bothy.** The relay claims itself from a pasted npub. The follow list
comes from the kind-3 the owner's client already publishes; nobody
maintains a second list. Backfill starts from the relay list the owner
already has. Nothing asks for information the network already holds.

## Writing

### Plain language, second person, verbs

The HIG's writing guidance: choose simple, plain language; avoid jargon;
write to the person as "you"; label actions with verbs; keep every word
that is necessary and no others. The Apple Style Guide adds that feature
names are capitalised consistently and never used as verbs.

**For bothy.** User-facing text is written to "you". No NIP numbers on the
admin page; "encrypted mail" rather than "kind-1059 gift wraps" where the
person is not a developer. The README's headings are things you do or
things that are true, and its paragraphs are instructions. Reasoning goes
in code comments and CLAUDE.md, never in the README unless it is a choice
the owner would want to know they are making.

### Errors say what would have worked

The HIG on alerts: interjections like "oops" are unnecessary and sound
insincere. And: "if language alone can't address an error that's likely to
affect many people, that's an opportunity to rethink the interaction."

**For bothy.** A refusal on the wire names the boundary that refused it:
"only the owner and people they follow can publish here", "may carry at
most 32 indexed tags". A management error names the accepted values. If a
refusal keeps happening to people who meant well, the fix is in the
design, not in a longer message.

### Say what is now true

After an action, Apple's interfaces show the new state rather than
narrating the action.

**For bothy.** A `change*` response ends by stating what is now in force,
because that is the question the owner has. The admin page shows the
current state and never a history of how it got there.

## Engineering

### One directly responsible individual

Apple assigns a single owner to every feature and every decision. Not a
committee, not two people sharing it.

**For bothy.** One contributor, one `main`, no branches and no pull
requests. Every decision has an owner because there is only one. A
change made by an assistant is still that person's decision, made before
the work, not discovered after it.

### Ship when it is right; never advertise the half-built

Apple does not iterate in public. What ships is finished; what is not
finished is not mentioned. This is the part of "secrecy" that survives
contact with open source: Swift, WebKit, Darwin, FoundationDB, MLX and
Pkl are all public code, ALAC was open-sourced in 2011, ProRes is a
published SMPTE document, and Apple sits in the Alliance for Open Media.
None of that changes what gets announced or when.

**For bothy.** The code is public; the claims are not made until the thing
works. Group support is in the tree, tested, and paused behind a switch
that defaults off, and the README says so in two sentences. A feature can
land before it is claimed. It is never claimed before it lands.

### Open source, decided direction

Swift's evolution process states two goals: engage the wider community,
and "maintain the vision and conceptual coherence of Swift". Proposals are
public; the steering groups decide.

**For bothy.** Input is welcome and the direction is not up for vote. A
change is judged against this document and [rungs.md](rungs.md). A
contribution that adds a second way to do something, or puts a mechanism
on the surface, is declined with a pointer here rather than merged with a
caveat.

### Small, whole changes

Each Apple release is complete in itself. A feature is either in or out;
it is not half in with a flag to finish it later.

**For bothy.** One commit per decision. A commit that changes behaviour
bumps the version. A switch that defaults off is a shipped decision to
pause, not a way to merge something unfinished.

### Compatibility is a discipline

Apple keeps old software working across years of platform change, and
when it breaks something it says so a release ahead.

**For bothy.** A stored setting, a stats field, a command name or an
environment variable, once shipped, keeps working or is replaced with a
documented line saying what to use instead. Storage survives every
deploy. Nothing an existing relay relies on changes silently.

## The checklist

Before a change lands, each of these gets a one-word answer, and the
answer to every one is no.

1. Does the person see a mechanism (a rung, a cache, a partition, a kind
   number) where they should see an outcome?
2. Is there now more than one way to do this thing?
3. Is the default a placeholder rather than the recommendation?
4. Does an error say what went wrong without saying what would have
   worked?
5. Does an irreversible action have zero confirmations, or two?
6. Does the README explain a reason where it should give an instruction?
7. Does the admin page show something that changes no decision?
8. Does a name differ between the page, the command, the response, the
   stats and the README?
9. Is anything claimed that does not yet work?
10. Does anything an existing relay relies on change without a migration
    line?

## Sources

- Apple, Human Interface Guidelines: Foundations, Writing; Patterns,
  Settings; the iOS design themes (clarity, deference, depth).
- Apple, Human Interface Guidelines (Macintosh, 1987 onward): consistency,
  feedback, forgiveness, perceived stability, aesthetic integrity.
- Apple Style Guide, current edition: second person, plain language,
  capitalisation of feature names.
- swiftlang/swift-evolution, `process.md`: the two stated goals and the
  pitch/review/decision stages.
- Apple Lossless Audio Codec, open-sourced under Apache 2.0, 27 October
  2011. Apple ProRes, SMPTE RDD 36:2015. Apple joined the Alliance for Open
  Media, January 2018.
- Steve Jobs, "We make progress by eliminating things", as quoted in
  Smithsonian Magazine's account of Apple's design under Jobs. Jony Ive,
  "So much of what we do is worry about the smallest of details", from
  interviews on Apple's design process.
