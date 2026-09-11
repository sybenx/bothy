// The optional environment variables, merged onto the generated `Env`
// (worker-configuration.d.ts declares none of them). None is declared in
// wrangler.jsonc's `vars` block, because the deploy button prompts for
// every declared var and a clean deploy must ask for nothing but a
// project name; every one is read as `env.X ?? fallback`. Words are read
// by limits.ts readSwitch (trimmed, lowercased, a malformed value logged
// once and ignored); numbers by limits.ts resolveLimit.
interface Env {
  // The two Rate Limiting bindings declared in wrangler.jsonc. Optional
  // because Cloudflare's docs do not say which plans carry the binding;
  // index.ts calls `env.X?.limit(...)` and treats an absent binding as
  // "allowed", since a relay that throws on every request for want of a
  // binding is a worse failure than one that serves them unlimited.
  RATE_LIMIT_API?: RateLimit;
  RATE_LIMIT_PROFILE?: RateLimit;
  // `npub1...` or lowercase hex. Set, it fixes ownership and disables
  // /api/claim; unset, the relay is claimed by the first pubkey posted to
  // /api/claim (TOFU). A value that does not normalise resolves to null,
  // which reads as unclaimed while the claim endpoint stays disabled.
  OWNER_PUBKEY?: string;
  // The NIP-11 name, description and icon. Each outranks the value set
  // through NIP-86 change*, which outranks the owner's kind-0 (nip11.ts).
  RELAY_NAME?: string;
  RELAY_DESCRIPTION?: string;
  RELAY_ICON?: string;
  // A SECRET (`wrangler secret put VAPID_PRIVATE_KEY`), never a var:
  // base64url, the 32-byte P-256 scalar of this deployment's VAPID
  // keypair (push.ts). The public half is derived from it. Unset, or a
  // value that does not decode (logged once), means no push_key and no
  // push, which is a supported state.
  VAPID_PRIVATE_KEY?: string;
  // The newer-release check behind /api/stats (upstream-version.ts). On
  // unless set to `off`.
  UPDATE_CHECK?: string;
  // Ephemeral group chat (limits.ts chatMode). Unset: the relay reports
  // each hour what it would delete and deletes nothing. `on`: it deletes.
  // `off`: no sweep, no report, no horizon.
  EPHEMERAL_CHAT?: string;
  // The write policy by name (write-policy.ts): `owner`, `inbox`,
  // `follows`, `mentions` or `all`. Set, it outranks the value stored
  // through NIP-86 changewritepolicy; unset, the stored value applies,
  // then the default, `follows`. ALLOW_FOLLOWS is no longer read.
  WRITE_POLICY?: string;
  // NIP-29 groups (limits.ts groupsEnabled). Paused unless set to `on`.
  GROUPS?: string;
  // The three write-path caps (limits.ts). Each takes a positive number,
  // or `off` to remove that cap; anything else keeps the default.
  MAX_EVENT_BYTES?: string;
  MAX_EVENTS_PER_PUBKEY_PER_MINUTE?: string;
  NON_OWNER_STORAGE_BYTES?: string;
}
