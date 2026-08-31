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
        bindings: {
          OWNER_PUBKEY: OWNER_PUBKEY_HEX,
          // The upstream update check (src/upstream-version.ts) is on by
          // default in a real deployment, and every test that calls
          // /api/stats would therefore make a real request to
          // githubusercontent -- a suite whose results depend on the
          // network, and on someone else's availability, for a field
          // none of those tests are about. Off here; the one file that IS
          // about it (test/upstream-version.test.ts) passes its own env
          // and stubs fetch, so it exercises both states without either
          // one leaving the machine.
          UPDATE_CHECK: "off",
        },
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
