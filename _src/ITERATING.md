# Iterating on the site with Claude Code

Paste the prompt below into Claude Code, run from a checkout of this branch.
It exists because the site was first built without a browser to look at, so
the visual pass — spacing, rhythm, the mark, the type scale — is the part
most worth doing again with a live preview open.

---

## Setup, before the prompt

From your `main` checkout:

```bash
git worktree add ../bothy-site gh-pages
cd ../bothy-site/_src && npm install && cd ..
python3 -m http.server 8000     # http://localhost:8000
```

Run Claude Code from `../bothy-site`.

---

## The prompt

> You are working on the website for **bothy**, a single-user nostr relay that
> runs on the Cloudflare free tier and deploys in one click. The site is served
> by GitHub Pages from this branch at `https://sybenx.github.io/bothy/`. A local
> server is already running on port 8000.
>
> **What is here**
>
> - `index.html` — the lander. Hand-written. This is the file to iterate on.
> - `style.css` — one stylesheet for the lander and the docs pages both.
> - `docs/index.html`, `docs/rungs.html` — **generated**; never edit them by
>   hand. They come from `README.md` and `docs/rungs.md` on `main`, via
>   `_src/build.mjs`. Rebuild with:
>   `node _src/build.mjs --repo ../bothy --out .`
> - `_src/build.mjs` — the generator. It rewrites the README's repo-relative
>   links so they resolve on the web, adds GitHub-compatible heading ids, and
>   builds the sidebar table of contents. If you change it, rebuild and check
>   that no relative `href` survives into the output:
>   `grep -o 'href="[^"]*"' docs/index.html | sort -u | grep -v 'href="https\?:\|href="#'`
>   Only `../`, `../style.css`, `../favicon.svg`, `../docs/` and `rungs.html`
>   should appear.
>
> **The design as it stands**
>
> Warm paper ground with a single accent — an ember `#a8492a`, meant as the lit
> window of the hut in the logo — against neutrals. Both themes are defined with
> custom properties on `:root` and re-declared under
> `@media (prefers-color-scheme: dark)`. System sans throughout, with a serif
> only for the pull quote in the hero. Section headings carry a short ember rule
> above them as a repeated motif. No JavaScript anywhere, no web fonts, no
> external requests except the two shield/button images inside the generated
> docs page.
>
> **The voice**
>
> Match the README, which is the project's real writing: precise, unhurried,
> gives the reason for a choice rather than asserting it, no hype, no
> exclamation marks, no "blazing fast". The strongest lines on the site are
> lifted from the README verbatim and should stay that way. Never claim a
> capability the README does not — check it before you write it.
>
> **What I want from you**
>
> Take screenshots at 1280px and 390px, in both colour schemes, and work on the
> visual result rather than the markup in the abstract. Specifically:
>
> 1. Vertical rhythm and section pacing on the lander — it was built without a
>    browser and the spacing is uniform rather than considered.
> 2. The hut mark in the hero. It is a hand-drawn SVG (roof, walls, door, ground
>    line, and one ember-filled window). See whether it can carry more of the
>    page's character at its current size, or wants to be larger and simpler.
> 3. The hero type scale: `clamp(3rem, 11vw, 4.25rem)` on the wordmark. Check the
>    awkward widths between the breakpoints.
> 4. The docs page's sticky sidebar: below 60rem it becomes a capped,
>    scrollable strip above the content. Check that it does not eat the fold on
>    a small phone.
>
> **Do not**
>
> - Add a framework, a build step for the lander, a web font, or any JavaScript.
>   The relay's own admin page is a single static file; the site should not be
>   heavier than the thing it describes.
> - Edit anything under `docs/` directly.
> - Change the copy's claims without checking them against `../bothy/README.md`.
>
> When you are done, show me the screenshots before committing.

---

## After you push

GitHub Pages redeploys this branch within a minute. The docs pages rebuild on
their own when `README.md` changes on `main`; see `.github/workflows/site.yml`
there. If you change `_src/build.mjs`, rebuild locally and commit the output, or
run **Actions → Build site → Run workflow**.
