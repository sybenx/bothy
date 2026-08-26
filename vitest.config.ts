import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { OWNER_PUBKEY_HEX } from "./test/helpers/keys";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // OWNER_PUBKEY fixture for the ownership write-gate tests (see
      // test/ownership.test.ts and test/helpers/keys.ts). Set here rather
      // than in wrangler.jsonc so a real deploy stays unclaimed (TOFU) by
      // default -- see CLAUDE.md "Ownership".
      miniflare: {
        bindings: { OWNER_PUBKEY: OWNER_PUBKEY_HEX },
      },
    }),
  ],
  test: {
    // Only this repo's own suite. Without an explicit include, vitest
    // globs the whole working tree -- including .claude/worktrees/, where
    // a background task's checkout carries its own copy of test/. Those
    // files then run against THIS tree's wrangler config and bindings,
    // mixing two checkouts and failing for reasons that have nothing to
    // do with either. `npm run test` has to mean the same thing whether
    // or not a worktree happens to exist.
    include: ["test/**/*.test.ts"],
  },
});
