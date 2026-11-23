// NIP-11 relay information document. List only what is actually
// implemented and enforced, never ahead of it.

import { GROUP_DECISIONS } from "./home-groups";
import {
  CALL_ICE_SERVERS,
  groupsEnabled,
  MAX_CREATED_AT_FUTURE_SECONDS,
  MAX_FILTER_LIMIT,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  maxEventBytes,
  photoMaxBytes,
  photoStorageBytes,
} from "./limits";
import { PHOTO_TYPES } from "./photos";
import { pushPublicKey } from "./push";
import { serviceAccount } from "./fcm";
import type { RelaySettings } from "./storage";
import { resolveWritePolicy } from "./write-policy";
import { version } from "../package.json";

// The bottom rung of the identity chain below.
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
//   3. the owner's kind-0     (cached on the owner row at claim time,
//                              refreshed by ownership.ts refreshProfile)
//   4. hardcoded default      (above)
//
// The environment variable wins because whoever holds the Cloudflare
// dashboard controls the deployment. A NIP-86 change* under a set
// variable is still stored, and the response says the variable is
// winning (src/nip86.ts changeIdentity).
//
// Every resolver here backs BOTH the NIP-11 document and /api/stats
// (src/relay.ts getStats), so the two can never disagree.
// ---------------------------------------------------------------------

// A name from the owner's kind-0 names the person, not the relay, so it
// is made possessive: "Aaron" -> "Aaron's relay". Always "'s", even after
// a final s ("Chris's relay"). Names from the other rungs were chosen for
// the relay and are used verbatim.
function possessive(ownerName: string): string {
  return `${ownerName}'s relay`;
}

export function resolveName(env: Env, stored: RelaySettings, profile: OwnerProfile): string {
  if (env.RELAY_NAME) return env.RELAY_NAME;
  if (stored.name) return stored.name;
  if (profile?.name) return possessive(profile.name);
  return DEFAULT_NAME;
}

// The kind-0 rung is `about`, used verbatim.
export function resolveDescription(env: Env, stored: RelaySettings, profile: OwnerProfile): string {
  if (env.RELAY_DESCRIPTION) return env.RELAY_DESCRIPTION;
  if (stored.description) return stored.description;
  if (profile?.about) return profile.about;
  return DEFAULT_DESCRIPTION;
}

// No hardcoded rung: null means "no icon", so NIP-11 omits the field and
// the admin page keeps its static favicon.
export function resolveIcon(env: Env, stored: RelaySettings, profile: OwnerProfile): string | null {
  return env.RELAY_ICON || stored.icon || profile?.picture || null;
}

// NIP-11 `contact` is an administrative contact URI. kind-0 `website` is
// the only profile field that is already a URI. Not `nip05`: it looks like
// an email address but often has no mailbox behind it. Not `lud16`: that
// is a payment endpoint, not a contact route. Omitted when absent.
//
// No env-var or NIP-86 rung, unlike name/description/icon: those exist so
// the relay can present differently from the person, and a contact
// address has no such split.
function resolveContact(profile: OwnerProfile): string | null {
  return profile?.website ?? null;
}

export function buildRelayInfo(
  env: Env,
  stored: RelaySettings,
  profile: OwnerProfile,
  ownerPubkey: string | null,
  relayPubkey: string,
  memberCount?: number,
  photos?: { url: string; usedBytes: number },
): Record<string, unknown> {
  const info: Record<string, unknown> = {
    name: resolveName(env, stored, profile),
    description: resolveDescription(env, stored, profile),
    // NIP-98 is not listed: it is used only as NIP-86's authentication
    // (src/nip98.ts), not offered as general HTTP auth.
    // 29 is listed only while groups are on (limits.ts groupsEnabled);
    // paused, every group write and join is refused, so listing it would
    // advertise a refusal. What is implemented is a subset of NIP-29 (the
    // moderation kinds in nip29.ts isSupportedModerationKind, plus
    // relay-signed 39000-series state); the policy tags on each generated
    // kind-39000 (nip29.ts POLICY_TAGS) tell a client the rest.
    supported_nips: groupsEnabled(env) ? [1, 9, 11, 29, 40, 42, 59, 62, 86] : [1, 9, 11, 40, 42, 59, 62, 86],
    // The upstream project, not the deployer's clone: NIP-11 wants the
    // implementation, not the deployment.
    software: "https://github.com/sybenx/bothy",
    // package.json `version` is the single source of truth; never
    // hardcode the version string anywhere.
    version,
    // Only constraints actually enforced, imported from limits.ts so they
    // cannot drift. No max_event_tags/max_content_length/
    // min_pow_difficulty: nothing enforces them.
    limitation: {
      // Resolved the same way the write gate resolves it.
      restricted_writes: resolveWritePolicy(env, stored.writePolicy).policy !== "all",
      max_subscriptions: MAX_SUBSCRIPTIONS_PER_CONNECTION,
      max_limit: MAX_FILTER_LIMIT,
      // limits.ts boundFilter uses this when a filter omits `limit`.
      default_limit: MAX_FILTER_LIMIT,
      // A delta in seconds, not a timestamp (as in the NIP's own
      // examples, e.g. nostr.wine's 300). No created_at_lower_limit:
      // nothing enforces one (see MAX_CREATED_AT_FUTURE_SECONDS).
      created_at_upper_limit: MAX_CREATED_AT_FUTURE_SECONDS,
    },
  };
  // Omitted when MAX_EVENT_BYTES is disabled by env var. The cap measures
  // the serialized event, while NIP-11 means the whole ["EVENT", {...}]
  // frame, a dozen bytes longer; advertising the smaller number is the
  // safe direction, since a client respecting it is never refused for
  // size.
  const byteCap = maxEventBytes(env);
  if (byteCap !== null) {
    (info.limitation as Record<string, unknown>).max_message_length = byteCap;
  }
  const icon = resolveIcon(env, stored, profile);
  if (icon) {
    info.icon = icon;
  }
  // The owner's hex pubkey (ownership.ts getOwnerPubkey). Omitted while
  // unclaimed, the normal state of a fresh deploy.
  if (ownerPubkey) {
    info.pubkey = ownerPubkey;
  }
  // The relay's own signing key (src/relay-identity.ts), distinct from the
  // owner's `pubkey`. `self` is the NIP-11 field for it, and NIP-29 tells
  // clients to verify 39000-series events against "the NIP-11 `self`
  // pubkey", so it must keep this name. Never omitted: it is generated at
  // schema init (schema.ts seedRelayIdentity), independent of claim.
  info.self = relayPubkey;
  // Public half of the VAPID keypair (src/push.ts), base64url unpadded,
  // as a browser wants for `applicationServerKey`. bothy's own field (no
  // NIP defines one); hearth reads it to decide whether push is
  // available. Omitted, never empty, when no VAPID key is configured:
  // that absence is how a client learns push is off.
  const pushKey = pushPublicKey(env);
  if (pushKey) {
    info.push_key = pushKey;
  }
  // Android push (src/fcm.ts), bothy's own field: present only when the
  // relay can send it, carrying the Firebase project it sends from. An app
  // registers (nip86.ts subscribefcm) only if that is its own project; a
  // token from another project would be refused by Google.
  const fcm = serviceAccount(env);
  if (fcm) {
    info.fcm = { project_id: fcm.projectId };
  }
  // How many people this relay keeps an inbox for besides the owner
  // (storage.ts memberCount). bothy's own field. A client deciding whether
  // to offer this relay as a home reads it beside `push_key`. Omitted while
  // unclaimed: an unclaimed relay has no members to count.
  if (ownerPubkey && memberCount !== undefined) {
    info.member_count = memberCount;
  }
  // The profile photo server (src/photos.ts), bothy's own field. A
  // Blossom server for members' photos only: where it is, what it takes,
  // and how full it is. Omitted while unclaimed or with
  // PHOTO_STORAGE_BYTES=off.
  const photoCap = photoStorageBytes(env);
  if (ownerPubkey && photos !== undefined && photoCap !== null) {
    info.blossom = {
      url: photos.url,
      types: [...PHOTO_TYPES],
      max_blob_bytes: photoMaxBytes(env),
      used_bytes: photos.usedBytes,
      max_bytes: photoCap,
    };
  }
  // The home's file server (nip86.ts setstorage), bothy's own field and a
  // separate one from `blossom`, which is this relay's own photo server:
  // media and history backups go here. Omitted while unset or unclaimed.
  if (ownerPubkey && stored.storageUrl) {
    info.storage = { url: stored.storageUrl };
  }
  // The restore vault (src/vault.ts), bothy's own field: this home keeps
  // members' passkey-locked copies (vaultput, vaultopen). Omitted while
  // unclaimed, when there are no members to keep one for.
  if (ownerPubkey) {
    info.restore = { v: 1 };
    // Sealed signals (relay.ts handleSignal, kind 21059), bothy's own
    // field: typing, seen and call setup, delivered live, never stored.
    info.signals = { v: 1 };
    // 1:1 calls, bothy's own field: rings are accepted (relay.ts
    // handleGiftWrap) and the ICE servers the apps build their call from
    // (limits.ts CALL_ICE_SERVERS). Copied, so no caller can change the
    // constant through the document.
    info.calls = { v: 1, ice: CALL_ICE_SERVERS.map((server) => ({ urls: [...server.urls] })) };
    // Private profiles (src/profiles.ts), bothy's own field: members'
    // kind 0 is served only to this home's authenticated owner, admins and
    // members, and members may store a sealed photo (octet-stream). An app
    // publishes its profile here, and only here, when it sees this; an
    // older bothy would serve it to anyone.
    info.profiles = "members";
    // History backup (nip86.ts backedup), bothy's own field: this home
    // takes a member's "my backup holds my mail up to here", which mailbox
    // retention waits for before deleting anything of theirs.
    info.backup = { v: 1 };
    // Home groups (src/home-groups.ts), bothy's own field. `keeper` is the
    // box's key once a box keeps every group's keys; null until then.
    info.groups = { v: 1, keeper: GROUP_DECISIONS.keeperIsStorage && stored.storageUrl && stored.storagePubkey ? stored.storagePubkey : null };
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
  memberCount?: number,
  photos?: { url: string; usedBytes: number },
): Response {
  return new Response(
    JSON.stringify(buildRelayInfo(env, stored, profile, ownerPubkey, relayPubkey, memberCount, photos)),
    {
      headers: {
        "Content-Type": "application/nostr+json",
        // Web clients fetch NIP-11 cross-origin.
        "Access-Control-Allow-Origin": "*",
      },
    },
  );
}
