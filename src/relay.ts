import { DurableObject } from "cloudflare:workers";
import {
  applyBackfillPage,
  type BackfillState,
  type BackfillStatus,
  getBackfillStatus,
  hasBackfillHeadroom,
  purgeSelfRelay,
  resetWronglyExhaustedRelays,
  seedBackfillRelays,
} from "./backfill";
import { matchesAnyFilter, parseFilter } from "./filters";
import { recordHost } from "./host";
import {
  ALL_SCOPES,
  CREATE_INVITE_KIND,
  filterNamesGroup,
  type GroupScope,
  isAnyGroupEvent,
  isGroupEvent,
  PUBLIC_SCOPE,
} from "./groups";
import {
  boundFilter,
  DAILY_ROWS_READ_LIMIT,
  DAILY_ROWS_WRITTEN_LIMIT,
  GIFT_WRAP_RATE_LIMIT_WINDOW_MS,
  JOIN_REQUEST_RATE_LIMIT_WINDOW_MS,
  MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW,
  LIVE_FEED_MAX_LIFETIME_MS,
  MAX_EVENTS_PER_REQ,
  MAX_CONN_STATE_BYTES,
  MAX_FILTER_ROWS_READ,
  MAX_FILTERS_PER_REQ,
  maxEventBytes,
  maxEventsPerPubkeyPerWindow,
  maxGiftWraps,
  MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
  MAX_LIVE_FEED_CONNECTIONS,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  VANISH_BATCH_SIZE,
  nonOwnerStorageLimit,
  PUBKEY_RATE_LIMIT_MAX_TRACKED,
  PUBKEY_RATE_LIMIT_WINDOW_MS,
  STORAGE_BYTES_LIMIT,
  utcDayStartSeconds,
} from "./limits";
import {
  applyModeration,
  authorizeGroupWrite,
  handleJoinRequest,
  isSupportedModerationKind,
  JOIN_REQUEST_KIND,
} from "./nip29";
import { handleManagementCall, type ManagementResponse } from "./nip86";
import { resolveIcon, resolveName, type OwnerProfile } from "./nip11";
import { version } from "../package.json";
import {
  type Filter,
  GIFT_WRAP_KIND,
  isEphemeralKind,
  type NostrEvent,
  pTagValues,
  VANISH_KIND,
} from "./nostr";
import {
  allowFollowsEnabled,
  CONTACT_LIST_KIND,
  claimOwner,
  getOwnerPubkey,
  getOwnerProfile,
  isAllowedWriter,
  refreshFollows,
  refreshProfile,
} from "./ownership";
import type { Profile } from "./profile-lookup";
import { normalizePubkey } from "./pubkey";
import {
  instrumentSql,
  readMetricsSnapshot,
  type ReadMetricsSnapshot,
  withReadPath,
  writeMetricsSnapshot,
  type WriteMetricsSnapshot,
} from "./read-metrics";
import { getRelayPubkey } from "./relay-identity";
import { initSchema } from "./schema";
import {
  applyDeletion,
  beginVanish,
  auditMaintainedCounts,
  countEvents24h,
  type CountAuditStatus,
  followsListAt,
  readIngestCounts,
  readMaintainedCounts,
  settleRowsWritten,
  drainVanish,
  hasVanishTargets,
  pendingVanishCutoff,
  pendingVanishes,
  vanishSummary,
  type VanishSummary,
  eventExists,
  expirationOf,
  fixMisclassifiedGroupEvents,
  getRelaySettings,
  giftWrapCount,
  hasNonOwnerStorageHeadroom,
  isDeleted,
  isGroupMember,
  isIpBlocked,
  queryFilters,
  type RelaySettings,
  storeEvent,
} from "./storage";
import { idMatchesContent, isCreatedAtTooFarInFuture, parseEventShape, verifySignature } from "./validate";

// Replies to a client-level "ping" with "pong" entirely inside the
// runtime -- it does not wake this object or count against DO duration.
// See CLAUDE.md "Architecture map".
const PING_PONG = new WebSocketRequestResponsePair("ping", "pong");

// Tag on the hibernation API's own connection registry (getWebSockets)
// that marks a socket as the admin page's live feed rather than a nostr
// protocol client -- see handleLiveFeed below.
// Using acceptWebSocket's built-in tagging means broadcast() can find
// these sockets with ctx.getWebSockets(LIVE_FEED_TAG) without keeping a
// second, memory-only registry that would need reconstructing after
// hibernation.
const LIVE_FEED_TAG = "live-feed";

// Live feed connection state -- just the connect time, used by the DO
// alarm below to enforce LIVE_FEED_MAX_LIFETIME_MS server-side. Same
// attachment mechanism as ConnState (survives hibernation/eviction), but
// a distinct, smaller shape since a live feed socket has no subs/auth to
// track.
interface LiveFeedState {
  connectedAt: number;
}

function getLiveFeedState(ws: WebSocket): LiveFeedState {
  return (ws.deserializeAttachment() as LiveFeedState | null) ?? { connectedAt: Date.now() };
}

// NIP-42's own kind for AUTH events (nips/42.md).
const AUTH_KIND = 22242;
// How far a client's AUTH `created_at` may drift from "now" before it's
// rejected as stale -- NIP-42 doesn't fix a number, this mirrors the
// ~10 minute window other relays use.
const AUTH_MAX_DRIFT_SECONDS = 600;

// Per-connection subscriptions, keyed by subscription id, plus the
// connecting IP for per-IP throttling. Persisted via WebSocket
// attachment (not object memory) so it survives hibernation -- see
// CLAUDE.md "The budget" on why an in-memory-only map would be wrong
// here: the object can be evicted between messages on an otherwise idle
// connection, and the attachment is what's still there on the next one.
//
// `host` is this connection's own request host (captured at connect
// time from the upgrade request's URL), used to check NIP-42 AUTH and
// NIP-62 vanish `relay` tags against -- see relayTagMatchesHost below.
// `challenge`/`authedPubkey` back the real NIP-42 challenge/response flow
// gating gift wrap reads: a challenge is issued
// lazily, the first time a REQ needs one, not proactively at connect.
type Subscriptions = Record<string, Filter[]>;
interface ConnState {
  ip: string;
  host: string;
  subs: Subscriptions;
  challenge?: string;
  authedPubkey?: string;
}

function getState(ws: WebSocket): ConnState {
  return (ws.deserializeAttachment() as ConnState | null) ?? { ip: "unknown", host: "unknown", subs: {} };
}

function setState(ws: WebSocket, state: ConnState): void {
  ws.serializeAttachment(state);
}

// Whether this state will fit in the WebSocket attachment, checked before
// storing it rather than discovered by serializeAttachment throwing --
// see limits.ts MAX_CONN_STATE_BYTES. Only handleReqInner needs to ask:
// it is the one path that adds an unbounded amount to the state, and the
// filters it would add are the client's own, so refusing is an answer the
// client can act on.
function stateFits(state: ConnState): boolean {
  return new TextEncoder().encode(JSON.stringify(state)).length <= MAX_CONN_STATE_BYTES;
}

// NIP-42 (nips/42.md "Signed Event Verification"): "checking if the
// domain name is correct should be enough." Also used for NIP-62's
// `relay` tag, which additionally allows the literal sentinel
// `ALL_RELAYS` (nips/62.md) -- checked by the caller, not here.
function relayTagMatchesHost(tagValue: string, host: string): boolean {
  try {
    return new URL(tagValue).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

// Per-IP message rate limit (CLAUDE.md "Threat model": "Per-IP
// throttling inside the DO"). Deliberately in-memory rather than in
// SQLite: it's a best-effort abuse mitigation, not a correctness
// guarantee, so it's fine for it to reset on hibernation -- persisting
// it would cost rows-written for no real benefit.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_MESSAGES = 50;

// RFC 6455 section 7.4.1: status codes an endpoint may never put in a
// Close frame. The runtime reports them to describe how a connection
// ended; sending one back is a protocol error and throws. See
// webSocketClose below.
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);
const NORMAL_CLOSURE = 1000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function send(ws: WebSocket, message: unknown[]): void {
  ws.send(JSON.stringify(message));
}

function ok(ws: WebSocket, id: string, accepted: boolean, message: string): void {
  send(ws, ["OK", id, accepted, message]);
}

// Maps ownership.ts isAllowedWriter's rejection reasons to distinct
// NIP-01 OK messages, written for the person reading them in their
// client rather than for a developer reading logs. All get the
// `restricted:` prefix per NIP-01's own worked example (nips/01.md line
// 173).
function writeRejectionMessage(reason: "unclaimed" | "not-follow" | "owner-only" | "banned"): string {
  switch (reason) {
    case "unclaimed":
      return "restricted: relay has not been claimed yet";
    case "not-follow":
      return "restricted: only the owner and people they follow can publish here";
    case "owner-only":
      return "restricted: writes are limited to the relay owner";
    case "banned":
      return "blocked: this pubkey is banned from writing here";
  }
}

export class Relay extends DurableObject<Env> {
  // Per-IP sliding window counters for webSocketMessage throttling --
  // see the RATE_LIMIT_* constants above for why this is memory, not
  // storage.
  private rateLimits = new Map<string, { windowStart: number; count: number }>();

  // Separate per-IP counter just for gift wrap writes (limits.ts
  // GIFT_WRAP_RATE_LIMIT_WINDOW_MS/MAX_GIFT_WRAPS_PER_IP_PER_WINDOW) --
  // the general rate limit above bounds connection-level message spam
  // across every frame type; this one specifically bounds rows-written
  // risk on the one write path anyone can use without being the owner.
  private giftWrapRateLimits = new Map<string, { windowStart: number; count: number }>();

  // The same shape again, for kind-9021 join requests -- the other write
  // path a stranger can reach. Keyed by IP and held in memory for the
  // same reasons and with the same eviction caveat (limits.ts
  // JOIN_REQUEST_RATE_LIMIT_WINDOW_MS/MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW).
  // A separate counter from the gift wrap one because they bound
  // different things: that one bounds rows written, this one bounds
  // guesses at a bearer token.
  private joinRateLimits = new Map<string, { windowStart: number; count: number }>();

  // Per-PUBKEY write counter (limits.ts PUBKEY_RATE_LIMIT_WINDOW_MS/
  // MAX_EVENTS_PER_PUBKEY_PER_WINDOW). The two maps above are keyed by IP
  // and a writer with several addresses walks around both; a follow's
  // authority to write here is their pubkey, so this is keyed by that.
  // Same in-memory, resets-on-eviction tradeoff as the other two -- see
  // the constant's comment for exactly how much that is and isn't worth.
  private pubkeyRateLimits = new Map<string, { windowStart: number; count: number }>();

  // DIAGNOSTIC (src/read-metrics.ts, and expected to be removed with it):
  // every storage access in this object goes through this handle rather
  // than `ctx.storage.sql` directly, so rows read are attributed to the
  // code path that caused them. Behaviourally identical to the handle it
  // wraps -- it adds a Proxy per query and no storage of its own.
  //
  // A field initializer, which runs after super() has set `ctx` and
  // before the constructor body, so initSchema below already sees it.
  private readonly sql: SqlStorage = instrumentSql(this.ctx.storage.sql);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Scoped because this runs on every wake from hibernation, not once
    // per deploy -- the Durable Object constructor is re-entered each
    // time an evicted object is revived, so whatever initSchema reads is
    // paid per wake. Whether that is a real share of the read budget was
    // exactly the sort of thing nothing here could answer before.
    withReadPath("schema", () => initSchema(this.sql));
    ctx.setWebSocketAutoResponse(PING_PONG);
  }

  override async fetch(request: Request): Promise<Response> {
    return this.metered(() => this.fetchInner(request));
  }

  private async fetchInner(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    // Opportunistic: every real client connection passes through here,
    // so this is the most reliable single place to learn the
    // deployment's own host (src/host.ts) for backfill's self-skip.
    // recordHost is a no-op write once the host is already known.
    // DIAGNOSTIC scope (read-metrics.ts): the two storage touches every
    // connection pays, kept together and off the async path -- a
    // withReadPath scope is synchronous, so it must not straddle the
    // `await` further down this method.
    const blocked = withReadPath("connect", () => {
      recordHost(this.sql, new URL(request.url).host);

      // NIP-86 blockip (src/nip86.ts), enforced exactly here: once per
      // connection, before the socket is accepted, and never again for the
      // life of that connection. Checking per message or per event would
      // put a storage read on the hot path for a table that is almost
      // always empty -- the whole reason IP blocking made phase one.
      //
      // This covers both WebSocket paths (the nostr protocol connection
      // and the admin page's /live feed) and nothing else. In particular
      // it does NOT cover the management endpoint, which is a plain POST
      // handled in the Worker and never reaches this method: blocking
      // your own address must never lock you out of the API that
      // unblocks it.
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      return isIpBlocked(this.sql, ip);
    });
    if (blocked) {
      return new Response("blocked", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // The admin page's live feed is a distinct,
    // push-only, unauthenticated channel -- not a nostr protocol
    // connection -- so it's routed to its own path rather than reusing
    // REQ/EVENT semantics. Keeping it separate means it never has to
    // satisfy the read-cost guard (limits.ts boundFilter, which admits a
    // filter only at a limit some index can afford) just to see
    // "everything," and the
    // gift-wrap NIP-42 read gate (handleReq below) never has to reason
    // about it: liveBroadcast unconditionally never sends kind 1059,
    // full stop, so there's no unauthenticated-viewer case to gate.
    if (new URL(request.url).pathname === "/live") {
      // Capped independently of the general per-IP/per-connection limits
      // above, which are tuned for the nostr protocol path -- this is an
      // unauthenticated, filter-less, always-broadcast channel, so its
      // own cap is what actually bounds worst-case broadcast fan-out
      // (liveBroadcast below iterates every open live socket per stored
      // event) and concurrent DO-side attachment state.
      if (this.ctx.getWebSockets(LIVE_FEED_TAG).length >= MAX_LIVE_FEED_CONNECTIONS) {
        return new Response("too many live feed connections", { status: 503 });
      }

      // acceptWebSocket (not server.accept()) is what makes this
      // connection hibernatable -- same reasoning as the tagged branch
      // below, see CLAUDE.md "Architecture map".
      this.ctx.acceptWebSocket(server, [LIVE_FEED_TAG]);
      server.serializeAttachment({ connectedAt: Date.now() } satisfies LiveFeedState);
      await this.scheduleLiveFeedAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    // acceptWebSocket (not server.accept()) is what makes this connection
    // hibernatable. Calling accept() instead pins the object in memory
    // and bills DO duration for the connection's entire lifetime -- see
    // CLAUDE.md "Architecture map".
    this.ctx.acceptWebSocket(server);
    setState(server, {
      ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
      host: new URL(request.url).host,
      subs: {},
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // TOFU claim: the first pubkey submitted here owns the relay,
  // permanently, with no signature check on the claim itself. This is
  // deliberate, not a shortcut -- a signature would buy no real security,
  // since every event is verified against its own signature regardless of
  // who owns the relay, so a wrong claim can never be used to forge
  // anything. The worst case of someone else claiming first is that the
  // relay archives a stranger's public notes at the real owner's expense,
  // and recovery is free: delete the Worker, deploy again. Requiring a
  // signature here would only move the hard step (proving control of a
  // key before you have anything working) onto this page, for a threat
  // that doesn't cost anything to recover from.
  //
  // RPC method, called directly by the Worker (src/index.ts) rather than
  // over fetch() -- this is the only code path that may write the `owner`
  // row (ownership.ts). Nothing to do here for the relay's own signing
  // identity (src/relay-identity.ts): it is seeded at schema-init time,
  // before this constructor's caller can reach any RPC method, precisely
  // so it exists whether or not this claim ever runs -- OWNER_PUBKEY
  // skips claim() entirely, and that deployment shape needs the identity
  // too.
  async claim(
    rawPubkey: unknown,
    profile?: Profile,
    host?: string,
  ): Promise<{ status: "claimed" | "conflict" | "disabled" | "invalid"; pubkey?: string }> {
    if (this.env.OWNER_PUBKEY) return { status: "disabled" };
    if (typeof rawPubkey !== "string") return { status: "invalid" };
    const pubkey = normalizePubkey(rawPubkey);
    if (!pubkey) return { status: "invalid" };

    return this.metered(() =>
      withReadPath("identity", () => {
        const sql = this.sql;
        if (host) recordHost(sql, host);
        if (!claimOwner(sql, pubkey, profile)) return { status: "conflict" as const };
        return { status: "claimed" as const, pubkey };
      }),
    );
  }

  // Backs the NIP-11 document's name/icon (src/nip11.ts) -- derived from
  // the owner's kind 0 at claim time rather than a deploy-time var, see
  // Null when unclaimed, when OWNER_PUBKEY skips storage entirely, or
  // when the claim-time profile lookup failed; the
  // caller (nip11.ts) falls back to hardcoded defaults in all those cases.
  async getIdentity(
    host?: string,
  ): Promise<{
    profile: OwnerProfile;
    settings: RelaySettings;
    ownerPubkey: string | null;
    relayPubkey: string;
  }> {
    return this.metered(() =>
      withReadPath("identity", () => {
        const sql = this.sql;
        if (host) recordHost(sql, host);
        // The owner pubkey rides along rather than costing a second RPC:
        // NIP-11 now publishes it (nip11.ts), and getOwnerPubkey is an
        // env read plus at most one indexed row. The relay's own pubkey
        // (src/relay-identity.ts) rides the same way -- one more row,
        // already guaranteed to exist by initSchema (schema.ts
        // seedRelayIdentity).
        return {
          profile: getOwnerProfile(sql, this.env),
          settings: getRelaySettings(sql),
          ownerPubkey: getOwnerPubkey(sql, this.env),
          relayPubkey: getRelayPubkey(sql),
        };
      }),
    );
  }

  // The owner pubkey on its own, for the Worker's NIP-98 check
  // (src/nip98.ts) -- the signature has to be verified against something
  // before any management call is allowed near storage, and verification
  // deliberately happens in the Worker. Null when unclaimed, which
  // verifyNip98 turns into a 401.
  async getOwner(): Promise<string | null> {
    return this.metered(() => withReadPath("identity", () => getOwnerPubkey(this.sql, this.env)));
  }

  // NIP-86 relay management (src/nip86.ts), write side. Reached only
  // after the Worker has verified a NIP-98 event signed by the owner --
  // this method performs no authentication of its own and must never be
  // called from anywhere that hasn't done that check. Storage mutations
  // live here rather than in the Worker for the same reason claim() and
  // ingestBackfillPage() do: the Durable Object owns every write, and it
  // opens no outbound connection to serve one.
  async manage(method: unknown, params: unknown[], callerIp: string): Promise<ManagementResponse> {
    return this.metered(() =>
      withReadPath("management", () =>
        handleManagementCall(this.sql, this.env, method, params, callerIp, nowSeconds()),
      ),
    );
  }

  // Backs GET /api/stats (src/index.ts) -- see CLAUDE.md "What it is".
  async getStats(host?: string): Promise<{
    version: string;
    claimed: boolean;
    ownerPubkey: string | null;
    // This relay's own signing identity (src/relay-identity.ts), never
    // the owner's -- generated once at schema-init time and guaranteed
    // to exist regardless of claim status, unlike ownerPubkey above.
    // NIP-29 requires 39000-series group metadata events to be "signed
    // by the relay keypair directly"; this is that identity's public
    // half, so a client can verify what it signs once that work lands.
    relayPubkey: string;
    // Maintained, not counted: storage.ts readMaintainedCounts reads one
    // row of `maintained_counts`, which insertEventRow and deleteEventRow
    // move. Exact and current -- it was a COUNT(*) over `events` served
    // from a six-hour snapshot until the counters landed.
    totalEvents: number;
    // Events whose own created_at falls in the last 24h -- what the owner
    // has been posting lately. NOT what this relay took in: a backfilled
    // event is years old by created_at and lands here as zero. See
    // ingested24h below, which is the other half of that sentence.
    //
    // Also maintained (storage.ts countEvents24h), from per-hour buckets
    // keyed by `created_at` -- which is what makes the sentence above
    // true of the counter and not just of the old scan. At most 26 rows
    // read, whatever E is and however busy the relay is. The window is
    // whole hours, so it spans 24-25h rather than exactly 24; see
    // countEvents24h for why that is an improvement on what it replaced.
    events24h: number;

    // Events this relay actually wrote in the last 24h, backfill
    // included -- maintained, from per-hour buckets keyed by
    // `ingested_at` (storage.ts readIngestCounts, schema.ts
    // `ingest_hour_counts`). At most 25 rows read, shared with the figure
    // below. Whole hours, so the window spans 24-25h.
    ingested24h: number;
    storageBytes: number;
    // Rows written since the last 00:00 UTC, when the free tier's
    // allowances reset -- the write-budget meter, and the only figure
    // here measured against a window the platform chose rather than one
    // this relay chose.
    //
    // ROWS WRITTEN, all of them, as of the release that bucketed this:
    // event rows and their index entries, tag rows, tombstones, counter
    // updates, the follow-list rebuild, NIP-86 bans, backfill
    // bookkeeping. It used to be a SUM over `events.row_cost`, which saw
    // only the storing of events -- during a vanish drain it could miss
    // tens of thousands of rows. Measured now, by the SqlStorage wrapper
    // in read-metrics.ts, and landed by storage.ts settleRowsWritten;
    // it reads slightly HIGH, because a removal is accounted at the
    // pessimistic figure the cursor cannot confirm (schema.ts
    // eventRemovalBudget), which is the safe direction for a budget.
    //
    // Exact at the boundary rather than approximate: a UTC day starts on
    // a whole hour, so the day's buckets are exactly the day's writes.
    rowsWrittenToday: number;
    // The three Workers-free-tier ceilings limits.ts declares, transported
    // rather than left for public/index.html to hardcode a second copy of
    // -- see CLAUDE.md "The budget". Static per deployment (none of these
    // are env-overridable), but served from the one place that already
    // knows them so the admin page's progress bars can never drift from
    // what this relay is actually being measured against.
    storageBytesLimit: number;
    dailyRowsWrittenLimit: number;
    dailyRowsReadLimit: number;
    backfill: BackfillStatus | null;
    icon: string | null;
    // The name actually in effect, resolved through the same chain the
    // NIP-11 document uses (nip11.ts resolveName) so the admin page's
    // readout and the document a client fetches can never disagree.
    // NIP-86 has no getrelayname, so this is the read side for
    // changerelayname.
    relayName: string;
    // Whether writes beyond the owner are currently possible at all
    // (CLAUDE.md "What it is"), plus the numbers that
    // back that state -- see the ALLOW_FOLLOWS-gate comment in
    // ownership.ts isAllowedWriter. Surfaced so an owner who enabled
    // ALLOW_FOLLOWS but never published a kind-3 here (an empty allowlist
    // that silently blocks every follow) has a visible signal instead of
    // a mystery.
    writePolicy: "owner" | "follows";
    // Maintained by ownership.ts refreshFollows, which is the only
    // function that writes the `follows` table -- so this comes out of
    // the same `maintained_counts` row as `totalEvents`, at no extra
    // read. It was a COUNT over `follows` behind a six-hour cache.
    followCount: number;
    // Whether the daily counter audit (storage.ts auditMaintainedCounts)
    // has ever run, and what it found last time -- out of the same
    // `maintained_counts` row as `totalEvents`/`followCount`, at no extra
    // read. Before this field existed, the only record of what that audit
    // found was a console.error line nobody was reading; three releases
    // of maintained counters ran with no way to check from the outside
    // that the safety net under them had ever actually fired.
    //
    // `lastRanAt: null` means the audit has never run, and it MUST NOT be
    // rendered as "no drift found" -- a guard reporting health before it
    // has checked anything is worse than no guard, which is the specific
    // failure this field exists to make impossible to draw by accident.
    // See schema.ts's `last_drift` column comment and public/index.html's
    // rendering of this field.
    countAudit: CountAuditStatus;
    // The `created_at` of the owner's contact list as the follow cache
    // currently has it -- not when that cache was last refreshed, which
    // is no longer a thing that happens on a schedule (ownership.ts
    // refreshFollows). One row read: every row in `follows` carries the
    // same value, so this needs no counter of its own.
    followsListAt: number | null;
    // NIP-62 vanish requests still draining. A vanish removes every event
    // its sender authored, the relay cannot refuse one, and the cost
    // scales with how many that is -- so a stalled drain is visible here
    // rather than inferred. See the comment on storage.ts deleteEventRow.
    //
    // Aggregated, never itemised. This field used to carry the pending
    // rows verbatim, pubkey included, on an endpoint that is public and
    // unauthenticated -- publishing exactly which identities had asked to
    // be erased from this relay, to anybody who asked for the page. A
    // count, a progress total and an age answer the operational question
    // ("is a drain stuck?") and name nobody. See storage.ts vanishSummary.
    //
    // It used to sit beside `largestNonOwnerAuthor`, which reported the
    // largest such exposure before one was requested. That field is gone:
    // it cost a GROUP BY over every event to produce, nothing acted on
    // it, and the exposure it described is bounded by the write gate and
    // the storage cap rather than by knowing the number.
    vanishing: VanishSummary;
    // DIAGNOSTIC, and expected to be removed with src/read-metrics.ts.
    // Rows read attributed to the code path that caused them, since the
    // relay's last outage was the 5,000,000 rows-read/day ceiling and
    // nothing here could say which path spent it. In-memory counters,
    // so this describes `reads.sinceMs` of uptime, NOT a day -- read it
    // for proportions, and read `projected24h` as an extrapolation of
    // exactly that sample, not as a measurement.
    reads: ReadMetricsSnapshot;
    // The write-side twin, over the same in-memory counters. Answers what
    // `rowsWrittenToday` on its own cannot: WHICH path is spending the
    // write budget, not just how much of it is spent. `rowsWrittenToday`
    // stays the authoritative, durable figure -- this is a diagnostic
    // breakdown of it, with the same reset-on-eviction caveat as `reads`.
    writes: WriteMetricsSnapshot;
  }> {
    // Scoped to "getStats" rather than measured per query: the nested
    // estimateRowsWrittenSince declares its own scope and so reports
    // separately -- it was for a long time the most expensive call in
    // here, and keeping it separately billed is how that stays visible.
    // It now runs only on a `live_stats` cache miss, so a run of stats
    // requests that leaves its bucket flat is the cache working, and a
    // bucket climbing with the request count is that cache broken.
    return this.metered(() => {
      const stats = withReadPath("getStats", () => this.collectStats(host));
      // Snapshotted after the scope closes so this call's own reads/writes
      // are included in what it reports -- a breakdown that excluded the
      // request producing it would understate getStats by exactly one call.
      return { ...stats, reads: readMetricsSnapshot(), writes: writeMetricsSnapshot() };
    });
  }

  private collectStats(host?: string): Omit<Awaited<ReturnType<Relay["getStats"]>>, "reads" | "writes"> {
    // recordHost is a write, and it is a no-op once the host is already
    // known (src/host.ts), so it costs nothing to keep honest.
    if (host) recordHost(this.sql, host);

    const sql = this.sql;
    const owner = getOwnerPubkey(sql, this.env);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    // The last 00:00 UTC, because the rows-written ceiling this measures
    // against is an allowance that empties then -- see limits.ts
    // utcDayStartSeconds. It used to be a cache key as well, since a
    // figure computed before yesterday's boundary was invalid however
    // fresh it looked; there is no cache to invalidate now, so it is
    // simply where the day's ingest-hour buckets start.
    const budgetSince = utcDayStartSeconds(nowMs);

    // Every count this relay maintains, in one row read (schema.ts
    // `maintained_counts`). This used to be a cache read that could miss
    // and fall through to ~3E rows of recomputation; there is nothing
    // left here that can miss.
    const counts = readMaintainedCounts(sql);
    // Both halves of the created_at buckets, one statement, ~26 rows --
    // the public figure published below is the difference.
    const windowed = countEvents24h(sql, nowSec);
    // The last two computed figures on this document, now maintained as
    // well -- both out of `ingest_hour_counts` in one statement, at most
    // 25 rows. They were a cache row on a five-minute clock, because each
    // read the ingest window (~1,200 rows) on an unauthenticated GET.
    // With them bucketed there is nothing on this document behind a
    // clock, and `liveAt` went with the last one that was.
    const ingest = readIngestCounts(sql, nowSec, budgetSince);

    const profile = getOwnerProfile(sql, this.env);
    const settings = getRelaySettings(sql);

    return {
      version,
      claimed: owner !== null,
      ownerPubkey: owner,
      // One more row, from the singleton relay_identity table -- see
      // CLAUDE.md "The budget" for /api/stats' overall read cost.
      relayPubkey: getRelayPubkey(sql),
      // Both maintained: the row read above, plus at most 26 bucket rows.
      // Current as of this request.
      // Group events are SUBTRACTED from every count on this document.
      // /api/stats is public and unauthenticated, and the security review
      // that produced the gift wrap read gate found the same shape here:
      // hold a /live socket, poll a total that moves with every stored
      // event, and each arrival the feed does not announce is dated to the
      // second. Group events have exactly that shape, so the counters are
      // maintained in two halves (schema.ts `group_events`/`group_n`) and
      // only the public half is published.
      //
      // WHAT THIS DOES NOT FIX, stated here because the fields sit on the
      // same document and a reader will assume otherwise:
      //
      //   storageBytes       `sql.databaseSize`, which grows with every
      //                      stored event whatever partition it is in. Page
      //                      granularity blurs it, a busy group still moves
      //                      it, and nothing short of not reporting it
      //                      would change that.
      //   rowsWrittenToday   deliberately whole. It is the owner's budget
      //                      meter, and a budget figure that under-reports
      //                      the day's real spend is worse than one that
      //                      leaks the shape of the traffic producing it.
      //   reads              the read-metrics diagnostic, whose per-path
      //                      counters move with group REQs like any other.
      //
      // All three are coarser channels than a per-event counter, and all
      // three remain.
      totalEvents: counts.events - counts.groupEvents,
      events24h: windowed.total - windowed.group,
      // Maintained, out of the ingest-hour buckets read above -- at most
      // 25 rows for the pair, current as of this request. They were the
      // two numbers most worth being current and the two that cost the
      // most to be, which is what a cache was papering over; bucketing
      // made the tension disappear rather than trading it.
      ingested24h: ingest.ingested24h - ingest.ingestedGroup24h,
      storageBytes: sql.databaseSize,
      rowsWrittenToday: ingest.rowsWrittenToday,
      storageBytesLimit: STORAGE_BYTES_LIMIT,
      dailyRowsWrittenLimit: DAILY_ROWS_WRITTEN_LIMIT,
      dailyRowsReadLimit: DAILY_ROWS_READ_LIMIT,
      // Live: the backfill tables hold one row per relay in the owner's
      // kind-10002 list, so this is ~20 rows read, not O(E). Snapshotting
      // it would save nothing and would make "last ran" and the refusal
      // message stale on the one part of this page whose whole job is
      // watching progress happen.
      backfill: owner !== null ? getBackfillStatus(sql) : null,
      // Same source as the NIP-11 document's icon (src/nip11.ts
      // resolveIcon) -- the admin page uses this to set the browser
      // tab's favicon from the owner's kind-0 picture. Null falls back
      // to the static default favicon client-side.
      icon: resolveIcon(this.env, settings, profile),
      relayName: resolveName(this.env, settings, profile),
      writePolicy: allowFollowsEnabled(this.env) ? "follows" : "owner",
      // Out of the same row as `totalEvents` above, at no additional read.
      followCount: counts.follows,
      countAudit: { lastRanAt: counts.lastRanAt, drift: counts.drift },
      followsListAt: followsListAt(sql),
      vanishing: vanishSummary(sql),
    };
  }

  // ------------------------------------------------------------------
  // THE WRITE METER'S LANDING, wrapped around every entry point into this
  // object.
  //
  // read-metrics.ts accumulates rows written from every cursor the
  // wrapped SqlStorage hands out, in INSTANCE MEMORY -- and this object
  // hibernates between messages, waking on the order of seventy times per
  // cron interval. A total that was flushed on a timer, or deferred to
  // the next cron tick, would therefore lose most of what it measured,
  // and lose more of it the quieter the relay is: the failure mode nobody
  // would notice, on the number an owner reads to decide whether the
  // relay is out of allowance or actually broken. So the rule is that a
  // total lands inside the execution context that produced it, before
  // that context returns, and this is where that rule is enforced.
  //
  // A wrapper rather than a call at the end of each method body, for the
  // reason read-metrics.ts wraps `sql.exec` rather than asking each query
  // to report itself: an early return, a thrown error or a new entry
  // point added later would each quietly skip a trailing call. `finally`
  // covers all three.
  //
  // Nearly always free. storage.ts settleRowsWritten writes nothing when
  // nothing is pending (every read-only path) and nothing when the
  // residue is smaller than the landing itself -- which is the case right
  // after an event write, since storing an event lands its own total
  // through a bucket row it was writing anyway. What actually pays a row
  // here is the cron tick, a NIP-86 call, the follow rebuild and the
  // vanish drain: on the order of thirty a day.
  //
  // The cost of landing is itself measured, so it carries into the next
  // landing rather than vanishing -- see read-metrics.ts.
  // ------------------------------------------------------------------
  private async metered<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      settleRowsWritten(this.sql, nowSeconds());
    }
  }

  // Cron entry point (src/index.ts scheduled()) -- refreshes the
  // ALLOW_FOLLOWS cache and, at most once/day, the cached NIP-11/favicon
  // icon from the owner's locally-stored kind-0 (ownership.ts
  // refreshProfile). Both are no-ops on their common paths (feature off;
  // empty list; already refreshed today), so this stays cheap on most
  // ticks.
  async runCron(): Promise<void> {
    return this.metered(() => this.runCronInner());
  }

  private async runCronInner(): Promise<void> {
    // Logged here, DO-side, and not left to the Worker's own catch in
    // src/index.ts scheduled(). A Durable Object exception does not
    // reliably carry its message across the RPC boundary: the Worker's
    // catch sees the call reject and logs "scheduled: runCron failed"
    // followed by an empty message and a single stack frame at the await,
    // which says only that something went wrong in here, not what. This
    // catch runs on the side that still holds the real Error.
    //
    // It rethrows, deliberately: the Worker's fault isolation is what
    // keeps a failure here from stopping backfill from ever running
    // (src/index.ts scheduled()), and swallowing the error here would
    // silently disable that. This adds a log line, not a behaviour
    // change.
    try {
      const sql = this.sql;
      const now = nowSeconds();
      withReadPath("cron", () => {
        refreshFollows(sql, this.env);
        refreshProfile(sql, this.env, now);
      // One-time correction for relays the pre-fix short-page exhaustion
      // heuristic wrongly retired -- see backfill.ts resetWronglyExhaustedRelays.
        resetWronglyExhaustedRelays(sql);
      // Runs AFTER the reset, deliberately: the reset clears every
      // exhausted flag including this relay's own row, so purging has to
      // be what happens last or backfill would spend the next tick
      // fetching its own history from itself. See purgeSelfRelay.
        purgeSelfRelay(sql);
        // One-time correction for events wrongly filed into this relay's
        // group partition (de-flagged into the public one) or wrongly
        // admitted as this relay's own group metadata (purged outright)
        // before groups.ts isGroupEvent and storage.ts storeEvent were
        // scoped to TOP_LEVEL_GROUP_ID and this relay's own signer -- see
        // storage.ts fixMisclassifiedGroupEvents. VANISH_BATCH_SIZE reused
        // rather than a new constant: both of that function's writes cost
        // the same shape VANISH_BATCH_SIZE is already paced against, an
        // UPDATE moving a row between partial-index partitions or a
        // DELETE removing one outright. Alongside the relay's own
        // upkeep, ahead of the vanish drain below, for the reason every
        // step above it is: this is the relay fixing its own past
        // mistake, not a cost a stranger's request sizes.
        fixMisclassifiedGroupEvents(sql, this.ctx.storage, VANISH_BATCH_SIZE);
        // Once a day (paced by maintained_counts.audited_at, not by this
        // tick's frequency), recount `events` and `follows` and log if the
        // maintained counters disagree. E + F rows read, once -- against
        // the ~12E a day the stats snapshot spent recomputing these same
        // numbers four times over before they were maintained, this is a
        // quarter of the cost and it checks the answer instead of
        // assuming it. Detect only: see storage.ts auditMaintainedCounts
        // for why it must not self-correct.
        //
        // This tick used to refresh the stats snapshot here as well, so
        // an admin page load would find one already computed. There is no
        // snapshot any more and nothing to precompute: a stats request
        // reads a row and at most 26 buckets, which is cheaper than the
        // cache read the snapshot cost.
        //
        // Before the vanish drain, deliberately: the drain is the step
        // that can consume the tick's budget, and everything the relay
        // does for itself goes ahead of the step a stranger's request
        // sizes.
        auditMaintainedCounts(sql, now);
        // Last, and deliberately so: this is the only step whose cost is
        // set by a stranger's request rather than by the relay's own
        // state, and everything above gates the owner's own writes.
        this.drainPendingVanishes(sql);
      });
    } catch (err) {
      console.error(
        "runCron failed (DO-side):",
        err instanceof Error ? err.message : String(err),
        err instanceof Error ? err.stack : "",
      );
      throw err;
    }
  }

  // One-shot backfill, read side. Called once per
  // cron tick by backfill-worker.ts (the Worker, never this object,
  // opens the outbound sockets -- see that file's header comment) to
  // decide whether to discover relays, fetch a page, or do nothing. Null
  // when unclaimed -- there's no owner pubkey to backfill and no relay
  // list to discover yet.
  async getBackfillState(): Promise<BackfillState | null> {
    return this.metered(() =>
      withReadPath("backfillState", () => {
        const sql = this.sql;
        const owner = getOwnerPubkey(sql, this.env);
        if (owner === null) return null;
        const now = nowSeconds();
        return { ...getBackfillStatus(sql), ownerPubkey: owner, canIngestNow: hasBackfillHeadroom(sql, now) };
      }),
    );
  }

  // Seeds backfill_relays from the owner's kind-10002 write relays, once
  // the Worker has resolved them from well-known relays (backfill-worker.ts
  // discoverWriteRelays). A pure write, no outbound connection here.
  async discoverBackfillRelays(relayUrls: string[]): Promise<void> {
    await this.metered(() =>
      withReadPath("backfillIngest", () => seedBackfillRelays(this.sql, relayUrls, nowSeconds())),
    );
  }

  // Stores one page of raw EVENT payloads the Worker already fetched over
  // its own short-lived outbound socket (backfill-worker.ts fetchPage) --
  // see backfill.ts applyBackfillPage for validation/dedup/tombstone/
  // storage-semantics ordering. Null when unclaimed (shouldn't happen in
  // practice, since the Worker only calls this after getBackfillState
  // returned a real owner, but this object must not guess an owner that
  // doesn't exist).
  async ingestBackfillPage(
    relayUrl: string,
    rawEvents: unknown[],
    eose: boolean,
    refusals: string[] = [],
  ): Promise<{ stored: number; exhausted: boolean } | null> {
    // Scoped here, at the RPC entry, rather than inside applyBackfillPage
    // -- one entry per cron tick, so `rowsPerCall` in the /api/stats
    // breakdown reads as "rows read per backfill tick", which is the unit
    // the arithmetic in CLAUDE.md "The budget" multiplies by 24.
    return this.metered(() =>
      withReadPath("backfillIngest", () => {
        const sql = this.sql;
        const owner = getOwnerPubkey(sql, this.env);
        if (owner === null) return null;
        return applyBackfillPage(sql, owner, relayUrl, rawEvents, eose, nowSeconds(), refusals);
      }),
    );
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.metered(() => this.webSocketMessageInner(ws, message));
  }

  private webSocketMessageInner(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;

    // The live feed (LIVE_FEED_TAG) is push-only and never has an
    // attachment set (setState is never called for it in fetch()) --
    // nothing it could legitimately send needs NIP-01 handling, so it's
    // routed away before frame parsing rather than falling through to
    // "unknown message type" against state meant for real relay clients.
    if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) return;

    if (this.isRateLimited(ws)) {
      this.handleRateLimitedMessage(ws, message);
      return;
    }

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      send(ws, ["NOTICE", "error: could not parse message"]);
      return;
    }
    if (!Array.isArray(frame) || typeof frame[0] !== "string") {
      send(ws, ["NOTICE", "error: malformed message"]);
      return;
    }

    switch (frame[0]) {
      case "EVENT":
        this.handleEvent(ws, frame[1]);
        return;
      case "REQ":
        this.handleReq(ws, frame);
        return;
      case "CLOSE":
        this.handleClose(ws, frame[1]);
        return;
      case "AUTH":
        this.handleAuth(ws, frame[1]);
        return;
      default:
        send(ws, ["NOTICE", `error: unknown message type ${frame[0]}`]);
    }
  }

  // True when this connection's IP has sent too many messages within
  // the current window -- CLAUDE.md "Threat model": "Per-IP throttling
  // inside the DO."
  private isRateLimited(ws: WebSocket): boolean {
    const { ip } = getState(ws);
    const now = Date.now();
    const entry = this.rateLimits.get(ip);
    if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.rateLimits.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > RATE_LIMIT_MAX_MESSAGES;
  }

  // A rate-limited EVENT frame used to get only the NOTICE below, with no
  // per-event verdict -- fine for a human at a keyboard, bad for a machine
  // client. A WebRTC signalling client blocks on OK to know a candidate was
  // delivered; measured in a signalling spike, 30 throttled events sat in
  // the client's pending-OK map forever, stalling ICE with nothing to
  // diagnose. So a frame that parses far enough to name an id gets OK false
  // with a rate-limited: prefix instead. The size check runs against the
  // raw frame BEFORE JSON.parse, the same ordering acceptEvent and
  // handleJoin use for their own copy of this check -- parsing and
  // extracting an id costs nothing like the schnorr verify this throttle
  // exists to avoid, and that has to stay true even for the frames this
  // throttle is refusing. Anything that isn't a parseable EVENT frame
  // falls back to the plain NOTICE.
  private handleRateLimitedMessage(ws: WebSocket, message: string): void {
    const byteCap = maxEventBytes(this.env);
    if (byteCap === null || message.length <= byteCap) {
      let frame: unknown;
      try {
        frame = JSON.parse(message);
      } catch {
        frame = null;
      }
      if (Array.isArray(frame) && frame[0] === "EVENT") {
        const event = parseEventShape(frame[1]);
        if (event) {
          ok(ws, event.id, false, "rate-limited: slow down");
          return;
        }
      }
    }
    send(ws, ["NOTICE", "rate-limited: slow down"]);
  }

  // Scoped as one "write" entry per EVENT frame (read-metrics.ts), which
  // covers the ownership gate, the tombstone and duplicate checks, the
  // gift wrap count, storeEvent's own replaceable/addressable lookups and
  // any NIP-09/NIP-62 application -- i.e. everything an inbound event
  // reads, in one bucket, so `rowsPerCall` reads as "rows read per event
  // offered to this relay".
  private handleEvent(ws: WebSocket, raw: unknown): void {
    withReadPath("write", () => this.handleEventInner(ws, raw));
  }

  private handleEventInner(ws: WebSocket, raw: unknown): void {
    const event = parseEventShape(raw);
    if (!event) {
      send(ws, ["NOTICE", "error: malformed event"]);
      return;
    }

    // NIP-62 vanish requests and NIP-59 gift wraps each have their own,
    // entirely different authorization -- neither goes through
    // isAllowedWriter below. See handleVanish and
    // handleGiftWrap.
    if (event.kind === VANISH_KIND) {
      this.handleVanish(ws, event);
      return;
    }
    if (event.kind === GIFT_WRAP_KIND) {
      this.handleGiftWrap(ws, event);
      return;
    }
    // NIP-29 join request. Necessarily above isAllowedWriter and not
    // beside it: somebody joining is by definition not in
    // `allowed_pubkeys` yet, so the relay-wide gate would refuse the one
    // event whose entire purpose is to get them past it. The authority is
    // the invite code -- see nip29.ts handleJoinRequest.
    if (event.kind === JOIN_REQUEST_KIND) {
      this.handleJoin(ws, event);
      return;
    }

    // Ownership is checked before id/signature validity, not after.
    // Schnorr verification is the most expensive per-event operation
    // (CLAUDE.md "The budget": "the CPU risk") and a non-owner write is
    // rejected unconditionally regardless of whether it's well-formed --
    // there's no reason to pay for a check whose result can't change the
    // outcome. This also means a non-owner event with a bad id or bad
    // signature still gets "restricted:"/"blocked:", not "invalid:", which
    // is fine: NIP-01 doesn't require checking id/sig before authorization.
    const sql = this.sql;
    const auth = isAllowedWriter(sql, this.env, event.pubkey);
    if (!auth.allowed) {
      ok(ws, event.id, false, writeRejectionMessage(auth.reason));
      return;
    }

    // NIP-29 group writes sit UNDER the gate above rather than beside it:
    // `allowed_pubkeys` and the follow list say whether this pubkey may
    // write to this relay at all, and only then does src/nip29.ts say
    // whether it may write to the group. Three integer comparisons decide
    // that an ordinary event is none of that file's business, so this
    // costs nothing on the path every non-group write takes.
    const groupAuth = authorizeGroupWrite(sql, event, auth.isOwner, nowSeconds());
    if (!groupAuth.ok) {
      ok(ws, event.id, false, groupAuth.message);
      return;
    }

    this.acceptEvent(ws, sql, event, auth.isOwner);
  }

  // NIP-59 (nips/59.md) Gift Wrap accept path -- the one deliberate
  // exception to owner-only writes: any pubkey may write a
  // kind-1059 event as long as it p-tags the owner. CLAUDE.md "Threat
  // model" calls this out as "the only unauthenticated write path in the
  // project" and "the only unbounded write path" -- hence the extra
  // abuse controls below, on top of the general per-connection rate
  // limit already applied to every message in webSocketMessage.
  private handleGiftWrap(ws: WebSocket, event: NostrEvent): void {
    // THE ONE CHECK THAT HAS TO COME FIRST, and not for cost reasons.
    //
    // This path is dispatched ABOVE both write gates, so nothing below it
    // ever consults nip29.ts authorizeGroupWrite -- and storeEvent
    // partitions by groups.ts isGroupEvent, which asks only whether the
    // event is IN THIS RELAY'S OWN group. A kind-1059 carrying an `h` tag
    // naming that group would land in the group partition without any
    // group authorization at all: unauthenticated injection into a
    // private group's feed, delivered to every reader entitled to that
    // partition, bounded by nothing but the gift wrap caps below.
    //
    // Refused rather than partitioned differently, because a gift wrap
    // carrying a group tag is not a thing that means anything. NIP-59
    // addresses a wrap to a recipient by `p` tag and the sender is a
    // throwaway key; a group tag on top of that names a feed the wrap's
    // own recipient rule already contradicts. There is nothing to
    // preserve, so the safe answer and the correct answer are the same --
    // whichever id that group tag names, not only this relay's own, so
    // this is tested with isAnyGroupEvent (groups.ts) rather than
    // isGroupEvent: a foreign id makes just as little sense on a wrap as
    // this relay's own does, and there is no reason to let one through
    // where the other is refused.
    if (isAnyGroupEvent(event)) {
      ok(
        ws,
        event.id,
        false,
        "invalid: a gift wrap is mail addressed to this relay's owner and cannot carry a group tag",
      );
      return;
    }

    const sql = this.sql;
    const owner = getOwnerPubkey(sql, this.env);
    if (owner === null) {
      ok(ws, event.id, false, "restricted: relay has not been claimed yet");
      return;
    }
    if (!pTagValues(event.tags).includes(owner)) {
      ok(ws, event.id, false, "restricted: gift wrap is not addressed to this relay's owner");
      return;
    }

    // No gift-wrap-specific size check here any more: MAX_GIFT_WRAP_BYTES
    // became the general MAX_EVENT_BYTES (limits.ts), enforced for every
    // writer at the top of acceptEvent below. A gift wrap is still size-
    // capped at the same 64KB, just by a cap that no longer has to be
    // kept in agreement with a second one.
    if (this.isGiftWrapRateLimited(getState(ws).ip)) {
      ok(ws, event.id, false, "rate-limited: too many gift wraps from this connection, slow down");
      return;
    }

    if (giftWrapCount(sql) >= maxGiftWraps(this.env)) {
      ok(ws, event.id, false, "blocked: gift wrap inbox storage is full");
      return;
    }

    // A gift wrap is signed by a fresh one-time key (nips/59.md), so it is
    // never the owner in practice -- compared anyway rather than hardcoding
    // false, since the owner p-tagging themselves is a legal event and
    // acceptEvent's exemptions should follow who signed it, not who this
    // path usually is.
    this.acceptEvent(ws, sql, event, event.pubkey === owner);
  }

  // NIP-29 (nips/29.md) join request: "Any user can send a kind 9021
  // event to the relay in order to request admission to the group."
  //
  // The decision itself is nip29.ts handleJoinRequest -- what belongs
  // here is the wire-level work that has to happen before any invite code
  // is looked at, and the ORDER of it is the part that matters.
  private handleJoin(ws: WebSocket, event: NostrEvent): void {
    // Size first, for the reason acceptEvent states about its own copy of
    // this check: it is the only check whose result bounds the cost of
    // the rest, and idMatchesContent below re-serializes and hashes the
    // whole event. A join request never reaches acceptEvent, so it would
    // otherwise be the one unauthenticated write path with no size bound
    // in front of the hash.
    const byteCap = maxEventBytes(this.env);
    if (byteCap !== null && JSON.stringify(event).length > byteCap) {
      ok(ws, event.id, false, `invalid: event exceeds the maximum size of ${byteCap} bytes`);
      return;
    }

    // Ahead of schnorr, because it is what bounds how often schnorr gets
    // paid on behalf of somebody this relay has not authorized -- the
    // same ordering and the same in-memory counter shape handleGiftWrap
    // uses above.
    if (this.isJoinRateLimited(getState(ws).ip)) {
      ok(ws, event.id, false, "rate-limited: too many join requests from this connection, slow down");
      return;
    }

    // AHEAD OF THE INVITE LOOKUP, which inverts this project's
    // cheapest-first convention on purpose. If a bad code were refused
    // before a bad signature, a caller could offer guessed codes under
    // junk signatures and learn which ones are real from which complaint
    // came back -- the signature check would become a free oracle over
    // the relay's live invites. Verifying first costs ~1.1ms of CPU on an
    // unauthenticated request; the throttle above is what bounds how
    // often that bill arrives.
    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }
    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }

    const result = withReadPath("join", () =>
      handleJoinRequest(this.sql, this.env, event, nowSeconds()),
    );
    ok(ws, event.id, result.accepted, result.message);
    // The regenerated member list, if this join changed one. Group state
    // is group state: broadcast() drops it for any socket that is neither
    // the owner nor a member, and it is deliberately not routed through
    // liveBroadcast -- the same handling acceptEvent gives the events
    // applyModeration returns. The pubkey that just joined IS a member by
    // the time this runs, so a client that joined and subscribed sees its
    // own admission land.
    for (const generated of result.generated) {
      this.broadcast(generated);
    }
  }

  // See limits.ts JOIN_REQUEST_RATE_LIMIT_WINDOW_MS/
  // MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW.
  private isJoinRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.joinRateLimits.get(ip);
    if (!entry || now - entry.windowStart >= JOIN_REQUEST_RATE_LIMIT_WINDOW_MS) {
      this.joinRateLimits.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW;
  }

  // See limits.ts GIFT_WRAP_RATE_LIMIT_WINDOW_MS/MAX_GIFT_WRAPS_PER_IP_PER_WINDOW
  // for why this is a separate counter from isRateLimited below.
  private isGiftWrapRateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.giftWrapRateLimits.get(ip);
    if (!entry || now - entry.windowStart >= GIFT_WRAP_RATE_LIMIT_WINDOW_MS) {
      this.giftWrapRateLimits.set(ip, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > MAX_GIFT_WRAPS_PER_IP_PER_WINDOW;
  }

  // See limits.ts MAX_EVENTS_PER_PUBKEY_PER_WINDOW. `max` is passed in
  // rather than read here because it is env-overridable and acceptEvent
  // has already resolved it (and already skipped this call entirely when
  // the cap is disabled).
  private isPubkeyRateLimited(pubkey: string, max: number): boolean {
    const now = Date.now();
    const entry = this.pubkeyRateLimits.get(pubkey);
    if (!entry || now - entry.windowStart >= PUBKEY_RATE_LIMIT_WINDOW_MS) {
      if (this.pubkeyRateLimits.size >= PUBKEY_RATE_LIMIT_MAX_TRACKED) {
        this.prunePubkeyRateLimits(now);
      }
      this.pubkeyRateLimits.set(pubkey, { windowStart: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > max;
  }

  // Keyed by pubkey, this map can be grown by an attacker for free (a
  // gift wrap carries a fresh one-time key every time), unlike the
  // IP-keyed maps above -- so it needs a bound the others don't. Dropping
  // expired windows is enough in every realistic case; clearing outright
  // is the backstop for the one where it isn't, and costs an attacker who
  // reaches it nothing they didn't already have, since a map that has just
  // been filled with 10,000 distinct one-shot keys was not throttling any
  // of them anyway.
  private prunePubkeyRateLimits(now: number): void {
    for (const [pubkey, entry] of this.pubkeyRateLimits) {
      if (now - entry.windowStart >= PUBKEY_RATE_LIMIT_WINDOW_MS) {
        this.pubkeyRateLimits.delete(pubkey);
      }
    }
    if (this.pubkeyRateLimits.size >= PUBKEY_RATE_LIMIT_MAX_TRACKED) {
      this.pubkeyRateLimits.clear();
    }
  }

  // NIP-62 (nips/62.md) Request to Vanish -- deliberately NOT routed
  // through isAllowedWriter. See storage.ts applyVanish's comment for why
  // a vanish request's authority comes from the requester vanishing
  // their own data, not from relay-write permission. Not stored as an
  // events row either way (the spec says relays MAY keep it for
  // bookkeeping, not MUST -- skipped here to avoid paying the row cost
  // for an action, not content).
  private handleVanish(ws: WebSocket, event: NostrEvent): void {
    // Relay-tag match is checked first, cheaply, before paying for a
    // hash or a schnorr verification on a request that isn't even meant
    // for this relay -- same CPU-ordering reasoning as the ownership
    // check in handleEvent above.
    const relayTags = event.tags
      .filter((t) => t[0] === "relay")
      .map((t) => t[1])
      .filter((v): v is string => v !== undefined);
    if (relayTags.length === 0) {
      ok(ws, event.id, false, "invalid: a vanish request must include a relay tag");
      return;
    }
    const { host } = getState(ws);
    const targetsThisRelay = relayTags.some((tag) => tag === "ALL_RELAYS" || relayTagMatchesHost(tag, host));
    if (!targetsThisRelay) {
      ok(ws, event.id, false, "invalid: relay tag does not name this relay");
      return;
    }

    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }
    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }

    // Two reads in front of the write, because everything below this
    // point is reachable by anyone, forever, with no prior relationship
    // with this relay and no gate above it. The dispatch order is
    // correct and cannot change -- NIP-62 binds write-restricted relays
    // to honour a vanish "regardless of the user's status" -- so the
    // available control is not WHETHER to honour the request but whether
    // honouring it has to cost a row.
    //
    // First: is this request already checkpointed? A vanish event is
    // signed, so it is replayable by anyone who has ever seen it. Each
    // replay used to re-run beginVanish and take another drain batch for
    // a request already in progress, which both spent writes and drained
    // faster than the reserved share paces for. A pending request at or
    // wider than this one is already the promise this request is asking
    // for, so the honest answer is the progress report, at one row read.
    const pendingCutoff = pendingVanishCutoff(this.sql, event.pubkey);
    if (pendingCutoff !== null && pendingCutoff >= event.created_at) {
      ok(
        ws,
        event.id,
        true,
        "vanish already accepted and in progress: the rest will be removed on subsequent cron ticks",
      );
      return;
    }

    // Second: is there anything to remove? beginVanish used to be called
    // unconditionally, so a request from a pubkey with nothing stored
    // wrote a checkpoint that the drain immediately deleted again, having
    // removed nothing -- 4 rows written, measured, to record and forget a
    // request about an empty set. See storage.ts hasVanishTargets for the
    // arithmetic against the daily ceiling. A vanish over nothing is
    // complete when it is asked; saying so is a truthful OK, not a
    // refusal, and NIP-62 asks for the events to be gone rather than for
    // the asking to be remembered.
    if (!hasVanishTargets(this.sql, event.pubkey, event.created_at)) {
      ok(ws, event.id, true, "");
      return;
    }

    // Recorded before anything is deleted, then drained one bounded batch
    // at a time -- see storage.ts beginVanish. A vanish is the only
    // request whose size the sender chooses and this relay cannot refuse,
    // so doing all of it inline would let one request run past
    // the daily write budget partway through, leaving the pubkey
    // half-vanished while this OK frame claimed success. "Fully delete"
    // is the spec's requirement; finishing across cron ticks meets it,
    // stopping wherever the ceiling fell does not.
    beginVanish(this.sql, event.pubkey, event.created_at, nowSeconds());
    const progress = drainVanish(this.sql, event.pubkey, VANISH_BATCH_SIZE);

    // The OK message distinguishes finished from in-progress rather than
    // reporting bare success for both. NIP-01 gives no machine-readable
    // prefix for "accepted and still working", and inventing one would be
    // worse than plain words -- but a requester who is told only "true"
    // has no way to tell a completed vanish from one with thousands of
    // events left to drain, and that difference is the entire point of
    // the checkpoint.
    ok(
      ws,
      event.id,
      true,
      progress.done
        ? ""
        : `vanish accepted and in progress: ${progress.deleted} events removed, ` +
          `the rest will be removed on subsequent cron ticks`,
    );
  }

  // Resumes every vanish request that has not finished draining. Called
  // from runCron, after the refreshes: a vanish is the heaviest thing a
  // tick can do, and letting it run first would mean a large drain
  // starved the follow-cache refresh that gates writes.
  //
  // Each pubkey gets one bounded batch per tick rather than one pubkey
  // being drained to completion, so several concurrent vanish requests
  // make progress together instead of the oldest blocking the rest.
  private drainPendingVanishes(sql: SqlStorage): void {
    for (const pending of pendingVanishes(sql)) {
      drainVanish(sql, pending.pubkey, VANISH_BATCH_SIZE);
    }
  }

  // Shared tail of the write path once authorization is settled --
  // id/tombstone/signature/duplicate/expiration checks and storage.
  // Used by both the owner-gated path in handleEvent and handleGiftWrap
  // above, whose authorization is entirely different but converges here.
  private acceptEvent(ws: WebSocket, sql: SqlStorage, event: NostrEvent, isOwner: boolean): void {
    // Size first, ahead of every other check including the integer
    // comparison below. It is the only check whose result bounds the cost
    // of the rest: idMatchesContent re-serializes the whole event and
    // hashes it, and storeEvent writes every byte of it permanently, so a
    // multi-megabyte event that is going to be refused should be refused
    // before anything touches it a second time. Applied to the owner too -- see
    // limits.ts MAX_EVENT_BYTES; a cap the owner can exceed is a cap that
    // does not bound stored bytes.
    const byteCap = maxEventBytes(this.env);
    if (byteCap !== null && JSON.stringify(event).length > byteCap) {
      ok(ws, event.id, false, `invalid: event exceeds the maximum size of ${byteCap} bytes`);
      return;
    }

    // A plain integer comparison -- the cheapest check here after the
    // length above, and still well ahead of id/signature verification, for
    // the same cheapest-check-first reason as the tombstone check below
    // (CLAUDE.md "Conventions", CLAUDE.md "The budget"). See limits.ts
    // MAX_CREATED_AT_FUTURE_SECONDS for why this rejects at all.
    if (isCreatedAtTooFarInFuture(event, nowSeconds())) {
      ok(ws, event.id, false, "invalid: created_at is too far in the future");
      return;
    }

    // Per-pubkey write throttle (limits.ts). Still ahead of every
    // id/tombstone/signature check -- it's a Map lookup, so it is cheaper
    // than the storage read below and far cheaper than schnorr.
    //
    // The owner is exempt -- NOT because ordinary owner traffic cannot
    // cost anything (it can: an unchanged kind-3 republished by a client
    // as a matter of course used to trigger a full follow-cache rebuild,
    // ~3F + 1 rows a touch with no abuse anywhere in it, until
    // ownership.ts refreshFollows started comparing content instead of
    // timestamps), but because the budget this cap protects is the
    // owner's own. CLAUDE.md "Threat model" already draws the line:
    // "Nothing here defends the relay against its own owner, and the
    // storage and rate caps deliberately exempt them." Refusing the
    // owner's events would spend the thing the relay exists for --
    // storing what they publish, a replayed post-offline backlog
    // included, which arrives at exactly the burst rate a cap would
    // refuse -- to conserve a resource that is theirs to spend and whose
    // spend their own admin page already shows (rowsWrittenToday). And
    // the kind-3 lesson says a cap here was never the right tool for
    // that shape anyway: it bounds event FREQUENCY, while the damage was
    // cost PER EVENT -- a few touches a day, far under any plausible
    // rate, at ~1,000 rows each. Costs like that get fixed by making
    // them not scale, not by throttling the principal. Ephemeral
    // kinds are exempt too: this throttle exists to bound rows written
    // (limits.ts MAX_EVENTS_PER_PUBKEY_PER_WINDOW), and storeEvent writes
    // zero rows for an ephemeral event -- there is nothing here for the
    // cap to bound. What an ephemeral event actually costs is a schnorr
    // verify and a broadcast, and the per-IP message throttle
    // (RATE_LIMIT_MAX_MESSAGES) already shapes both of those. Left gated
    // on the cap being enabled at all, so `"off"` still disables every
    // pubkey-keyed check in one place rather than this one silently
    // surviving it.
    const eventCap = maxEventsPerPubkeyPerWindow(this.env);
    if (
      !isOwner &&
      eventCap !== null &&
      !isEphemeralKind(event.kind) &&
      this.isPubkeyRateLimited(event.pubkey, eventCap)
    ) {
      ok(ws, event.id, false, "rate-limited: too many events from this pubkey, slow down");
      return;
    }

    // Storage headroom (limits.ts NON_OWNER_STORAGE_SHARE_LIMIT), non-owner
    // only. Last of the three abuse caps and still ahead of id/signature
    // verification: `databaseSize` is a property read, cheaper than the
    // tombstone query below and far cheaper than schnorr. The owner keeps
    // writing at any size -- reserving the remaining half FOR the owner is
    // the entire point, so applying it to them would invert it.
    const storageLimit = nonOwnerStorageLimit(this.env);
    if (!isOwner && storageLimit !== null && !hasNonOwnerStorageHeadroom(sql, storageLimit)) {
      ok(ws, event.id, false, "blocked: relay storage is full for writers other than the owner");
      return;
    }

    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }

    // Checked before signature verification for the same CPU reason as
    // the ownership check above: a tombstoned id can never legitimately
    // be re-stored (NIP-09/NIP-62 durability -- schema.ts `deleted_ids`),
    // so there's no reason to pay for schnorr before rejecting it. This
    // is what makes gift wrap deletion actually mean something: the
    // sender still holds their own signed copy and can always resend it.
    if (isDeleted(sql, event.id)) {
      ok(ws, event.id, false, "blocked: this event was deleted and cannot be re-published");
      return;
    }

    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }

    if (eventExists(sql, event.id)) {
      ok(ws, event.id, true, "duplicate: already have this event");
      return;
    }

    const expiration = expirationOf(event);
    if (expiration !== null && expiration <= nowSeconds()) {
      ok(ws, event.id, false, "invalid: event already expired");
      return;
    }

    // Wall-clock now, not event.created_at -- see schema.ts's
    // `ingested_at` comment.
    const result = storeEvent(sql, event, nowSeconds());
    if (event.kind === 5 && result.stored) {
      applyDeletion(sql, event);
    }
    // NIP-29 moderation, applied exactly where a kind-5 reaches
    // applyDeletion above and for the same reason: the moderation event is
    // itself part of the group's canonical history, so it is stored first
    // and acted on second. Scoped separately from "write" because the
    // regeneration it triggers is a cost of its own -- reading the relay's
    // three group state events and replacing whichever changed -- and
    // folding it into the per-event write bucket would make every REQ-cost
    // projection over that bucket describe a path most events never take.
    //
    // The events it returns are the relay's OWN, already stored by
    // storeEvent; they are broadcast below beside the client's.
    const generated =
      isSupportedModerationKind(event.kind) && result.stored
        ? withReadPath("groupState", () => applyModeration(sql, this.env, event, nowSeconds()))
        : [];
    ok(ws, event.id, result.ok, result.message);

    if (result.stored) {
      // Refresh the follow cache the instant the owner publishes a new
      // kind-3, rather than waiting up to an hour for the next cron tick
      // (CLAUDE.md "What it is"). Gated on `event.pubkey === owner`,
      // not just `event.kind` -- under ALLOW_FOLLOWS a follow can publish
      // their own kind-3 through this same accept path, and refreshFollows
      // always re-derives from the *owner's* most recent event regardless
      // of whose write triggered the call, so this only costs an extra
      // check, never a wrong overwrite. Still, gating here means a
      // follow's own kind-3 can never even trigger a redundant refresh.
      const owner = getOwnerPubkey(sql, this.env);
      if (event.pubkey === owner && event.kind === CONTACT_LIST_KIND) {
        refreshFollows(sql, this.env);
      }
      this.broadcast(result.stored);
      this.liveBroadcast(result.stored);
    }
    // Group state is group state: broadcast() drops these for any socket
    // that is neither the owner nor a member of the group, and
    // liveBroadcast refuses them outright whoever is listening, both on
    // the strength of groups.ts isGroupEvent -- which now recognises the
    // relay-generated 39000-series by kind. Deliberately not routed
    // through liveBroadcast at all, since it would refuse them anyway and
    // calling it would only invite someone to "fix" that later.
    for (const event of generated) {
      this.broadcast(event);
    }
  }

  // Scoped as one "req" entry per REQ frame (read-metrics.ts). The
  // NIP-42 gift wrap probe inside declares its own scope, so the two
  // report separately: the probe is a cost CLAUDE.md "The budget" already
  // measured and defended, the REQ query itself is one it never did.
  private handleReq(ws: WebSocket, frame: unknown[]): void {
    withReadPath("req", () => this.handleReqInner(ws, frame));
  }

  private handleReqInner(ws: WebSocket, frame: unknown[]): void {
    const subId = frame[1];
    if (typeof subId !== "string") {
      send(ws, ["NOTICE", "error: malformed REQ"]);
      return;
    }

    const state = getState(ws);
    if (!(subId in state.subs) && Object.keys(state.subs).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      send(ws, ["CLOSED", subId, "rate-limited: too many open subscriptions"]);
      return;
    }

    // Filters per frame, bounded before any of them is parsed or priced.
    //
    // limits.ts MAX_FILTER_ROWS_READ caps what ONE filter may read, and
    // nothing capped how many filters a REQ could carry -- so the ceiling
    // that reads like a per-message bound was a per-filter one, and a
    // single message could stack it as many times as fit in a 1MiB frame
    // while the per-IP throttle in this file counted the message once.
    // Measured before this check: a REQ carrying 200 filters was answered
    // with EOSE. See MAX_FILTERS_PER_REQ for why the two caps are stated
    // as a product now.
    //
    // Note this is NOT the same quantity as MAX_SUBSCRIPTIONS_PER_CONNECTION
    // above, which the reuse of an existing subId legitimately skips:
    // NIP-01 says a REQ on a live subscription id replaces its filters
    // (nips/01.md), so a reused id cannot raise the open-subscription
    // count and there is nothing there to close. What one message could
    // make the relay DO was never bounded by that cap in the first place;
    // it is bounded here.
    const rawFilters = frame.slice(2);
    if (rawFilters.length > MAX_FILTERS_PER_REQ) {
      send(ws, [
        "CLOSED",
        subId,
        `invalid: too many filters in one REQ (${rawFilters.length}), at most ${MAX_FILTERS_PER_REQ}`,
      ]);
      return;
    }

    // One pass, not two. The old code clamped the limit and separately
    // asked whether the filter was "unconstrained", and neither step
    // could see the other -- the clamp bounded rows RETURNED and the
    // guard bounded nothing about rows READ. boundFilter (limits.ts)
    // does both against one cost model derived from the index set, so a
    // filter is admitted only at a limit its access path can actually
    // afford.
    // MAX_FILTER_ROWS_READ shared out across this frame's filters, not
    // handed to each of them. It is the number this relay has always
    // claimed for a REQ ("it takes 500 filters at the cap to spend a
    // day's budget"), and applying it per filter is what made the claim
    // false: ten filters each admitted at the cap is ten times the cap.
    //
    // Equal shares rather than a running budget spent in order, so two
    // clients sending the same filters in a different order get the same
    // answer. At the common single-filter REQ the share IS the cap, so
    // nothing about the ordinary case moves.
    const perFilterBudget = Math.floor(MAX_FILTER_ROWS_READ / Math.max(1, rawFilters.length));

    // Who this connection is, resolved once and used by all three read
    // gates below. One owner lookup rather than three, and none at all on
    // the unauthenticated path -- `authedPubkey` is undefined there, so
    // the `&&` short-circuits before the storage read, which is the
    // property the gift wrap gate was rewritten to have and must not lose.
    //
    // THREE permissions, not one, and they are three because the group is
    // no longer a single thing to be let into:
    //
    //   gift wraps   the owner alone. The p-tagged recipient of every wrap
    //                this relay accepts is the owner (handleGiftWrap), so
    //                there is nobody else it could widen to.
    //   the group    the owner OR a member, checked against `group_members`
    //                -- the same inner list nip29.ts authorizeGroupWrite
    //                consults on the write side, so a pubkey admitted to
    //                write to the group is by construction admitted to read
    //                it back. Before this, a member could write and could
    //                not read, which made the group unusable by anyone but
    //                the owner.
    //   invite codes the owner alone, INSIDE a partition members may now
    //                read. A kind-9009 create-invite carries its code in a
    //                `code` tag and an invite code is a bearer token, so a
    //                member who could read one could mint memberships and
    //                owner-only invites would stop being owner-only with no
    //                change to the write path at all. Withheld by omission
    //                rather than refusal -- see groups.ts
    //                CREATE_INVITE_KIND, and filters.ts
    //                FilterQueryOptions.excludeInvites for the SQL.
    //
    // The membership lookup is one indexed row and it is paid only by an
    // authenticated non-owner: the owner short-circuits on the `||`, and
    // an unauthenticated client never reaches either read.
    //
    // broadcast() below enforces all three again, and has to: a
    // subscription registered here is never re-examined, so a permission
    // widened in this function and not in that one silently pushes events
    // to sockets this gate would have refused.
    const authedPubkey = state.authedPubkey;
    const authedAsOwner =
      authedPubkey !== undefined && authedPubkey === getOwnerPubkey(this.sql, this.env);
    const mayReadGiftWraps = authedAsOwner;
    const mayReadInvites = authedAsOwner;
    const mayReadGroups =
      authedAsOwner || (authedPubkey !== undefined && isGroupMember(this.sql, authedPubkey));
    // Which partitions this read covers. Passed into boundFilter because
    // it multiplies the query count -- storage.ts runs the filter once per
    // partition -- so an authorised reader is priced for what it actually
    // costs rather than for half of it.
    const scopes: readonly GroupScope[] = mayReadGroups ? ALL_SCOPES : [PUBLIC_SCOPE];

    const filters: Filter[] = [];
    for (const raw of rawFilters) {
      const filter = parseFilter(raw);
      if (!filter) {
        send(ws, ["CLOSED", subId, "error: malformed filter"]);
        return;
      }
      const bound = boundFilter(filter, perFilterBudget, scopes.length);
      if (!bound.ok) {
        send(ws, ["CLOSED", subId, bound.reason]);
        return;
      }
      filters.push(bound.filter);
    }

    // NIP-42 gate on gift wrap reads (CLAUDE.md "Threat model": "an
    // anonymous query returns every DM envelope the owner has received,
    // leaking volume and timing"), in two halves that answer to two
    // different rules.
    //
    // A filter that NAMES kind 1059 is refused, from `f.kinds` alone,
    // with no storage access at all. Refusing here leaks nothing: the
    // client said what it wanted, and being told it needs to authenticate
    // for it is not information it did not already have.
    //
    // A filter that does not name `kinds` is answered normally with the
    // gift wraps OMITTED (filters.ts excludeGiftWraps). It used to be
    // refused too, on the strength of a storage probe -- re-run the
    // filter restricted to kind 1059, refuse if anything came back -- and
    // that probe made the refusal itself the answer. Measured: an
    // unauthenticated `{"#p":[owner],"since":S,"until":U,"limit":1}`
    // returned `auth-required` when a gift wrap fell inside the window
    // and `EOSE` when none did, so bisecting since/until yielded exact
    // arrival windows and an exact inbox count without the filter ever
    // naming 1059 -- the gate answering the exact question it existed to
    // refuse. Refusal leaks; omission does not, because omission returns
    // the same thing whether or not the inbox holds anything.
    //
    // Deleting the probe also deletes it from the COMMON path: it ran on
    // every REQ that omitted `kinds`, including the owner's own, and
    // measured 141 rows read on a `#p` REQ at limit 20 against a
    // 500-wrap inbox -- scaling with the filter's limit, since the probe
    // had to look as far into the tag index as the REQ itself could.
    //
    // The owner lookup is now inside the authenticated branch, so an
    // unauthenticated REQ -- every public read this relay serves -- pays
    // neither the probe nor the owner's two rows.
    // Group events are gated the same way, and split the same way: a
    // filter that NAMES a group (`{"#h":[...]}`, groups.ts
    // filterNamesGroup) is refused from the filter alone, with no storage
    // access, because the client has already said what it wants and being
    // told to authenticate tells it nothing. A filter that does not name
    // one is answered normally with the group's events omitted -- refusing
    // that would make the refusal itself the answer, which is precisely
    // the leak the gift wrap storage probe turned out to be.
    if (!mayReadGroups && filters.some(filterNamesGroup)) {
      if (state.authedPubkey === undefined) {
        if (!state.challenge) {
          state.challenge = crypto.randomUUID();
          setState(ws, state);
        }
        send(ws, ["AUTH", state.challenge]);
        send(ws, ["CLOSED", subId, "auth-required: authentication required to read group events"]);
      } else {
        send(ws, ["CLOSED", subId, "restricted: not allowed to read group events"]);
      }
      return;
    }
    if (!mayReadGiftWraps && filters.some((f) => f.kinds?.includes(GIFT_WRAP_KIND))) {
      if (state.authedPubkey === undefined) {
        if (!state.challenge) {
          state.challenge = crypto.randomUUID();
          setState(ws, state);
        }
        send(ws, ["AUTH", state.challenge]);
        send(ws, ["CLOSED", subId, "auth-required: authentication required to read gift wraps"]);
      } else {
        send(ws, ["CLOSED", subId, "restricted: not allowed to read gift wraps"]);
      }
      return;
    }

    // Registered only once it is known to fit. Subscriptions live in the
    // WebSocket attachment so they survive hibernation, and that
    // attachment has a hard 16KiB ceiling that serializeAttachment
    // enforces by throwing -- which, for a filter big enough to reach it,
    // meant the query ran, the events were sent, and then the connection
    // took an uncaught exception instead of an EOSE. Every cap in
    // limits.ts admitted `{"authors":[<400 keys>],"kinds":[1]}`, and it
    // serializes to ~26KB.
    //
    // Checked against a copy, so a refusal leaves the connection exactly
    // as it was -- a REQ that cannot be stored must not evict the
    // subscriptions that could.
    const next: ConnState = { ...state, subs: { ...state.subs, [subId]: filters } };
    if (!stateFits(next)) {
      send(ws, [
        "CLOSED",
        subId,
        "invalid: filters are too large to hold open; name fewer authors or ids, " +
          "and split the request across several REQs",
      ]);
      return;
    }
    setState(ws, next);

    // The same rule this stored read applies is applied to the PUSH path
    // by broadcast() below, which drops kind-1059 events for any socket
    // not authenticated as the owner -- a subscription registered here
    // stays open, so the two have to agree.
    const events = queryFilters(this.sql, filters, nowSeconds(), {
      excludeGiftWraps: !mayReadGiftWraps,
      // Only where it can match something, which is a read that covers the
      // group partition at all. An unauthenticated read never sees a
      // kind-9009 -- it is a group event, and the partition already omits
      // it -- so setting this there would add a condition and a bound
      // parameter to every public read on this relay to exclude rows that
      // are not in the partition being read.
      excludeInvites: mayReadGroups && !mayReadInvites,
      scopes,
    }).slice(0, MAX_EVENTS_PER_REQ);
    for (const event of events) {
      send(ws, ["EVENT", subId, event]);
    }
    send(ws, ["EOSE", subId]);
  }

  private handleClose(ws: WebSocket, subId: unknown): void {
    if (typeof subId !== "string") return;
    const state = getState(ws);
    delete state.subs[subId];
    setState(ws, state);
  }

  // NIP-42 (nips/42.md): AUTH MUST be answered with OK. Gift wrap reads
  // (handleReq) are this relay's first auth-gated
  // resource, so this now checks against a challenge actually issued to
  // this connection (state.challenge, set lazily in handleReq) rather
  // than always failing. On success, the authenticated pubkey is stored
  // on the connection for handleReq to check.
  private handleAuth(ws: WebSocket, raw: unknown): void {
    const event = parseEventShape(raw);
    if (!event) {
      send(ws, ["NOTICE", "error: malformed event"]);
      return;
    }
    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }
    if (!verifySignature(event)) {
      ok(ws, event.id, false, "invalid: signature verification failed");
      return;
    }
    if (event.kind !== AUTH_KIND) {
      ok(ws, event.id, false, `invalid: kind must be ${AUTH_KIND}`);
      return;
    }
    if (Math.abs(nowSeconds() - event.created_at) > AUTH_MAX_DRIFT_SECONDS) {
      ok(ws, event.id, false, "invalid: created_at is too far from now");
      return;
    }
    const state = getState(ws);
    const challenge = event.tags.find((t) => t[0] === "challenge")?.[1];
    if (!challenge || !state.challenge || challenge !== state.challenge) {
      ok(ws, event.id, false, "invalid: no matching challenge was issued");
      return;
    }
    // NIP-42 "Signed Event Verification": "that the relay tag matches
    // the relay URL." Without this, an AUTH event signed for a
    // *different* relay's challenge-less flow could be replayed here to
    // claim the owner's identity.
    const relayTag = event.tags.find((t) => t[0] === "relay")?.[1];
    if (!relayTag || !relayTagMatchesHost(relayTag, state.host)) {
      ok(ws, event.id, false, "invalid: relay tag does not match this relay");
      return;
    }
    state.authedPubkey = event.pubkey;
    setState(ws, state);
    ok(ws, event.id, true, "");
  }

  private broadcast(event: NostrEvent): void {
    // The gate in handleReqInner decides a REQ once, when the REQ arrives,
    // and nothing re-examines the subscription it leaves open. So it
    // proves nothing about events stored afterwards, and this path has to
    // enforce every one of its rules itself.
    //
    // Both gated kinds show the shape. `{"#p":[owner]}` registered while
    // the inbox is empty is admitted with nothing to withhold, and every
    // gift wrap accepted afterwards necessarily p-tags the owner
    // (handleGiftWrap), so it matches. `{"kinds":[1]}` from an
    // unauthenticated client is a standing request that matches the
    // group's kind-1 events as they are stored. Without the check below,
    // each of those sockets receives what its REQ was never allowed to
    // ask for. Owner looked up only on a gated kind, so the common path
    // stays free of the extra read.
    //
    // The same three permissions handleReqInner resolves, enforced again
    // here because this path never consults that one. The two must agree
    // exactly: a permission widened there and not here refuses a stored
    // read and then pushes the same event down the same socket seconds
    // later, and one widened here and not there does the reverse.
    //
    //   gift wrap    owner only.
    //   kind-9009    owner only, even though the group around it is not.
    //                A create-invite reaches this line the moment the
    //                owner publishes one, so a member holding
    //                `{"kinds":[9009]}` would be handed a live code with
    //                no REQ ever sent -- the surface a REQ-time gate
    //                cannot cover, which is the whole reason this
    //                function has a copy of the rule.
    //   other group  owner or member, against the same `group_members`
    //                list the REQ gate and the write gate both use.
    //
    // Memoised per broadcast rather than per socket: a member with three
    // open connections is one lookup, not three, and a broadcast to
    // sockets that are all the owner's or all unauthenticated does none.
    const giftWrap = event.kind === GIFT_WRAP_KIND;
    const gated = giftWrap || isGroupEvent(event);
    const ownerOnly = giftWrap || event.kind === CREATE_INVITE_KIND;
    const owner = gated ? getOwnerPubkey(this.sql, this.env) : null;
    const membership = new Map<string, boolean>();
    const mayReceive = (authed: string | undefined): boolean => {
      if (authed === undefined) return false;
      if (owner !== null && authed === owner) return true;
      if (ownerOnly) return false;
      let member = membership.get(authed);
      if (member === undefined) {
        member = isGroupMember(this.sql, authed);
        membership.set(authed, member);
      }
      return member;
    };
    for (const ws of this.ctx.getWebSockets()) {
      // ctx.getWebSockets() with no tag argument returns every socket,
      // live feed ones included -- those carry a LiveFeedState
      // attachment (connectedAt only, no `subs`), not a ConnState, so
      // they're routed to liveBroadcast instead, never here.
      if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) continue;
      const state = getState(ws);
      if (gated && !mayReceive(state.authedPubkey)) continue;
      for (const [subId, filters] of Object.entries(state.subs)) {
        if (matchesAnyFilter(event, filters)) {
          send(ws, ["EVENT", subId, event]);
        }
      }
    }
  }

  // Pushes a redacted notice of a newly stored event to every open live
  // feed connection. Gift wraps are never sent here,
  // full stop, regardless of who is connected -- the admin page has no
  // way to authenticate (CLAUDE.md "What it is" is static, unsigned), so
  // every live feed viewer is permanently the unauthenticated case NIP-42
  // gates gift wrap reads against elsewhere (handleReq above). Only
  // kind/time/a truncated id go out, never tags or content, so even a
  // non-gift-wrap DM-adjacent event (e.g. a kind-1 reply quoting
  // something sensitive) doesn't leak its body to whoever has the admin
  // page open.
  private liveBroadcast(event: NostrEvent): void {
    // Group events never reach the live feed, on the same terms as gift
    // wraps and for the same reason: this channel has no authentication
    // at all (the admin page is static and unsigned), so every viewer is
    // permanently the unauthenticated case. Even the redacted notice this
    // sends -- kind, time, eight hex characters of id -- would time every
    // message in the group to the second for anyone who opened the page.
    //
    // This is what MIRRORING the owner-or-member widening looks like on a
    // channel with no identity in it: nothing changes. A live feed socket
    // cannot be a member, because it cannot be anybody -- there is no
    // AUTH on this path and no ConnState to hold an authenticated pubkey
    // -- so the widened rule evaluates to the refusal that was already
    // here. Stated rather than left implicit, so a later reading of
    // "members may now read the group" does not arrive at this function
    // and take the absence of a member case for an oversight.
    if (event.kind === GIFT_WRAP_KIND || isGroupEvent(event)) return;
    const live = this.ctx.getWebSockets(LIVE_FEED_TAG);
    if (live.length === 0) return;
    const notice = JSON.stringify({ kind: event.kind, created_at: event.created_at, id: event.id.slice(0, 8) });
    for (const ws of live) {
      ws.send(notice);
    }
  }

  // Ensures a DO alarm is scheduled no later than this connection's own
  // expiry: live feed sockets are closed after a fixed duration
  // regardless of client behavior. Alarms -- unlike a JS
  // timer -- are hibernation-compatible: the platform wakes the object
  // at the scheduled time even if it evicted in the meantime, runs
  // alarm() below, and lets it hibernate again afterward, so this never
  // pins the object in memory the way an open outbound connection or an
  // in-process setTimeout would (CLAUDE.md "The budget"). Only schedules
  // when the existing alarm (if any) is later than this connection's own
  // expiry -- an earlier live feed connection's alarm already fires
  // first and, in alarm() below, reschedules for whatever's next, so a
  // busier admin page (several tabs/reconnects) doesn't multiply
  // `setAlarm` calls (each one is a row write, CLAUDE.md: "setAlarm()
  // counts as a write").
  private async scheduleLiveFeedAlarm(): Promise<void> {
    const desired = Date.now() + LIVE_FEED_MAX_LIFETIME_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > desired) {
      await this.ctx.storage.setAlarm(desired);
    }
  }

  // DO alarm handler -- closes any live feed connection past its max
  // lifetime and reschedules for whichever remaining connection expires
  // next, if any. `ws.close()` here is the same hibernation-compatible
  // API the client-initiated paths use (webSocketClose below just
  // mirrors it back); calling it from inside an alarm invocation, which
  // is itself a brief, billed wake rather than a standing timer, is what
  // keeps this from pinning the object -- see scheduleLiveFeedAlarm's
  // comment above.
  override async alarm(): Promise<void> {
    return this.metered(() => this.alarmInner());
  }

  private async alarmInner(): Promise<void> {
    const now = Date.now();
    let nextExpiry: number | null = null;
    for (const ws of this.ctx.getWebSockets(LIVE_FEED_TAG)) {
      const expiresAt = getLiveFeedState(ws).connectedAt + LIVE_FEED_MAX_LIFETIME_MS;
      if (expiresAt <= now) {
        ws.close(1000, "live feed connection lifetime exceeded, reconnect");
      } else if (nextExpiry === null || expiresAt < nextExpiry) {
        nextExpiry = expiresAt;
      }
    }
    if (nextExpiry !== null) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // RFC 6455 section 7.4.1 reserves 1005, 1006 and 1015: they exist to
    // DESCRIBE how a connection ended and "MUST NOT be set as a status
    // code in a Close frame by an endpoint." The runtime hands them to
    // this method for exactly that descriptive purpose -- 1005 when the
    // peer closed with no status, 1006 when it vanished without a close
    // frame at all (a dropped connection, a killed tab, a phone leaving
    // coverage), 1015 for a TLS failure -- so mirroring the code straight
    // back threw `Invalid WebSocket close code` on every abnormal
    // disconnect, which on a WebSocket relay is routine rather than
    // exceptional. Mapped to 1000 (normal closure): this side is closing
    // deliberately and cleanly in response, whatever happened to the peer.
    ws.close(RESERVED_CLOSE_CODES.has(code) ? NORMAL_CLOSURE : code, reason);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }
}
