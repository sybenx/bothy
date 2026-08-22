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
});
