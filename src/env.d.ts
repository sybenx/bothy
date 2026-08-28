// None of these are declared in wrangler.jsonc's `vars`: the Cloudflare
// deploy button prompts for every declared var with no notion of
// "optional", so a clean deploy must declare none (CLAUDE.md
// "Configuration").
// OWNER_PUBKEY is deliberately absent so a real deploy stays unclaimed
// (TOFU) by default, per CLAUDE.md "What it is" -- it's injected as a
// miniflare binding in vitest.config.ts for tests, and set by the claim
// flow at runtime. RELAY_NAME/RELAY_DESCRIPTION/RELAY_ICON are optional
// advanced overrides anyone can add in the Cloudflare dashboard; read
// them defensively with `env.X ?? fallback` everywhere they're used
// (nip11.ts, ownership.ts) since they may be undefined. ALLOW_FOLLOWS is
// an opt-OUT: writes from the owner's follows are enabled by default, and
// setting it to the exact string "false" is the only way to turn them
// off (ownership.ts allowFollowsEnabled).
// MAX_EVENT_BYTES/MAX_EVENTS_PER_PUBKEY_PER_MINUTE/NON_OWNER_STORAGE_BYTES
// are the three write-path abuse caps (limits.ts), raisable for anyone on
// a paid plan where the free tier's ceilings don't apply. Each takes a
// positive number, or the exact string "off" to disable that cap
// entirely -- the same only-one-exact-value-disables-it shape as
// ALLOW_FOLLOWS, so no truthy value can remove a safety limit by
// accident (limits.ts resolveLimit).
// The generated Env type (worker-configuration.d.ts) never declares any
// of these, so this merges the optional fields onto the global `Env`.
// RATE_LIMIT_API/RATE_LIMIT_PROFILE are the two Rate Limiting bindings
// declared in wrangler.jsonc (see the comment there for the values and
// why there are two). Optional for the same defensive reason every var
// above is read with `?? fallback`: Cloudflare's docs do not say which
// plans the binding is available on, and a relay that throws on every
// request because a binding is missing would be a far worse failure than
// one that serves them unlimited. src/index.ts calls them as
// `env.X?.limit(...)` and treats an absent binding as "allowed".
interface Env {
  RATE_LIMIT_API?: RateLimit;
  RATE_LIMIT_PROFILE?: RateLimit;
  // `npub1...` or lowercase hex -- ownership.ts getOwnerPubkey runs it
  // through pubkey.ts normalizePubkey, like every other pubkey boundary.
  // A value that does not normalize resolves to null, which reads as
  // unclaimed; the claim endpoint stays disabled either way, since
  // index.ts gates it on this being set rather than on it resolving.
  OWNER_PUBKEY?: string;
  RELAY_NAME?: string;
  RELAY_DESCRIPTION?: string;
  RELAY_ICON?: string;
  ALLOW_FOLLOWS?: string;
  MAX_EVENT_BYTES?: string;
  MAX_EVENTS_PER_PUBKEY_PER_MINUTE?: string;
  NON_OWNER_STORAGE_BYTES?: string;
}
