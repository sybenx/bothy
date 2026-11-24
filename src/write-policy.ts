// The write policy: who may publish to this relay, as one named level.
//
// The ladder docs/rungs.md describes, each step defined by WHO may write
// and WHAT BOUNDS THE VOLUME. The levels are CUMULATIVE -- each admits
// everyone the one before it does plus one more class of writer -- so the
// policy is a single value. The ordering is internal: owners only ever see
// the five names, never a number or the word "rung".
//
//   owner     Only events signed by the relay's owner.
//             Bounded by the owner's own posting rate.
//   inbox     + NIP-59 gift wraps from anyone, p-tagged to the owner or
//             a member (relay.ts handleGiftWrap; members are storage.ts
//             isMember). Bounded by MAX_EVENT_BYTES, the
//             gift wrap storage share and the per-IP wrap throttle
//             (limits.ts).
//   follows   + any event signed by a pubkey in the owner's kind-3
//             contact list (ownership.ts refreshFollows).
//             Bounded by the size of that list.
//   mentions  + any event, from any author, that p-tags the owner.
//             The default: bothy is meant to sit in the owner's NIP-65
//             list, so it is their inbox, and senders deliver replies to
//             read relays. Spam is handled with NIP-86 banpubkey, since
//             per-pubkey caps do not bound many throwaway keys.
//             Bounded by how many people mention the owner -- and,
//             because "anyone" can choose that number, by
//             MAX_MENTION_EVENT_INDEXED_TAGS on top of the per-event
//             caps every non-owner write already pays.
//   network   + any event signed by someone the owner's follows follow
//             (network.ts, the `network_keys` table). Bounded by
//             limits.ts NETWORK_MAX_KEYS and the per-writer caps. After
//             `mentions`, not before it: the levels are cumulative, and
//             slotting it below `mentions` would have widened every relay
//             already on `mentions`.
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
// Where the value lives: `WRITE_POLICY` in the environment pins it from
// the dashboard, where a stored value cannot override it; the stored value
// (NIP-86 changewritepolicy, relay_settings) lets the owner change it from
// a client without a redeploy; otherwise `mentions`.

import { pTagValues, isIndexedTag, type NostrEvent } from "./nostr";
import { MAX_MENTION_EVENT_INDEXED_TAGS } from "./limits";

// The five names, in order from most closed to most open. This array IS
// the ordering: a policy admits everything every policy before it admits.
export const WRITE_POLICIES = ["owner", "inbox", "follows", "mentions", "network", "all"] as const;
export type WritePolicy = (typeof WRITE_POLICIES)[number];

export const DEFAULT_WRITE_POLICY: WritePolicy = "mentions";

// One plain sentence per policy, written for the owner reading their own
// relay's status: the admin page and getwritepolicy both use these.
export const POLICY_DESCRIPTIONS: Readonly<Record<WritePolicy, string>> = {
  owner: "Only you can publish here.",
  inbox: "Only you can publish here. Anyone can send you encrypted mail.",
  follows: "You and the people you follow can publish here.",
  mentions: "You, the people you follow, and anyone who mentions or replies to you can publish here.",
  network:
    "You, the people you follow, the people they follow, and anyone who mentions or replies to you can publish here.",
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
// `stored` is the relay_settings value (storage.ts getStoredWritePolicy;
// null if never set), passed in so this function reads no rows: relay.ts
// caches the resolved policy per instance, paying the read once per wake
// and again after each management call, not per event.
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

// The `mentions` test: does the event reference or address the owner? A
// `p` tag is how nostr does both (replies under NIP-10, mentions,
// reactions, zaps). Read off the event alone, so it costs no storage read.
// An `e` tag pointing at an owner's event is not checked: that needs a
// lookup per event, and NIP-10 replies already carry the owner's `p`.
export function mentionsPubkey(event: Pick<NostrEvent, "tags">, pubkey: string): boolean {
  return pTagValues(event.tags).includes(pubkey);
}

// Keeps `mentions` bounded in ROWS, not only in authors. Each indexed tag
// costs 3 rows written (schema.ts eventRowCost), and under `mentions` the
// author can be anyone, so one 64KB event carrying two thousand `p` tags
// would spend about 6% of the 100,000 rows/day ceiling, repeatable at the
// per-pubkey rate from any number of fresh keys. Counted with isIndexedTag,
// the same test storage pricing uses, so tags that cost no rows (`imeta`,
// `emoji`) are not counted.
//
// NOT applied under `all` (ownership.ts isAllowedWriter returns before
// it): that policy is bounded by the per-writer caps alone, and an open
// relay must accept a stranger's kind-3 with hundreds of `p` tags.
export function exceedsMentionTagCap(event: Pick<NostrEvent, "tags">): boolean {
  let indexed = 0;
  for (const tag of event.tags) {
    if (isIndexedTag(tag) && ++indexed > MAX_MENTION_EVENT_INDEXED_TAGS) return true;
  }
  return false;
}
