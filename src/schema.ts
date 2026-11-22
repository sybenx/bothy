import { sha256 } from "@noble/hashes/sha2.js";
import { TOP_LEVEL_GROUP_ID } from "./groups";
import { bytesToHex } from "@noble/hashes/utils.js";
import { generateRelayKeypair } from "./relay-identity";

// Schema, index set and rows-written accounting for the Relay Durable
// Object's SQLite storage.
//
// Rows written per stored event, as SqlStorageCursor.rowsWritten reports them
// (test/hibernation.test.ts pins this as eventRowCostMeasured):
//
//   events row      1 base + 1 implicit PK index (`id TEXT PRIMARY KEY` is
//                   not a rowid alias) + one half of each of the three
//                   partial pairs + idx_events_ingested                 = 6
//   counters        maintained_counts, event_hour_counts,
//                   ingest_hour_counts (EVENT_COUNTER_ROW_COST)          = 3
//   per tag row     1 base + one half of the lookup pair
//                   + idx_event_tags_event                               = 3
//
//   => 9 + 3T for T single-letter tags: a bare note 9, a reply carrying #e
//      and #p 15, a five-tag note 24. eventRowCost deliberately charges
//      12 + 4T; see EVENT_BASE_ROW_COST.
//
// Workers Free allows 100,000 rows written and 5,000,000 rows read per day,
// and those two ceilings shape this file (a 1GB storage budget, limits.ts storageBudget, and 10ms of CPU
// per request are not close to binding). The REQ-serving indexes keep reads
// bounded: without idx_events_kind_created_* and idx_events_pubkey_created_*,
// `{"kinds":[1],"limit":20}` and `{"authors":[owner],"limit":20}` each read
// more than the whole table whatever their limit; with them, 41 rows
// (test/read-cost.test.ts). On a single-owner relay every row shares one
// pubkey, so pinning the pubkey alone bounds nothing.
//
// The index set is declared once, as data (INDEXES), and the per-event cost
// is derived from it (eventRowCost), so adding an index updates every
// consumer of the cost at once instead of relying on a constant being kept in
// step by hand.
//
// `event_tags` stores single-letter tag names only, because NIP-01 filters
// only on "#<single-letter>"; other tags stay in `events.tags`, unindexed.
//
// `deleted_ids` is the tombstone set, outside the per-event cost: a NIP-09 or
// NIP-62 deletion or a NIP-86 banevent writes one (TOMBSTONE_ROW_COST,
// storage.ts deleteAndTombstone) so a sender holding a signed copy cannot
// store it again. Replaceable/addressable replacement uses the untombstoned
// deleteEventRow, since a superseded version carries no replay risk.

// ---------------------------------------------------------------------
// The schema is declared here, once, as data. Both the CREATE TABLE for a
// fresh database and the ALTER TABLE ADD COLUMN for an existing one are
// generated from it (reconcileColumns), so a new column cannot skip its own
// migration. `CREATE TABLE IF NOT EXISTS` is a no-op on an existing table, so
// a column added only to a CREATE statement never reaches a deployed relay,
// and tests cannot catch that because they always start from an empty
// database. Adding a column is a one-line edit to a TABLES entry.
// ---------------------------------------------------------------------

export interface ColumnSpec {
  readonly name: string;
  // Everything that follows the column name in CREATE TABLE, used
  // verbatim in ALTER TABLE ADD COLUMN as well. Keeping one string for
  // both is what makes the two paths incapable of disagreeing.
  readonly definition: string;
  // Other columns in the same table to set to NULL when THIS column is added
  // to an existing database by ALTER TABLE (never on a fresh CREATE TABLE).
  // For a column derived from another column's data behind a "has the source
  // changed since we last derived this" guard: the source has not changed, so
  // a newly added column would never get its first derivation. Resetting the
  // guard forces one re-derive. See owner.about.
  readonly resetsOnAdd?: readonly string[];
}

export interface TableSpec {
  readonly name: string;
  readonly columns: readonly ColumnSpec[];
  // Table-level constraints, in practice a composite PRIMARY KEY. Used in
  // CREATE TABLE only: SQLite's ALTER TABLE cannot add one
  // (sqlite.org/lang_altertable.html), so a table whose key changes needs a
  // new name and a data migration. reconcileColumns never sees these;
  // computeSchemaHash covers them.
  readonly tableConstraints?: readonly string[];
}

function col(name: string, definition: string, resetsOnAdd?: readonly string[]): ColumnSpec {
  return resetsOnAdd ? { name, definition, resetsOnAdd } : { name, definition };
}

export const TABLES: readonly TableSpec[] = [
  {
    name: "events",
    columns: [
      col("id", "TEXT PRIMARY KEY"),
      col("pubkey", "TEXT NOT NULL"),
      col("created_at", "INTEGER NOT NULL"),
      col("kind", "INTEGER NOT NULL"),
      col("tags", "TEXT NOT NULL"),
      col("content", "TEXT NOT NULL"),
      col("sig", "TEXT NOT NULL"),
      col("expiration", "INTEGER"),
      // The wall-clock second this relay wrote the row, as opposed to
      // `created_at`, the second the author says they signed it. Anything
      // that measures what the relay did (estimateRowsWrittenSince and
      // backfill.ts hasBackfillHeadroom, ingest_hour_counts) must key on
      // this: a backfilled event carries its original, often years-old
      // created_at, so measuring by created_at hides backfill's own writes
      // from the guard that restrains backfill.
      //
      // Nullable: rows stored before the column existed are NULL and never
      // match `> cutoff`, which undercounts only the 24h window straddling
      // the upgrade. Deliberately not backfilled from `created_at`, which
      // would reintroduce the conflation. Indexed by idx_events_ingested,
      // with `row_cost`.
      col("ingested_at", "INTEGER"),
      // This event's eventRowCost() (the deliberately high figure; see
      // EVENT_BASE_ROW_COST), stamped at insert by storage.ts insertEventRow
      // so estimateRowsWrittenSince sums a column instead of rebuilding the
      // figure from a join against `event_tags`, which reads E + T rows. A
      // column on an existing INSERT costs no extra rows written. Carried as
      // the covering payload of idx_events_ingested so the SUM never touches
      // the table.
      //
      // Nullable; NULL rows are absent from the SUM. Not backfilled: a row's
      // cost under an older index set is not its cost today, and inventing
      // one gives a wrong number rather than a known-low one.
      col("row_cost", "INTEGER"),
      // 1 when this event belongs to a group this relay hosts (groups.ts
      // isGroupEvent: an `h` tag, or for the 39000-series a `d` tag, naming a
      // row in `groups`), else 0. Kinds 39000 and 39001 are group state but
      // public, so they are 0 (groups.ts isPubliclyReadableGroupKind).
      //
      // A PARTITION: the REQ-serving indexes are partial pairs keyed on it,
      // so every query against `events` must pin `is_group` to one value or
      // it can use neither half and scans the table (see INDEXES, and the
      // partition rule in storage.ts). A column rather than a second table:
      // it costs no rows written, and a second table measured no cheaper on
      // any read while doubling every write, delete and tombstone path.
      //
      // DEFAULT 0, so rows that predate the column migrate as public.
      col("is_group", "INTEGER NOT NULL DEFAULT 0"),
      // WHICH group, where `is_group` says only whether. NULL exactly when
      // `is_group = 0`. Kept apart from the boolean because a partial index
      // needs a fixed predicate (`is_group = 0` / `= 1`) and a relay hosting
      // many groups cannot have an index pair per id: the boolean stays the
      // partition, and `group_id` scopes a read within the group partition
      // after the partition seek. It also spares readers from knowing that
      // the 39000-series names its group in `d` rather than `h` (groups.ts
      // groupIdOf).
      col("group_id", "TEXT"),
    ],
  },
  {
    name: "event_tags",
    columns: [
      col("tag_name", "TEXT NOT NULL"),
      col("tag_value", "TEXT NOT NULL"),
      col("event_id", "TEXT NOT NULL"),
      col("created_at", "INTEGER NOT NULL"),
      // Copied from the event at insert, like `created_at`, so the tag
      // subquery can exclude the other partition before its own LIMIT
      // (filters.ts tagScanLimit) applies. Excluded only afterwards, the
      // candidate set fills with group rows: at 50,000 group events a client
      // asking for 20 got 1. Costs no extra rows written, because the lookup
      // index is a partial pair on this column.
      col("is_group", "INTEGER NOT NULL DEFAULT 0"),
      // Copied from the event, for the same reason `is_group` is: the
      // tag-filter subquery reads this table alone, so it has to scope to
      // a group without joining back to `events`.
      col("group_id", "TEXT"),
    ],
  },
  {
    // TOFU ownership: at most one row, ever. The claim paths in ownership.ts
    // are the only writers and refuse if a row exists.
    name: "owner",
    columns: [
      col("pubkey", "TEXT NOT NULL"),
      // name/picture/about/website cache the owner's kind-0, backing the
      // NIP-11 name/description/icon/contact (nip11.ts resolveName and its
      // siblings). NULL when the lookup found nothing.
      col("name", "TEXT"),
      col("picture", "TEXT"),
      // resetsOnAdd: added after profile_synced_at existed on deployed
      // relays, so without clearing that guard ownership.ts refreshProfile
      // would see no newer kind-0 to parse and this column would stay NULL
      // forever.
      col("about", "TEXT", ["profile_synced_at"]),
      // Backs NIP-11 `contact` (nip11.ts resolveContact). resetsOnAdd for the
      // same reason as `about`.
      col("website", "TEXT", ["profile_synced_at"]),
      // profile_synced_at is the created_at of the stored kind-0 the cached
      // fields were last derived from, so ownership.ts refreshProfile can ask
      // "is there a newer one" without re-parsing every tick.
      // icon_refreshed_at limits the icon refresh to once a day however often
      // the cron fires.
      col("profile_synced_at", "INTEGER"),
      col("icon_refreshed_at", "INTEGER"),
      // The claim nonce that won, for a QR claim (ownership.ts
      // claimWithNonce, reached by /api/claim with a code or by
      // /api/claim-signed); NULL for a plain paste claim. GET
      // /api/claim-status compares against it to tell "this QR won" from
      // "claimed some other way", because claim_nonces is wiped the moment
      // any claim succeeds (ownership.ts clearClaimNonces).
      col("claim_nonce", "TEXT"),
    ],
  },
  {
    // Single-use claim nonces for the QR claim (limits.ts
    // CLAIM_NONCE_TTL_SECONDS), minted by POST /api/claim-nonce and consumed
    // by /api/claim or /api/claim-signed. Anyone can grow this table on an
    // unclaimed relay, so ownership.ts issueClaimNonce deletes expired rows
    // on every issuance rather than only excluding them from the count. That
    // keeps it at MAX_OUTSTANDING_CLAIM_NONCES rows whatever a flood does, at
    // 2 rows written per issuance, and the table is wiped when any claim
    // succeeds.
    name: "claim_nonces",
    columns: [
      col("nonce", "TEXT PRIMARY KEY"),
      col("created_at", "INTEGER NOT NULL"),
      col("expires_at", "INTEGER NOT NULL"),
    ],
  },
  {
    // Follow cache: the owner's kind-3 follow list (ownership.ts
    // refreshFollows). Rebuilt wholesale when the follow set changes, so no
    // index beyond the primary key.
    //
    // `fetched_at` is the `created_at` of the kind-3 the rows were derived
    // from, not the wall clock. Every row carries the same value, so one row
    // read answers for the table (storage.ts followsListAt). Kept here rather
    // than on `owner` because under OWNER_PUBKEY there is no owner row.
    // Whether to rebuild is decided by relay_meta.follows_hash, not by this
    // timestamp.
    name: "follows",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("fetched_at", "INTEGER NOT NULL")],
  },
  {
    name: "deleted_ids",
    columns: [col("id", "TEXT PRIMARY KEY")],
  },
  {
    // NIP-62 vanish requests still draining (storage.ts
    // beginVanish/drainVanish, relay.ts runCron). One row per pubkey, deleted
    // when nothing is left.
    //
    // A vanish is sized by the sender, so it can exceed one tick's budget:
    // removing a two-tag event costs 8 rows written as the cursor counts them
    // and is paced against a pessimistic 22 (eventRemovalRowsWritten /
    // eventRemovalBudget). Without a checkpoint, a drain cut off partway
    // would leave a half-vanished pubkey that looks finished, and NIP-62
    // requires full deletion.
    //
    // `cutoff_created_at` is the ORIGINAL request's created_at, stored so a
    // resumed drain removes exactly the set that was asked for.
    name: "vanishing",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("cutoff_created_at", "INTEGER NOT NULL"),
      col("requested_at", "INTEGER NOT NULL"),
      // Purely diagnostic: how many rows have been removed so far, so a
      // stalled drain is visible on /api/stats rather than inferred.
      col("deleted_so_far", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // This deployment's own host (see src/host.ts) -- recorded from
    // inbound request traffic, not known at deploy time. Single row, like
    // backfill_meta below.
    name: "relay_meta",
    columns: [
      col("host", "TEXT"),
      // One-time guard for storage.ts fixMisclassifiedGroupEvents (run from
      // relay.ts runCron), which moves events wrongly filed in the group
      // partition: 0 until a tick finds nothing left to fix, then permanently
      // 1. Same shape as backfill_meta.exhaust_reset_applied.
      col("group_scope_fixed", "INTEGER NOT NULL DEFAULT 0"),
      // One-time guard for storage.ts migrateToMultiGroup (run from relay.ts
      // runCron), same shape as group_scope_fixed. A fresh relay has nothing
      // to migrate and reaches 1 on its first tick.
      col("multi_group_migrated", "INTEGER NOT NULL DEFAULT 0"),
      // Fingerprint of the follow SET the `follows` table holds (ownership.ts
      // computeFollowsHash), so refreshFollows can tell "a newer kind-3
      // arrived" from "the follows changed" with one row read; clients
      // routinely republish unchanged lists. Written only after a rebuild
      // completes, so a rebuild that dies partway leaves the old hash and the
      // next call retries. NULL until the first rebuild, and cleared with the
      // cache.
      col("follows_hash", "TEXT"),
    ],
  },
  {
    // This relay's own signing keypair (relay-identity.ts), distinct from the
    // owner's pubkey; nip29.ts signs the 39000-series with it. Exactly one
    // row, seeded at schema init (seedRelayIdentity) rather than at claim,
    // because OWNER_PUBKEY skips claim() and the identity must exist then
    // too.
    name: "relay_identity",
    columns: [col("secret_key", "TEXT NOT NULL"), col("public_key", "TEXT NOT NULL")],
  },
  {
    // One-shot backfill: one row per relay in the owner's kind-10002 list,
    // tracking how far back it has been fetched. Persisted so hourly cron
    // ticks can resume a backfill that needs more than a day within its share
    // of the rows-written ceiling (backfill.ts).
    name: "backfill_relays",
    columns: [
      col("relay_url", "TEXT PRIMARY KEY"),
      // Walks backward in time as pages are ingested (backfill.ts).
      col("until_cursor", "INTEGER NOT NULL"),
      // Set once a relay returns a page that is both empty AND terminated
      // by a real EOSE. A short-but-nonempty page (the relay's own
      // per-REQ cap), a page cut off by a fetch timeout or connection
      // error, and a refusal must never set this, since none of them mean
      // "no more history" -- see backfill.ts applyBackfillPage.
      col("exhausted", "INTEGER NOT NULL DEFAULT 0"),
      // The CLOSED, NOTICE or AUTH text a relay sent instead of history
      // (backfill-worker.ts fetchPage). Set only on an empty page and cleared
      // when events arrive, so it always explains why a relay is currently
      // producing nothing; without it, "auth-required" and silence look the
      // same.
      col("last_refusal", "TEXT"),
    ],
  },
  {
    // Single-row backfill status (backfill.ts
    // getBackfillStatus/seedBackfillRelays).
    name: "backfill_meta",
    columns: [
      // 'pending' until the owner's relay list has been discovered,
      // 'running' while any backfill_relays row is unexhausted,
      // 'paused-budget' when a cron tick's ingest hit the daily
      // rows-written ceiling and stopped without finishing its page,
      // 'done' once every relay is exhausted.
      col("status", "TEXT NOT NULL DEFAULT 'pending'"),
      col("total_stored", "INTEGER NOT NULL DEFAULT 0"),
      col("last_run_at", "INTEGER"),
      // One-time guard for backfill.ts resetWronglyExhaustedRelays, which
      // clears the exhausted flag on relays wrongly marked exhausted by a
      // short page: 0 until it has run once, then permanently 1.
      col("exhaust_reset_applied", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // NIP-86 banevent/allowevent/listbannedevents (nip86.ts). Kept apart from
    // deleted_ids, which also holds NIP-09 and NIP-62 deletions: this table
    // is "what did I ban, and why" for listbannedevents. banevent writes both
    // (the tombstone is what refuses a re-send or a backfill replay);
    // allowevent clears both.
    name: "banned_events",
    columns: [col("id", "TEXT PRIMARY KEY"), col("reason", "TEXT"), col("banned_at", "INTEGER NOT NULL")],
  },
  {
    // NIP-86 blockip/unblockip/listblockedips (nip86.ts). Read once per
    // WebSocket connection in Relay.fetch, never per message, and never on
    // the management endpoint, so blocking your own address cannot lock you
    // out of the API that unblocks it.
    name: "blocked_ips",
    columns: [col("ip", "TEXT PRIMARY KEY"), col("reason", "TEXT"), col("blocked_at", "INTEGER NOT NULL")],
  },
  {
    // NIP-86 changerelayname/changerelaydescription/changerelayicon
    // (nip86.ts). One row per set key ('name', 'description', 'icon',
    // 'write_policy', and 'storage_url'/'storage_pubkey' from setstorage).
    // Clearing deletes the row rather than storing "", so nip11.ts's
    // resolution chain can tell "unset" from "set to empty".
    name: "relay_settings",
    columns: [col("key", "TEXT PRIMARY KEY"), col("value", "TEXT NOT NULL")],
  },
  {
    // NIP-86 banpubkey/unbanpubkey/listbannedpubkeys (nip86.ts). Read on the
    // write path: ownership.ts isAllowedWriter checks it for every non-owner
    // write, before the policy and follows checks, so a banned pubkey is
    // refused even if followed. One indexed read per non-owner write.
    name: "banned_pubkeys",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("reason", "TEXT"), col("banned_at", "INTEGER NOT NULL")],
  },
  {
    // NIP-86 allowpubkey/unallowpubkey/listallowedpubkeys (nip86.ts): a
    // manual allowlist admitting pubkeys the write policy would otherwise
    // refuse, and the OUTER of the two nested group lists (nip29.ts).
    // ownership.ts isAllowedWriter reads it only after the follows check has
    // failed, so the common accept path never pays for it.
    name: "allowed_pubkeys",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("reason", "TEXT"),
      col("allowed_at", "INTEGER NOT NULL"),
      // Who granted this row, which decides whether a NIP-29 remove-user may
      // take it back. 'owner': an explicit NIP-86 allowpubkey. 'invite':
      // written by kind-9000 put-user or a redeemed kind-9021 join
      // (storage.ts allowPubkeyForGroup), because a group member also needs
      // relay-wide write access. remove-user deletes only 'invite' rows:
      // deleting every row would revoke grants the owner made separately,
      // deleting none would let removed members write forever.
      //
      // 'member': written by a redeemed member invite (nip86.ts
      // redeeminvite, storage.ts redeemMemberInvite). Every row is a member,
      // whatever its source (storage.ts isMember); the source only says
      // how they got in.
      //
      // 'request': the owner approved a join request (nip86.ts approvejoin).
      //
      // allowpubkey on an existing row promotes it to 'owner'; nothing
      // demotes an 'owner' row (allowPubkeyForGroup does nothing on
      // conflict). DEFAULT 'owner' because allowpubkey was the only writer
      // before this column existed.
      col("source", "TEXT NOT NULL DEFAULT 'owner'"),
      // Who let them in, as a hex pubkey: the edge of the invite tree. The
      // creator of the code they redeemed, the member whose link a request
      // came through, or the owner. NULL on rows written before it existed
      // and on rows a NIP-29 group wrote; listmembers reports those as the
      // owner's, so every row has a parent. Removing someone re-parents
      // their invitees or removes them too (storage.ts removeMember).
      col("invited_by", "TEXT"),
      // The member invite code they redeemed, if they came that way, so
      // erasing their account (storage.ts eraseMember) gives the place
      // back on that exact code. NULL for every other way in, and for
      // members who joined before this column.
      col("via_code", "TEXT"),
    ],
  },
  // The groups this relay hosts, one row each. NIP-29 leaves creation to the
  // relay ("relays ... will create rules around some specific ids"), and a
  // row here is that rule. Written by kind-9007 create-group (storage.ts
  // createGroup) and by seedTopLevelGroup for `_`. An `h` tag naming an id
  // with no row is a stranger's tag and lands in the public partition.
  {
    name: "groups",
    columns: [
      col("id", "TEXT PRIMARY KEY"),
      col("created_at", "INTEGER NOT NULL"),
      // The operator-set metadata a kind-9002 carries, kept here so a
      // 39000 can be regenerated without re-reading the previous one.
      col("name", "TEXT"),
      col("picture", "TEXT"),
      col("about", "TEXT"),
      // Whether joining needs an invite. NIP-29's other axis, `private`, is
      // not a column: on this relay it is the same for every group (a group's
      // existence, name and picture are public; its messages and member list
      // are not), and it is enforced by which partition a row lands in
      // (groups.ts isGroupEvent).
      col("is_closed", "INTEGER NOT NULL DEFAULT 1"),
    ],
  },
  {
    // Group membership, keyed (group_id, pubkey) so "is this pubkey in this
    // group" is a primary-key seek. Replaces `group_members`, which was keyed
    // by pubkey alone; a new table because SQLite cannot ALTER a primary key.
    // storage.ts migrateToMultiGroup copies the old rows in and drops the old
    // table.
    name: "group_membership",
    columns: [
      col("group_id", "TEXT NOT NULL"),
      col("pubkey", "TEXT NOT NULL"),
      col("added_at", "INTEGER NOT NULL"),
      // Mirrors allowed_pubkeys.source, but nothing currently writes 'invite'
      // here or reads the column: storage.ts addGroupMember takes the DEFAULT
      // and removeGroupMember deletes whatever the source. The reclaim rule
      // that matters is on allowed_pubkeys.source.
      col("source", "TEXT NOT NULL DEFAULT 'owner'"),
    ],
    tableConstraints: ["PRIMARY KEY (group_id, pubkey)"],
  },
  {
    // NIP-29 invite codes (nip29.ts): one row per kind-9009 the owner
    // publishes, checked when a kind-9021 join presents a code. The row, not
    // the signed 9009, holds the invite's current state, since spending a
    // code cannot mutate a signed event.
    //
    // Stored verbatim, not hashed: the only reader is the owner who issued
    // it, and listunusedinvites exists to show live codes back to them.
    // Hashing would not help against the real threat, guessing, which the
    // code-length floor and the per-IP join throttle bound.
    //
    // Spent (redeemed_at), revoked (revoked_at) and expired (expires_at
    // passed) are tracked separately because a row can be more than one; a
    // code is redeemable only while none applies. Never swept: rows
    // accumulate at owner pace, and the dead ones are what let the owner's
    // log line and NIP-86 methods say "expired" or "already used" rather than
    // "no such code".
    name: "group_invites",
    columns: [
      col("code", "TEXT PRIMARY KEY"),
      // Which group the code admits to. DEFAULT '_', the only group that
      // existed before groups had rows, so older invites migrate with no
      // separate pass.
      col("group_id", "TEXT NOT NULL DEFAULT '_'"),
      col("created_at", "INTEGER NOT NULL"),
      // Always set. See limits.ts INVITE_DEFAULT_TTL_SECONDS: there is no
      // never-expiring invite, so this column has no "unset" state to
      // represent and is NOT NULL rather than nullable-means-forever.
      col("expires_at", "INTEGER NOT NULL"),
      col("redeemed_at", "INTEGER"),
      col("redeemed_by", "TEXT"),
      col("revoked_at", "INTEGER"),
    ],
  },
  {
    // Web push subscriptions (push.ts). One row per (ENDPOINT, PUBKEY): a
    // phone, a laptop and a browser tab are three endpoints for one pubkey,
    // and two accounts in one app on one phone are one endpoint under two
    // pubkeys. Keyed by endpoint alone until 0.20.0, when the second
    // account's subscribe took the first's row; rekeyPushSubscriptions
    // rebuilds a table still keyed that way.
    //
    // `label`: an opaque tag the app chose for the account (nip86.ts
    // subscribepush), echoed in the payload so the app knows which account
    // a push is for without the push service ever seeing a pubkey. NULL
    // when the app sent none.
    //
    // `pubkey` comes from the NIP-98 signature, never from the request body
    // (nip86.ts subscribepush). A body-supplied pubkey would let anyone
    // register a device against someone else's name, and since the fan-out
    // skips a message's author, that could also suppress their notifications.
    //
    // One secondary index, idx_push_subscriptions_pubkey: a member's mail
    // is pushed to that member's endpoints alone (relay.ts
    // drainInboxPushes), and the write path asks whether they have any
    // before queuing. It costs one row written per subscribe, which is
    // rare; the group fan-out still pages through every endpoint
    // (storage.ts pushSubscriptionsAfter).
    //
    // `p256dh`/`auth` are the subscription's RFC 8291 keys, base64url as the
    // browser produced them. Stored verbatim because the relay presents them
    // to the push service; they are not credentials to this relay.
    //
    // `last_ok_at`: when a send last succeeded. Refreshed at most once a day
    // (limits.ts PUSH_LAST_OK_INTERVAL_SECONDS) and read only by that
    // throttle; it is what a sweep of dead endpoints would use. A 404/410
    // from the push service deletes the row at once (relay.ts
    // drainPushOutbox).
    name: "push_subscriptions",
    columns: [
      col("endpoint", "TEXT NOT NULL"),
      col("pubkey", "TEXT NOT NULL"),
      col("p256dh", "TEXT NOT NULL"),
      col("auth", "TEXT NOT NULL"),
      col("created_at", "INTEGER NOT NULL"),
      col("last_ok_at", "INTEGER"),
      col("label", "TEXT"),
    ],
    tableConstraints: ["PRIMARY KEY (endpoint, pubkey)"],
  },
  {
    // Android push tokens (src/fcm.ts, nip86.ts subscribefcm). One row per
    // (token, pubkey), like `push_subscriptions` and for the same reason:
    // two accounts in one app share one token. Counted separately from web
    // push devices (limits.ts MAX_FCM_TOKENS_PER_PUBKEY), since a phone
    // with the app and a browser tab are two devices. `pubkey` is the
    // NIP-98 signer, never the body. Dropped on removal, and on a 404 or
    // UNREGISTERED from Google.
    name: "fcm_tokens",
    columns: [
      col("token", "TEXT NOT NULL"),
      col("pubkey", "TEXT NOT NULL"),
      col("label", "TEXT"),
      col("created_at", "INTEGER NOT NULL"),
    ],
    tableConstraints: ["PRIMARY KEY (token, pubkey)"],
  },
  {
    // The push fan-out queue: one row per REASON ("message", "voice"), so at
    // most two. Messages arriving before the alarm fires fold into the queued
    // row (an upsert, 1 row written) rather than adding a row each; hearth's
    // service worker would collapse them into one notification anyway.
    //
    // `actors`: JSON array of pubkeys not to push to, the authors of the
    // coalesced occurrences.
    //
    // `cursor`: the last endpoint sent to, in endpoint order. One alarm
    // invocation may make only limits.ts MAX_PUSHES_PER_TICK pushes (Workers
    // Free allows 50 subrequests per invocation), so a wide fan-out resumes
    // on the next alarm. Ordered by endpoint, not rowid, so it survives
    // subscriptions being added or removed mid-fan-out.
    //
    // `sent`: pushes made for this notification, capped at limits.ts
    // MAX_PUSH_ENDPOINTS_PER_NOTIFICATION. Past the cap the rest are dropped
    // and the count is logged (relay.ts), so stale news does not wake phones.
    name: "push_outbox",
    columns: [
      col("reason", "TEXT PRIMARY KEY"),
      col("actors", "TEXT NOT NULL"),
      col("queued_at", "INTEGER NOT NULL"),
      col("cursor", "TEXT"),
      col("sent", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // Mail waiting to be announced, one row per RECIPIENT (relay.ts
    // drainInboxPushes). Unlike `push_outbox`, which fans a group message
    // out to everyone, a gift wrap is for one person, so the queue is keyed
    // by who it is for. Mail arriving for someone already queued folds into
    // the row (INSERT ... DO NOTHING), so a burst is one notification.
    // Nothing else is recorded: not the wrap, not its sender, not when the
    // wraps after the first arrived.
    name: "inbox_push",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("queued_at", "INTEGER NOT NULL")],
  },
  {
    // Member invite codes (nip86.ts createinvite/redeeminvite). Separate
    // from `group_invites`: those admit to a NIP-29 group, are created by a
    // signed kind-9009 and are single-use by construction; these make
    // someone a member of the relay, are created by a management call, and
    // may be redeemed `uses_allowed` times.
    //
    // Stored verbatim for the reason `group_invites` gives: the owner reads
    // live codes back (listunusedinvites). The relay generates every code
    // (limits.ts MEMBER_INVITE_CODE_BYTES), so one cannot be guessed.
    //
    // Never swept, like `group_invites`: rows accumulate at owner pace, and
    // a dead row is what lets revokeinvite say "already used up" rather
    // than "never issued".
    name: "member_invites",
    columns: [
      col("code", "TEXT PRIMARY KEY"),
      col("created_at", "INTEGER NOT NULL"),
      // Always set: there is no never-expiring code (limits.ts
      // INVITE_DEFAULT_TTL_SECONDS gives the reason).
      col("expires_at", "INTEGER NOT NULL"),
      col("uses_allowed", "INTEGER NOT NULL DEFAULT 1"),
      col("uses", "INTEGER NOT NULL DEFAULT 0"),
      col("revoked_at", "INTEGER"),
      // Who made the code, as a hex pubkey; whoever redeems it is recorded
      // as invited by them (`allowed_pubkeys.invited_by`). Only the owner
      // makes codes today. Members making their own (limited in number,
      // and in depth below the owner) needs only a count over this column
      // and a walk up `invited_by`, not a new table. NULL on codes made
      // before this column, which are read as the owner's.
      col("created_by", "TEXT"),
    ],
  },
  {
    // Admins (nip86.ts addadmin/removeadmin/listadmins): pubkeys the owner
    // lets run the member list, invites and join requests, and nothing
    // relay-level (nip86.ts ADMIN_CALLABLE_METHODS). Made for the owner's
    // own second key, a messenger identity kept apart from the main npub.
    // Every admin is also a member: addadmin writes the `allowed_pubkeys`
    // row if there is none, and removing the member removes the admin.
    // removeadmin takes the role away and leaves the membership.
    name: "admins",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("added_at", "INTEGER NOT NULL")],
  },
  {
    // Join requests (nip86.ts requestjoin): one row per pubkey that asked
    // to become a member without a code. Pending while `declined_at` is
    // NULL; either way the row goes at `expires_at` (limits.ts
    // JOIN_REQUEST_TTL_SECONDS after the request, or after the decline),
    // swept by the cron tick. Approval deletes the row and writes the
    // `allowed_pubkeys` row. `name` and `note` are what the requester typed,
    // bounded by limits.ts and shown only to the owner.
    name: "join_requests",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("name", "TEXT"),
      col("note", "TEXT"),
      col("requested_at", "INTEGER NOT NULL"),
      col("expires_at", "INTEGER NOT NULL"),
      col("declined_at", "INTEGER"),
      // Whose "Message me" link the request came through, as the requester
      // says (unverified: anyone can name anyone). On approval it becomes
      // `invited_by` if it names a member then, and the owner otherwise.
      col("via", "TEXT"),
    ],
  },
  {
    // Profile photos (src/photos.ts): ONE per pubkey, the member's or the
    // owner's current photo, so a new upload replaces the row. The bytes
    // are in `data`, one row each: limits.ts PHOTO_MAX_BYTES_CEILING keeps
    // a photo under SQLite's per-value limit. Served publicly by `sha256`
    // (idx_photos_sha256); there is no listing. A removed member's photo
    // goes when their grace period ends (storage.ts sweepFormerMembers).
    name: "photos",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("sha256", "TEXT NOT NULL"),
      col("type", "TEXT NOT NULL"),
      col("size", "INTEGER NOT NULL"),
      col("data", "BLOB NOT NULL"),
      col("uploaded_at", "INTEGER NOT NULL"),
    ],
  },
  {
    // The per-pubkey daily upload count (limits.ts PHOTO_UPLOADS_PER_DAY).
    // `day` is the UTC day number; a new day resets `count`. Durable, not
    // in memory, because an evicted object would otherwise forget it.
    name: "photo_uploads",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("day", "INTEGER NOT NULL"),
      col("count", "INTEGER NOT NULL"),
    ],
  },
  {
    // Home activity (nip86.ts homestats), the one per-person thing it keeps:
    // the last UTC day each member completed NIP-42 auth, one row each,
    // overwritten, never a log. Read only as counts ("members seen in the
    // last 7 days"); nothing returns a row. Deleted when the member is
    // removed (storage.ts unallowPubkey).
    name: "member_seen",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("day", "INTEGER NOT NULL")],
  },
  {
    // Gift wraps accepted per UTC day (relay.ts handleGiftWrap), for
    // homestats' "messages per day". A count and nothing else: not who to,
    // not who from. Kept for limits.ts HOME_STATS_DAYS_KEPT days, pruned
    // by the cron tick.
    name: "mail_days",
    columns: [col("day", "INTEGER PRIMARY KEY"), col("n", "INTEGER NOT NULL")],
  },
  {
    // The mailbox's bytes (limits.ts mailStorageBytes, mailBytesPerMember):
    // one row per recipient, plus `*` for the whole home, holding the bytes
    // and count of stored gift wraps addressed to them. Maintained by
    // storage.ts insertEventRow and deleteEventRow, the two places every
    // event row passes, so no delete path can forget it; seeded once from
    // the wraps already stored (seedMailUsage). A wrap naming several
    // recipients is charged to each.
    name: "mail_usage",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("bytes", "INTEGER NOT NULL"),
      col("n", "INTEGER NOT NULL"),
    ],
  },
  {
    // Gift wraps that carry a NIP-40 expiration, by when: the expiry sweep
    // (storage.ts sweepExpiredGiftWraps) reads this rather than walking
    // every stored wrap each hour. Written and deleted with the wrap.
    name: "wrap_expiry",
    columns: [col("id", "TEXT PRIMARY KEY"), col("expiration", "INTEGER NOT NULL")],
  },
  {
    // Members the owner removed (nip86.ts unallowpubkey), kept for
    // limits.ts MEMBER_REMOVAL_GRACE_SECONDS so the mail already stored for
    // them stays readable while their app moves house. After that the cron
    // tick deletes it (storage.ts sweepFormerMembers) and then this row.
    // Re-admitting the pubkey deletes the row, so nothing of a returning
    // member's is swept.
    name: "former_members",
    columns: [
      col("pubkey", "TEXT PRIMARY KEY"),
      col("removed_at", "INTEGER NOT NULL"),
      // Why they left, for the storage service (nip86.ts memberkeys):
      // 'removed' by the owner or an admin. Room for a member erasing
      // their own account, which will write 'erased'.
      col("reason", "TEXT NOT NULL DEFAULT 'removed'"),
    ],
  },
  {
    // Call presence (push.ts CALL_PRESENCE_KIND): one row per pubkey, holding
    // the second its beat was last WRITTEN, not last seen. hearth beats every
    // five seconds, and storing each beat would be a row per beat per
    // participant. limits.ts PRESENCE_WRITE_INTERVAL_SECONDS (40s) and
    // PRESENCE_STALE_SECONDS (45s) derive how coarse the row may be and what
    // "absent" means when read back: ten people in an hour-long call cost 900
    // rows written rather than 72,000. Not swept; a leave beat deletes the
    // row.
    name: "presence",
    columns: [col("pubkey", "TEXT PRIMARY KEY"), col("last_seen", "INTEGER NOT NULL")],
  },
  {
    // Ephemeral group chat state (storage.ts sweepChat; limits.ts, the
    // section beginning CONVERSATION_IDLE_SECONDS). One row, for the group
    // `_`: storage.ts reads and updates it with no group_id predicate and the
    // sweep deletes only `_`'s chat, so chat in any other group does not
    // expire.
    //
    // No per-message bookkeeping: a conversation is a RANGE of `created_at`,
    // so its whole state is two integers here plus a seek on
    // idx_events_kind_created_grp.
    name: "chat_state",
    columns: [
      // Which group the row describes. DEFAULT '_' so the row that predates
      // the column became `_`'s, keeping its watermark and swept-through
      // checkpoint. Nothing enforces one row per group (there is no unique
      // index), and storage.ts treats the table as a single row.
      col("group_id", "TEXT NOT NULL DEFAULT '_'"),
      // The last wall-clock second at which MIN_ROOM_OCCUPANTS or more
      // distinct group readers held sockets at once, written coarsely
      // (limits.ts CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS). It is the sweep
      // cutoff: a message at or before it was said while someone else was
      // there (speech, swept); a message after it was said into an empty room
      // (a note, kept).
      col("last_occupied_at", "INTEGER NOT NULL DEFAULT 0"),
      // The highest cutoff swept to completion. It checkpoints a sweep too
      // large for one cron tick, and nip29.ts authorizeGroupWrite refuses
      // chat at or before it, so a member holding a signed copy cannot replay
      // a finished conversation. That replaces per-message tombstones, which
      // would leave two permanent rows per deleted message: a record of the
      // conversation outliving it.
      col("swept_through", "INTEGER NOT NULL DEFAULT 0"),
      // Diagnostic: messages removed in total.
      col("swept_total", "INTEGER NOT NULL DEFAULT 0"),
      // The last report the sweep made, acted on or not: when, and how many
      // messages were eligible. Written in reporting mode too, so there is a
      // state to read back and not only a log line. Not on /api/stats: that
      // endpoint is public, and a count of a group's chat must not be.
      col("reported_at", "INTEGER NOT NULL DEFAULT 0"),
      col("reported_pending", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // Counts /api/stats reports that are maintained rather than computed, so
    // no stats request walks a table. Exactly one row.
    //
    // Seeded once (seedMaintainedCounts), then moved only by the code that
    // writes the counted table, and never recomputed or repaired: storage.ts
    // auditMaintainedCounts recounts daily and logs a disagreement without
    // fixing it, since a self-repairing counter hides whatever broke it.
    //
    // Correct only while nothing changes the counted table without moving the
    // counter. `events` rows are inserted and deleted only by storage.ts
    // insertEventRow/deleteEventRow, and the two one-time partition
    // migrations in storage.ts adjust `group_events` alongside their UPDATEs;
    // `follows` is written only by ownership.ts refreshFollows, in both write
    // branches. The counter writes sit inside those functions, not beside
    // their callers (test/stats.test.ts, test/follows.test.ts).
    //
    // `events` costs 1 row written per stored event, accepted because the
    // alternative is an unbounded scan on a public endpoint. `follows` moves
    // only when the follow set changes.
    name: "maintained_counts",
    columns: [
      col("events", "INTEGER NOT NULL"),
      // How many of `events` are in the group partition. /api/stats reports
      // `events - group_events` because it is public: a total that moved with
      // group traffic would let anyone polling it, while holding a /live
      // socket, time group arrivals to the second. A column on a row this
      // write already updates, so free in rows written (an UPDATE touching
      // two columns reports 1 row, the same as one).
      col("group_events", "INTEGER NOT NULL DEFAULT 0"),
      col("follows", "INTEGER NOT NULL"),
      // Wall-clock seconds of the last auditMaintainedCounts run, so the
      // daily recount is paced by the data rather than by how often the
      // cron happens to fire. NULL until the first audit.
      col("audited_at", "INTEGER"),
      // What the last audit found: a JSON array of one string per
      // disagreement, the same text auditMaintainedCounts logs. Holds counts,
      // never pubkeys, because /api/stats reads it back and is public. NULL
      // means clean only when `audited_at` is set; /api/stats must tell
      // "never checked" from "checked, clean" (relay.ts getStats
      // `countAudit`). Written by the same UPDATE as `audited_at`. Display
      // only; nothing corrects from it.
      col("last_drift", "TEXT"),
    ],
  },
  {
    // `events24h` on /api/stats: one row per hour of `created_at`, counting
    // the stored events signed in that hour. Buckets because the window
    // ROLLS: an event leaves it as the clock moves, which no scalar counter
    // can express.
    //
    // Keyed by `created_at`, not `ingested_at`: a note signed in 2021 and
    // backfilled today belongs in a 2021 bucket, or backfill would look like
    // a posting spree. ingest_hour_counts is the ingest-time view. Moved by
    // the same two functions as maintained_counts.events.
    //
    // `hour INTEGER PRIMARY KEY` is a rowid alias: an upsert writes 1 row and
    // a window read is a range seek. A 24h window reads at most 26 rows, from
    // the bucket holding now - 86400 to the one an hour ahead of now
    // (limits.ts MAX_CREATED_AT_FUTURE_SECONDS refuses anything later).
    //
    // Emptied buckets are kept: deleting one would add a second write on the
    // removal path to save a read, and outside the window nothing reads them.
    name: "event_hour_counts",
    columns: [
      // created_at / 3600 truncated toward zero. storage.ts hourBucket uses
      // Math.trunc to match SQLite's integer `/` (which the seed and the
      // audit use), so all three agree on the bucket even for a negative
      // created_at, which nothing rejects (validate.ts
      // isCreatedAtTooFarInFuture is one-sided).
      col("hour", "INTEGER PRIMARY KEY"),
      col("n", "INTEGER NOT NULL"),
      // The group-partition share of `n`, subtracted before /api/stats
      // reports `events24h` (see maintained_counts.group_events). Free in
      // rows written.
      col("group_n", "INTEGER NOT NULL DEFAULT 0"),
    ],
  },
  {
    // `ingested24h` and `rowsWrittenToday` on /api/stats: one row per hour of
    // INGEST time, holding the events taken in and the rows written in that
    // hour. Separate from event_hour_counts because it keys on the other
    // clock (see events.ingested_at); one table would conflate the two.
    //
    // Both figures come from one statement reading at most 25 rows: the
    // rolling 24h window starts at the bucket holding now - 86400 and cannot
    // pass the current hour, and the since-00:00-UTC window is a suffix of
    // it. 00:00 UTC falls on an hour boundary, so `hour >= dayStart / 3600`
    // selects exactly today; the rolling window spans 24-25h.
    //
    // Rowid-alias key, and emptied buckets kept, as in event_hour_counts.
    name: "ingest_hour_counts",
    columns: [
      // ingested_at / 3600, by storage.ts hourBucket (see
      // event_hour_counts.hour).
      col("hour", "INTEGER PRIMARY KEY"),
      // Events this relay ingested in this hour and still holds.
      // Decremented on removal, so it matches what a COUNT over `events`
      // by `ingested_at` would say -- which is what makes it auditable
      // (storage.ts auditMaintainedCounts).
      col("n", "INTEGER NOT NULL"),
      // How many of `n` are group events, subtracted before /api/stats
      // reports `ingested24h`. Same argument as `group_n` on
      // `event_hour_counts`, through the other clock.
      col("group_n", "INTEGER NOT NULL DEFAULT 0"),
      // Every row written in this hour: events, index entries, tombstones,
      // counters, follow rebuilds, NIP-86 calls, backfill bookkeeping.
      // Measured by the SqlStorage wrapper (read-metrics.ts) and landed by
      // the execution context that spent it (storage.ts insertEventRow,
      // settleRowsWritten). Never decremented, unlike `n`: a deleted row was
      // still written. That also keeps auditMaintainedCounts' floor check
      // valid, since this can only exceed the cost of the events still
      // standing in the hour.
      col("rows_written", "INTEGER NOT NULL"),
    ],
  },
];

// ---------------------------------------------------------------------
// The index set, declared as data. Read by:
//
// 1. initSchema, which creates each one and drops any undeclared `idx_`
//    index.
// 2. limits.ts filterReadCost, which prices a filter against the indexes on
//    `events`, so adding or removing one changes which filters are
//    affordable without editing the guard.
// 3. eventRowCost, which derives the per-event rows-written cost.
//
// An index serves `ORDER BY created_at DESC LIMIT n` cheaply only when every
// key column ahead of `created_at` is pinned to a single value: the rows then
// arrive sorted and LIMIT stops the scan. Otherwise SQLite reads and sorts
// every match before LIMIT applies, and limit 20 costs the same as limit 500.
//
// An index whose DEFINITION changes must change its NAME: CREATE INDEX IF NOT
// EXISTS will not redefine an existing index and reports no error. Any change
// here changes the schema hash, so the next wake runs the reconcile pass; a
// new index costs a one-time write of one row per existing table row on that
// wake.
// ---------------------------------------------------------------------

export interface IndexSpec {
  readonly name: string;
  readonly table: string;
  // Columns that must ALL be pinned to a single value by a filter before
  // this index can serve an ordered scan. In index order.
  readonly keyColumns: readonly string[];
  // The column the index is then sorted by, declared DESC to match
  // buildFilterQuery's `ORDER BY created_at DESC`. Omitted for an index that
  // exists only for an equality lookup (idx_event_tags_event), where an
  // ordering column would widen it for nothing.
  readonly orderedBy?: string;
  // Columns appended after the key and ordering columns only so a query can
  // be answered from the index without visiting the table. Not key columns:
  // filterReadCost must never treat them as something a filter can pin, which
  // is why they are a separate field. Widening an index costs no extra rows
  // written.
  readonly covering?: readonly string[];
  // Partial-index predicate (sqlite.org/partialindex.html). SQLite uses a
  // partial index only for a query whose WHERE implies the predicate.
  //
  // Every entry with one is half of a PAIR, `is_group = 0` and `is_group = 1`
  // over identical columns (asserted in test/schema-migration.test.ts). A row
  // satisfies exactly one half, so a pair costs one index entry per row, the
  // same as a single index. The price is that a query pinning neither value
  // can use neither half and scans: 51,500 rows against 2, measured at 50,000
  // group events. Hence storage.ts's partition rule.
  readonly where?: string;
}

export const INDEXES: readonly IndexSpec[] = [
  // ---------------------------------------------------------------------
  // The three REQ-serving indexes, each declared as a partial pair over the
  // public and group partitions (`is_group`; see TABLES and groups.ts).
  //
  // Not one index with `is_group` as a key column: that changes the plan of
  // every query that does not pin it. The owner's own gift wrap read went
  // from 601 rows to 204,701 that way, as SQLite gave up the primary-key
  // seek; with partial pairs it is 567. A query pinning a partition gets the
  // plan it would get with no partition column at all.
  //
  // Not one partial index over public rows alone: group rows would then be
  // unindexed for internal lookups (replacement, NIP-09, NIP-62), and a full
  // index beside it would charge every public row twice.
  //
  // Serves `authors` + `kinds` together.
  {
    name: "idx_events_pubkey_kind_created_pub",
    table: "events",
    keyColumns: ["pubkey", "kind"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_events_pubkey_kind_created_grp",
    table: "events",
    keyColumns: ["pubkey", "kind"],
    orderedBy: "created_at",
    where: "is_group = 1",
  },
  // Serves `kinds` with no `authors`. Also makes storage.ts giftWrapCount,
  // run on every accepted gift wrap, two index counts rather than a table
  // scan.
  {
    name: "idx_events_kind_created_pub",
    table: "events",
    keyColumns: ["kind"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_events_kind_created_grp",
    table: "events",
    keyColumns: ["kind"],
    orderedBy: "created_at",
    where: "is_group = 1",
  },
  // Serves `authors` with no `kinds`. On a single-owner relay every row
  // carries the owner's pubkey, so without it `{"authors":[owner]}` reads the
  // whole table whatever its limit.
  {
    name: "idx_events_pubkey_created_pub",
    table: "events",
    keyColumns: ["pubkey"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_events_pubkey_created_grp",
    table: "events",
    keyColumns: ["pubkey"],
    orderedBy: "created_at",
    where: "is_group = 1",
  },
  // Serves `#<letter>` tag filters through buildFilterQuery's subquery. A
  // partial pair for the same reason as above (with `is_group` as a key
  // column, the gift wrap read above is the one that went to 204,701), and so
  // the subquery excludes the other partition before its own LIMIT; see
  // event_tags.is_group.
  {
    name: "idx_event_tags_lookup_pub",
    table: "event_tags",
    keyColumns: ["tag_name", "tag_value"],
    orderedBy: "created_at",
    where: "is_group = 0",
  },
  {
    name: "idx_event_tags_lookup_grp",
    table: "event_tags",
    keyColumns: ["tag_name", "tag_value"],
    orderedBy: "created_at",
    where: "is_group = 1",
  },
  // Serves `DELETE FROM event_tags WHERE event_id = ?` (storage.ts
  // deleteEventRow), which otherwise scans the table. No ordering column. The
  // costliest index here, one row per TAG row (TAG_ROW_COST 3 rather than 2);
  // the justification is on deleteEventRow: NIP-62 vanish cannot be gated or
  // throttled, so its cost is the only control the relay has over it.
  {
    name: "idx_event_tags_event",
    table: "event_tags",
    keyColumns: ["event_id"],
  },
  // Serves `WHERE ingested_at > ?` (storage.ts estimateRowsWrittenSince,
  // behind backfill.ts hasBackfillHeadroom), so the read scales with the
  // window rather than with E. Unindexed, that SUM reads every row of
  // `events` per call: a cost that grows with the table and is paid on every
  // cron tick with no client connected.
  //
  // `row_cost` is covering, so the SUM never touches the table. Costs one row
  // written per stored event. No `orderedBy`: it is a range SUM, and
  // `ingested_at` is not a filterable field (limits.ts PINS), so
  // filterReadCost never treats it as bounding a REQ.
  // Serves `WHERE pubkey = ?` on push_subscriptions: whose devices a
  // member's mail goes to (relay.ts drainInboxPushes, storage.ts
  // hasPushSubscription), and dropping a removed member's devices. One row
  // written per subscribe.
  // Serves the expiry sweep's "soonest first" (schema.ts `wrap_expiry`).
  {
    name: "idx_wrap_expiry_expiration",
    table: "wrap_expiry",
    keyColumns: ["expiration"],
  },
  // Serves the per-creator counts of member invites (storage.ts
  // inviteSlotsUsed, countOutstandingMemberInvites) and a member's own
  // listing. One row written per createinvite.
  {
    name: "idx_member_invites_created_by",
    table: "member_invites",
    keyColumns: ["created_by"],
  },
  // Serves GET /<sha256> (src/photos.ts): a photo is found by its hash.
  {
    name: "idx_photos_sha256",
    table: "photos",
    keyColumns: ["sha256"],
  },
  // Serves a member's own Android tokens (storage.ts fcmTokensFor).
  {
    name: "idx_fcm_tokens_pubkey",
    table: "fcm_tokens",
    keyColumns: ["pubkey"],
  },
  {
    name: "idx_push_subscriptions_pubkey",
    table: "push_subscriptions",
    keyColumns: ["pubkey"],
  },
  {
    name: "idx_events_ingested",
    table: "events",
    keyColumns: ["ingested_at"],
    covering: ["row_cost"],
  },
];

function createIndexSql(spec: IndexSpec): string {
  const columns = [
    ...spec.keyColumns,
    ...(spec.orderedBy === undefined ? [] : [`${spec.orderedBy} DESC`]),
    // Last, and unordered: these exist to be read off the index, not to
    // be seeked or sorted on, so their position after the ordering column
    // is what keeps them out of the part of the index that does the work.
    ...(spec.covering ?? []),
  ];
  const where = spec.where === undefined ? "" : ` WHERE ${spec.where}`;
  return `CREATE INDEX IF NOT EXISTS ${spec.name} ON ${spec.table} (${columns.join(", ")})${where}`;
}

// Indexes declared on one table. Exported because limits.ts needs the
// `events` set to decide what a filter costs.
export function indexesOn(table: string): readonly IndexSpec[] {
  return INDEXES.filter((i) => i.table === table);
}

// ---------------------------------------------------------------------
// Per-event rows-written cost, derived from INDEXES, and DELIBERATELY HIGH.
// test/hibernation.test.ts asserts the over-charge so a fix cannot land
// silently.
//
// EVENT_BASE_ROW_COST counts the base row, the implicit PK index and every
// declared index on `events` (seven). Three of those are the group halves of
// partial pairs, and a row pays only one half of each pair:
//
//   charged    2 + 7 = 9   + EVENT_COUNTER_ROW_COST 3   + 4 per tag row
//   measured   2 + 4 = 6   + EVENT_COUNTER_ROW_COST 3   + 3 per tag row
//
//   => eventRowCost is 12 + 4T; an event actually costs 9 + 3T.
//      A five-tag note: 32 charged, 24 spent.
//
// Left high because every consumer is a guard that an over-estimate makes
// stricter: limits.ts BACKFILL_PAGE_SIZE fetches smaller pages,
// VANISH_BATCH_SIZE, CHAT_SWEEP_BATCH_SIZE and GIFT_WRAP_SWEEP_BATCH_SIZE
// remove fewer events per tick, and the stamped `events.row_cost` makes
// estimateRowsWrittenSince (backfill.ts hasBackfillHeadroom) read high.
// Slower, never overrunning. Correcting it means teaching the derivation that
// a pair costs one row, which moves all of those and every stamped
// `row_cost`; do it deliberately or not at all.
//
// The one consumer for which over-charging is unsafe is storage.ts
// auditMaintainedCounts' rows-written check, which is a floor: an inflated
// floor would raise a false alarm daily. It uses the *_MEASURED figures
// below.
// ---------------------------------------------------------------------
export const EVENT_BASE_ROW_COST = 2 + indexesOn("events").length;

// The three counter rows storage.ts insertEventRow moves per stored event:
// `maintained_counts` (one row, no index), `event_hour_counts` and
// `ingest_hour_counts` (rowid-aliased keys, no index entry). Named here
// rather than as a bare `+ 3` so backfill sizing, drain pacing and the
// stamped `row_cost` all include it. The `ingest_hour_counts` bump is also
// where the measured rows-written total lands, so the write meter costs
// nothing extra on the event path (storage.ts settleRowsWritten covers paths
// with no bucket of their own).
export const EVENT_COUNTER_ROW_COST = 3;

// One base row per `event_tags` row, plus one per index on that table --
// over-charged by exactly one, for the reason EVENT_BASE_ROW_COST above
// carries in full: `idx_event_tags_lookup_pub`/`_grp` are a partial pair
// and a tag row pays one of them, so this says 4 where a tag row costs 3.
export const TAG_ROW_COST = 1 + indexesOn("event_tags").length;

// Partial index PAIRS declared on a table: exactly how much the two constants
// above over-charge per row. Assumes every partial index has a mirror (it
// halves the count); test/schema-migration.test.ts asserts that.
export function partialIndexPairsOn(table: string): number {
  return indexesOn(table).filter((i) => i.where !== undefined).length / 2;
}

// What a stored event actually costs, as SqlStorageCursor reports it. For
// storage.ts auditMaintainedCounts' floor check only; everything else
// deliberately uses the over-charged eventRowCost. test/hibernation.test.ts
// pins both and the gap between them.
export const EVENT_BASE_ROW_COST_MEASURED = EVENT_BASE_ROW_COST - partialIndexPairsOn("events");
export const TAG_ROW_COST_MEASURED = TAG_ROW_COST - partialIndexPairsOn("event_tags");

export function eventRowCostMeasured(indexedTagCount: number): number {
  return (
    EVENT_BASE_ROW_COST_MEASURED + EVENT_COUNTER_ROW_COST + TAG_ROW_COST_MEASURED * indexedTagCount
  );
}

// Rows written to store one event carrying `indexedTagCount` single-letter
// tags, over-charged as described above, counters included so every guard
// that prices a write sees them. Stamped into `events.row_cost` by storage.ts
// insertEventRow.
export function eventRowCost(indexedTagCount: number): number {
  return EVENT_BASE_ROW_COST + EVENT_COUNTER_ROW_COST + TAG_ROW_COST * indexedTagCount;
}

// Rows written by tombstoning one id: the `deleted_ids` row, plus the
// implicit unique index behind its TEXT PRIMARY KEY (same shape as
// `events.id`), plus any index later declared on that table.
export const TOMBSTONE_ROW_COST = 2 + indexesOn("deleted_ids").length;

// ---------------------------------------------------------------------
// Removing one stored event. SqlStorageCursor counts index maintenance on
// INSERT but NOT on DELETE (measured on workerd, 2026-08-26; asserted in
// test/hibernation.test.ts). For a two-tag event the cursor reports:
//
//   DELETE FROM event_tags (2 rows)        2   (not 2 x 3)
//   DELETE FROM events (1 row)             1   (not 6)
//   INSERT OR IGNORE INTO deleted_ids      2
//   UPDATE the three counters              3
//
// That is one row per base row deleted, plus the tombstone and counters.
// Since the SqlStorage write meter (read-metrics.ts) can only report what the
// cursor reports, storage.ts deleteEventRow accounts for a removal explicitly
// with the budget figure. Use eventRemovalRowsWritten to report and
// eventRemovalBudget to budget.
// ---------------------------------------------------------------------

// What SqlStorageCursor actually reports for removing one event: the tag
// rows, the event row, the tombstone and the three counters. Asserted
// against a real cursor in test/hibernation.test.ts.
export function eventRemovalRowsWritten(indexedTagCount: number): number {
  return indexedTagCount + 1 + TOMBSTONE_ROW_COST + EVENT_COUNTER_ROW_COST;
}

// What the NIP-62 vanish drain is paced against: a removal assumed to cost
// what the insertion did, plus the tombstone. Whether Cloudflare's billing
// also skips index maintenance on DELETE is something the cursor cannot show,
// and pacing against the smaller figure would overrun the drain's share if
// the cursor under-reports. If the cursor is right, the drain simply runs at
// about a third of its allowance.
export function eventRemovalBudget(indexedTagCount: number): number {
  return eventRowCost(indexedTagCount) + TOMBSTONE_ROW_COST;
}

function createTableSql(spec: TableSpec): string {
  const parts = spec.columns.map((c) => `${c.name} ${c.definition}`);
  for (const constraint of spec.tableConstraints ?? []) parts.push(constraint);
  return `CREATE TABLE IF NOT EXISTS ${spec.name} (${parts.join(", ")})`;
}

// SQLite's ALTER TABLE ADD COLUMN cannot add every column a CREATE TABLE
// can declare (sqlite.org/lang_altertable.html): no PRIMARY KEY, no
// UNIQUE, no NOT NULL without a non-null constant default, no
// non-constant default, no generated STORED column.
//
// Returns why a column cannot be added, or null if it can. Only consulted
// for columns that are actually missing -- a PRIMARY KEY declared on a
// fresh database is created by CREATE TABLE and never reaches this path.
function whyNotAddable(c: ColumnSpec): string | null {
  const d = c.definition.toUpperCase();
  if (/\bPRIMARY\s+KEY\b/.test(d)) return "a PRIMARY KEY cannot be added to an existing table";
  if (/\bUNIQUE\b/.test(d)) return "a UNIQUE column cannot be added to an existing table";
  if (/\bREFERENCES\b/.test(d)) return "a foreign key column cannot be added to an existing table";
  if (/\bGENERATED\b/.test(d) && /\bSTORED\b/.test(d)) return "a generated STORED column cannot be added";
  if (/\bNOT\s+NULL\b/.test(d)) {
    if (!/\bDEFAULT\b/.test(d)) return "NOT NULL requires a DEFAULT to be added to an existing table";
    if (/\bDEFAULT\s+NULL\b/.test(d)) return "NOT NULL with DEFAULT NULL is not a usable default";
  }
  if (/\bDEFAULT\s+(CURRENT_TIME|CURRENT_DATE|CURRENT_TIMESTAMP|\()/.test(d)) {
    return "only a constant DEFAULT can be added to an existing table";
  }
  return null;
}

// Adds whatever declared columns an existing table is missing and returns
// their names. Existing rows get the column's DEFAULT (or NULL).
//
// A missing column SQLite cannot add throws rather than being skipped. This
// runs in the Durable Object constructor, so the object fails loudly and at
// once instead of running half-migrated and failing somewhere unrelated.
export function reconcileColumns(sql: SqlStorage, spec: TableSpec): string[] {
  const present = new Set(
    sql
      .exec<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, spec.name)
      .toArray()
      .map((r) => r.name),
  );
  // No rows means the table does not exist; createTableSql already ran
  // and declared every column, so there is nothing to reconcile.
  if (present.size === 0) return [];

  const added: string[] = [];
  // Collected rather than applied inline: a resetsOnAdd target may itself
  // be a column this same pass is about to add later in `spec.columns`
  // (owner.about resets profile_synced_at, which is declared after it),
  // and an UPDATE against a column that doesn't exist yet fails outright.
  const resets = new Set<string>();
  for (const column of spec.columns) {
    if (present.has(column.name)) continue;
    const refusal = whyNotAddable(column);
    if (refusal !== null) {
      throw new Error(
        `schema: cannot add ${spec.name}.${column.name} (${column.definition}) to an existing database: ` +
          `${refusal}. Additive, defaultable columns are the only shape this reconciler supports; ` +
          `anything else needs a deliberate table rebuild.`,
      );
    }
    sql.exec(`ALTER TABLE ${spec.name} ADD COLUMN ${column.name} ${column.definition}`);
    added.push(column.name);
    for (const resetColumn of column.resetsOnAdd ?? []) {
      resets.add(resetColumn);
    }
  }
  for (const resetColumn of resets) {
    sql.exec(`UPDATE ${spec.name} SET ${resetColumn} = NULL`);
  }
  return added;
}

// ---------------------------------------------------------------------
// initSchema runs in the Relay constructor, i.e. on every wake from
// hibernation, not once per deploy. A full reconcile reads tens of rows (55
// when measured, ~94,000 rows/day at the relay's wake rate), so it runs only
// when the schema changed: `schema_meta` stores the hash of the declaration
// the database was last reconciled to, and a match returns after one row
// read. Two properties make that safe:
//
// 1. computeSchemaHash is derived structurally from every field that
//    createTableSql, reconcileColumns and createIndexSql act on, not from a
//    hand-bumped version. A field it does not cover is a field whose change
//    silently skips its migration, so a new field on ColumnSpec, TableSpec
//    or IndexSpec must be added to it.
// 2. The hash is written only after the reconcile completes without
//    throwing. Written earlier, a migration that died partway (e.g.
//    reconcileColumns refusing an un-addable column) would leave the new
//    hash over the old shape and never be retried. Every statement in the
//    pass is idempotent, so the retry is safe.
//
// The first wake after a schema-changing deploy pays the full reconcile; that
// is the one wake with work to do.
// ---------------------------------------------------------------------

// Not a TABLES entry: it has to be readable before initSchema can decide
// whether TABLES needs reconciling, so ensureSchemaMetaTable creates it
// directly. Its one-column shape is fixed so it never needs migrating.
const SCHEMA_META_TABLE = "schema_meta";

// Structural fingerprint of a TABLES/INDEXES declaration. Takes the
// declaration as arguments so tests can hash two and assert they differ.
export function computeSchemaHash(tables: readonly TableSpec[], indexes: readonly IndexSpec[]): string {
  const fingerprint = {
    tables: tables.map((t) => ({
      name: t.name,
      // A composite key reaches the database only through CREATE TABLE, so a
      // change to one must change the hash.
      tableConstraints: t.tableConstraints ?? [],
      columns: t.columns.map((c) => ({
        name: c.name,
        definition: c.definition,
        resetsOnAdd: c.resetsOnAdd ?? [],
      })),
    })),
    indexes: indexes.map((i) => ({
      name: i.name,
      table: i.table,
      keyColumns: i.keyColumns,
      orderedBy: i.orderedBy ?? null,
      covering: i.covering ?? [],
      where: i.where ?? null,
    })),
  };
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(fingerprint))));
}

function currentSchemaHash(): string {
  return computeSchemaHash(TABLES, INDEXES);
}

function ensureSchemaMetaTable(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${SCHEMA_META_TABLE} (hash TEXT NOT NULL)`);
}

function readStoredSchemaHash(sql: SqlStorage): string | null {
  const row = sql.exec<{ hash: string }>(`SELECT hash FROM ${SCHEMA_META_TABLE} LIMIT 1`).toArray()[0];
  return row?.hash ?? null;
}

function writeSchemaHash(sql: SqlStorage, hash: string): void {
  sql.exec(`DELETE FROM ${SCHEMA_META_TABLE}`);
  sql.exec(`INSERT INTO ${SCHEMA_META_TABLE} (hash) VALUES (?)`, hash);
}

// TEST ONLY: discards the stored fingerprint so the next initSchema() runs a
// full reconcile, as on the first wake after a schema-changing deploy.
export function forgetSchemaHash(sql: SqlStorage): void {
  sql.exec(`DROP TABLE IF EXISTS ${SCHEMA_META_TABLE}`);
}

// Seeds `maintained_counts` and `event_hour_counts` from what is stored, so
// the counters start at the truth on a relay that predates them.
//
// Guarded on `maintained_counts` being EMPTY, not on the schema hash: the
// reconcile pass reruns on every schema change, and reseeding then would
// silently repair any drift before auditMaintainedCounts could report it.
//
// The buckets are filled first and the totals summed from them, so the two
// agree at birth and `events` is scanned once. Rows read: E + F, once.
function seedMaintainedCounts(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM maintained_counts LIMIT 1`).toArray().length > 0) return;
  // Clears a seed that died between the statements below: `hour` is a primary
  // key, so a retry over half-filled buckets would throw on every wake.
  // Reached only while `maintained_counts` is empty, so it never discards a
  // completed seed's buckets.
  sql.exec(`DELETE FROM event_hour_counts`);
  sql.exec(
    `INSERT INTO event_hour_counts (hour, n, group_n)
       SELECT created_at / 3600, COUNT(*), COALESCE(SUM(is_group), 0)
         FROM events GROUP BY created_at / 3600`,
  );
  sql.exec(
    `INSERT INTO maintained_counts (events, group_events, follows, audited_at)
       SELECT (SELECT COALESCE(SUM(n), 0) FROM event_hour_counts),
              (SELECT COALESCE(SUM(group_n), 0) FROM event_hour_counts),
              (SELECT COUNT(*) FROM follows),
              NULL`,
  );
}

// Seeds `ingest_hour_counts`, guarded on that table being empty for the same
// reason as seedMaintainedCounts, and separately because the two were
// introduced at different times.
//
// `rows_written` is seeded from `events.row_cost`, the cost of storing the
// events still present. Past deletions, rebuilds and bookkeeping are not
// recoverable and are not invented, so pre-seed buckets are a floor. Rows
// with a NULL `ingested_at` are skipped rather than filed under hour 0. Rows
// read: E, once.
function seedIngestCounts(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM ingest_hour_counts LIMIT 1`).toArray().length > 0) return;
  sql.exec(
    `INSERT INTO ingest_hour_counts (hour, n, group_n, rows_written)
       SELECT ingested_at / 3600, COUNT(*), COALESCE(SUM(is_group), 0),
              COALESCE(SUM(row_cost), 0)
         FROM events WHERE ingested_at IS NOT NULL
        GROUP BY ingested_at / 3600`,
  );
}

// Guarded on the table being empty, so no later reconcile can mint a second
// keypair under events already signed with the first.
function seedRelayIdentity(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM relay_identity LIMIT 1`).toArray().length > 0) return;
  const { secretKeyHex, publicKeyHex } = generateRelayKeypair();
  sql.exec(`INSERT INTO relay_identity (secret_key, public_key) VALUES (?, ?)`, secretKeyHex, publicKeyHex);
}

// What a stored gift wrap is charged beyond its content and tags (limits.ts
// mailStorageBytes): the id, pubkey and sig (256 characters as hex) and
// the rest of the row, rounded up. Fixed, so the charge on insert and the
// refund on delete always match (storage.ts wrapBytes). Here rather than
// in limits.ts, which imports this file.
export const WRAP_FIXED_BYTES = 300;

// Seeds `mail_usage` and `wrap_expiry` from the gift wraps already stored,
// once: guarded on the `*` row, which exists from then on. The charge is
// the same as storage.ts wrapBytes (content, tags, limits.ts
// WRAP_FIXED_BYTES), in SQL. Rows read: the stored wraps, once.
function seedMailUsage(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM mail_usage WHERE pubkey = '*' LIMIT 1`).toArray().length > 0) return;
  sql.exec(
    `INSERT INTO mail_usage (pubkey, bytes, n)
       SELECT '*', COALESCE(SUM(LENGTH(content) + LENGTH(tags) + ?), 0), COUNT(*) FROM events WHERE kind = 1059`,
    WRAP_FIXED_BYTES,
  );
  sql.exec(
    `INSERT INTO mail_usage (pubkey, bytes, n)
       SELECT t.tag_value, SUM(LENGTH(e.content) + LENGTH(e.tags) + ?), COUNT(*)
         FROM events e JOIN event_tags t ON t.event_id = e.id
        WHERE e.kind = 1059 AND t.tag_name = 'p'
        GROUP BY t.tag_value
       ON CONFLICT(pubkey) DO NOTHING`,
    WRAP_FIXED_BYTES,
  );
  sql.exec(
    `INSERT OR IGNORE INTO wrap_expiry (id, expiration)
       SELECT id, expiration FROM events WHERE kind = 1059 AND expiration IS NOT NULL`,
  );
}

// Ensures group `_` has a row. Every relay hosted `_` before groups were
// rows, so seeding it unconditionally keeps existing group events, members
// and invites (whose group_id defaults to `_`) attached to a hosted group,
// and gives a fresh relay a group to write to. Here rather than in claim()
// because the row must exist under OWNER_PUBKEY too. Like every seed, it runs
// only on the reconcile path.
function seedTopLevelGroup(sql: SqlStorage): void {
  if (sql.exec(`SELECT 1 FROM groups WHERE id = ? LIMIT 1`, TOP_LEVEL_GROUP_ID).toArray().length > 0) {
    return;
  }
  sql.exec(
    `INSERT INTO groups (id, created_at, is_closed) VALUES (?, ?, 1)`,
    TOP_LEVEL_GROUP_ID,
    Math.floor(Date.now() / 1000),
  );
}

// Drops any `idx_` index INDEXES no longer declares, so a renamed or removed
// index stops costing a row per stored event. The prefix keeps it away from
// `sqlite_autoindex_*`, the implicit PRIMARY KEY indexes. Runs after the
// CREATE INDEX loop, so a throw partway leaves the old indexes in place: an
// extra index is a cost, a missing one an outage.
function dropUndeclaredIndexes(sql: SqlStorage): void {
  const declared = new Set(INDEXES.map((i) => i.name));
  const existing = sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx\\_%' ESCAPE '\\'`,
    )
    .toArray();
  for (const row of existing) {
    if (!declared.has(row.name)) sql.exec(`DROP INDEX IF EXISTS ${row.name}`);
  }
}

// push_subscriptions was keyed by endpoint alone before 0.20.0 (see that
// table). SQLite cannot change a primary key in place, so a table still
// keyed that way is renamed, recreated from TABLES and copied back, rows
// and all, then the old one dropped. Bounded by the per-pubkey device cap
// times the members, so one pass. Runs only on the reconcile path, ahead
// of the CREATE TABLE loop, which then finds the new table already there.
function rekeyPushSubscriptions(sql: SqlStorage): void {
  const keyed = sql
    .exec<{ name: string; pk: number }>(`SELECT name, pk FROM pragma_table_info('push_subscriptions')`)
    .toArray()
    .filter((c) => c.pk > 0);
  if (keyed.length !== 1) return;
  const spec = TABLES.find((t) => t.name === "push_subscriptions")!;
  sql.exec(`ALTER TABLE push_subscriptions RENAME TO push_subscriptions_old`);
  sql.exec(createTableSql(spec));
  sql.exec(
    `INSERT OR IGNORE INTO push_subscriptions (endpoint, pubkey, p256dh, auth, created_at, last_ok_at)
       SELECT endpoint, pubkey, p256dh, auth, created_at, last_ok_at FROM push_subscriptions_old`,
  );
  sql.exec(`DROP TABLE push_subscriptions_old`);
}

export function initSchema(sql: SqlStorage): void {
  ensureSchemaMetaTable(sql);
  const hash = currentSchemaHash();
  if (readStoredSchemaHash(sql) === hash) return;

  rekeyPushSubscriptions(sql);
  for (const spec of TABLES) {
    // Creates the table with every declared column on a fresh database,
    // and is a no-op on an existing one -- which is exactly why the
    // reconcile pass below has to exist.
    sql.exec(createTableSql(spec));
    reconcileColumns(sql, spec);
  }
  for (const index of INDEXES) {
    sql.exec(createIndexSql(index));
  }
  dropUndeclaredIndexes(sql);
  // Tables of removed features, dropped where they still exist: `mutes`
  // (NIP-51 mute-list write revocation), and `stats_snapshot` and
  // `live_stats` (caches for /api/stats figures that are now maintained
  // counters).
  sql.exec(`DROP TABLE IF EXISTS mutes`);
  sql.exec(`DROP TABLE IF EXISTS stats_snapshot`);
  sql.exec(`DROP TABLE IF EXISTS live_stats`);
  // backfill_meta must have exactly one row to hold status -- seeded here
  // rather than by whichever code path happens to run first, so every
  // reader (getBackfillStatus, /api/stats) can assume it exists.
  sql.exec(`INSERT INTO backfill_meta (status) SELECT 'pending' WHERE NOT EXISTS (SELECT 1 FROM backfill_meta)`);
  // relay_meta must have exactly one row, like backfill_meta above, so
  // getOwnHost/recordHost (src/host.ts) never have to special-case "no
  // row yet".
  sql.exec(`INSERT INTO relay_meta (host) SELECT NULL WHERE NOT EXISTS (SELECT 1 FROM relay_meta)`);
  // chat_state's single row (see that table), so storage.ts readChatState
  // never handles "no row yet". `last_occupied_at` starts at 0 ("empty since
  // the epoch"), so the first sweep's cutoff is 0 and removes nothing. On a
  // relay that already held chat, all of it goes at the end of the first real
  // conversation, whose cutoff covers everything before it; reporting mode
  // (EPHEMERAL_CHAT unset) exists to show that before it happens.
  sql.exec(`INSERT INTO chat_state (last_occupied_at) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM chat_state)`);
  seedMaintainedCounts(sql);
  seedIngestCounts(sql);
  seedMailUsage(sql);
  seedRelayIdentity(sql);
  seedTopLevelGroup(sql);

  // Last: a throw anywhere above leaves the old hash, and the next wake
  // retries. See the comment above initSchema.
  writeSchemaHash(sql, hash);
}
