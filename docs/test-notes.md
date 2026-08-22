# Test notes

Notes for whoever implements chunk 3 against the chunk 2 conformance suite.

## Layout

- `test/skeleton.test.ts`, `test/hibernation.test.ts` — chunk 1 smoke tests. Don't add protocol assertions here.
- `test/nip01-write.test.ts` — EVENT/OK: accept, duplicate, bad signature, id/content mismatch.
- `test/nip01-subscriptions.test.ts` — REQ/EOSE/CLOSE lifecycle, real-time delivery, sub replacement.
- `test/nip01-filters.test.ts` — ids/authors/kinds/`#tag`/since/until/limit, AND-within, OR-across, ordering.
- `test/nip01-kinds.test.ts` — regular vs. replaceable vs. addressable storage rules.
- `test/nip09-deletion.test.ts`, `test/nip40-expiration.test.ts`, `test/nip42-auth.test.ts` — one file per optional NIP.
- `test/ownership.test.ts` — owner-only write gate.
- `test/helpers/` — shared fixtures (see below).

## Helpers

- `keys.ts` — a fixed `OWNER_SECRET_KEY_HEX`/`OWNER_PUBKEY_HEX` pair (matches the `OWNER_PUBKEY` binding injected in `vitest.config.ts`), plus `randomKeypair()` for non-owner authors.
- `event.ts` — `signEvent()` builds a correctly-signed NIP-01 event; `withCorruptSignature()`/`withTamperedContent()` build negative fixtures.
- `socket.ts` — `connectRelay()` opens the hibernation-safe WS to the singleton DO; `publish()` and `collectStored()` wrap the send/await-response pattern.
- `isolate.ts` — `isolateStorage()` calls `reset()` in `afterEach`. **Call this at the top of every test file that writes events** — storage isolation in this vitest plugin is per file, not per test, and most files share the one owner pubkey.

## Why some things look the way they do

- Only the owner can write, so `authors`-filter tests use list membership (owner's key among others) rather than storing events from multiple authors — a second author's event can never reach storage in this relay.
- `test/nip40-expiration.test.ts`'s "does not return a stored event whose expiration has since passed" case inserts a row directly into the `events` table (via `runInDurableObject`) instead of going through the wire. That's the one deliberate exception to testing purely over the wire: there's no way to make an event expire *after* it was validly stored without controlling wall-clock time, and NIP-40's write-time and read-time rules are independent SHOULDs that need to be tested independently.
- NIP-42 tests cover the AUTH message's own validation contract (kind, freshness, challenge match) rather than a full challenge/response round trip — this relay has no auth-gated resource yet, so there's no scenario where it issues a challenge for a test to receive.

## Running

```bash
npm run test        # all suites
npm run typecheck
npx vitest run test/nip01-filters.test.ts   # one file
```

As of chunk 2, all 44 protocol tests fail identically with `no message received from relay within 250ms` — `webSocketMessage` is still a stub. That's the expected state; chunk 3 is done when this suite is green.
