// Optional configuration, merged onto the generated global `Env`
// (worker-configuration.d.ts declares none of it). None of it may be
// declared in wrangler.jsonc `vars`: the deploy button prompts for every
// declared var with no notion of "optional", and a clean deploy must ask
// for nothing but a project name. Everything is read defensively
// (`env.X ?? fallback`) and added by hand in the Cloudflare dashboard if
// wanted.
//
// RATE_LIMIT_API/RATE_LIMIT_PROFILE are the Rate Limiting bindings
// declared in wrangler.jsonc (values and reasons there). Optional because
// Cloudflare's docs do not say which plans offer the binding (checked
// 2026-08-27); index.ts calls `env.X?.limit(...)` and treats an absent
// binding as "allowed" rather than failing every request.
interface Env {
  RATE_LIMIT_API?: RateLimit;
  RATE_LIMIT_PROFILE?: RateLimit;
  // `npub1...` or lowercase hex, normalized by ownership.ts
  // getOwnerPubkey (pubkey.ts normalizePubkey). Absent by default so a
  // deploy starts unclaimed (TOFU); the claim flow stores the owner in
  // the database and never sets this. A value that does not normalize
  // resolves to null, which reads as unclaimed, while index.ts still
  // disables the claim endpoint because it gates on this being set,
  // so a bad value fails closed. Tests inject it in vitest.config.ts.
  OWNER_PUBKEY?: string;
  // Outrank the NIP-86 change* stored values and the owner's kind-0
  // (nip11.ts resolution chain).
  RELAY_NAME?: string;
  RELAY_DESCRIPTION?: string;
  RELAY_ICON?: string;
  // Web push (push.ts). A SECRET, not a var: `wrangler secret put
  // VAPID_PRIVATE_KEY`. A git-connected Worker may sync config vars over
  // dashboard values on deploy, and secrets are never synced, so the key
  // cannot end up in the repository. Base64url 32-byte P-256 scalar; the
  // public half is derived, so the two cannot disagree. Unset (or
  // invalid) means no push_key on NIP-11 and no push, a supported state.
  VAPID_PRIVATE_KEY?: string;
  // Android push (src/fcm.ts): a Google service-account JSON, the whole
  // file, as a secret. Unset means no Android push.
  FCM_SERVICE_ACCOUNT?: string;
  // The upstream update check (upstream-version.ts). On unless this is
  // exactly "off", the same shape as the write caps below.
  UPDATE_CHECK?: string;
  // Ephemeral group chat (limits.ts chatMode). Unset means reporting:
  // log hourly what would be deleted, delete nothing. Exactly "on"
  // deletes; exactly "off" disables the behaviour. Inverted from the
  // usual only-"off"-disables shape on purpose: for a safety cap, turning
  // it off is the act that must be spelled out; here, deleting is.
  EPHEMERAL_CHAT?: string;
  // Write policy by name (write-policy.ts): owner, inbox, follows,
  // mentions or all. Outranks the value stored by NIP-86
  // changewritepolicy; unset means the stored value, then the default
  // (follows). A malformed value is logged and ignored. ALLOW_FOLLOWS is
  // no longer read.
  WRITE_POLICY?: string;
  // NIP-29 groups (limits.ts groupsEnabled). Paused unless exactly "on":
  // no group-scoped write, moderation event or join request is honoured,
  // and NIP-11 does not list 29. What the group partition already holds
  // stays readable by the owner and members.
  GROUPS?: string;
  // The write-path abuse caps (limits.ts). Each takes a positive number,
  // or exactly "off" to disable that cap; no other value can remove it
  // (limits.ts resolveLimit falls back to the default).
  MAX_EVENT_BYTES?: string;
  MAX_EVENTS_PER_PUBKEY_PER_MINUTE?: string;
  NON_OWNER_STORAGE_BYTES?: string;
  // The relay's storage budget (limits.ts storageBudget): 1GB by default,
  // the smallest reading of the Free plan's per-object limit. Every share
  // is a fraction of it.
  STORAGE_BUDGET_BYTES?: string;
  // Profile photos (src/photos.ts). PHOTO_STORAGE_BYTES is the total they
  // may occupy, or exactly "off" to turn photo storage off. PHOTO_MAX_BYTES
  // is the largest one photo may be, never above limits.ts
  // PHOTO_MAX_BYTES_CEILING; it cannot be turned off.
  // Members' own invites (limits.ts memberInviteLimits): how many people
  // a member may let in, and how many steps from the owner invites go.
  // A positive number, or "off" to leave invites to the owner and admins.
  // The mailbox (limits.ts mailStorageBytes, mailBytesPerMember): bytes
  // of stored gift wraps for the whole home and per recipient. A positive
  // number, or "off" to remove that cap.
  MAIL_STORAGE_BYTES?: string;
  MAIL_BYTES_PER_MEMBER?: string;
  // Whether members can see who else is in the home (limits.ts
  // memberListVisibility): "members" (default) or "hidden".
  MEMBER_LIST?: string;
  // The `network` write policy's list of follows' follows (network.ts):
  // how many keys it may hold. A positive number.
  NETWORK_MAX_KEYS?: string;
  INVITES_PER_MEMBER?: string;
  INVITE_DEPTH?: string;
  PHOTO_STORAGE_BYTES?: string;
  PHOTO_MAX_BYTES?: string;
  // Rate limit for serving photos (wrangler.jsonc), separate from
  // RATE_LIMIT_API because an app showing a list of friends loads many
  // at once.
  RATE_LIMIT_PHOTOS?: RateLimit;
}
