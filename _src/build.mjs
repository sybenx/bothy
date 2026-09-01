#!/usr/bin/env node
/* Builds the docs pages of the bothy site from the repository's own
   markdown, so the site cannot drift from the README. The lander
   (../index.html) is hand-written and is never touched by this.

   Usage:  node _src/build.mjs [--repo <path>] [--out <path>]
     --repo  checkout of sybenx/bothy main   (default: ".")
     --out   checkout of the gh-pages branch (default: "site")

   Locally, from a gh-pages worktree beside a main checkout:
     node _src/build.mjs --repo ../bothy --out .
*/

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { marked } from "marked";

const REPO_URL = "https://github.com/sybenx/bothy";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const REPO = arg("--repo", ".");
const OUT = arg("--out", "site");

/* ---------- helpers ---------- */

const escapeAttr = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/* GitHub-compatible heading slugs, so anchors that work in the README
   work here too, and so a link someone copied from GitHub still lands. */
function slugify(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/* Links in the README are written for GitHub's own rendering: relative to
   the repository, not to a website. Every one of them has to be pointed
   somewhere that exists on the site or on GitHub, or the docs page ships
   with dead links in it. */
function rewriteHref(href, page) {
  if (/^(https?:|mailto:|#|\/\/)/i.test(href)) return href;

  // "../../tags", "../../new/main?..." — GitHub's own repo-root shorthand.
  if (href.startsWith("../../")) return `${REPO_URL}/${href.slice(6)}`;

  // Cross-references between the two pages this script generates.
  if (page === "readme" && href === "docs/rungs.md") return "rungs.html";
  if (page === "rungs" && (href === "../README.md" || href === "README.md")) return "./";

  // Anything else that points at a file in the repo: send it to GitHub,
  // which is where that file is actually readable.
  const path = href.replace(/^\.\//, "");
  return `${REPO_URL}/blob/main/${path}`;
}

/* ---------- rendering ---------- */

function render(markdown, page) {
  let html = marked.parse(markdown, { mangle: false, headerIds: false, gfm: true });

  // Tables need their own scroll container; the config table is wider than
  // a phone and must not widen the whole document.
  html = html.replace(/<table>/g, '<div class="table-scroll"><table>').replace(/<\/table>/g, "</table></div>");

  // Heading ids + a hover anchor, collecting the table of contents as we go.
  const toc = [];
  const seen = new Map();
  html = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level, inner) => {
    let id = slugify(inner);
    if (seen.has(id)) {
      const n = seen.get(id) + 1;
      seen.set(id, n);
      id = `${id}-${n}`;
    } else {
      seen.set(id, 0);
    }
    const text = inner.replace(/<[^>]+>/g, "");
    toc.push({ level: Number(level), id, text });
    return `<h${level} id="${id}">${inner}<a class="anchor" href="#${id}" aria-label="Link to this section">#</a></h${level}>`;
  });

  html = html.replace(/href="([^"]*)"/g, (m, href) => {
    const next = rewriteHref(href, page);
    return next === href ? m : `href="${escapeAttr(next)}"`;
  });

  return { html, toc };
}

function tocMarkup(toc) {
  if (!toc.length) return "";
  const items = toc
    .map((h) => `<li class="lvl-${h.level}"><a href="#${h.id}">${h.text}</a></li>`)
    .join("\n        ");
  return `<nav class="toc" aria-label="On this page">
      <p class="toc-title">On this page</p>
      <ul>
        ${items}
      </ul>
    </nav>`;
}

const BRAND = `<svg viewBox="0 0 16 16" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 8.5 8 3l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><rect x="4.5" y="8" width="7" height="5.5" fill="currentColor"/></svg>`;

function page({ title, description, body, toc, base, source }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${title}</title>
<meta name="description" content="${escapeAttr(description)}" />
<link rel="icon" type="image/svg+xml" href="${base}favicon.svg" />
<link rel="stylesheet" href="${base}style.css" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeAttr(title)}" />
<meta property="og:description" content="${escapeAttr(description)}" />
</head>
<body>

<a class="skip" href="#main">Skip to content</a>

<header class="topbar">
  <div class="wrap">
    <a class="brand" href="${base}">${BRAND} bothy</a>
    <nav>
      <a href="${base}docs/" aria-current="page">Docs</a>
      <a href="${REPO_URL}">GitHub</a>
    </nav>
  </div>
</header>

<div class="docs-layout">
  ${tocMarkup(toc)}
  <article class="doc" id="main">
${body}
  </article>
</div>

<footer class="site">
  <div class="wrap">
    <span>MIT licensed.</span>
    <a href="${REPO_URL}">Source</a>
    <a href="${base}">Home</a>
    <a href="https://github.com/sybenx/hearth">hearth, the client</a>
    <span class="spacer"></span>
    <span>Generated from <a href="${REPO_URL}/blob/main/${source}">${source}</a>.</span>
  </div>
</footer>

</body>
</html>
`;
}

/* ---------- build ---------- */

function build(srcPath, outPath, opts) {
  const md = readFileSync(join(REPO, srcPath), "utf8");
  const { html, toc } = render(md, opts.page);
  mkdirSync(dirname(join(OUT, outPath)), { recursive: true });
  writeFileSync(join(OUT, outPath), page({ ...opts, body: html, toc }), "utf8");
  console.log(`${srcPath} -> ${outPath}  (${toc.length} headings, ${html.length} bytes)`);
}

build("README.md", "docs/index.html", {
  page: "readme",
  source: "README.md",
  title: "bothy documentation",
  description:
    "Setup, configuration, ownership, group chat, push notifications and the relay management API for bothy — a single-user nostr relay on the Cloudflare free tier.",
  base: "../",
});

build("docs/rungs.md", "docs/rungs.html", {
  page: "rungs",
  source: "docs/rungs.md",
  title: "The write ladder — bothy",
  description:
    "A relay's write policy as a ladder of rungs, from owner-only up to the open relay bothy deliberately refuses to become.",
  base: "../",
});
