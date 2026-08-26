// None of these are declared in wrangler.jsonc's `vars` (ROADMAP.md
// chunk 5: the Cloudflare deploy button prompts for every declared var
// with no notion of "optional", so a clean deploy must declare none).
// OWNER_PUBKEY is deliberately absent so a real deploy stays unclaimed
// (TOFU) by default, per CLAUDE.md "Ownership" -- it's injected as a
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
interface Env {
  OWNER_PUBKEY?: string;
  RELAY_NAME?: string;
  RELAY_DESCRIPTION?: string;
  RELAY_ICON?: string;
  ALLOW_FOLLOWS?: string;
  MAX_EVENT_BYTES?: string;
  MAX_EVENTS_PER_PUBKEY_PER_MINUTE?: string;
  NON_OWNER_STORAGE_BYTES?: string;
}
