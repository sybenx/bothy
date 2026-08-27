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
  boundFilter,
  GIFT_WRAP_RATE_LIMIT_WINDOW_MS,
  LIVE_FEED_MAX_LIFETIME_MS,
  MAX_EVENTS_PER_REQ,
  maxEventBytes,
  maxEventsPerPubkeyPerWindow,
  MAX_GIFT_WRAPS,
  MAX_GIFT_WRAPS_PER_IP_PER_WINDOW,
  MAX_LIVE_FEED_CONNECTIONS,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  VANISH_BATCH_SIZE,
  nonOwnerStorageLimit,
  PUBKEY_RATE_LIMIT_MAX_TRACKED,
  PUBKEY_RATE_LIMIT_WINDOW_MS,
  STATS_SNAPSHOT_MAX_AGE_MS,
} from "./limits";
import { handleManagementCall, type ManagementResponse } from "./nip86";
import { resolveIcon, resolveName, type OwnerProfile } from "./nip11";
import { version } from "../package.json";
import {
  type Filter,
  GIFT_WRAP_KIND,
  type NostrEvent,
  pTagValues,
  tagFilterEntries,
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
import { instrumentSql, readMetricsSnapshot, type ReadMetricsSnapshot, withReadPath } from "./read-metrics";
import { initSchema } from "./schema";
import {
  applyDeletion,
  beginVanish,
  computeStatsSnapshot,
  drainVanish,
  pendingVanishes,
  readStatsSnapshot,
  type StatsSnapshot,
  writeStatsSnapshot,
  estimateRowsWritten24h,
  eventExists,
  expirationOf,
  getRelaySettings,
  countIngested24h,
  giftWrapCount,
  hasNonOwnerStorageHeadroom,
  isDeleted,
  isIpBlocked,
  queryFilter,
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
  // row (ownership.ts).
  async claim(
    rawPubkey: unknown,
    profile?: Profile,
    host?: string,
  ): Promise<{ status: "claimed" | "conflict" | "disabled" | "invalid"; pubkey?: string }> {
    if (this.env.OWNER_PUBKEY) return { status: "disabled" };
    if (typeof rawPubkey !== "string") return { status: "invalid" };
    const pubkey = normalizePubkey(rawPubkey);
    if (!pubkey) return { status: "invalid" };

    return withReadPath("identity", () => {
      const sql = this.sql;
      if (host) recordHost(sql, host);
      if (!claimOwner(sql, pubkey, profile)) return { status: "conflict" as const };
      return { status: "claimed" as const, pubkey };
    });
  }

  // Backs the NIP-11 document's name/icon (src/nip11.ts) -- derived from
  // the owner's kind 0 at claim time rather than a deploy-time var, see
  // Null when unclaimed, when OWNER_PUBKEY skips storage entirely, or
  // when the claim-time profile lookup failed; the
  // caller (nip11.ts) falls back to hardcoded defaults in all those cases.
  async getIdentity(
    host?: string,
  ): Promise<{ profile: OwnerProfile; settings: RelaySettings; ownerPubkey: string | null }> {
    return withReadPath("identity", () => {
      const sql = this.sql;
      if (host) recordHost(sql, host);
      // The owner pubkey rides along rather than costing a second RPC:
      // NIP-11 now publishes it (nip11.ts), and getOwnerPubkey is an
      // env read plus at most one indexed row.
      return {
        profile: getOwnerProfile(sql, this.env),
        settings: getRelaySettings(sql),
        ownerPubkey: getOwnerPubkey(sql, this.env),
      };
    });
  }

  // The owner pubkey on its own, for the Worker's NIP-98 check
  // (src/nip98.ts) -- the signature has to be verified against something
  // before any management call is allowed near storage, and verification
  // deliberately happens in the Worker. Null when unclaimed, which
  // verifyNip98 turns into a 401.
  async getOwner(): Promise<string | null> {
    return withReadPath("identity", () => getOwnerPubkey(this.sql, this.env));
  }

  // NIP-86 relay management (src/nip86.ts), write side. Reached only
  // after the Worker has verified a NIP-98 event signed by the owner --
  // this method performs no authentication of its own and must never be
  // called from anywhere that hasn't done that check. Storage mutations
  // live here rather than in the Worker for the same reason claim() and
  // ingestBackfillPage() do: the Durable Object owns every write, and it
  // opens no outbound connection to serve one.
  async manage(method: unknown, params: unknown[], callerIp: string): Promise<ManagementResponse> {
    return withReadPath("management", () =>
      handleManagementCall(this.sql, this.env, method, params, callerIp, nowSeconds()),
    );
  }

  // Backs GET /api/stats (src/index.ts) -- see CLAUDE.md "What it is".
  async getStats(host?: string): Promise<{
    version: string;
    claimed: boolean;
    ownerPubkey: string | null;
    totalEvents: number;
    // Events whose own created_at falls in the last 24h -- what the owner
    // has been posting lately. NOT what this relay took in: a backfilled
    // event is years old by created_at and lands here as zero. See
    // ingested24h below, which is the other half of that sentence.
    events24h: number;
    // When `totalEvents`, `events24h`, `followCount`,
    // `followsRefreshedAt` and `largestNonOwnerAuthor` were computed
    // (unix seconds). Those five come from the `stats_snapshot` row and
    // are up to limits.ts STATS_SNAPSHOT_MAX_AGE_MS old; every other
    // field here is read live. Reported so a consumer can tell the two
    // apart instead of assuming the whole document describes one instant.
    snapshotAt: number;
    // Events this relay actually wrote in the last 24h, backfill
    // included (storage.ts countIngested24h). Live, not snapshotted.
    ingested24h: number;
    storageBytes: number;
    rowsWrittenEstimate24h: number;
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
    followCount: number;
    followsRefreshedAt: number | null;
    // The largest number of stored events held by one non-owner pubkey,
    // and NIP-62 vanish requests still draining. Both are here for the
    // same reason: a vanish removes every event its sender authored, the
    // relay cannot refuse one, and the cost scales with how many that is
    // -- so this is the worst case the deployment is actually exposed to,
    // reported rather than assumed. See storage.ts largestNonOwnerAuthor
    // and the comment on deleteEventRow.
    largestNonOwnerAuthor: { pubkey: string; events: number } | null;
    vanishing: { pubkey: string; deletedSoFar: number; requestedAt: number }[];
    // DIAGNOSTIC, and expected to be removed with src/read-metrics.ts.
    // Rows read attributed to the code path that caused them, since the
    // relay's last outage was the 5,000,000 rows-read/day ceiling and
    // nothing here could say which path spent it. In-memory counters,
    // so this describes `reads.sinceMs` of uptime, NOT a day -- read it
    // for proportions, and read `projected24h` as an extrapolation of
    // exactly that sample, not as a measurement.
    reads: ReadMetricsSnapshot;
  }> {
    // Scoped to "getStats" rather than measured per query: the nested
    // estimateRowsWritten24h declares its own scope and so reports
    // separately -- it was for a long time the most expensive call in
    // here, and keeping it separately billed is how that stays visible.
    const stats = withReadPath("getStats", () => this.collectStats(host));
    // Snapshotted after the scope closes so this call's own reads are
    // included in what it reports -- a breakdown that excluded the
    // request producing it would understate getStats by exactly one call.
    return { ...stats, reads: readMetricsSnapshot() };
  }

  private collectStats(host?: string): Omit<Awaited<ReturnType<Relay["getStats"]>>, "reads"> {
    // recordHost is a write, and it is a no-op once the host is already
    // known (src/host.ts), so it costs nothing to keep honest.
    if (host) recordHost(this.sql, host);

    const sql = this.sql;
    const owner = getOwnerPubkey(sql, this.env);
    const since = nowSeconds() - 86400;

    // The expensive half, read back from `stats_snapshot` rather than
    // recomputed. Recomputed here only when the cron tick has not done it
    // -- a relay deployed minutes ago, or one whose cron has not fired
    // since the snapshot aged out. See limits.ts STATS_SNAPSHOT_MAX_AGE_MS
    // for why the bound is where it is, and schema.ts `stats_snapshot`
    // for why this lives in a row rather than in memory.
    const snapshot = this.refreshStatsSnapshot(owner);

    const profile = getOwnerProfile(sql, this.env);
    const settings = getRelaySettings(sql);

    return {
      version,
      claimed: owner !== null,
      ownerPubkey: owner,
      totalEvents: snapshot.totalEvents,
      events24h: snapshot.events24h,
      // When the counts above were taken. They are up to
      // STATS_SNAPSHOT_MAX_AGE_MS old and the fields beside them are
      // current, so the age is reported rather than left to be assumed --
      // the admin page shows it next to the total.
      snapshotAt: snapshot.computedAt,
      // Live, and cheap enough to stay that way: `ingested_at` is indexed
      // as of v0.7.6 (schema.ts idx_events_ingested), so both of these
      // read the 24h window rather than the table. They are also the two
      // numbers most worth being current -- the second is the write-budget
      // meter.
      ingested24h: countIngested24h(sql, since),
      storageBytes: sql.databaseSize,
      rowsWrittenEstimate24h: estimateRowsWritten24h(sql, since),
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
      followCount: snapshot.followCount,
      followsRefreshedAt: snapshot.followsRefreshedAt,
      largestNonOwnerAuthor: snapshot.largestNonOwnerAuthor,
      vanishing: pendingVanishes(sql),
    };
  }

  // Returns a snapshot no older than STATS_SNAPSHOT_MAX_AGE_MS,
  // recomputing and storing one if what is there is older than that or
  // absent.
  //
  // Both callers go through here, and that is what makes the bound real:
  // the cron tick refreshes a stale snapshot so page loads normally find
  // a fresh one, and a page load refreshes a stale snapshot so a relay
  // whose cron has not fired yet still shows real numbers. Neither can
  // recompute more often than the constant allows, however often it is
  // called -- unlike the in-memory cache this replaced, whose
  // recomputation rate was set by the page-load rate, because the object
  // hibernated between loads and lost the cache every time.
  //
  // No `force`. Nothing should be able to ask for a recomputation outside
  // the gate: a bypass would be a way to spend 3E rows read per call, and
  // the reason this exists is that something already could.
  private refreshStatsSnapshot(owner: string | null): StatsSnapshot {
    const sql = this.sql;
    const existing = readStatsSnapshot(sql);
    const nowSec = nowSeconds();
    if (existing !== null && (nowSec - existing.computedAt) * 1000 < STATS_SNAPSHOT_MAX_AGE_MS) {
      return existing;
    }
    const fresh = computeStatsSnapshot(sql, owner, nowSec);
    writeStatsSnapshot(sql, fresh);
    return fresh;
  }

  // Cron entry point (src/index.ts scheduled()) -- refreshes the
  // ALLOW_FOLLOWS cache and, at most once/day, the cached NIP-11/favicon
  // icon from the owner's locally-stored kind-0 (ownership.ts
  // refreshProfile). Both are no-ops on their common paths (feature off;
  // empty list; already refreshed today), so this stays cheap on most
  // ticks.
  async runCron(): Promise<void> {
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
        refreshFollows(sql, this.env, now);
        refreshProfile(sql, this.env, now);
      // One-time correction for relays the pre-fix short-page exhaustion
      // heuristic wrongly retired -- see backfill.ts resetWronglyExhaustedRelays.
        resetWronglyExhaustedRelays(sql);
      // Runs AFTER the reset, deliberately: the reset clears every
      // exhausted flag including this relay's own row, so purging has to
      // be what happens last or backfill would spend the next tick
      // fetching its own history from itself. See purgeSelfRelay.
        purgeSelfRelay(sql);
        // Refreshed here so an admin page load normally finds a snapshot
        // already computed and pays nothing for it. Gated by
        // STATS_SNAPSHOT_MAX_AGE_MS rather than run on every tick: the
        // computation is ~3E rows read (storage.ts computeStatsSnapshot),
        // and doing it hourly would have cost 72E rows/day with nobody
        // watching -- more than the 48E cron floor this release removed
        // by indexing `ingested_at`. Same shape as refreshProfile above,
        // which is likewise gated below the cron's own frequency.
        //
        // Before the vanish drain, deliberately: the drain is the step
        // that can consume the tick's budget, and a stale stats page is a
        // better failure than a stalled vanish.
        this.refreshStatsSnapshot(getOwnerPubkey(sql, this.env));
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
    return withReadPath("backfillState", () => {
      const sql = this.sql;
      const owner = getOwnerPubkey(sql, this.env);
      if (owner === null) return null;
      const now = nowSeconds();
      return { ...getBackfillStatus(sql), ownerPubkey: owner, canIngestNow: hasBackfillHeadroom(sql, now) };
    });
  }

  // Seeds backfill_relays from the owner's kind-10002 write relays, once
  // the Worker has resolved them from well-known relays (backfill-worker.ts
  // discoverWriteRelays). A pure write, no outbound connection here.
  async discoverBackfillRelays(relayUrls: string[]): Promise<void> {
    withReadPath("backfillIngest", () => seedBackfillRelays(this.sql, relayUrls, nowSeconds()));
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
    return withReadPath("backfillIngest", () => {
      const sql = this.sql;
      const owner = getOwnerPubkey(sql, this.env);
      if (owner === null) return null;
      return applyBackfillPage(sql, owner, relayUrl, rawEvents, eose, nowSeconds(), refusals);
    });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    // The live feed (LIVE_FEED_TAG) is push-only and never has an
    // attachment set (setState is never called for it in fetch()) --
    // nothing it could legitimately send needs NIP-01 handling, so it's
    // routed away before frame parsing rather than falling through to
    // "unknown message type" against state meant for real relay clients.
    if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) return;

    if (this.isRateLimited(ws)) {
      send(ws, ["NOTICE", "rate-limited: slow down"]);
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

    if (giftWrapCount(sql) >= MAX_GIFT_WRAPS) {
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

    // Recorded before anything is deleted, then drained one bounded batch
    // at a time -- see storage.ts beginVanish. A vanish is the only
    // request whose size the sender chooses and this relay cannot refuse
    // (NIP-62 binds write-restricted relays "regardless of the user's
    // status"), so doing all of it inline would let one request run past
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
    // than the storage read below and far cheaper than schnorr. The owner
    // is exempt: they cannot meaningfully abuse their own relay, and a
    // client replaying a backlog after being offline is a normal thing for
    // an owner to do and an abnormal thing for a follow to do.
    const eventCap = maxEventsPerPubkeyPerWindow(this.env);
    if (!isOwner && eventCap !== null && this.isPubkeyRateLimited(event.pubkey, eventCap)) {
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
        refreshFollows(sql, this.env, nowSeconds());
      }
      this.broadcast(result.stored);
      this.liveBroadcast(result.stored);
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

    // One pass, not two. The old code clamped the limit and separately
    // asked whether the filter was "unconstrained", and neither step
    // could see the other -- the clamp bounded rows RETURNED and the
    // guard bounded nothing about rows READ. boundFilter (limits.ts)
    // does both against one cost model derived from the index set, so a
    // filter is admitted only at a limit its access path can actually
    // afford.
    const filters: Filter[] = [];
    for (const raw of frame.slice(2)) {
      const filter = parseFilter(raw);
      if (!filter) {
        send(ws, ["CLOSED", subId, "error: malformed filter"]);
        return;
      }
      const bound = boundFilter(filter);
      if (!bound.ok) {
        send(ws, ["CLOSED", subId, bound.reason]);
        return;
      }
      filters.push(bound.filter);
    }

    // NIP-42 gate on gift wrap reads (CLAUDE.md
    // "Threat model": "an anonymous query returns every DM envelope the
    // owner has received, leaking volume and timing"). Rather than
    // guessing which filter shapes (kinds/authors/ids/tags, in whatever
    // combination) could surface a kind-1059 row, ask storage directly:
    // re-run the filter restricted to kind 1059 and see if anything comes
    // back. An earlier version of this gate tried to reason about it
    // instead ("ids/authors alone can't leak, since a gift wrap's id/
    // pubkey is unguessable without already possessing it") and missed
    // that an ids-only filter naming a real, already-known gift wrap id
    // sailed straight through ungated -- true that nothing *new* leaks to
    // someone who already has the event, but that's not the rule this
    // relay promises: gift wraps go only to the authenticated p-tagged
    // recipient, with no exception for "unless you already know the id"
    // (CLAUDE.md "What it is").
    // Reusing the real query engine here means the gate can't drift out
    // of sync with whatever storage.ts actually considers a match, the
    // way the hand-rolled version did.
    //
    // The AUTH check comes FIRST, and the probe only runs when it can
    // still change the outcome. The owner is allowed to read gift wraps,
    // so for them the probe decides nothing and is pure rows read on
    // every REQ they send; a filter naming kind 1059 outright is refused
    // without touching storage at all.
    const owner = getOwnerPubkey(this.sql, this.env);
    if (state.authedPubkey !== owner && this.requestsGiftWraps(filters, owner)) {
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

    state.subs[subId] = filters;
    setState(ws, state);

    const events = queryFilters(this.sql, filters, nowSeconds()).slice(0, MAX_EVENTS_PER_REQ);
    for (const event of events) {
      send(ws, ["EVENT", subId, event]);
    }
    send(ws, ["EOSE", subId]);
  }

  // Whether any filter in this REQ could surface a kind-1059 event.
  // Answered from `kinds` alone where that settles it, and otherwise by
  // re-running the filter against real storage restricted to gift wraps
  // -- see the gate in handleReqInner for why the question is asked of
  // storage rather than of the filter's shape.
  //
  // The probe's `limit` is the filter's own whenever the filter carries a
  // tag condition, and 1 otherwise, and the difference is load-bearing
  // rather than a tuning choice. filters.ts bounds a tag subquery to
  // tagScanLimit(limit) rows, so how far a filter can reach into the tag
  // index depends on its limit: probing `{"#p":[owner]}` at limit 1 would
  // look at five tag rows and clear a REQ that goes on to read a hundred,
  // and a gift wrap sitting anywhere past the fifth would be handed to an
  // unauthenticated client. Probing at the same limit looks at exactly
  // the rows the REQ itself can return. Every other filter shape is
  // complete at any limit -- existence does not depend on it -- so 1 is
  // still enough there, and the common kinds-less REQ keeps paying three
  // rows for its gate.
  private requestsGiftWraps(filters: Filter[], owner: string | null): boolean {
    return filters.some((f) => {
      if (f.kinds !== undefined) return f.kinds.includes(GIFT_WRAP_KIND);
      if (owner === null) return false;
      const limit = tagFilterEntries(f).length > 0 ? (f.limit ?? 1) : 1;
      return withReadPath(
        "giftWrapGate",
        () =>
          queryFilter(this.sql, { ...f, kinds: [GIFT_WRAP_KIND], limit }, nowSeconds()).length > 0,
      );
    });
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
    // The NIP-42 gate in handleReq proves nothing about *future* events:
    // it probes storage at REQ time, so a filter that matches no stored
    // gift wrap when registered (most simply, a `#p` filter naming the
    // owner while the inbox is empty) is accepted ungated -- and every
    // gift wrap accepted afterward necessarily p-tags the owner
    // (handleGiftWrap), so it matches. This push path must therefore
    // enforce the same authenticated-recipient rule itself, exactly as
    // liveBroadcast below already refuses kind 1059 for its permanently
    // unauthenticated channel. Owner looked up only on the gated kind so
    // the common path stays free of the extra read.
    const gated = event.kind === GIFT_WRAP_KIND;
    const owner = gated ? getOwnerPubkey(this.sql, this.env) : null;
    for (const ws of this.ctx.getWebSockets()) {
      // ctx.getWebSockets() with no tag argument returns every socket,
      // live feed ones included -- those carry a LiveFeedState
      // attachment (connectedAt only, no `subs`), not a ConnState, so
      // they're routed to liveBroadcast instead, never here.
      if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) continue;
      const state = getState(ws);
      // Same condition handleReq's gate enforces for stored reads:
      // kind-1059 events go only to the connection authenticated as the
      // owner (the p-tagged recipient, per handleGiftWrap's accept rule).
      if (gated && state.authedPubkey !== owner) continue;
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
    if (event.kind === GIFT_WRAP_KIND) return;
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
