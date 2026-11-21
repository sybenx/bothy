#!/usr/bin/env node
// Moves the build and test tooling forward, and nothing else.
//
// The rule for what is automated is the split package.json already makes:
//
//   devDependencies   moved here, within their current major version
//   dependencies      never moved here, only reported
//
// devDependencies are wrangler, the test runner and the compiler. None of
// their code is in the Worker, and a bad release of one shows up as a failed
// typecheck, a failed test or a failed build, which is exactly what the
// workflow calling this checks before it commits anything.
//
// dependencies are @noble/curves and @noble/hashes: the signature
// verification every event on the relay depends on, and the only third-party
// code that ships. They release a few times a year. A person reads that
// changelog.
//
// A new MAJOR version of anything is reported and left alone too, since a
// major is where a tool is allowed to change what its config means.
//
// Nothing here touches wrangler.jsonc's compatibility_date (it changes how
// the runtime behaves, which no test of ours can fully see) or the version in
// package.json, which moves only with a release: it is bumped by hand
// whenever main moves past the last tag (docs/workflow.md "Releasing").
//
// Outside tsconfig's `include` and outside the deploy, like sync-badge.mjs.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A release has to have been public this long before it is taken. Most
// compromised npm releases are found and pulled within days, and nothing
// here is urgent enough to be first.
const COOLDOWN_DAYS = 7;

const cutoff = Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
const readPkg = () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const pkg = readPkg();

// Stable releases only: "4.165.0", never "5.0.0-beta.2".
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const newer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function releases(name) {
  const out = execFileSync("npm", ["view", name, "time", "--json"], { encoding: "utf8" });
  const parsed = JSON.parse(out);
  const times = Array.isArray(parsed) ? parsed[0] : parsed;
  return Object.entries(times)
    .map(([version, at]) => ({ version, parts: parse(version), at: Date.parse(at) }))
    .filter((r) => r.parts !== null)
    .sort((a, b) => newer(a.parts, b.parts));
}

const take = [];
const held = [];

for (const [name, current] of Object.entries(pkg.devDependencies ?? {})) {
  const now = parse(current);
  if (now === null) {
    held.push(`${name}: "${current}" is not an exact version, left alone`);
    continue;
  }
  const all = releases(name);
  const sameMajor = all.filter((r) => r.parts[0] === now[0] && r.at <= cutoff && newer(r.parts, now) > 0);
  const best = sameMajor.at(-1);
  if (best) take.push({ name, from: current, to: best.version });
  const latest = all.at(-1);
  if (latest && latest.parts[0] > now[0]) held.push(`${name}: ${latest.version} is a new major`);
}

for (const [name, current] of Object.entries(pkg.dependencies ?? {})) {
  const now = parse(current);
  const latest = releases(name).at(-1);
  if (now && latest && newer(latest.parts, now) > 0) {
    held.push(`${name}: ${current} -> ${latest.version} ships in the relay`);
  }
}

const npm = (args) => execFileSync("npm", args, { stdio: ["ignore", process.stderr, process.stderr] });

if (take.length > 0) {
  npm(["install", "--save-exact", "--save-dev", ...take.map((t) => `${t.name}@${t.to}`)]);
}

// Advisories are the one thing taken without the cooldown: `audit fix` only
// moves a package that has a published advisory against it, and only within
// the ranges the tooling above already accepts.
try {
  npm(["audit", "fix"]);
} catch {
  // Exits non-zero when something is left that it cannot fix in range. The
  // workflow's own `npm audit` step is what reports that.
}

// package.json's allowScripts pins the install scripts npm may run to exact
// versions, so a wrangler bump that brings a new workerd or esbuild leaves
// them blocked. Re-approve the SAME package names that are already approved,
// at their new versions. A package that newly wants an install script is not
// on that list and stays blocked.
const approved = [...new Set(Object.keys(readPkg().allowScripts ?? {}).map((k) => k.slice(0, k.lastIndexOf("@"))))];
if (take.length > 0) {
  // One at a time: fsevents is macOS-only and is not installed on the Linux
  // runner, and one name npm has nothing to approve for must not stop the
  // others.
  for (const name of approved) {
    try {
      npm(["install-scripts", "approve", name]);
    } catch {
      console.error(`install-scripts: nothing approved for ${name}`);
    }
  }
}

// stdout is the summary, and the workflow uses it as the commit body.
for (const t of take) console.log(`${t.name} ${t.from} -> ${t.to}`);
if (held.length > 0) {
  console.error("\nLeft for a person:");
  for (const h of held) console.error(`  ${h}`);
}
