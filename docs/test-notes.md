# Test notes

Notes for whoever implements chunk 3 against the chunk 2 conformance suite.

## Layout

- `test/skeleton.test.ts`, `test/hibernation.test.ts` — chunk 1 smoke tests. Don't add protocol assertions here.
- `test/nip01-write.test.ts` — EVENT/OK: accept, duplicate, bad signature, id/content mismatch.
- `test/nip01-subscriptions.test.ts` — REQ/EOSE/CLOSE lifecycle, real-time delivery, sub replacement.
- `test/nip01-filters.test.ts` — ids/authors/kinds/`#tag`/since/until/limit, AND-within, OR-across, ordering.
- `test/nip01-kinds.test.ts` — regular vs. replaceable vs. ephemeral vs. addressable storage rules.
- `test/nostr-kinds.test.ts` — kind-classifier boundary values (44/45, 999/1000, 9999/10000, 19999/20000, 29999/30000, 39999/40000), asserted directly against `isReplaceableKind`/`isEphemeralKind`/`isAddressableKind` rather than over the wire.
- `test/nip09-deletion.test.ts`, `test/nip40-expiration.test.ts`, `test/nip42-auth.test.ts` — one file per optional NIP.
- `test/ownership.test.ts` — owner-only write gate (fixed OWNER_PUBKEY binding).
- `test/claim.test.ts` — TOFU claim flow: HTTP behavior with OWNER_PUBKEY set (chunk 4's actual test env), plus claim atomicity and pubkey normalization tested directly against real storage.
- `test/follows.test.ts` — ALLOW_FOLLOWS write gate, tested directly against real storage.
- `test/read-limits.test.ts` — subscription cap, unconstrained-filter rejection, per-IP throttle.
- `test/stats.test.ts` — `/api/stats` shape, `/api/profile` validation, admin page fallback.
- `test/helpers/` — shared fixtures (see below).

## Helpers

- `keys.ts` — a fixed `OWNER_SECRET_KEY_HEX`/`OWNER_PUBKEY_HEX` pair (matches the `OWNER_PUBKEY` binding injected in `vitest.config.ts`), plus `randomKeypair()` for non-owner authors.
- `event.ts` — `signEvent()` builds a correctly-signed NIP-01 event; `withCorruptSignature()`/`withTamperedContent()` build negative fixtures.
- `socket.ts` — `connectRelay()` opens the hibernation-safe WS to the singleton DO; `publish()` and `collectStored()` wrap the send/await-response pattern.
- `management.ts` — `callManagement()` sends a NIP-86 request through the Worker's fetch handler, signing the NIP-98 authorization for it. The management API is the one client path in this project that is plain HTTP rather than a WebSocket, so it does not go through `socket.ts` at all. Every field of `AuthOptions` overrides exactly one part of the authorization, so a reject-path test can break one rule at a time; the accept path is the same call with no overrides.
- `isolate.ts` — `isolateStorage()` calls `reset()` in `afterEach`. **Call this at the top of every test file that writes events** — storage isolation in this vitest plugin is per file, not per test, and most files share the one owner pubkey.

## Why some things look the way they do

- Only the owner can write, so `authors`-filter tests use list membership (owner's key among others) rather than storing events from multiple authors — a second author's event can never reach storage in this relay.
- `test/nip40-expiration.test.ts`'s "does not return a stored event whose expiration has since passed" case inserts a row directly into the `events` table (via `runInDurableObject`) instead of going through the wire. That's the one deliberate exception to testing purely over the wire: there's no way to make an event expire *after* it was validly stored without controlling wall-clock time, and NIP-40's write-time and read-time rules are independent SHOULDs that need to be tested independently.
- NIP-42 tests cover the AUTH message's own validation contract (kind, freshness, challenge match) rather than a full challenge/response round trip — this relay has no auth-gated resource yet, so there's no scenario where it issues a challenge for a test to receive.
- `test/claim.test.ts` and `test/follows.test.ts` cannot exercise the *unclaimed* relay or ALLOW_FOLLOWS=true over the wire: the global test env's OWNER_PUBKEY/ALLOW_FOLLOWS bindings (vitest.config.ts) are fixed for the whole run, matching every other suite. Instead they call the pure functions in `ownership.ts` (`claimOwner`, `getOwnerPubkey`, `isAllowedWriter`, `refreshFollows`) directly against real `SqlStorage` obtained via `runInDurableObject`, passing a hand-built `env` object rather than the injected one. This is the same category of exception `nip40-expiration.test.ts` documents for its own reason: no wire-protocol path exists to reach that state, so the test drops one level to real storage instead of mocking it.

- `test/nip86-management.test.ts`'s "still stores the value when an environment variable outranks it" case calls `handleManagementCall` directly against real `SqlStorage` with a hand-built `env`, the same exception `claim.test.ts` and `follows.test.ts` document above and for the same reason: the RELAY_NAME binding is fixed for the whole run by vitest.config.ts, so there is no wire path that reaches the state where an environment variable and a stored value are both set. Everything else about the management API is tested over real HTTP through the Worker.

- `test/websocket-close.test.ts` calls `webSocketClose` on the Relay instance directly instead of closing a client socket, for the same reason the fixtures above drop below the wire: RFC 6455's reserved codes (1005/1006/1015) are equally illegal for a client to *send*, so no wire-level close can deliver one. The runtime synthesizes them when a peer disappears, and calling the handler is the only way to reproduce that.

## Running

```bash
npm run test        # all suites
npm run typecheck
npx vitest run test/nip01-filters.test.ts   # one file
```


