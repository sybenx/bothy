# bothy — website source

This branch is the website at <https://sybenx.github.io/bothy/>. GitHub Pages
serves it from here, at the branch root.

It is deliberately not on `main`. The **Deploy to Cloudflare** button copies
`main` into the deploying user's own GitHub account, and `.github/workflows/sync.yml`
copies every upstream file down into that copy once a week — so anything added to
`main` becomes weight inside every relay anyone deploys. A website is not part of a
relay, so it lives here instead, where nothing downstream ever sees it.

## What is hand-written and what is generated

| Path | |
|---|---|
| `index.html` | The lander. Hand-written; nothing generates it. |
| `style.css` | One stylesheet for the whole site, lander and docs both. |
| `favicon.svg` | Same mark the relay's own admin page uses. |
| `docs/index.html` | **Generated** from `main`'s `README.md`. Do not edit. |
| `docs/rungs.html` | **Generated** from `main`'s `docs/rungs.md`. Do not edit. |
| `_src/build.mjs` | The generator. |
| `.nojekyll` | Stops GitHub Pages running the output through Jekyll. |

The README is the documentation, and it stays that way: the docs pages are built
from it rather than written twice, so the site cannot drift from the repository.
Edit the README on `main` and the site follows.

## How it rebuilds

`.github/workflows/site.yml`, on `main`, runs when `README.md` or `docs/rungs.md`
changes. It checks out both branches, runs the generator, and commits the result
here. Editing `_src/build.mjs` or anything else on this branch does not trigger it —
run it by hand from **Actions → Build site → Run workflow** when you change the
generator, or just build locally and push.

## Working on it locally

Put a checkout of this branch beside your `main` checkout:

```bash
git worktree add ../bothy-site gh-pages
cd ../bothy-site/_src && npm install
```

Then, from `../bothy-site`:

```bash
node _src/build.mjs --repo ../bothy --out .   # regenerate the docs pages
python3 -m http.server 8000                   # http://localhost:8000
```

Push this branch and GitHub Pages redeploys within a minute.

## Turning Pages on

Once, in the repository's **Settings → Pages**: source **Deploy from a branch**,
branch `gh-pages`, folder `/ (root)`.
