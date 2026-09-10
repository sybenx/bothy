// The write ladder (docs/rungs.md), as this relay enforces it.
//
// docs/rungs.md describes a relay's write policy as a ladder of rungs,
// each defined by WHO may write and WHAT BOUNDS THE VOLUME, running from
// owner-only up to an open relay -- with a cliff between rungs 4 and 5,
// because rungs 1-4 each have a bound tied to a real-world quantity and
// rung 5 has none. This file is that ladder made concrete: one integer,
// resolved through the same chain the relay's name and icon resolve
// through (nip11.ts), consulted by ownership.ts isAllowedWriter on every
// non-owner write and by relay.ts handleGiftWrap on every gift wrap.
//
// The rungs are CUMULATIVE. Each admits everything the one below it
// admits and one more class of writer, so a relay at rung 3 accepts the
// owner (1), addressed mail (2) and the owner's follows (3). That is what
// makes "which rung" a single number rather than a set of flags, and it
// is the property the tests pin: raising the rung can only widen who
// gets in, lowering it can only narrow.
//
//   1  owner     Only events signed by the relay's owner.
//                Bounded by the owner's own posting rate.
//   2  inbox     + NIP-59 gift wraps from anyone, p-tagged to the owner
//                (relay.ts handleGiftWrap). Bounded by MAX_EVENT_BYTES,
//                the gift wrap storage share and the per-IP wrap throttle
//                (limits.ts).
//   3  follows   + any event signed by a pubkey in the owner's kind-3
//                contact list (ownership.ts refreshFollows). Bounded by
//                the size of that list.
//   4  mentions  + any event, from any author, that p-tags the owner.
//                Bounded by how many people mention the owner -- and,
//                because "anyone" can choose that number, by
//                MAX_MENTION_EVENT_INDEXED_TAGS below on top of the
//                per-event caps every non-owner write already pays.
//   5  open      Never. There is no rung 5 in this file, and asking for
//                one (nip86.ts changewritepolicy) is refused with the
//                explanation rather than with "unknown".
//
// The explicit allowlist (NIP-86 allowpubkey) is not a rung. docs/rungs.md
// puts named individuals inside rung 1 -- the owner deciding, by hand,
// exactly who else may write -- so an allowed pubkey writes at EVERY
// rung, and the rung says who ELSE does. banpubkey is the mirror image:
// a banned pubkey is refused at every rung, follows and mentions
// included, because a ban is the owner closing the door on one person
// whatever the door's general setting is.
//
// Why the number lives in three places. `WRITE_RUNG` in the environment
// is for an operator who configures in the dashboard and wants the
// policy pinned there, where a stored value cannot quietly override it;
// the stored value (NIP-86 changewritepolicy, relay_settings) is for the
// owner moving the ladder from a client without a redeploy; the default
// is rung 3, which is the policy this relay has shipped with since
// ALLOW_FOLLOWS became an opt-out and is what an unconfigured relay
// keeps doing. `ALLOW_FOLLOWS=false`, the variable that used to be the
// only way to narrow writes, is read as rung 2 -- the rung that variable
// actually produced, since gift wraps were accepted under it -- and sits
// below WRITE_RUNG in the chain so a relay that sets both gets the one
// that names a rung.

import { pTagValues, isIndexedTag, type NostrEvent } from "./nostr";
import { MAX_MENTION_EVENT_INDEXED_TAGS } from "./limits";

export type WriteRung = 1 | 2 | 3 | 4;

// The one place the names live. Short, because they are what an operator
// types (`nak admin changewritepolicy follows`) and what the admin page
// shows; and nouns naming the class of writer the rung adds, because
// "what changes at this rung" is the question a person choosing one is
// asking.
export const RUNG_NAMES: Readonly<Record<WriteRung, string>> = {
  1: "owner",
  2: "inbox",
  3: "follows",
  4: "mentions",
};

// One sentence per rung, in the voice of the ladder document, used by
// getwritepolicy and by the admin page. Written for the person reading
// their own relay's status rather than for a developer.
export const RUNG_DESCRIPTIONS: Readonly<Record<WriteRung, string>> = {
  1: "Only the owner can publish here.",
  2: "Only the owner can publish here, plus gift-wrapped mail addressed to them from anyone.",
  3: "The owner, gift-wrapped mail addressed to them, and the people the owner follows can publish here.",
  4: "The owner, gift-wrapped mail, the people the owner follows, and anyone whose event mentions the owner can publish here.",
};

export const DEFAULT_WRITE_RUNG: WriteRung = 3;
export const MAX_WRITE_RUNG: WriteRung = 4;

// The rung at which each class of writer is admitted. Named so the
// comparisons in isAllowedWriter read as the policy they enforce rather
// than as magic numbers, and so the cumulative property is one place:
// "rung >= INBOX_RUNG" is the whole test for whether gift wraps are
// accepted, whatever rung above it is in force.
export const OWNER_RUNG: WriteRung = 1;
export const INBOX_RUNG: WriteRung = 2;
export const FOLLOWS_RUNG: WriteRung = 3;
export const MENTIONS_RUNG: WriteRung = 4;

// Where the effective rung came from, for getwritepolicy and /api/stats.
// An operator whose changewritepolicy call appears to do nothing needs
// to be told that WRITE_RUNG in the dashboard is what is winning, and
// this is how the answer reaches them.
export type WriteRungSource = "env" | "legacy-env" | "stored" | "default";

export interface ResolvedWriteRung {
  rung: WriteRung;
  source: WriteRungSource;
}

// The result of parsing an operator-supplied rung -- a number, a name,
// or one of the shapes that gets an explanation rather than a rung.
export type ParsedRung =
  | { ok: true; rung: WriteRung }
  | { ok: false; reason: "open" | "malformed" };

// Accepts "1".."4", the bare number, or a rung name, case-insensitively
// and with surrounding whitespace ignored, since the value may come from
// a dashboard text field or a shell argument. "5" and "open" are
// recognised so they can be refused BY NAME: the ladder document is
// explicit that rung 5 is a cliff rather than a step, and an operator
// asking for it should be told that, not "malformed".
export function parseRung(value: unknown): ParsedRung {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "5" || raw === "open") return { ok: false, reason: "open" };
  if (/^[1-4]$/.test(raw)) return { ok: true, rung: Number(raw) as WriteRung };
  for (const [rung, name] of Object.entries(RUNG_NAMES)) {
    if (raw === name) return { ok: true, rung: Number(rung) as WriteRung };
  }
  return { ok: false, reason: "malformed" };
}

export function rungName(rung: WriteRung): string {
  return RUNG_NAMES[rung];
}

// The resolution chain, in order: WRITE_RUNG, then the legacy
// ALLOW_FOLLOWS=false, then the stored value, then the default. Every
// step is read defensively -- a malformed WRITE_RUNG is skipped rather
// than treated as any particular rung, for the reason limits.ts
// resolveLimit gives about the write caps: a typo in the dashboard
// should cost the operator the override, not the policy.
//
// `stored` is the relay_settings value as storage.ts getRelaySettings
// reads it (null when no changewritepolicy has ever been stored), passed
// in rather than read here so this function costs no rows on its own:
// relay.ts caches the resolved rung per instance and pays the one-row
// read once per wake, not once per event.
export function resolveWriteRung(env: Env, stored: string | null): ResolvedWriteRung {
  if (env.WRITE_RUNG !== undefined) {
    const parsed = parseRung(env.WRITE_RUNG);
    if (parsed.ok) return { rung: parsed.rung, source: "env" };
    console.warn(
      `WRITE_RUNG is set to ${JSON.stringify(env.WRITE_RUNG)}, which is not a rung (1-4 or ` +
        `owner/inbox/follows/mentions); ignoring it`,
    );
  }
  if (env.ALLOW_FOLLOWS === "false") return { rung: INBOX_RUNG, source: "legacy-env" };
  if (stored !== null) {
    const parsed = parseRung(stored);
    if (parsed.ok) return { rung: parsed.rung, source: "stored" };
  }
  return { rung: DEFAULT_WRITE_RUNG, source: "default" };
}

// Which environment variable, if any, is outranking a stored rung -- so
// changewritepolicy can say so in its response the way changerelayname
// does about RELAY_NAME (nip86.ts identityNote). Null when the stored
// value is what takes effect.
export function envOverridingRung(env: Env): string | null {
  if (env.WRITE_RUNG !== undefined && parseRung(env.WRITE_RUNG).ok) return "WRITE_RUNG";
  if (env.ALLOW_FOLLOWS === "false") return "ALLOW_FOLLOWS";
  return null;
}

// Rung 4's test: does the event concern the owner? docs/rungs.md says
// "must reference or address the owner", and a `p` tag is how nostr
// does both -- a reply p-tags the author it answers (NIP-10), a mention
// p-tags the person mentioned, a reaction p-tags the note's author, a
// zap p-tags its recipient. Read off the event itself, which is what
// puts this on the CHEAP tier of the filter ladder underneath the rungs:
// no storage read and no outbound connection, just a walk over tags the
// relay already holds. An `e` tag pointing at one of the owner's events
// would also be a reference, but deciding that needs a lookup per event,
// and every event that references the owner that way already carries
// the owner's `p` under NIP-10.
export function mentionsPubkey(event: Pick<NostrEvent, "tags">, pubkey: string): boolean {
  return pTagValues(event.tags).includes(pubkey);
}

// The cap that keeps rung 4 bounded in ROWS and not only in authors. A
// non-owner event costs 3 rows written per single-letter tag it carries
// (CLAUDE.md "The budget"), and at rung 4 the author is anyone, so a
// stranger could otherwise mention the owner once inside a 64KB event
// carrying two thousand `p` tags and spend six percent of the day's
// ceiling on it -- twenty a minute, from as many pubkeys as they care to
// generate. Counted over the tags this relay would actually index (the
// same isIndexedTag storage.ts prices), so the cap bounds what it costs
// rather than the shape of the event: an NIP-92 `imeta` or an `emoji`
// tag costs no rows and is not counted.
export function exceedsMentionTagCap(event: Pick<NostrEvent, "tags">): boolean {
  let indexed = 0;
  for (const tag of event.tags) {
    if (isIndexedTag(tag) && ++indexed > MAX_MENTION_EVENT_INDEXED_TAGS) return true;
  }
  return false;
}
