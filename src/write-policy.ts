// The write policy: who may publish to this relay, as one named level.
//
// docs/rungs.md describes a relay's write policy as a ladder, each step
// defined by WHO may write and WHAT BOUNDS THE VOLUME. This file is that
// ladder made concrete. The levels are CUMULATIVE -- each admits everyone
// the one below it admits and one more class of writer -- so the policy is
// a single value, and the ordering below is what "cumulative" means in
// code. The ordering is internal: nothing that reaches an owner (the
// management API, the env var, /api/stats, the admin page, the README)
// ever shows a number or the word "rung". They see the five names.
//
//   owner     Only events signed by the relay's owner.
//             Bounded by the owner's own posting rate.
//   inbox     + NIP-59 gift wraps from anyone, p-tagged to the owner
//             (relay.ts handleGiftWrap). Bounded by MAX_EVENT_BYTES, the
//             gift wrap storage share and the per-IP wrap throttle
//             (limits.ts).
//   follows   + any event signed by a pubkey in the owner's kind-3
//             contact list (ownership.ts refreshFollows). The default.
//             Bounded by the size of that list.
//   mentions  + any event, from any author, that p-tags the owner.
//             Bounded by how many people mention the owner -- and,
//             because "anyone" can choose that number, by
//             MAX_MENTION_EVENT_INDEXED_TAGS on top of the per-event
//             caps every non-owner write already pays.
//   all       + anything from anyone. Bounded only by the per-writer
//             caps (limits.ts MAX_EVENT_BYTES, MAX_EVENTS_PER_PUBKEY_PER_
//             WINDOW, NON_OWNER_STORAGE_BYTES). This is the open relay
//             docs/rungs.md calls the cliff; the owner steps off it
//             deliberately, and nip86.ts changewritepolicy asks for an
//             exact confirmation string before storing it.
//
// The explicit allowlist (NIP-86 allowpubkey) is not a level. An allowed
// pubkey writes under EVERY policy, and the policy says who ELSE does.
// banpubkey is the mirror image: a banned pubkey is refused under every
// policy, follows and mentions and all included.
//
// Where the value lives. `WRITE_POLICY` in the environment is for an
// operator who configures in the dashboard and wants the policy pinned
// there, where a stored value cannot quietly override it; the stored
// value (NIP-86 changewritepolicy, relay_settings) is for the owner
// changing it from a client without a redeploy; the default is
// `follows`, which is the policy this relay has shipped with since
// writes opened to the owner's contact list.

import { pTagValues, isIndexedTag, type NostrEvent } from "./nostr";
import { MAX_MENTION_EVENT_INDEXED_TAGS } from "./limits";

// The five names, in order from most closed to most open. This array IS
// the ordering: a policy admits everything every policy before it admits.
export const WRITE_POLICIES = ["owner", "inbox", "follows", "mentions", "all"] as const;
export type WritePolicy = (typeof WRITE_POLICIES)[number];

export const DEFAULT_WRITE_POLICY: WritePolicy = "follows";

// One plain sentence per policy, written for the owner reading their own
// relay's status: the admin page and getwritepolicy both use these.
export const POLICY_DESCRIPTIONS: Readonly<Record<WritePolicy, string>> = {
  owner: "Only you can publish here.",
  inbox: "Only you can publish here. Anyone can send you encrypted mail.",
  follows: "You and the people you follow can publish here.",
  mentions: "You, the people you follow, and anyone who mentions or replies to you can publish here.",
  all: "Anyone can publish here.",
};

// The exact string changewritepolicy demands as its second parameter
// before it will store `all`. Same shape as nip86.ts
// SELF_BLOCK_CONFIRMATION and for the same reason: opening the relay to
// everyone is the one policy change that is easy to type and hard to
// notice the consequences of, so it costs one extra deliberate call.
export const OPEN_POLICY_CONFIRMATION = "yes, let anyone publish here";

// Where the effective policy came from, for getwritepolicy and
// /api/stats. An operator whose changewritepolicy call appears to do
// nothing needs to be told that WRITE_POLICY in the dashboard is what is
// winning, and this is how the answer reaches them.
export type WritePolicySource = "env" | "stored" | "default";

export interface ResolvedWritePolicy {
  policy: WritePolicy;
  source: WritePolicySource;
}

// "Is policy A at least as open as policy B" -- the one comparison the
// gate needs, expressed over names so no number leaks out of this file.
export function admitsAtLeast(policy: WritePolicy, floor: WritePolicy): boolean {
  return WRITE_POLICIES.indexOf(policy) >= WRITE_POLICIES.indexOf(floor);
}

// Accepts a policy name, case-insensitively and with surrounding
// whitespace ignored, since the value may come from a dashboard text
// field or a shell argument. Names only: numbers are internal ordering
// and are refused as malformed like anything else.
export function parsePolicy(value: unknown): WritePolicy | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  return (WRITE_POLICIES as readonly string[]).includes(raw) ? (raw as WritePolicy) : null;
}

// The resolution chain, in order: WRITE_POLICY, then the stored value,
// then the default. Every step is read defensively -- a malformed
// WRITE_POLICY is logged and skipped rather than treated as any
// particular policy, for the reason limits.ts resolveLimit gives about
// the write caps: a typo in the dashboard should cost the operator the
// override, not the policy.
//
// `stored` is the relay_settings value as storage.ts getRelaySettings
// reads it (null when no changewritepolicy has ever been stored), passed
// in rather than read here so this function costs no rows on its own:
// relay.ts caches the resolved policy per instance and pays the one-row
// read once per wake, not once per event.
export function resolveWritePolicy(env: Env, stored: string | null): ResolvedWritePolicy {
  if (env.WRITE_POLICY !== undefined) {
    const policy = parsePolicy(env.WRITE_POLICY);
    if (policy !== null) return { policy, source: "env" };
    console.warn(
      `WRITE_POLICY is set to ${JSON.stringify(env.WRITE_POLICY)}, which is not one of ` +
        `${WRITE_POLICIES.join("/")}; ignoring it`,
    );
  }
  if (stored !== null) {
    const policy = parsePolicy(stored);
    if (policy !== null) return { policy, source: "stored" };
  }
  return { policy: DEFAULT_WRITE_POLICY, source: "default" };
}

// Whether WRITE_POLICY in the environment is outranking a stored value --
// so changewritepolicy can say so in its response the way changerelayname
// does about RELAY_NAME (nip86.ts identityNote).
export function envOverridesPolicy(env: Env): boolean {
  return env.WRITE_POLICY !== undefined && parsePolicy(env.WRITE_POLICY) !== null;
}

// The `mentions` test: does the event concern the owner? docs/rungs.md
// says "must reference or address the owner", and a `p` tag is how nostr
// does both -- a reply p-tags the author it answers (NIP-10), a mention
// p-tags the person mentioned, a reaction p-tags the note's author, a
// zap p-tags its recipient. Read off the event itself, which is what
// puts this on the CHEAP tier of the filter ladder underneath the
// policy: no storage read and no outbound connection, just a walk over
// tags the relay already holds. An `e` tag pointing at one of the
// owner's events would also be a reference, but deciding that needs a
// lookup per event, and every event that references the owner that way
// already carries the owner's `p` under NIP-10.
export function mentionsPubkey(event: Pick<NostrEvent, "tags">, pubkey: string): boolean {
  return pTagValues(event.tags).includes(pubkey);
}

// The cap that keeps `mentions` bounded in ROWS and not only in authors.
// A non-owner event costs 3 rows written per single-letter tag it carries
// (docs/budget.md), and under `mentions` the author is anyone, so
// a stranger could otherwise mention the owner once inside a 64KB event
// carrying two thousand `p` tags and spend six percent of the day's
// ceiling on it -- twenty a minute, from as many pubkeys as they care to
// generate. Counted over the tags this relay would actually index (the
// same isIndexedTag storage.ts prices), so the cap bounds what it costs
// rather than the shape of the event: an NIP-92 `imeta` or an `emoji`
// tag costs no rows and is not counted.
//
// NOT applied under `all`. That policy's stated bound is the per-writer
// caps and nothing else, and an open relay that refused a stranger's
// kind-3 contact list -- hundreds of `p` tags, every one of them
// legitimate -- would not be open.
export function exceedsMentionTagCap(event: Pick<NostrEvent, "tags">): boolean {
  let indexed = 0;
  for (const tag of event.tags) {
    if (isIndexedTag(tag) && ++indexed > MAX_MENTION_EVENT_INDEXED_TAGS) return true;
  }
  return false;
}
