#!/usr/bin/env node
// Regenerates the "Turn on auto-update" badge link in README.md from the
// real .github/workflows/sync.yml.
//
// That badge is a GitHub "new file" URL carrying the whole workflow in a
// `?value=` query parameter, because the Cloudflare deploy button's clone
// arrives without .github/workflows/ (Cloudflare's GitHub App cannot
// write workflow files), so the one thing a downstream copy cannot
// inherit is the updater itself -- see README.md "Keeping it updated".
// Which means the README holds a second, URL-encoded copy of a file that
// also lives in this repo, and two copies of anything drift. This script
// is what makes the file the source of truth and the README a derived
// artifact: run it after every edit to sync.yml, and run it with --check
// in a review to find out whether someone forgot.
//
//   node scripts/sync-badge.mjs           # rewrite README.md in place
//   node scripts/sync-badge.mjs --check   # exit 1 if the README is stale
//
// Deliberately dependency-free and plain .mjs: it is a repo chore, not
// part of the Worker, so it is outside tsconfig's `include` and adds
// nothing to what gets deployed.

import { readFileSync, writeFileSync } from "node:fs";

const WORKFLOW_PATH = ".github/workflows/sync.yml";
const README_PATH = "README.md";

// GitHub's own web editor accepts the file body as `?value=`. The
// filename half is left literal (slashes and dots are legal in a query
// value and GitHub's URLs read better for it); the body half is fully
// escaped.
//
// encodeURIComponent leaves !'()* unescaped -- legal in a query string,
// but this URL sits inside a markdown link, where an unescaped ) ENDS THE
// LINK. `if: github.repository != 'sybenx/bothy'` alone carries three of
// them. So the four are escaped by hand on top of encodeURIComponent,
// which is also exactly the encoding the badge already committed to the
// README uses -- a run of this script against an unmodified sync.yml
// reproduces that URL byte for byte.
function encodeValue(text) {
  return encodeURIComponent(text).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

const workflow = readFileSync(WORKFLOW_PATH, "utf8");
const readme = readFileSync(README_PATH, "utf8");

const link = `](../../new/main?filename=${WORKFLOW_PATH}&value=${encodeValue(workflow)})`;

// Matches the link half of the badge only, so whatever label the README
// gives it is preserved -- this script owns the URL, not the wording.
const pattern = /\]\(\.\.\/\.\.\/new\/main\?filename=[^)]*\)/;
if (!pattern.test(readme)) {
  console.error(`${README_PATH}: no "new file" badge link found -- has the badge been renamed or removed?`);
  process.exit(1);
}

const updated = readme.replace(pattern, () => link);

if (process.argv.includes("--check")) {
  if (updated === readme) {
    console.log(`${README_PATH} badge is in sync with ${WORKFLOW_PATH}.`);
    process.exit(0);
  }
  console.error(
    `${README_PATH} badge is stale: it does not match ${WORKFLOW_PATH}. Run \`npm run sync-badge\`.`,
  );
  process.exit(1);
}

if (updated === readme) {
  console.log(`${README_PATH} badge already matches ${WORKFLOW_PATH}; nothing to do.`);
} else {
  writeFileSync(README_PATH, updated);
  console.log(`${README_PATH} badge regenerated from ${WORKFLOW_PATH}.`);
}
