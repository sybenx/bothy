// None of these are declared in wrangler.jsonc's `vars` (ROADMAP.md
// chunk 5: the Cloudflare deploy button prompts for every declared var
// with no notion of "optional", so a clean deploy must declare none).
// OWNER_PUBKEY is deliberately absent so a real deploy stays unclaimed
// (TOFU) by default, per CLAUDE.md "Ownership" -- it's injected as a
// miniflare binding in vitest.config.ts for tests, and set by the claim
// flow at runtime. RELAY_NAME/RELAY_DESCRIPTION/RELAY_ICON/ALLOW_FOLLOWS
// are optional advanced overrides anyone can add in the Cloudflare
// dashboard; read them defensively with `env.X ?? fallback` everywhere
// they're used (nip11.ts, ownership.ts) since they may be undefined.
// The generated Env type (worker-configuration.d.ts) never declares any
// of these, so this merges the optional fields onto the global `Env`.
interface Env {
  OWNER_PUBKEY?: string;
  RELAY_NAME?: string;
  RELAY_DESCRIPTION?: string;
  RELAY_ICON?: string;
  ALLOW_FOLLOWS?: string;
}
