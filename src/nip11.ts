// NIP-11 relay information document. `supported_nips` only lists NIPs
// actually implemented so far -- update it as later chunks land protocol
// support, not ahead of them.

import {
  MAX_CREATED_AT_FUTURE_SECONDS,
  MAX_FILTER_LIMIT,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  maxEventBytes,
} from "./limits";
import { pushPublicKey } from "./push";
import type { RelaySettings } from "./storage";
import { version } from "../package.json";

// Hardcoded fallbacks (the last rung of the identity chain: fallbacks in code
// for when the lookup fails"). The bottom rung of the chain below: used
// when nothing else in it resolved.
export const DEFAULT_NAME = "bothy";
export const DEFAULT_DESCRIPTION = "A single-user nostr relay.";

export type OwnerProfile = {
  name: string | null;
  picture: string | null;
  about: string | null;
  website: string | null;
} | null;

// ---------------------------------------------------------------------
// The relay identity chain. Name, description and icon each resolve in
// the same order, highest to lowest:
//
//   1. environment variable   (RELAY_NAME/RELAY_DESCRIPTION/RELAY_ICON)
//   2. stored value           (NIP-86 change*, src/nip86.ts)
//   3. the owner's kind-0     (cached at claim time, ownership.ts)
//   4. hardcoded default      (above)
//
// The environment variable sits on top because it is the one rung whose
// holder demonstrably controls the deployment itself: someone with the
// Cloudflare dashboard has already won any argument with the relay's own
// storage. NIP-86 still stores a value written underneath a set variable
// rather than discarding it -- see src/nip86.ts changeIdentity, which
// says so in the response.
//
// Every resolver here is used by BOTH the NIP-11 document and
// /api/stats (src/relay.ts getStats), so the document a client fetches
// and the readout the admin page shows can never disagree -- the pattern
// resolveIcon already established when it was the only one.
// ---------------------------------------------------------------------

// A relay name taken from the owner's kind-0 is DERIVED, not chosen: the
// owner named themselves, not their relay, so "Aaron" becomes "Aaron's
// relay" rather than a relay literally called Aaron. Always "'s", names
// already ending in s included -- "Chris's relay", not "Chris' relay".
// One rule with no exception is one fewer thing to get wrong, and it
// matches how the name is spoken.
//
// The other three rungs are chosen relay names and are used verbatim: an
// operator who sets RELAY_NAME or calls changerelayname has named the
// relay itself, and possessivising that would be putting words in their
// mouth.
function possessive(ownerName: string): string {
  return `${ownerName}'s relay`;
}

export function resolveName(env: Env, stored: RelaySettings, profile: OwnerProfile): string {
  if (env.RELAY_NAME) return env.RELAY_NAME;
  if (stored.name) return stored.name;
  if (profile?.name) return possessive(profile.name);
  return DEFAULT_NAME;
}

// kind-0's `about` is the profile field that corresponds to a relay
// description, so it takes the kind-0 rung here the way `name` and
// `picture` do for the other two. Used verbatim -- unlike a name, a
// description needs no grammatical adjustment to read correctly.
export function resolveDescription(env: Env, stored: RelaySettings, profile: OwnerProfile): string {
  if (env.RELAY_DESCRIPTION) return env.RELAY_DESCRIPTION;
  if (stored.description) return stored.description;
  if (profile?.about) return profile.about;
  return DEFAULT_DESCRIPTION;
}

// Shared between the NIP-11 document and /api/stats (src/relay.ts
// getStats), which the admin page uses to set the browser tab's favicon
// from the same source rather than inventing a second resolution path.
// There is no hardcoded icon -- null means "no icon", which the NIP-11
// document expresses by omitting the field entirely (buildRelayInfo
// below) and the admin page by keeping its static default favicon.
export function resolveIcon(env: Env, stored: RelaySettings, profile: OwnerProfile): string | null {
  return env.RELAY_ICON || stored.icon || profile?.picture || null;
}

// NIP-11's `contact` is "an administrative contact", and the NIP's own
// examples are URIs -- `mailto:` or `https:`. kind-0 has no field named
// `contact`, so one of its fields has to be chosen, and `website` is the
// only one that is already a URI.
//
// The other candidates were rejected rather than overlooked. `nip05` is
// shaped like an email address and is not one: it is an identity
// verifier at a well-known path, and a great many nip05 identifiers have
// no mailbox behind them, so publishing one as an administrative contact
// would send mail into a void. `lud16` is a lightning address -- a
// payment endpoint, not a contact route -- and advertising it here would
// invite people to pay the operator when they meant to email them.
//
// Omitted entirely when the owner's kind-0 has no website, rather than
// emitted empty: NIP-11's fields are all optional, and an absent field
// says "unknown" while an empty one says "deliberately blank."
//
// No environment-variable or NIP-86 rung, unlike name/description/icon.
// Those three have a `change*` method and a RELAY_* variable because an
// operator may want the relay to present differently from the person; a
// contact address has no such split -- there is one operator and this is
// how to reach them. Adding rungs nobody asked for would be three more
// pieces of resolution order to keep consistent.
function resolveContact(profile: OwnerProfile): string | null {
  return profile?.website ?? null;
}

export function buildRelayInfo(
  env: Env,
  stored: RelaySettings,
  profile: OwnerProfile,
  ownerPubkey: string | null,
  relayPubkey: string,
): Record<string, unknown> {
  const info: Record<string, unknown> = {
    name: resolveName(env, stored, profile),
    description: resolveDescription(env, stored, profile),
    // NIP-42: real as of gift wrap reads being the
    // first auth-gated resource -- relay.ts issues an actual challenge
    // and checks it, not just the unconditional AUTH-message checklist.
    // NIP-59/62: gift wrap accept/read/delete and vanish requests, same
    // chunk. NIP-86: the management API (src/nip86.ts). NIP-98 is not
    // listed -- it is verified here only as NIP-86's authentication
    // (src/nip98.ts), and this relay offers no general NIP-98 HTTP auth
    // a client could use for anything else.
    // 29 is listed for what is actually implemented, which is a subset and
    // is stated as one in the group's own metadata: one group, one admin,
    // put-user/remove-user/edit-metadata, and relay-generated
    // 39000/39001/39002 signed by `self` above. What a NIP-29 client will
    // find missing is advertised by the group document itself -- `closed`
    // (no join requests or invites yet) and `hidden`/`private` (metadata
    // and messages are owner-only reads) -- rather than left for it to
    // discover by being refused. See CLAUDE.md "What it refuses to be".
    supported_nips: [1, 9, 11, 29, 40, 42, 59, 62, 86],
    // Points at the upstream project, not the deployer's own cloned repo
    // -- the NIP requires a URL identifying the implementation, not the
    // deployment, and every deploy button clone shares this same software.
    software: "https://github.com/sybenx/bothy",
    // package.json's `version` is the single source of truth (CLAUDE.md
    // "Release step") -- never hardcode this string elsewhere.
    version,
    // Only constraints actually enforced -- imported from limits.ts so
    // this document can never drift from the real caps. Still no
    // max_event_tags/max_content_length/min_pow_difficulty: none of those
    // are enforced anywhere in this codebase, and advertising an
    // unenforced limit is worse than advertising none. max_message_length
    // was in that list until limits.ts MAX_EVENT_BYTES made it real; it
    // is added below rather than left out, which is the same rule applied
    // in the other direction.
    limitation: {
      // This relay is never fully open -- see ownership.ts isAllowedWriter.
      restricted_writes: true,
      max_subscriptions: MAX_SUBSCRIPTIONS_PER_CONNECTION,
      max_limit: MAX_FILTER_LIMIT,
      // boundFilter (limits.ts) defaults a filter's limit to this
      // when the filter omits one.
      default_limit: MAX_FILTER_LIMIT,
      // A delta in seconds, not an absolute timestamp -- confirmed
      // against nips.md's own examples (e.g. nostr.wine's 300), and the
      // field name has no "seconds" qualifier either way. No
      // created_at_lower_limit: nothing enforces one (see
      // MAX_CREATED_AT_FUTURE_SECONDS's comment -- backfill and archive
      // republishing both need old timestamps to keep working).
      created_at_upper_limit: MAX_CREATED_AT_FUTURE_SECONDS,
    },
  };
  // Derived from the enforced cap, never a hardcoded copy of it. Omitted
  // entirely when MAX_EVENT_BYTES is disabled by env var, since the rule
  // above is that this block names only what is actually enforced.
  //
  // The cap measures the JSON-serialized *event*, while NIP-11 defines
  // this field as the whole message -- an ["EVENT", {...}] frame is a
  // dozen bytes longer. Advertising the smaller number is the safe
  // direction to be wrong in: a client that respects it can never be
  // refused for size.
  const byteCap = maxEventBytes(env);
  if (byteCap !== null) {
    (info.limitation as Record<string, unknown>).max_message_length = byteCap;
  }
  const icon = resolveIcon(env, stored, profile);
  if (icon) {
    info.icon = icon;
  }
  // The owner's pubkey, in hex, from the same resolution the rest of the
  // relay uses (ownership.ts getOwnerPubkey: OWNER_PUBKEY environment
  // variable, else the TOFU claim in storage). This is the field that
  // answers "who runs this relay", and without it a client fetching this
  // document could read the operator's name and see their picture while
  // having no way to identify them as a nostr user at all.
  //
  // Omitted while unclaimed, which is not a degenerate case but the
  // normal state of a freshly deployed relay: there is genuinely no
  // owner yet, and emitting an empty string would assert otherwise.
  if (ownerPubkey) {
    info.pubkey = ownerPubkey;
  }
  // This relay's own signing identity (src/relay-identity.ts), and
  // deliberately not `pubkey`: that field already means "who administers
  // this relay" (above), while this is the key the relay signs its own
  // events with -- a different key with a different purpose.
  //
  // `self` is the NIP-11 field for it (nips/11.md "Self": "A relay MAY
  // maintain an identity independent from its administrator using the
  // `self` field"), and it is the name NIP-29 points a client at: the
  // 39000-series group state events "MUST be created by the relay master
  // key only (as stated by the NIP-11 `self` pubkey)". It shipped for one
  // release as `relay_pubkey`, a name of our own invention, which was
  // harmless while nothing signed anything and became a conformance bug
  // the moment src/nip29.ts started generating events -- a client
  // following the spec looks for `self` and would have found no key to
  // verify them against.
  //
  // Unlike `pubkey`, never omitted: it is generated at schema-init time
  // (schema.ts seedRelayIdentity) and exists independently of claim
  // status, so there is no unclaimed-relay state where it is unknown.
  info.self = relayPubkey;
  // The public half of this deployment's VAPID keypair (src/push.ts), and
  // the field hearth reads to decide whether push is available at all
  // (reference/push.md: "loadRelayInfo takes push_key out of the relay's
  // NIP-11 document"). base64url, unpadded, the exact string a browser
  // wants as `applicationServerKey`.
  //
  // Not a NIP-11 field -- the spec defines none for this, and neither
  // does any NIP -- so it is bothy's own, named after what a client does
  // with it rather than under a vendor prefix, on the same reasoning
  // nip86.ts names listunusedinvites plainly.
  //
  // OMITTED, never emitted empty, when no VAPID key is configured. That
  // absence is the entire degradation path: hearth reads no key, never
  // calls subscribepush, keeps raising notifications while it is open,
  // and says so in its account overlay. A relay with push switched off is
  // not a relay with push broken.
  const pushKey = pushPublicKey(env);
  if (pushKey) {
    info.push_key = pushKey;
  }
  const contact = resolveContact(profile);
  if (contact) {
    info.contact = contact;
  }
  return info;
}

export function nip11Response(
  env: Env,
  stored: RelaySettings,
  profile: OwnerProfile,
  ownerPubkey: string | null,
  relayPubkey: string,
): Response {
  return new Response(JSON.stringify(buildRelayInfo(env, stored, profile, ownerPubkey, relayPubkey)), {
    headers: {
      "Content-Type": "application/nostr+json",
      // NIP-11 is fetched cross-origin by web clients before they ever
      // open a connection.
      "Access-Control-Allow-Origin": "*",
    },
  });
}
