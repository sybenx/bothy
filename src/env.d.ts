// OWNER_PUBKEY is deliberately absent from wrangler.jsonc's `vars` -- a
// real deploy stays unclaimed (TOFU) by default, per CLAUDE.md
// "Ownership". It's injected as a miniflare binding in vitest.config.ts
// for tests, and will be set by the chunk 4 claim flow at runtime, so the
// generated Env type (worker-configuration.d.ts) never declares it. This
// merges the optional field onto the same global `Env` interface.
interface Env {
  OWNER_PUBKEY?: string;
}
