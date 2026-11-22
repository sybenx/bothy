# More than one storage box (design only, not built)

Aaron: "so long as i can add another storage box later and easy, this is
fine". Today a home names one file server. This note says what it takes to
name several, so the one-box shape chosen now does not box us in. Nothing
here is built. Written 2026-11-22 for bothy 0.29.0.

## Today

- `setstorage [url, pubkey]` (owner) writes two `relay_settings` rows,
  `storage_url` and `storage_pubkey`. `setstorage [""]` deletes both.
- `getstorage` returns `{url, pubkey}` or null.
- NIP-11 shows `storage: {url}` once the relay is claimed and a URL is set.
- `memberkeys` is in `STORAGE_CALLABLE_METHODS`; index.ts lets a NIP-98
  signer call it only if `relay.ts isStorageService(pubkey)` is true, which
  compares against the single `storage_pubkey` row (storage.ts
  `storagePubkey`).

## Storage as a list, without breaking `storage.url`

NIP-11 keeps `storage.url` and adds a list beside it:

```json
"storage": {
  "url": "https://box-a.example",
  "boxes": [
    { "url": "https://box-a.example" },
    { "url": "https://box-b.example" }
  ]
}
```

- `storage.url` stays, always the FIRST box (the primary). Apps that read
  only `storage.url` keep working and just never see the others.
- New apps read `storage.boxes` when present, else `[{url: storage.url}]`.
- Order is the owner's: the first box is where new uploads go by default;
  the rest are extra room or a second home for backups. Which box a file
  lives on is the box's and the app's business, not the relay's (the file's
  URL already says it).

Methods:

- `setstorage [url, pubkey]` keeps its meaning: it sets the primary box,
  replacing box 1 only. `setstorage [""]` clears all of them (as today, a
  full clear).
- New `addstorage [url, pubkey]` appends a box; `removestorage [url]`
  drops one (removing the primary promotes the next). Both owner only,
  same URL and pubkey validation as setstorage.
- `getstorage` keeps returning `{url, pubkey}` for the primary (old admin
  pages) and gains `boxes: [{url, pubkey}]`. Additive, so old callers are
  unaffected.
- A cap (say 4 boxes) in limits.ts, so NIP-11 stays small.

## memberkeys for more than one key

- `isStorageService(pubkey)` becomes "is this pubkey one of the boxes",
  one indexed lookup instead of comparing one row. Nothing else in the gate
  changes: memberkeys is still answered for storage keys only, never the
  owner.
- The answer is the same for every box (members, admins, removed with
  deadlines); a box does not need to know about the others. If that ever
  changes, the caller's pubkey is already passed to `manage()`, so the
  answer can be tailored per box without a new method.
- Two boxes sharing one key works too (one row each, same pubkey).

## Data migration

- New table `storage_boxes (url TEXT PRIMARY KEY, pubkey TEXT NOT NULL,
  position INTEGER NOT NULL, added_at INTEGER NOT NULL)`, plus an index on
  `pubkey` for the gate.
- At schema init, once: if `storage_url`/`storage_pubkey` exist and the
  table is empty, insert them as position 0. Guarded on the table being
  empty, like `seedMailUsage`, so it runs once and is idempotent.
- Then either keep the two `relay_settings` rows mirrored to box 0 for one
  release (cheap rollback to an older bothy, which still reads them), or
  delete them in the release after. Mirroring is the safer default:
  redeploying an older tag then still finds its box.
- No change to any member, mail or photo data. Boxes hold their own files;
  the relay only stores URLs and keys.

## Effort

Small: one table, one migration, two new methods, a list in NIP-11 and
getstorage, the gate reading a table. Nothing about the
one-box version shipped now needs undoing to get there.
