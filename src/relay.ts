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
import {
  groupIdOf,
  ALL_SCOPES,
  CREATE_INVITE_KIND,
  filterNamesGroup,
  type GroupScope,
  isAnyGroupEvent,
  isGroupEvent,
  PUBLIC_SCOPE,
} from "./groups";
import {
  MAX_SCOPED_GROUPS,
  boundFilter,
  MAX_PUSHES_PER_TICK,
  MAX_WRAP_RECIPIENTS_CHECKED,
  MEMBER_REMOVAL_GRACE_SECONDS,
  FORMER_MEMBER_SWEEP_PUBKEYS,
  FORMER_MEMBER_SWEEP_BATCH_SIZE,
  MAX_PUSH_ENDPOINTS_PER_NOTIFICATION,
  PRESENCE_MAX_TRACKED,
  PRESENCE_STALE_SECONDS,
  PRESENCE_WRITE_INTERVAL_SECONDS,
  PUSH_ALARM_DELAY_MS,
  PUSH_LAST_OK_INTERVAL_SECONDS,
  DAILY_ROWS_READ_LIMIT,
  DAILY_ROWS_WRITTEN_LIMIT,
  GIFT_WRAP_RATE_LIMIT_WINDOW_MS,
  GIFT_WRAP_SWEEP_BATCH_SIZE,
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
  MAX_MENTION_EVENT_INDEXED_TAGS,
  MAX_SUBSCRIPTIONS_PER_CONNECTION,
  VANISH_BATCH_SIZE,
  CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS,
  CHAT_SWEEP_BATCH_SIZE,
  chatMode,
  type ChatMode,
  groupsEnabled,
  MIN_ROOM_OCCUPANTS,
  nonOwnerStorageLimit,
  PUBKEY_RATE_LIMIT_MAX_TRACKED,
  PUBKEY_RATE_LIMIT_WINDOW_MS,
  STORAGE_BYTES_LIMIT,
  utcDayStartSeconds,
} from "./limits";
import {
  applyModeration,
  authorizeGroupWrite,
  GROUPS_PAUSED_MESSAGE,
  handleJoinRequest,
  isSupportedModerationKind,
  JOIN_REQUEST_KIND,
} from "./nip29";
import { handleManagementCall, type ManagementResponse } from "./nip86";
import { resolveIcon, resolveName, type OwnerProfile } from "./nip11";
import {
  CALL_PRESENCE_KIND,
  GROUP_CHAT_KIND,
  type PushPayload,
  type PushReason,
  pushConfigured,
  pushSubject,
  sendPush,
  vapidKeys,
} from "./push";
import { getOwnHost, recordHost } from "./host";
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
  type ClaimStatus,
  CONTACT_LIST_KIND,
  claimOwner,
  clearClaimNonces,
  claimWithNonce,
  getClaimStatus,
  getOwnerPubkey,
  getOwnerProfile,
  isAllowedWriter,
  issueClaimNonce,
  ownerListsThisRelay,
  refreshFollows,
  refreshProfile,
  type WriteRejection,
} from "./ownership";
import { authChallenge, checkAuthFreshness, checkAuthRelayTag, relayTagMatchesHost } from "./nip42";
import { admitsAtLeast, resolveWritePolicy, type ResolvedWritePolicy, type WritePolicy } from "./write-policy";
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
import { connMetricsSnapshot, noteClose, noteRefusal, type ConnMetricsSnapshot } from "./conn-metrics";
import { reqCacheSnapshot, type ReqCacheSnapshot } from "./req-cache";
import { initSchema } from "./schema";
import {
  groupHost,
  advancePush,
  applyDeletion,
  beginVanish,
  chatHorizon,
  clearPresence,
  clearPush,
  forgetPushEndpoint,
  lastPresenceAt,
  markPushEndpointOk,
  pendingPushes,
  type PushFanoutRow,
  pushSubscriptionsAfter,
  queuePush,
  noteRoomOccupied,
  readChatState,
  recordPresence,
  sweepChat,
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
  migrateToMultiGroup,
  getRelaySettings,
  getStoredWritePolicy,
  giftWrapCount,
  sweepExpiredGiftWraps,
  hasNonOwnerStorageHeadroom,
  isDeleted,
  isGroupMember,
  isMember,
  listMemberGroups,
  clearInboxPush,
  hasPushSubscription,
  memberCount,
  pendingInboxPushes,
  pushSubscriptionsFor,
  queueInboxPush,
  sweepFormerMembers,
  isIpBlocked,
  queryFilters,
  type RelaySettings,
  storeEvent,
} from "./storage";
import { idMatchesContent, isCreatedAtTooFarInFuture, parseEventShape, verifySignature } from "./validate";

// Answers a client "ping" with "pong" inside the runtime, without waking
// this object or billing DO duration.
const PING_PONG = new WebSocketRequestResponsePair("ping", "pong");

// Marks a socket as the admin page's /live feed rather than a nostr
// client. Using acceptWebSocket's own tags lets the code find these with
// ctx.getWebSockets(LIVE_FEED_TAG), with no memory-only registry to
// rebuild after hibernation.
const LIVE_FEED_TAG = "live-feed";

// A live feed socket's attachment: only the connect time, which alarm()
// uses to enforce LIVE_FEED_MAX_LIFETIME_MS.
interface LiveFeedState {
  connectedAt: number;
}

function getLiveFeedState(ws: WebSocket): LiveFeedState {
  return (ws.deserializeAttachment() as LiveFeedState | null) ?? { connectedAt: Date.now() };
}

// Per-connection state, kept in the WebSocket attachment rather than
// object memory: the object can be evicted between messages on an idle
// connection, and the attachment is what survives.
//
// `host` is the upgrade request's host, checked against NIP-42 AUTH and
// NIP-62 vanish `relay` tags (nip42.ts relayTagMatchesHost). `challenge`
// is issued lazily, the first time a REQ needs AUTH; `authedPubkey` is
// set by a successful AUTH.
type Subscriptions = Record<string, Filter[]>;
interface ConnState {
  ip: string;
  host: string;
  subs: Subscriptions;
  challenge?: string;
  authedPubkey?: string;
  // Set once handleReqInner's read gate has admitted this connection to
  // the group partition, i.e. this person is in the room. Recorded here so
  // groupOccupants can count occupants by walking sockets in memory
  // instead of repeating a membership lookup per socket.
  groupReader?: boolean;
  // conn-metrics.ts: when the connection was accepted and how many REQs it
  // has had answered, read back once in webSocketClose. Optional so an
  // attachment without them still parses.
  connectedAt?: number;
  reqs?: number;
}

function getState(ws: WebSocket): ConnState {
  return (ws.deserializeAttachment() as ConnState | null) ?? { ip: "unknown", host: "unknown", subs: {} };
}

function setState(ws: WebSocket, state: ConnState): void {
  ws.serializeAttachment(state);
}

// Whether this state fits the WebSocket attachment (limits.ts
// MAX_CONN_STATE_BYTES), checked before storing rather than discovered by
// serializeAttachment throwing. Only handleReqInner needs it: it is the
// one path that grows the state by an amount the client chooses.
function stateFits(state: ConnState): boolean {
  return new TextEncoder().encode(JSON.stringify(state)).length <= MAX_CONN_STATE_BYTES;
}

// Per-IP message throttle, covering every WebSocket frame. In memory
// rather than SQLite: it is best-effort abuse mitigation, so resetting on
// hibernation is acceptable, and persisting it would cost rows written.
// It bounds messages, not rows read over time; see limits.ts
// MAX_FILTER_ROWS_READ for what 5 REQs/second at the cap adds up to.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX_MESSAGES = 50;

// RFC 6455 section 7.4.1: status codes that describe how a connection
// ended and must never be sent in a Close frame; sending one throws. See
// webSocketClose below.
const RESERVED_CLOSE_CODES = new Set([1005, 1006, 1015]);
const NORMAL_CLOSURE = 1000;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// hearth's call presence content: `{"status":"here","muted":false}` while
// in the call, `{"status":"leave"}` on the way out (its app.js
// publishPresence/publishLeavePresence). Unparseable content reads as
// "here": a beat did arrive, and treating it as a departure would
// announce the next beat as an arrival.
function presenceStatus(event: NostrEvent): "here" | "leave" {
  try {
    const parsed = JSON.parse(event.content) as { status?: unknown };
    return parsed?.status === "leave" ? "leave" : "here";
  } catch {
    return "here";
  }
}

function send(ws: WebSocket, message: unknown[]): void {
  ws.send(JSON.stringify(message));
}

function ok(ws: WebSocket, id: string, accepted: boolean, message: string): void {
  send(ws, ["OK", id, accepted, message]);
}

// Maps ownership.ts isAllowedWriter's rejection reasons to distinct
// NIP-01 OK messages, written for the person reading them in their
// client: `restricted:` for a policy boundary, `blocked:` for a ban.
function writeRejectionMessage(reason: WriteRejection): string {
  switch (reason) {
    case "unclaimed":
      return "restricted: relay has not been claimed yet";
    case "not-follow":
      return "restricted: only the owner and people they follow can publish here";
    case "owner-only":
      return "restricted: writes are limited to the relay owner";
    case "banned":
      return "blocked: this pubkey is banned from writing here";
    // The two `mentions` refusals (write-policy.ts). Each names the
    // boundary it enforces, so a stranger learns what this relay WOULD
    // accept.
    case "not-mention":
      return "restricted: only the owner, people they follow, and events that mention the owner can publish here";
    case "too-many-tags":
      return `restricted: an event from someone the owner does not follow may carry at most ${MAX_MENTION_EVENT_INDEXED_TAGS} indexed tags`;
  }
}

// Whether a filter asks only for mail addressed to `pubkey`: its `#p` is
// present and names nobody else. The one shape in which somebody other
// than the owner may read kind 1059 (handleReqInner, broadcast). NIP-17
// clients already ask for their inbox exactly this way
// (`{"kinds":[1059],"#p":[me]}`).
function readsOnlyOwnMail(filter: Filter, pubkey: string): boolean {
  const recipients = filter["#p"];
  return Array.isArray(recipients) && recipients.length > 0 && recipients.every((value) => value === pubkey);
}

export class Relay extends DurableObject<Env> {
  // Per-IP message throttle state (RATE_LIMIT_* above).
  private rateLimits = new Map<string, { windowStart: number; count: number }>();

  // Per-IP gift wrap throttle (limits.ts GIFT_WRAP_RATE_LIMIT_WINDOW_MS/
  // MAX_GIFT_WRAPS_PER_IP_PER_WINDOW). Separate from the message throttle
  // because it bounds rows written on a write path open to anyone.
  private giftWrapRateLimits = new Map<string, { windowStart: number; count: number }>();

  // Per-IP kind-9021 join throttle (limits.ts
  // JOIN_REQUEST_RATE_LIMIT_WINDOW_MS/MAX_JOIN_REQUESTS_PER_IP_PER_WINDOW).
  // Separate from the gift wrap counter because it bounds something else:
  // guesses at a bearer token, not rows written.
  private joinRateLimits = new Map<string, { windowStart: number; count: number }>();

  // Per-pubkey write throttle (limits.ts PUBKEY_RATE_LIMIT_WINDOW_MS/
  // MAX_EVENTS_PER_PUBKEY_PER_WINDOW). The IP-keyed maps above are walked
  // around by a writer with several addresses; a writer's authority here
  // is their pubkey. All four throttles are in memory and reset on
  // eviction, a deliberate trade against paying rows to enforce them.
  private pubkeyRateLimits = new Map<string, { windowStart: number; count: number }>();

  // When this object last WROTE a `presence` row per pubkey (not when it
  // last saw a beat). hearth beats every five seconds and a row is written
  // at most every PRESENCE_WRITE_INTERVAL_SECONDS, so seven beats in eight
  // never reach storage. Losing it on eviction is harmless: the stored row
  // is the authority, and PRESENCE_STALE_SECONDS is derived to be exactly
  // the staleness a live row can have.
  private presenceWrites = new Map<string, number>();

  // When this object last looked at who is in the room. It gates the socket
  // walk, not only the write: gating only the write would leave the
  // watermark unmoved while fewer than MIN_ROOM_OCCUPANTS are present, so
  // every group event would walk every socket. The cost is up to
  // CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS of delay noticing a second
  // arrival (limits.ts). Lost on eviction, costing one extra sample;
  // storage.ts noteRoomOccupied takes a MAX so two cold entry points in the
  // same second cannot move the watermark backwards.
  private roomSampledAt = 0;

  // The effective write policy (write-policy.ts resolveWritePolicy),
  // cached per instance so the write gate reads the stored setting once
  // per wake rather than per event. manage() clears it after every
  // management call, since changewritepolicy arrives there, so a change
  // takes effect on the next event.
  private cachedWritePolicy: ResolvedWritePolicy | undefined;

  private writePolicy(): ResolvedWritePolicy {
    this.cachedWritePolicy ??= resolveWritePolicy(this.env, getStoredWritePolicy(this.sql));
    return this.cachedWritePolicy;
  }

  // Set when this invocation queued a push, consumed by settlePushAlarm()
  // at the end of it. A flag rather than an await at the queue site,
  // because that site is inside the synchronous write path, which would
  // otherwise have to become async for a call unrelated to storing the
  // event.
  private pushAlarmWanted = false;

  // Every storage access in this object goes through this handle rather
  // than `ctx.storage.sql`. read-metrics.ts uses it to attribute rows read
  // to code paths and to measure rows written (landed by metered()), so a
  // query cannot be missed. A field initializer runs after super() sets
  // `ctx` and before the constructor body, so initSchema sees it.
  private readonly sql: SqlStorage = instrumentSql(this.ctx.storage.sql);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Runs on every wake from hibernation, not once per deploy, so its
    // reads are attributed separately.
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

    // Every client connection passes through here, so this is where the
    // deployment learns its own host (src/host.ts) for backfill's
    // self-skip; recordHost writes nothing once the host is known. The
    // read-metrics scope is synchronous and must not straddle the `await`
    // further down.
    const blocked = withReadPath("connect", () => {
      recordHost(this.sql, new URL(request.url).host);

      // NIP-86 blockip, enforced once per connection before the socket is
      // accepted, never per message (that would put a read on the hot path
      // for an almost always empty table). Covers both WebSocket paths and
      // NOT the management endpoint, which is handled in the Worker:
      // blocking your own address must not lock you out of the API that
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

    // The admin page's live feed: push-only, unauthenticated, not a nostr
    // connection. Kept off REQ/EVENT so it never passes through
    // boundFilter or the read gates; liveBroadcast decides what it may
    // see (never gift wraps or group events, never content).
    if (new URL(request.url).pathname === "/live") {
      // Its own cap bounds liveBroadcast's per-event fan-out and the
      // attachment state, since nothing else on this channel does.
      if (this.ctx.getWebSockets(LIVE_FEED_TAG).length >= MAX_LIVE_FEED_CONNECTIONS) {
        return new Response("too many live feed connections", { status: 503 });
      }

      // acceptWebSocket, not server.accept(): see below.
      this.ctx.acceptWebSocket(server, [LIVE_FEED_TAG]);
      server.serializeAttachment({ connectedAt: Date.now() } satisfies LiveFeedState);
      await this.scheduleLiveFeedAlarm();
      return new Response(null, { status: 101, webSocket: client });
    }

    // acceptWebSocket (the Hibernation API), not server.accept(): accept()
    // pins the object in memory and bills DO duration for the connection's
    // whole lifetime.
    this.ctx.acceptWebSocket(server);
    setState(server, {
      ip: request.headers.get("CF-Connecting-IP") ?? "unknown",
      host: new URL(request.url).host,
      subs: {},
      connectedAt: Date.now(),
      reqs: 0,
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // TOFU claim: the first pubkey submitted owns the relay, permanently,
  // with no signature on the claim. Deliberate: every event is verified
  // against its own signature regardless of owner, so a wrong claim
  // forges nothing; the worst case is archiving a stranger's public notes,
  // and recovery is deleting and redeploying the Worker. A signature would
  // only move the hard step (proving key control before anything works)
  // onto the setup page.
  //
  // claim() and claimSigned() are the only paths that write the `owner`
  // row. The relay's own signing identity is not created here: it is
  // seeded at schema init (schema.ts seedRelayIdentity) because
  // OWNER_PUBKEY skips claiming entirely and still needs it.
  //
  // `nonce` is present when a phone opened the admin page's QR link
  // (ownership.ts claimWithNonce). The claim is still unsigned and
  // first-come-first-served; the nonce only lets the desktop page learn
  // that its own QR is the one that landed.
  async claim(
    rawPubkey: unknown,
    profile?: Profile,
    host?: string,
    nonce?: string,
  ): Promise<{ status: "claimed" | "conflict" | "disabled" | "invalid" | "invalid-nonce"; pubkey?: string }> {
    if (this.env.OWNER_PUBKEY) return { status: "disabled" };
    if (typeof rawPubkey !== "string") return { status: "invalid" };
    const pubkey = normalizePubkey(rawPubkey);
    if (!pubkey) return { status: "invalid" };

    return this.metered(() =>
      withReadPath("identity", () => {
        const sql = this.sql;
        if (host) recordHost(sql, host);
        if (nonce !== undefined) {
          const status = claimWithNonce(sql, pubkey, profile, nonce, nowSeconds());
          return status === "claimed" ? { status, pubkey } : { status };
        }
        if (!claimOwner(sql, pubkey, profile)) return { status: "conflict" as const };
        // Every outstanding QR code is moot once the relay has an owner,
        // whichever path claimed it.
        clearClaimNonces(sql);
        return { status: "claimed" as const, pubkey };
      }),
    );
  }

  // POST /api/claim-nonce, DO-side half. One RPC that both checks for an
  // owner and inserts the row: unlike claim(), there is no outbound work
  // to keep away from an "already claimed" caller.
  async issueClaimNonce(): Promise<
    { status: "disabled" | "conflict" | "limited" } | { status: "issued"; nonce: string; expiresAt: number }
  > {
    if (this.env.OWNER_PUBKEY) return { status: "disabled" };
    return this.metered(() =>
      withReadPath("identity", () => {
        const sql = this.sql;
        if (getOwnerPubkey(sql, this.env) !== null) return { status: "conflict" as const };
        const result = issueClaimNonce(sql, nowSeconds());
        if (result === "capped") return { status: "limited" as const };
        return { status: "issued" as const, nonce: result.nonce, expiresAt: result.expiresAt };
      }),
    );
  }

  // POST /api/claim-signed, DO-side half: a claim proved by a signed
  // NIP-42-style event answering a claim nonce, for a signer that
  // implements it (none does yet). The Worker has already verified the
  // event's signature, kind, freshness and relay tag (nip42.ts
  // verifyClaimAuthEvent); what is left needs storage: whether the nonce
  // is live, and the same single-threaded claim.
  //
  // No profile lookup, unlike claim(): there is no preview to serve, and
  // the cron's refreshProfile picks up the owner's kind-0 as it does under
  // OWNER_PUBKEY.
  async claimSigned(
    nonce: string,
    pubkey: string,
    host?: string,
  ): Promise<{ status: "disabled" | "invalid-nonce" | "conflict"; pubkey?: string } | { status: "claimed"; pubkey: string }> {
    if (this.env.OWNER_PUBKEY) return { status: "disabled" };
    return this.metered(() =>
      withReadPath("identity", () => {
        const sql = this.sql;
        if (host) recordHost(sql, host);
        const status = claimWithNonce(sql, pubkey, undefined, nonce, nowSeconds());
        return status === "claimed" ? { status, pubkey } : { status };
      }),
    );
  }

  // GET /api/claim-status, DO-side half. One indexed row read.
  async getClaimStatus(nonce: string): Promise<ClaimStatus> {
    return this.metered(() => withReadPath("identity", () => getClaimStatus(this.sql, nonce)));
  }

  // Backs the NIP-11 document (src/nip11.ts): stored settings, the owner's
  // profile, the owner pubkey and the relay's own pubkey in one RPC.
  // `ownerPubkey` is null when unclaimed; nip11.ts falls back through its
  // resolution chain when profile fields are missing.
  async getIdentity(
    host?: string,
  ): Promise<{
    profile: OwnerProfile;
    settings: RelaySettings;
    ownerPubkey: string | null;
    relayPubkey: string;
    memberCount: number;
  }> {
    return this.metered(() =>
      withReadPath("identity", () => {
        const sql = this.sql;
        if (host) recordHost(sql, host);
        // Both pubkeys ride along rather than costing more RPCs: one row
        // each at most. The relay's own always exists (seeded by
        // initSchema).
        return {
          profile: getOwnerProfile(sql, this.env),
          settings: getRelaySettings(sql),
          ownerPubkey: getOwnerPubkey(sql, this.env),
          relayPubkey: getRelayPubkey(sql),
          // M rows, M the size of a friend group (storage.ts memberCount).
          memberCount: memberCount(sql),
        };
      }),
    );
  }

  // The owner pubkey on its own, null when unclaimed. index.ts asks for it
  // on the NIP-86 path only after a valid NIP-98 signature exists
  // (ownerReason), so an unauthenticated request never wakes this object
  // for it; the claim endpoints use it to refuse early.
  async getOwner(): Promise<string | null> {
    return this.metered(() => withReadPath("identity", () => getOwnerPubkey(this.sql, this.env)));
  }

  // NIP-86 relay management (src/nip86.ts). Performs NO authentication:
  // it must only be reached after the Worker has verified a NIP-98 event
  // from the owner (or, for nip86.ts MEMBER_CALLABLE_METHODS, a member).
  // `signer` is that verified pubkey.
  async manage(
    method: unknown,
    params: unknown[],
    callerIp: string,
    signer: string,
  ): Promise<ManagementResponse> {
    const response = await this.metered(() =>
      withReadPath("management", () =>
        handleManagementCall(this.sql, this.env, method, params, callerIp, nowSeconds(), signer),
      ),
    );
    // Cleared after every method, not only changewritepolicy: it costs one
    // row on the next non-owner write, and a cache that has to know which
    // methods invalidate it will eventually be wrong about one.
    this.cachedWritePolicy = undefined;
    return response;
  }

  // For the Worker's management gate (src/index.ts), deciding whether a
  // non-owner signer may call nip86.ts MEMBER_CALLABLE_METHODS. A member
  // of the relay (storage.ts isMember), or of the top-level group
  // (TOP_LEVEL_GROUP_ID), whose members a group fan-out pushes to. At most
  // two PK seeks, reached only after a valid signature.
  async isMember(pubkey: string): Promise<boolean> {
    return this.metered(() =>
      withReadPath("management", () => isMember(this.sql, pubkey) || isGroupMember(this.sql, pubkey)),
    );
  }

  // Backs GET /api/stats (src/index.ts), which is public and
  // unauthenticated: every figure here is maintained or bounded, so no
  // request walks a table.
  async getStats(host?: string): Promise<{
    version: string;
    claimed: boolean;
    ownerPubkey: string | null;
    // This relay's own signing identity (src/relay-identity.ts), never the
    // owner's: the key that signs NIP-29 39000-series events. Always
    // present, regardless of claim status.
    relayPubkey: string;
    // Maintained, not counted: one row of `maintained_counts`
    // (storage.ts readMaintainedCounts).
    totalEvents: number;
    // Events whose own created_at is in the last 24h: what the owner has
    // been posting, NOT what this relay took in (a backfilled event is
    // years old by created_at; see ingested24h). Maintained per-hour
    // buckets keyed by `created_at` (storage.ts countEvents24h), at most 26
    // rows read. Whole hours, so the window spans 24-25h.
    events24h: number;

    // Events this relay wrote in the last 24h, backfill included.
    // Maintained per-hour buckets keyed by `ingested_at` (storage.ts
    // readIngestCounts), at most 25 rows read, shared with
    // rowsWrittenToday. Whole hours, so the window spans 24-25h.
    ingested24h: number;
    storageBytes: number;
    // Rows written since the last 00:00 UTC, when the free tier's
    // allowances reset: the write-budget meter. All rows written (events,
    // index entries, tags, tombstones, counters, follow rebuilds, NIP-86
    // calls, backfill bookkeeping), measured by the SqlStorage wrapper in
    // read-metrics.ts and landed by storage.ts settleRowsWritten. Reads
    // slightly high, because a removal is accounted at schema.ts
    // eventRemovalBudget's pessimistic figure. Exact at the day boundary,
    // since a UTC day starts on a whole bucket hour.
    rowsWrittenToday: number;
    // The free-tier ceilings from limits.ts, served so public/index.html's
    // progress bars cannot drift from what the relay is measured against.
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
    // The write policy in force (write-policy.ts), by name, and where it
    // came from -- the environment, a stored changewritepolicy, or the
    // default. The admin page renders the policy as one sentence; the
    // follow count beside it is what lets that sentence say "the follow
    // list is empty" when it is, rather than reading as healthy.
    writePolicy: WritePolicy;
    writePolicySource: ResolvedWritePolicy["source"];
    // Whether NIP-29 groups are accepting anything (limits.ts
    // groupsEnabled): "on" or "paused". Configuration, like chatPolicy
    // below, and nothing about what the group holds.
    groupPolicy: "on" | "paused";
    // What ephemeral group chat may do (limits.ts chatMode): "off",
    // "reporting" or "deleting". The mode only, never counts: a count of
    // pending or swept messages on this public endpoint would disclose
    // group activity. The numbers go to the log (sweepEphemeralChat).
    chatPolicy: ChatMode;
    // From the same `maintained_counts` row as `totalEvents`; ownership.ts
    // refreshFollows is the only writer of `follows` and moves it.
    followCount: number;
    // Members (storage.ts memberCount): the people this relay keeps an
    // inbox for besides the owner. The same figure as NIP-11
    // `member_count`.
    memberCount: number;
    // Whether this relay can send push notifications at all (push.ts
    // pushConfigured): "on" or "off". Configuration, like groupPolicy;
    // NIP-11 says the same thing by carrying `push_key` or not.
    pushPolicy: "on" | "off";
    // Whether the daily counter audit (storage.ts auditMaintainedCounts)
    // has run and what it last found, from the same row. `lastRanAt: null`
    // means it has never run and must NOT be rendered as "no drift found".
    // See schema.ts `last_drift` and public/index.html.
    countAudit: CountAuditStatus;
    // The `created_at` of the owner's contact list as the follow cache has
    // it (not a refresh time). One row: every `follows` row carries the
    // same value.
    followsListAt: number | null;
    // NIP-62 vanish requests still draining, so a stalled drain is
    // visible. Aggregated (count, progress, age), never itemised: listing
    // pubkeys here would publish who asked to be erased. See storage.ts
    // vanishSummary.
    vanishing: VanishSummary;
    // Whether the owner's resolved kind-10002 already names this relay
    // (ownership.ts ownerListsThisRelay); the claimed view hides the
    // wss:// copy box when it does. False while unclaimed.
    ownerListsThisRelay: boolean;
    // DIAGNOSTIC (src/read-metrics.ts): rows read per code path. In-memory
    // counters, so this covers `reads.sinceMs` of uptime, not a day: read
    // it for proportions, and `projected24h` as an extrapolation.
    reads: ReadMetricsSnapshot;
    // The write-side breakdown over the same in-memory counters: which
    // path spends the write budget. `rowsWrittenToday` stays the durable
    // figure.
    writes: WriteMetricsSnapshot;
    // DIAGNOSTIC, memory only, same reset-on-eviction caveat. Hits on
    // src/req-cache.ts are REQ queries that read zero rows; a hit count
    // far below the miss count means the client varies its filters (a
    // sliding `since`, most likely) and the cache is not the answer.
    reqCache: ReqCacheSnapshot;
    // DIAGNOSTIC: why connections end -- src/conn-metrics.ts.
    connections: ConnMetricsSnapshot;
  }> {
    return this.metered(() => {
      const stats = withReadPath("getStats", () => this.collectStats(host));
      // Snapshotted after the scope closes so this call's own reads and
      // writes are included in what it reports.
      return {
        ...stats,
        reads: readMetricsSnapshot(),
        writes: writeMetricsSnapshot(),
        reqCache: reqCacheSnapshot(),
        connections: connMetricsSnapshot(),
      };
    });
  }

  private collectStats(
    host?: string,
  ): Omit<Awaited<ReturnType<Relay["getStats"]>>, "reads" | "writes" | "reqCache" | "connections"> {
    // recordHost writes nothing once the host is known (src/host.ts).
    if (host) recordHost(this.sql, host);

    const sql = this.sql;
    const owner = getOwnerPubkey(sql, this.env);
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    // The last 00:00 UTC, when the rows-written allowance empties (limits.ts
    // utcDayStartSeconds): where the day's ingest-hour buckets start.
    const budgetSince = utcDayStartSeconds(nowMs);

    // Every maintained count, one row (schema.ts `maintained_counts`).
    const counts = readMaintainedCounts(sql);
    // Both partitions' created_at buckets, one statement, ~26 rows.
    const windowed = countEvents24h(sql, nowSec);
    // `ingest_hour_counts`, one statement, at most 25 rows.
    const ingest = readIngestCounts(sql, nowSec, budgetSince);

    const profile = getOwnerProfile(sql, this.env);
    const settings = getRelaySettings(sql);

    return {
      version,
      claimed: owner !== null,
      ownerPubkey: owner,
      // One row, from the singleton relay_identity table.
      relayPubkey: getRelayPubkey(sql),
      // Group-partition events are SUBTRACTED from every count here. This
      // endpoint is public: polling a total that moves with every stored
      // event while holding a /live socket would date each group arrival
      // (which the feed does not announce) to the second. The counters are
      // maintained in two halves (schema.ts `group_events`/`group_n`) so
      // only the public half is published.
      //
      // Not fixed, and coarser than a per-event counter:
      //   storageBytes       `sql.databaseSize` grows with every stored
      //                      event in either partition.
      //   rowsWrittenToday   deliberately whole: a budget meter that
      //                      under-reports spend is worse than one that
      //                      leaks traffic shape.
      //   reads              the per-path diagnostic moves with group REQs.
      totalEvents: counts.events - counts.groupEvents,
      events24h: windowed.total - windowed.group,
      ingested24h: ingest.ingested24h - ingest.ingestedGroup24h,
      storageBytes: sql.databaseSize,
      rowsWrittenToday: ingest.rowsWrittenToday,
      storageBytesLimit: STORAGE_BYTES_LIMIT,
      dailyRowsWrittenLimit: DAILY_ROWS_WRITTEN_LIMIT,
      dailyRowsReadLimit: DAILY_ROWS_READ_LIMIT,
      // Read live: one row per relay in the owner's kind-10002 list
      // (~20 rows), not O(E).
      backfill: owner !== null ? getBackfillStatus(sql) : null,
      // Same resolution as the NIP-11 icon (nip11.ts resolveIcon); the
      // admin page uses it as the favicon, falling back to the static one
      // on null.
      icon: resolveIcon(this.env, settings, profile),
      relayName: resolveName(this.env, settings, profile),
      writePolicy: this.writePolicy().policy,
      writePolicySource: this.writePolicy().source,
      groupPolicy: groupsEnabled(this.env) ? "on" : "paused",
      chatPolicy: chatMode(this.env),
      followCount: counts.follows,
      memberCount: memberCount(sql),
      pushPolicy: pushConfigured(this.env) ? "on" : "off",
      countAudit: { lastRanAt: counts.lastRanAt, drift: counts.drift },
      followsListAt: followsListAt(sql),
      vanishing: vanishSummary(sql),
      ownerListsThisRelay: owner !== null && ownerListsThisRelay(sql, this.env, host ?? getOwnHost(sql) ?? ""),
    };
  }

  // ------------------------------------------------------------------
  // Lands the write meter. EVERY entry point into this object must run
  // inside metered().
  //
  // read-metrics.ts accumulates rows written in instance memory, and this
  // object hibernates between messages (on the order of seventy wakes per
  // cron interval). A total flushed on a timer or at the next cron tick
  // would lose most of the count, and more of it the quieter the relay is.
  // So each total lands before the invocation that produced it returns.
  // A `finally` wrapper rather than a trailing call, so an early return, a
  // throw or a new entry point cannot skip it.
  //
  // Nearly always free: storage.ts settleRowsWritten writes nothing when
  // nothing is pending or the residue is smaller than the landing itself
  // (an event write lands its own total in a bucket row it already
  // writes). Cron ticks, NIP-86 calls, follow rebuilds and vanish drains
  // pay a row, on the order of thirty a day. The landing's own cost
  // carries into the next landing (read-metrics.ts).
  // ------------------------------------------------------------------
  private async metered<T>(fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } finally {
      settleRowsWritten(this.sql, nowSeconds());
    }
  }

  // Cron entry point (src/index.ts scheduled()). The relay's own upkeep
  // runs first and the vanish drain last: the drain is the only step whose
  // cost a stranger's request sets, and it must not starve the steps that
  // gate the owner's writes (the follow cache above all).
  async runCron(): Promise<void> {
    return this.metered(() => this.runCronInner());
  }

  private async runCronInner(): Promise<void> {
    // Logged here because a DO exception's message does not reliably
    // survive the RPC boundary: the Worker's catch sees only an empty
    // message and one stack frame. Rethrown so index.ts scheduled()'s
    // fault isolation (backfill still runs) keeps working.
    try {
      const sql = this.sql;
      const now = nowSeconds();
      withReadPath("cron", () => {
        refreshFollows(sql, this.env);
        refreshProfile(sql, this.env, now);
        // One-time correction; see backfill.ts resetWronglyExhaustedRelays.
        resetWronglyExhaustedRelays(sql);
        // AFTER the reset, which clears every exhausted flag including
        // this relay's own row; otherwise backfill would fetch its own
        // history from itself. See purgeSelfRelay.
        purgeSelfRelay(sql);
        // One-time corrections to rows written by older code: events
        // misfiled into the group partition or wrongly accepted as relay
        // group metadata (storage.ts fixMisclassifiedGroupEvents), and the
        // migration to groups-as-rows (storage.ts migrateToMultiGroup).
        // Paced by VANISH_BATCH_SIZE because each write has the shape that
        // constant is paced against: an UPDATE moving a row between
        // partial-index halves, or a DELETE. Run from cron rather than at
        // deploy because nothing prompts a redeploy, and until the
        // migration runs, existing group metadata stays unreadable to
        // unauthenticated NIP-29 clients.
        fixMisclassifiedGroupEvents(sql, this.ctx.storage, VANISH_BATCH_SIZE);
        migrateToMultiGroup(sql, this.ctx.storage, VANISH_BATCH_SIZE);
        // Once a day (paced by maintained_counts.audited_at), recount the
        // tables behind the maintained counters and log any disagreement.
        // Detect only; see storage.ts auditMaintainedCounts for why it
        // must not self-correct.
        auditMaintainedCounts(sql, now);
        // Skipped while groups are paused (limits.ts groupsEnabled): no new
        // chat arrives, so there is no conversation to time or report on.
        if (groupsEnabled(this.env)) {
          // The only occupancy sample that sees a room of people sitting
          // quietly. Before the sweep, so a conversation still in progress
          // moves the watermark before the sweep reads it.
          this.noteRoomOccupancy(sql, now);
          // Ephemeral group chat (limits.ts, from CONVERSATION_IDLE_SECONDS).
          // Bounded by CHAT_SWEEP_BATCH_SIZE and checkpointed.
          withReadPath("chatSweep", () => this.sweepEphemeralChat(sql, now));
        }
        // Expired gift wraps (storage.ts sweepExpiredGiftWraps): deleted,
        // not just hidden, because kind 1059 is capped by count (limits.ts
        // maxGiftWraps) and a hidden row would still hold a slot.
        withReadPath("giftWrapSweep", () => this.sweepExpiredWraps(sql, now));
        // Removed members' mail, once their grace period is over
        // (storage.ts sweepFormerMembers). Free while nobody is waiting.
        withReadPath("giftWrapSweep", () => this.sweepFormerMemberMail(sql, now));
        // Last: see the comment on runCron.
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

  // One-shot backfill, read side. Called once per cron tick by
  // backfill-worker.ts (the Worker opens the outbound sockets, never this
  // object) to decide whether to discover relays, fetch a page, or do
  // nothing. Null when unclaimed.
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

  // Stores one page of raw events the Worker fetched (backfill-worker.ts
  // fetchPage); see backfill.ts applyBackfillPage for the checks and their
  // order. Null when unclaimed, which the Worker's prior getBackfillState
  // call should already have ruled out.
  async ingestBackfillPage(
    relayUrl: string,
    rawEvents: unknown[],
    eose: boolean,
    refusals: string[] = [],
  ): Promise<{ stored: number; exhausted: boolean } | null> {
    // Scoped at the RPC entry, so `rowsPerCall` in the /api/stats
    // breakdown reads as rows read per backfill tick.
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
    return this.metered(async () => {
      this.webSocketMessageInner(ws, message);
      // Inside metered(), so a setAlarm here is counted as a row written.
      await this.settlePushAlarm();
    });
  }

  private webSocketMessageInner(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;

    // The live feed is push-only and carries a LiveFeedState, not a
    // ConnState, so anything it sends is ignored before frame parsing.
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

  // True when this connection's IP has sent too many messages within the
  // current window (RATE_LIMIT_* above).
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

  // A throttled EVENT that parses far enough to name an id gets
  // `OK false rate-limited:` rather than only a NOTICE: machine clients
  // (WebRTC signalling, for one) block on an OK per event and would
  // otherwise wait forever. The size cap is checked on the raw frame
  // before JSON.parse, so the throttled path stays cheap. Anything else
  // gets the plain NOTICE.
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

  // One "write" read-metrics entry per EVENT frame, covering everything an
  // inbound event reads, so `rowsPerCall` reads as rows read per event
  // offered.
  private handleEvent(ws: WebSocket, raw: unknown): void {
    withReadPath("write", () => this.handleEventInner(ws, raw));
  }

  private handleEventInner(ws: WebSocket, raw: unknown): void {
    const event = parseEventShape(raw);
    if (!event) {
      send(ws, ["NOTICE", "error: malformed event"]);
      return;
    }

    // Three kinds are dispatched ABOVE both write gates, each with its own
    // authorization: NIP-62 vanish (must be honoured regardless of the
    // requester's status), NIP-59 gift wraps (mail to the owner from
    // anyone), and NIP-29 join requests (the joiner is by definition not
    // yet in `allowed_pubkeys`; the invite code is the authority). Since
    // they skip authorizeGroupWrite, none may put a client event into the
    // group partition: vanish and join store no event, and a gift wrap
    // carrying a group tag is refused.
    if (event.kind === VANISH_KIND) {
      this.handleVanish(ws, event);
      return;
    }
    if (event.kind === GIFT_WRAP_KIND) {
      this.handleGiftWrap(ws, event);
      return;
    }
    if (event.kind === JOIN_REQUEST_KIND) {
      this.handleJoin(ws, event);
      return;
    }

    // Authorization before id/signature validity: schnorr is the most
    // expensive per-event step (validate.ts verifySignature), and a refused
    // writer is refused whether or not the event is well-formed. So a
    // refused event with a bad signature gets `restricted:`/`blocked:`
    // rather than `invalid:`; NIP-01 allows that order.
    const sql = this.sql;
    const auth = isAllowedWriter(sql, this.env, event.pubkey, {
      policy: this.writePolicy().policy,
      tags: event.tags,
    });
    if (!auth.allowed) {
      ok(ws, event.id, false, writeRejectionMessage(auth.reason));
      return;
    }

    // NIP-29 group authorization sits UNDER the relay-wide gate, never
    // beside it: the relay-wide gate decides whether this pubkey may write
    // here at all, and only then does nip29.ts decide about the group. Its
    // early exit reads no storage, so ordinary writes pay nothing.
    const groupAuth = authorizeGroupWrite(sql, this.env, event, auth.isOwner, nowSeconds());
    if (!groupAuth.ok) {
      ok(ws, event.id, false, groupAuth.message);
      return;
    }

    this.acceptEvent(ws, sql, event, auth.isOwner);
  }

  // NIP-59 gift wrap accept path: any pubkey may write a kind-1059 that
  // p-tags the owner or a member (storage.ts isMember), with no prior
  // relationship to the relay. Hence the extra controls below on top of
  // the per-IP message throttle. One inbox share and one throttle for all
  // of them: a member's mail is the owner's mail as far as the bounds go.
  private handleGiftWrap(ws: WebSocket, event: NostrEvent): void {
    // First, for safety rather than cost. This path skips
    // authorizeGroupWrite, and storeEvent partitions by groups.ts
    // isGroupEvent, so a wrap carrying an `h` tag naming a hosted group
    // would be injected unauthenticated into that group's feed. Refused
    // outright: a wrap is addressed to one recipient by `p` tag, so a
    // group tag on it means nothing. isAnyGroupEvent, so a foreign group
    // id is refused too.
    if (isAnyGroupEvent(event)) {
      ok(
        ws,
        event.id,
        false,
        "invalid: a gift wrap is mail addressed to one person and cannot carry a group tag",
      );
      return;
    }

    // Gift wraps need at least the `inbox` policy (write-policy.ts): under
    // `owner`, a wrap (signed by a throwaway key) is never the owner's.
    // Ahead of the owner lookup because it is answered from memory.
    if (!admitsAtLeast(this.writePolicy().policy, "inbox")) {
      ok(ws, event.id, false, "restricted: writes are limited to the relay owner, and that includes mail");
      return;
    }

    const sql = this.sql;
    const owner = getOwnerPubkey(sql, this.env);
    if (owner === null) {
      ok(ws, event.id, false, "restricted: relay has not been claimed yet");
      return;
    }
    // Who the wrap is for: the owner (free, from memory) and any members
    // among its first few `p` values (a PK seek each, bounded by
    // MAX_WRAP_RECIPIENTS_CHECKED). A removed member is no longer in
    // `allowed_pubkeys`, so their new mail stops here.
    const named = [...new Set(pTagValues(event.tags))];
    const recipients = named
      .filter((pubkey) => pubkey !== owner)
      .slice(0, MAX_WRAP_RECIPIENTS_CHECKED)
      .filter((pubkey) => isMember(sql, pubkey));
    if (named.includes(owner)) recipients.unshift(owner);
    if (recipients.length === 0) {
      ok(ws, event.id, false, "restricted: gift wrap is not addressed to this relay's owner or one of its members");
      return;
    }

    // Size is capped for every writer at the top of acceptEvent
    // (limits.ts MAX_EVENT_BYTES).
    if (this.isGiftWrapRateLimited(getState(ws).ip)) {
      ok(ws, event.id, false, "rate-limited: too many gift wraps from this connection, slow down");
      return;
    }

    if (giftWrapCount(sql) >= maxGiftWraps(this.env)) {
      ok(ws, event.id, false, "blocked: gift wrap inbox storage is full");
      return;
    }

    // Compared rather than hardcoded false: a wrap is normally signed by a
    // one-time key, but acceptEvent's exemptions should follow who signed
    // it.
    this.acceptEvent(ws, sql, event, event.pubkey === owner, recipients);
  }

  // NIP-29 kind-9021 join request. The decision is nip29.ts
  // handleJoinRequest; this is the wire-level work before any invite code
  // is looked at, and its ORDER is what matters.
  private handleJoin(ws: WebSocket, event: NostrEvent): void {
    // Paused groups (limits.ts groupsEnabled) refuse first, with their
    // own message rather than JOIN_REFUSAL_MESSAGE: it is configuration,
    // the same answer whatever the request carried, so it reveals nothing
    // about any code.
    if (!groupsEnabled(this.env)) {
      ok(ws, event.id, false, GROUPS_PAUSED_MESSAGE);
      return;
    }

    // Size before hashing, as in acceptEvent: a join never reaches
    // acceptEvent, so this is its only size bound.
    const byteCap = maxEventBytes(this.env);
    if (byteCap !== null && JSON.stringify(event).length > byteCap) {
      ok(ws, event.id, false, `invalid: event exceeds the maximum size of ${byteCap} bytes`);
      return;
    }

    // Ahead of schnorr: this throttle bounds how often schnorr is paid for
    // a stranger, and how fast invite codes can be guessed.
    if (this.isJoinRateLimited(getState(ws).ip)) {
      ok(ws, event.id, false, "rate-limited: too many join requests from this connection, slow down");
      return;
    }

    // Signature AHEAD of the invite lookup, inverting the cheapest-first
    // convention on purpose: if a bad code were refused before a bad
    // signature, guesses offered under junk signatures would reveal which
    // codes are real by which refusal came back. Costs ~1.1ms of CPU per
    // request (validate.ts verifySignature), bounded by the throttle above.
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
    // The regenerated kind-39002 member list, if this join changed it:
    // broadcast() gates it to the owner and the group's members (the
    // joiner included by now, so they see their own admission), and it is
    // not sent to the live feed, as with acceptEvent's generated events.
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

  // See limits.ts GIFT_WRAP_RATE_LIMIT_WINDOW_MS/MAX_GIFT_WRAPS_PER_IP_PER_WINDOW.
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

  // See limits.ts MAX_EVENTS_PER_PUBKEY_PER_WINDOW. `max` is the
  // env-resolved cap; acceptEvent skips this call when it is disabled.
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

  // Keyed by pubkey, this map can be grown for free (every gift wrap
  // carries a fresh one-time key), so unlike the IP-keyed maps it needs a
  // bound. Expired windows are dropped first; clearing outright is the
  // backstop, and gives an attacker nothing, since a map full of distinct
  // one-shot keys was throttling none of them.
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

  // NIP-62 Request to Vanish. Deliberately NOT routed through
  // isAllowedWriter: NIP-62 binds write-restricted relays to honour it
  // "regardless of the user's status", and the authority is the requester
  // erasing their own events. So it cannot be gated, throttled below
  // "eventually completes", or revoked; cost is the only control, which is
  // why it is checkpointed and drained across cron ticks. The request
  // itself is not stored (NIP-62 says MAY), saving its row cost.
  private handleVanish(ws: WebSocket, event: NostrEvent): void {
    // Relay-tag match first, before paying for a hash or schnorr on a
    // request not meant for this relay.
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

    // Two reads before any write, because this path is open to anyone
    // forever: whether to honour the request is fixed, but whether
    // honouring it costs rows is not.
    //
    // First: already checkpointed? A signed vanish is replayable by anyone
    // who has seen it, and re-running beginVanish plus a drain batch per
    // replay would spend writes and drain faster than the reserved share
    // allows. A pending request at or wider than this one already covers
    // it, so answer with progress, for one row read.
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

    // Second: anything to remove? A vanish over nothing is complete when
    // asked, and checkpointing it would write rows only for the drain to
    // delete them (storage.ts hasVanishTargets has the arithmetic).
    if (!hasVanishTargets(this.sql, event.pubkey, event.created_at)) {
      ok(ws, event.id, true, "");
      return;
    }

    // Checkpointed before anything is deleted, then drained one bounded
    // batch at a time (storage.ts beginVanish). The sender chooses the
    // size, so doing it all inline could hit the daily write ceiling
    // partway and leave the pubkey half-vanished after an OK.
    beginVanish(this.sql, event.pubkey, event.created_at, nowSeconds());
    const progress = drainVanish(this.sql, event.pubkey, VANISH_BATCH_SIZE);

    // Plain words distinguish finished from in progress: NIP-01 has no
    // prefix for "accepted and still working", and a bare `true` would
    // hide the difference.
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

  // Resumes every unfinished vanish, last in runCron. One bounded batch per
  // pubkey per tick, so concurrent requests progress together rather than
  // the oldest blocking the rest.
  private drainPendingVanishes(sql: SqlStorage): void {
    for (const pending of pendingVanishes(sql)) {
      drainVanish(sql, pending.pubkey, VANISH_BATCH_SIZE);
    }
  }

  // Shared tail of the write path once authorization is settled, reached
  // from handleEventInner and handleGiftWrap. Cheapest and most certain
  // rejections run first; schnorr runs as late as possible.
  // `wrapRecipients`: for a gift wrap, who handleGiftWrap found it is for,
  // so the push queue does not look them up a second time.
  private acceptEvent(
    ws: WebSocket,
    sql: SqlStorage,
    event: NostrEvent,
    isOwner: boolean,
    wrapRecipients: readonly string[] = [],
  ): void {
    // Size first: it bounds the cost of everything after it (hashing
    // re-serializes the event, storage keeps every byte). Applied to the
    // owner too, or it would not bound stored bytes (limits.ts
    // MAX_EVENT_BYTES).
    const byteCap = maxEventBytes(this.env);
    if (byteCap !== null && JSON.stringify(event).length > byteCap) {
      ok(ws, event.id, false, `invalid: event exceeds the maximum size of ${byteCap} bytes`);
      return;
    }

    // See limits.ts MAX_CREATED_AT_FUTURE_SECONDS for why this refuses.
    if (isCreatedAtTooFarInFuture(event, nowSeconds())) {
      ok(ws, event.id, false, "invalid: created_at is too far in the future");
      return;
    }

    // Per-pubkey write throttle, a Map lookup.
    //
    // The owner is exempt: the budget it protects is theirs, the relay
    // does not defend against its own owner, and a replayed offline
    // backlog arrives at exactly the burst rate a cap would refuse. An
    // expensive owner event is fixed by making its cost not scale, not by
    // throttling the owner. Ephemeral kinds are exempt because storeEvent
    // writes no rows for them; their schnorr and broadcast cost is shaped
    // by the per-IP message throttle.
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

    // Storage headroom (limits.ts NON_OWNER_STORAGE_SHARE_LIMIT), a
    // property read. Non-owner only: the rest is reserved FOR the owner.
    const storageLimit = nonOwnerStorageLimit(this.env);
    if (!isOwner && storageLimit !== null && !hasNonOwnerStorageHeadroom(sql, storageLimit)) {
      ok(ws, event.id, false, "blocked: relay storage is full for writers other than the owner");
      return;
    }

    if (!idMatchesContent(event)) {
      ok(ws, event.id, false, "invalid: id does not match the hash of its contents");
      return;
    }

    // A tombstoned id (schema.ts `deleted_ids`: NIP-09, NIP-62, banevent)
    // can never be re-stored, so it is refused before schnorr. This is what
    // stops a sender who kept a signed copy from replaying it.
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
    // NIP-29 moderation, stored first and acted on second like a kind-5,
    // because the moderation event is part of the group's history. Its own
    // read-metrics scope because the group-state regeneration it triggers
    // is a cost most events never pay. Returns the relay's own events,
    // already stored through storeEvent.
    const generated =
      isSupportedModerationKind(event.kind) && result.stored
        ? withReadPath("groupState", () => applyModeration(sql, this.env, event, nowSeconds()))
        : [];
    ok(ws, event.id, result.ok, result.message);

    if (result.stored) {
      // The owner's new kind-3 refreshes the follow cache now rather than
      // at the next cron tick. Gated on the owner as author so a follow's
      // own kind-3 does not trigger a redundant refresh.
      const owner = getOwnerPubkey(sql, this.env);
      if (event.pubkey === owner && event.kind === CONTACT_LIST_KIND) {
        refreshFollows(sql, this.env);
      }
      // Occupancy sample on the write path. Any stored group event shows
      // somebody is here; groupOccupants decides whether somebody else is,
      // by counting sockets rather than authors.
      if (isGroupEvent(event, groupHost(sql))) this.noteRoomOccupancy(sql, nowSeconds());
      // Only for an accepted event: a notification about a refused event
      // would be about nothing.
      this.notePush(sql, event, wrapRecipients);
      this.broadcast(result.stored);
      this.liveBroadcast(result.stored);
    }
    // The relay's regenerated group state goes to subscriptions through
    // broadcast(), which gates the private kinds (39002) to the owner and
    // the group's members; 39000/39001 are public (groups.ts
    // isPubliclyReadableGroupKind). None of it is sent to the live feed.
    for (const event of generated) {
      this.broadcast(event);
    }
  }

  // ------------------------------------------------------------------
  // Ephemeral group chat, the occupancy half (limits.ts, from
  // CONVERSATION_IDLE_SECONDS; storage.ts sweepChat). The relay does this
  // because it is the only party that sees everyone's presence at once.
  //
  // "The room" here is relay-wide: any connection admitted to the group
  // partition counts, whichever group it reads, and storage.ts
  // noteRoomOccupied/readChatState do not take a group id.
  // ------------------------------------------------------------------

  // Distinct people in the room now. No storage reads: a walk over the
  // object's live sockets, using `groupReader` as set by the read gate.
  //
  // Distinct pubkeys, not sockets: one person's phone and laptop must not
  // look like a conversation. Live feed sockets have no `groupReader` and
  // fall out on their own.
  //
  // An open socket IS the definition of being here, so somebody sitting
  // quietly counts (occupancy is not inferred from traffic). The known
  // cost: a tab left open overnight is indistinguishable from that, so a
  // room with two abandoned tabs never empties and its chat is never
  // swept. There is deliberately no ceiling on message lifetime to bound
  // this (limits.ts argues it out); the alternative is deleting a
  // conversation under people the relay believes are still present.
  private groupOccupants(): number {
    const present = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as ConnState | null;
      if (state?.groupReader !== true) continue;
      if (state.authedPubkey === undefined) continue;
      present.add(state.authedPubkey);
    }
    return present.size;
  }

  // Moves the stored occupancy watermark if the room is occupied and the
  // last sample is stale. Cheapest first:
  //
  //   sampled recently         nothing: no socket walk, no read, no write.
  //   fewer than two present   the socket walk only. One person alone is
  //                            an empty room for the chat rule: a message
  //                            nobody hears is a note, not speech.
  //   otherwise                one row updated in place.
  //
  // Called from an accepted group write, a REQ the read gate admitted to
  // the group partition, and the cron tick (the only one that sees a room
  // of people sitting quietly).
  private noteRoomOccupancy(sql: SqlStorage, nowSec: number): void {
    if (nowSec - this.roomSampledAt < CHAT_OCCUPANCY_WRITE_INTERVAL_SECONDS) return;
    // Stamped whatever the count finds, so an empty room throttles like a
    // busy one (see roomSampledAt).
    this.roomSampledAt = nowSec;
    if (this.groupOccupants() < MIN_ROOM_OCCUPANTS) return;
    noteRoomOccupied(sql, nowSec);
  }

  // One cron tick of the chat sweep, or of the reporting mode in front of
  // it (limits.ts chatMode). In reporting mode the log line is the output.
  // It goes to the log, not /api/stats, because that endpoint is public
  // and a count of group chat would disclose group activity. Silent when
  // there is nothing to report.
  private sweepEphemeralChat(sql: SqlStorage, nowSec: number): void {
    const mode = chatMode(this.env);
    if (mode === "off") return;
    const state = readChatState(sql);
    const result = sweepChat(sql, state, nowSec, CHAT_SWEEP_BATCH_SIZE, mode === "deleting");
    if (result.pending === 0 && result.removed === 0) return;
    const occupants = this.groupOccupants();
    console.log(
      mode === "deleting"
        ? `ephemeral chat: removed ${result.removed} of ${result.pending} chat messages at or before ` +
          `${result.cutoff}${result.done ? "" : ", more to come next tick"}; ` +
          `${occupants} in the room, last occupied ${state.lastOccupiedAt}`
        : `ephemeral chat (reporting only, set EPHEMERAL_CHAT=on to act): would remove ` +
          `${result.pending} chat messages at or before ${result.cutoff}; ` +
          `${occupants} in the room, last occupied ${state.lastOccupiedAt}`,
    );
  }

  // One cron tick of the removed-member sweep. Logs counts only: which
  // pubkeys were removed is the owner's business, not the log's.
  private sweepFormerMemberMail(sql: SqlStorage, nowSec: number): void {
    const result = sweepFormerMembers(
      sql,
      nowSec,
      MEMBER_REMOVAL_GRACE_SECONDS,
      getOwnerPubkey(sql, this.env),
      FORMER_MEMBER_SWEEP_PUBKEYS,
      FORMER_MEMBER_SWEEP_BATCH_SIZE,
    );
    if (result.removed === 0 && result.finished === 0) return;
    console.log(
      `member sweep: removed ${result.removed} gift wrap(s) held for removed members; ` +
        `${result.finished} removed member(s) now have nothing left here`,
    );
  }

  // One cron tick of the expired-gift-wrap sweep (storage.ts
  // sweepExpiredGiftWraps). No mode switch, unlike the chat sweep: it
  // removes only rows whose author set an expiry that has passed, and no
  // query has returned them since. Logs only when it removed something.
  private sweepExpiredWraps(sql: SqlStorage, nowSec: number): void {
    const result = sweepExpiredGiftWraps(sql, nowSec, GIFT_WRAP_SWEEP_BATCH_SIZE);
    if (result.removed === 0) return;
    console.log(
      `gift wrap sweep: removed ${result.removed} expired gift wrap(s)` +
        `${result.done ? "" : ", more to come next tick"}`,
    );
  }

  // ------------------------------------------------------------------
  // Push (src/push.ts, reference/push.md). Everything below is a no-op
  // without a VAPID key: no rows, no alarm, no fetch, no client-visible
  // error.
  // ------------------------------------------------------------------

  // What an accepted event owes the notification queue. Only three kinds
  // qualify, decided by integer comparisons, so other writes pay nothing.
  private notePush(sql: SqlStorage, event: NostrEvent, wrapRecipients: readonly string[]): void {
    if (!pushConfigured(this.env)) return;
    // Mail: queued per recipient who has a device registered (one indexed
    // read each), so mail for someone without push writes nothing.
    if (event.kind === GIFT_WRAP_KIND) {
      withReadPath("push", () => {
        const now = nowSeconds();
        for (const pubkey of wrapRecipients) {
          if (!hasPushSubscription(sql, pubkey)) continue;
          queueInboxPush(sql, pubkey, now);
          this.pushAlarmWanted = true;
        }
      });
      return;
    }
    if (event.kind === CALL_PRESENCE_KIND) {
      withReadPath("presence", () => this.notePresence(sql, event));
      return;
    }
    // isGroupEvent, not isAnyGroupEvent: a kind-9 tagged with a group this
    // relay does not host is not a message anyone here can read.
    if (event.kind === GROUP_CHAT_KIND && isGroupEvent(event, groupHost(sql))) {
      withReadPath("push", () => {
        queuePush(sql, "message", event.pubkey, nowSeconds());
        this.pushAlarmWanted = true;
      });
    }
  }

  // Call presence. Push on the absent-to-present TRANSITION, never on the
  // event: hearth beats every five seconds, so pushing per event would
  // send twelve notifications a minute per participant. Cheapest first:
  //
  //   memory says written recently   nothing (seven beats in eight).
  //   stored watermark is fresh      one read, one write, no push.
  //   stored watermark is stale      the same plus a queued push: an arrival.
  //
  // limits.ts derives the interval and staleness threshold from hearth's
  // heartbeat (a ten-person call costs 900 rows an hour, not 72,000).
  private notePresence(sql: SqlStorage, event: NostrEvent): void {
    const now = nowSeconds();

    // An explicit leave clears the row, so a deliberate return is announced
    // however soon it comes. A dropped connection returning inside
    // PRESENCE_STALE_SECONDS stays silent, which is correct for that case.
    if (presenceStatus(event) === "leave") {
      this.presenceWrites.delete(event.pubkey);
      clearPresence(sql, event.pubkey);
      return;
    }

    const written = this.presenceWrites.get(event.pubkey);
    if (written !== undefined && now - written < PRESENCE_WRITE_INTERVAL_SECONDS) return;

    // Read BEFORE the write: the stored watermark's age is the only thing
    // that tells an arrival from a beat once memory is gone.
    const stored = lastPresenceAt(sql, event.pubkey);
    recordPresence(sql, event.pubkey, now);
    this.rememberPresenceWrite(event.pubkey, now);

    // Inside the staleness window means continuous beating, since a live
    // row is refreshed every PRESENCE_WRITE_INTERVAL_SECONDS at the latest.
    if (stored !== null && now - stored <= PRESENCE_STALE_SECONDS) return;
    queuePush(sql, "voice", event.pubkey, now);
    this.pushAlarmWanted = true;
  }

  // Bounded (limits.ts PRESENCE_MAX_TRACKED) because it is keyed by pubkey
  // and membership is not bounded. A prune drops entries older than the
  // write interval, keeping those most likely still in a call.
  private rememberPresenceWrite(pubkey: string, nowSec: number): void {
    if (this.presenceWrites.size >= PRESENCE_MAX_TRACKED) {
      const cutoff = nowSec - PRESENCE_WRITE_INTERVAL_SECONDS;
      for (const [key, written] of this.presenceWrites) {
        if (written <= cutoff) this.presenceWrites.delete(key);
      }
      // Still full: more live participants than the map is sized for.
      // Cleared outright; the cost is at most one duplicate notification
      // each, against unbounded memory.
      if (this.presenceWrites.size >= PRESENCE_MAX_TRACKED) this.presenceWrites.clear();
    }
    this.presenceWrites.set(pubkey, nowSec);
  }

  // Schedules the drain, once per invocation that queued anything. Only
  // moves the alarm sooner, like scheduleLiveFeedAlarm: there is one alarm
  // shared with the live feed, and setAlarm is a row write.
  // PUSH_ALARM_DELAY_MS is also the coalescing window: a message inside it
  // finds an alarm already due sooner and writes nothing.
  private async settlePushAlarm(): Promise<void> {
    if (!this.pushAlarmWanted) return;
    this.pushAlarmWanted = false;
    const desired = Date.now() + PUSH_ALARM_DELAY_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > desired) {
      await this.ctx.storage.setAlarm(desired);
    }
  }

  // Nobody with an open socket is pushed to (reference/push.md): they
  // already see what arrived. Only authenticated sockets count; group
  // reads and gift wrap reads both require NIP-42, so a client reading
  // either has authenticated. No storage: the pubkey is in the attachment.
  private onlinePubkeys(): Set<string> {
    const online = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) continue;
      const authed = getState(ws).authedPubkey;
      if (authed !== undefined) online.add(authed);
    }
    return online;
  }

  // Announces mail (schema.ts `inbox_push`): each queued recipient's own
  // devices get one "message" push, the same payload a group message
  // gets, the room name and the word and nothing else. The relay could
  // not add a sender or a conversation if it wanted to: a gift wrap is
  // signed by a throwaway key and its contents are sealed.
  //
  // Recipients are served whole or not at all, oldest first, until the
  // subrequest budget would run out; the rest wait for the next alarm. A
  // recipient online now, or with no devices left (removed, or every
  // endpoint gone), is dequeued without a push.
  //
  // Returns how many subrequests it spent and whether anyone is still
  // queued.
  private async drainInboxPushes(budget: number): Promise<{ spent: number; more: boolean }> {
    const keys = vapidKeys(this.env);
    if (keys === null) return { spent: 0, more: false };
    const sql = this.sql;
    const nowSec = nowSeconds();
    const online = this.onlinePubkeys();

    const plan = withReadPath("push", () => {
      // One more than could possibly be served, so "more" is known without
      // a second query.
      const pending = pendingInboxPushes(sql, budget + 1);
      if (pending.length === 0) return null;
      const payload: PushPayload = {
        room: resolveName(this.env, getRelaySettings(sql), getOwnerProfile(sql, this.env)),
        kind: "message",
      };
      const subject = pushSubject(getOwnHost(sql));
      let left = budget;
      const serve: { pubkey: string; targets: PushFanoutRow[] }[] = [];
      const skip: string[] = [];
      let more = false;
      for (const pubkey of pending) {
        if (online.has(pubkey)) {
          skip.push(pubkey);
          continue;
        }
        const targets = pushSubscriptionsFor(sql, pubkey);
        if (targets.length === 0) {
          skip.push(pubkey);
          continue;
        }
        if (targets.length > left) {
          more = true;
          break;
        }
        serve.push({ pubkey, targets });
        left -= targets.length;
      }
      // The extra row read above was there: somebody beyond this batch is
      // waiting, whatever happened to the ones before them.
      if (pending.length > budget) more = true;
      return { payload, subject, serve, skip, more };
    });
    if (plan === null) return { spent: 0, more: false };

    const results = await Promise.all(
      plan.serve.map(async (entry) => ({
        entry,
        outcomes: await Promise.all(
          entry.targets.map((target) => sendPush(keys, plan.subject, target, plan.payload, nowSec)),
        ),
      })),
    );

    let spent = 0;
    withReadPath("push", () => {
      for (const pubkey of plan.skip) clearInboxPush(sql, pubkey);
      for (const { entry, outcomes } of results) {
        spent += outcomes.length;
        outcomes.forEach((outcome, index) => this.settlePushOutcome(sql, entry.targets[index]!, outcome, nowSec));
        clearInboxPush(sql, entry.pubkey);
      }
    });
    return { spent, more: plan.more };
  }

  // What one send's outcome does to its subscription row, shared by both
  // drains. 404/410: the endpoint is gone for good, so the row goes
  // (reference/push.md "Cleanup"). Anything else (429, 5xx, network)
  // keeps the row; this notification just misses that device, with no
  // retry queue, since a retried notification is stale by the time it
  // lands. A success refreshes last_ok_at at most once a day (limits.ts
  // PUSH_LAST_OK_INTERVAL_SECONDS), never per push.
  private settlePushOutcome(sql: SqlStorage, target: PushFanoutRow, outcome: string, nowSec: number): void {
    if (outcome === "gone") {
      forgetPushEndpoint(sql, target.endpoint);
      return;
    }
    if (outcome !== "sent") return;
    if (target.last_ok_at === null || nowSec - target.last_ok_at >= PUSH_LAST_OK_INTERVAL_SECONDS) {
      markPushEndpointOk(sql, target.endpoint, nowSec);
    }
  }

  // One batch of the fan-out. Returns true when the alarm should come back
  // for more.
  //
  // Bounded by SUBREQUESTS: Workers Free allows 50 per invocation and each
  // push is one, so sixty endpoints (twenty members, three devices each)
  // cannot be served in one invocation. limits.ts MAX_PUSHES_PER_TICK is
  // one invocation's spend, the outbox row's cursor is where the next
  // resumes, and past MAX_PUSH_ENDPOINTS_PER_NOTIFICATION the remainder is
  // dropped, with a log line so it is not mistaken for finishing.
  //
  // Reads and writes sit in separate synchronous withReadPath scopes with
  // the awaits between them; a scope must not straddle an await.
  //
  // `budget`: the subrequests this invocation has left after
  // drainInboxPushes, which runs first.
  private async drainPushOutbox(budgetLeft: number): Promise<boolean> {
    const keys = vapidKeys(this.env);
    if (keys === null) return false;
    const sql = this.sql;
    const nowSec = nowSeconds();
    const online = this.onlinePubkeys();

    const plan = withReadPath("push", () => {
      const pending = pendingPushes(sql);
      if (pending.length === 0) return null;
      const owner = getOwnerPubkey(sql, this.env);
      // isGroupMember with no group id checks the top-level group
      // (TOP_LEVEL_GROUP_ID) only, whichever group the queued message was
      // in: the outbox row does not record a group.
      const membership = new Map<string, boolean>();
      const isMember = (pubkey: string): boolean => {
        if (owner !== null && pubkey === owner) return true;
        let member = membership.get(pubkey);
        if (member === undefined) {
          member = isGroupMember(sql, pubkey);
          membership.set(pubkey, member);
        }
        return member;
      };
      // The payload carries the room name and the notification kind and
      // NOTHING else (not the message, not the sender): it passes through
      // Apple's or Google's push service, and the name is already public as
      // the NIP-11 `name`.
      const payloadRoom = resolveName(this.env, getRelaySettings(sql), getOwnerProfile(sql, this.env));
      const subject = pushSubject(getOwnHost(sql));

      let budget = budgetLeft;
      const batches: {
        reason: string;
        payload: PushPayload;
        page: PushFanoutRow[];
        targets: PushFanoutRow[];
        exhausted: boolean;
        sent: number;
      }[] = [];
      for (const row of pending) {
        // Out of subrequests. Rows not reached set `deferred` below, so the
        // alarm is rescheduled for them rather than waiting for an
        // unrelated event to queue another.
        if (budget <= 0) break;
        // No larger than the subrequests left.
        const page = pushSubscriptionsAfter(sql, row.cursor, budget);
        const targets = page
          .filter((sub) => !row.actors.includes(sub.pubkey))
          .filter((sub) => !online.has(sub.pubkey))
          .filter((sub) => isMember(sub.pubkey));
        batches.push({
          reason: row.reason,
          payload: { room: payloadRoom, kind: row.reason as PushReason },
          page,
          targets,
          // A short page is the end of the table. The cap is the other
          // way out, and the only one that loses a notification.
          exhausted: page.length < budget,
          sent: row.sent,
        });
        budget -= targets.length;
      }
      return { subject, batches, deferred: batches.length < pending.length };
    });
    if (plan === null) return false;

    // The one place this Durable Object reaches the network; see push.ts
    // sendPush for why an alarm may (a completed HTTPS request does not
    // block hibernation; an outbound WebSocket would). Concurrent: the
    // runtime queues against its own connection limit, and sequential
    // round trips would only multiply wall clock.
    const results = await Promise.all(
      plan.batches.map(async (batch) => ({
        batch,
        outcomes: await Promise.all(
          batch.targets.map((target) => sendPush(keys, plan.subject, target, batch.payload, nowSec)),
        ),
      })),
    );

    let more = plan.deferred;
    withReadPath("push", () => {
      for (const { batch, outcomes } of results) {
        outcomes.forEach((outcome, index) => this.settlePushOutcome(sql, batch.targets[index]!, outcome, nowSec));
        const sent = batch.sent + outcomes.filter((outcome) => outcome === "sent").length;
        const last = batch.page[batch.page.length - 1];
        if (batch.exhausted || last === undefined) {
          clearPush(sql, batch.reason);
          continue;
        }
        if (sent >= MAX_PUSH_ENDPOINTS_PER_NOTIFICATION) {
          // Stop rather than wake somebody about stale traffic, and say so,
          // since stopping quietly would look like finishing.
          console.warn(
            `push: dropped the rest of a "${batch.reason}" notification after ` +
              `${sent} endpoints (limits.ts MAX_PUSH_ENDPOINTS_PER_NOTIFICATION); ` +
              `this group has more subscribed devices than one notification may fan out to`,
          );
          clearPush(sql, batch.reason);
          continue;
        }
        advancePush(sql, batch.reason, last.endpoint, sent);
        more = true;
      }
    });
    return more;
  }

  // One "req" read-metrics entry per REQ frame.
  private handleReq(ws: WebSocket, frame: unknown[]): void {
    withReadPath("req", () => this.handleReqInner(ws, frame));
  }

  // Every CLOSED a REQ is refused with goes through here, so
  // conn-metrics.ts can count refusals by reason.
  private refuse(ws: WebSocket, subId: string, reason: string): void {
    noteRefusal(reason);
    send(ws, ["CLOSED", subId, reason]);
  }

  private handleReqInner(ws: WebSocket, frame: unknown[]): void {
    const subId = frame[1];
    if (typeof subId !== "string") {
      send(ws, ["NOTICE", "error: malformed REQ"]);
      return;
    }

    const state = getState(ws);
    if (!(subId in state.subs) && Object.keys(state.subs).length >= MAX_SUBSCRIPTIONS_PER_CONNECTION) {
      this.refuse(ws, subId, "rate-limited: too many open subscriptions");
      return;
    }

    // Filters per frame (limits.ts MAX_FILTERS_PER_REQ), bounded before any
    // is parsed or priced: the per-IP throttle counts a frame once however
    // many filters it carries. Not the same bound as
    // MAX_SUBSCRIPTIONS_PER_CONNECTION above, which a reused subId
    // legitimately skips (NIP-01: a REQ on a live id replaces its filters).
    const rawFilters = frame.slice(2);
    if (rawFilters.length > MAX_FILTERS_PER_REQ) {
      this.refuse(
        ws,
        subId,
        `invalid: too many filters in one REQ (${rawFilters.length}), at most ${MAX_FILTERS_PER_REQ}`,
      );
      return;
    }

    // MAX_FILTER_ROWS_READ is a per-REQ budget, split equally across the
    // frame's filters (per filter, ten filters would read ten times the
    // cap). Equal shares rather than a running budget so filter order does
    // not change the answer. boundFilter (limits.ts) then admits each
    // filter only at a limit its access path can afford within its share.
    const perFilterBudget = Math.floor(MAX_FILTER_ROWS_READ / Math.max(1, rawFilters.length));

    // Who this connection is, resolved once for all the read gates below.
    // An unauthenticated client pays no storage read here (the `&&`
    // short-circuits), and that must stay true.
    //
    // Three permissions:
    //
    //   gift wraps    the owner, all of them; anyone else authenticated,
    //                 only those addressed to them, and only by asking for
    //                 exactly that (readsOnlyOwnMail). That is how a member
    //                 reads their inbox, and how a removed member reads
    //                 what was stored for them until it is swept.
    //   groups        the owner, or a member of that group, from
    //                 `group_membership`, the same list nip29.ts
    //                 authorizeGroupWrite uses, so anyone who may write to
    //                 a group may read it back.
    //   invite codes  the owner alone, even inside a group partition
    //                 members read: a kind-9009 carries a bearer-token
    //                 code, so a member who could read one could mint
    //                 memberships. Withheld by omission, not refusal
    //                 (groups.ts CREATE_INVITE_KIND, filters.ts
    //                 FilterQueryOptions.excludeInvites).
    //
    // broadcast() enforces all three again and must agree exactly: a
    // subscription registered here is never re-examined, so a rule widened
    // in one place and not the other leaks through the other.
    const authedPubkey = state.authedPubkey;
    const authedAsOwner =
      authedPubkey !== undefined && authedPubkey === getOwnerPubkey(this.sql, this.env);
    const mayReadGiftWraps = authedAsOwner;
    const mayReadInvites = authedAsOwner;
    // Which groups. `undefined` means unrestricted (the owner), which binds
    // no parameters (filters.ts FilterQueryOptions.groupIds); everyone else
    // gets the groups they are a member of (one indexed lookup; none when
    // unauthenticated).
    const readableGroups: readonly string[] | undefined = authedAsOwner
      ? undefined
      : authedPubkey === undefined
        ? []
        : listMemberGroups(this.sql, authedPubkey);
    const mayReadGroups = readableGroups === undefined || readableGroups.length > 0;
    // Bounded because the group condition binds a parameter per group
    // (limits.ts MAX_SCOPED_GROUPS). Refused with a remedy rather than
    // silently reading fewer groups than the reader is entitled to.
    if (readableGroups !== undefined && readableGroups.length > MAX_SCOPED_GROUPS) {
      this.refuse(
        ws,
        subId,
        `restricted: you are in more than ${MAX_SCOPED_GROUPS} groups -- name the one you want with "#h"`,
      );
      return;
    }
    // Which partitions this read covers. Passed to boundFilter because the
    // filter runs once per partition, so a group reader is priced for both.
    const scopes: readonly GroupScope[] = mayReadGroups ? ALL_SCOPES : [PUBLIC_SCOPE];

    const filters: Filter[] = [];
    for (const raw of rawFilters) {
      const filter = parseFilter(raw);
      if (!filter) {
        this.refuse(ws, subId, "error: malformed filter");
        return;
      }
      const bound = boundFilter(filter, perFilterBudget, scopes.length);
      if (!bound.ok) {
        this.refuse(ws, subId, bound.reason);
        return;
      }
      filters.push(bound.filter);
    }

    // The read gates for gift wraps and groups share one rule:
    // REFUSAL LEAKS, OMISSION DOES NOT.
    //
    // A filter that NAMES what it may not read (kind 1059, or a group via
    // groups.ts filterNamesGroup) is refused from the filter alone, with no
    // storage access: the client already said what it wants, so being told
    // to authenticate reveals nothing.
    //
    // Any other filter is answered normally with those rows OMITTED in SQL
    // (filters.ts excludeGiftWraps and the partition scope). It must never
    // be refused on the strength of what storage holds: refusing when a
    // wrap fell inside `since`/`until` and answering EOSE when none did
    // would let an unauthenticated client bisect the window into exact
    // arrival times and an exact inbox count. Omission answers the same
    // whether or not anything is there.
    //
    // For groups, "names a group this reader may not read" is every group
    // when unauthenticated and every group but their own for a member.
    if (filters.some((f) => filterNamesGroup(f, readableGroups))) {
      if (state.authedPubkey === undefined) {
        if (!state.challenge) {
          state.challenge = crypto.randomUUID();
          setState(ws, state);
        }
        send(ws, ["AUTH", state.challenge]);
        this.refuse(ws, subId, "auth-required: authentication required to read group events");
      } else {
        this.refuse(ws, subId, "restricted: not allowed to read group events");
      }
      return;
    }
    if (
      !mayReadGiftWraps &&
      filters.some(
        (f) =>
          f.kinds?.includes(GIFT_WRAP_KIND) &&
          (state.authedPubkey === undefined || !readsOnlyOwnMail(f, state.authedPubkey)),
      )
    ) {
      if (state.authedPubkey === undefined) {
        if (!state.challenge) {
          state.challenge = crypto.randomUUID();
          setState(ws, state);
        }
        send(ws, ["AUTH", state.challenge]);
        this.refuse(ws, subId, "auth-required: authentication required to read gift wraps");
      } else {
        this.refuse(
          ws,
          subId,
          'restricted: you can read only the gift wraps addressed to you; ask with "#p" set to your own pubkey',
        );
      }
      return;
    }

    // Registered only once it is known to fit. The attachment has a hard
    // 16KiB ceiling that serializeAttachment enforces by throwing, which
    // would otherwise land after the events were sent, in place of EOSE;
    // the other caps admit filters that exceed it (400 authors serialize
    // to ~26KB). Checked on a copy, so a refused REQ leaves the existing
    // subscriptions intact.
    const next: ConnState = {
      ...state,
      subs: { ...state.subs, [subId]: filters },
      reqs: (state.reqs ?? 0) + 1,
      // Set here, after every refusal above, so a refused REQ cannot put
      // somebody in a room they never entered.
      ...(mayReadGroups ? { groupReader: true } : {}),
    };
    if (!stateFits(next)) {
      this.refuse(
        ws,
        subId,
        "invalid: filters are too large to hold open; name fewer authors or ids, " +
          "and split the request across several REQs",
      );
      return;
    }
    setState(ws, next);

    // Occupancy sample, then the chat horizon, paid only by a group
    // reader. Sample first: this arrival may make the room occupied, and
    // the horizon should describe the room with them in it.
    const now = nowSeconds();
    let horizon: number | undefined;
    if (mayReadGroups && chatMode(this.env) === "deleting") {
      this.noteRoomOccupancy(this.sql, now);
      horizon = chatHorizon(readChatState(this.sql), now);
    }

    const events = queryFilters(this.sql, filters, now, {
      excludeGiftWraps: !mayReadGiftWraps,
      // Somebody joining a conversation sees its last few minutes, not the
      // whole of it (limits.ts CHAT_BACKLOG_SECONDS). Applied to the owner
      // too: it describes what group chat is, not a permission. Only in
      // "deleting" mode; reporting mode withholds nothing.
      ...(horizon === undefined ? {} : { chatHorizon: horizon }),
      // Only when the group partition is read at all: a kind-9009 is a
      // group event, so a public read never sees one, and setting this
      // there would add a condition and a parameter to every public read.
      excludeInvites: mayReadGroups && !mayReadInvites,
      scopes,
      // Omitted for the owner (unrestricted); see filters.ts
      // FilterQueryOptions.groupIds.
      ...(readableGroups === undefined ? {} : { groupIds: readableGroups }),
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

  // NIP-42 AUTH, always answered with OK. Checked against the challenge
  // issued to this connection (state.challenge, set lazily by
  // handleReqInner); on success the pubkey is stored on the connection for
  // the read gates.
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
    // Kind and freshness, challenge match, relay tag, in that order. The
    // challenge match stays here because it compares against this
    // connection's own state; the other checks are shared with the HTTP
    // claim path (nip42.ts).
    const fresh = checkAuthFreshness(event, nowSeconds());
    if (!fresh.ok) {
      ok(ws, event.id, false, fresh.reason);
      return;
    }
    const state = getState(ws);
    const challenge = authChallenge(event);
    if (!challenge || !state.challenge || challenge !== state.challenge) {
      ok(ws, event.id, false, "invalid: no matching challenge was issued");
      return;
    }
    const relayCheck = checkAuthRelayTag(event, state.host);
    if (!relayCheck.ok) {
      ok(ws, event.id, false, relayCheck.reason);
      return;
    }
    state.authedPubkey = event.pubkey;
    setState(ws, state);
    ok(ws, event.id, true, "");
  }

  private broadcast(event: NostrEvent): void {
    // handleReqInner's gate decides a REQ once and never re-examines the
    // subscription it leaves open, so this path enforces the same three
    // permissions itself, and the two must agree exactly. For example,
    // `{"#p":[owner]}` admitted while the inbox is empty matches every
    // later gift wrap, and an unauthenticated `{"kinds":[1]}` matches
    // later group kind-1s.
    //
    //   gift wrap    the owner; anyone else only on a subscription that
    //                asked for their own mail (readsOnlyOwnMail), which
    //                the REQ gate already required of any filter naming
    //                kind 1059. Checked again per filter here anyway, so
    //                the two cannot drift.
    //   kind-9009    owner only, even inside a group the reader belongs
    //                to: a member holding `{"kinds":[9009]}` would
    //                otherwise receive a live invite code the moment the
    //                owner publishes one.
    //   other group  owner, or a member of the event's own group
    //                (`group_membership`, as the REQ and write gates use).
    //
    // The owner is looked up only for a gated event, and membership is
    // memoised per broadcast, so ungated events pay no reads.
    const giftWrap = event.kind === GIFT_WRAP_KIND;
    const gated = giftWrap || isGroupEvent(event, groupHost(this.sql));
    const ownerOnly = giftWrap || event.kind === CREATE_INVITE_KIND;
    const owner = gated ? getOwnerPubkey(this.sql, this.env) : null;
    // Membership is checked against this event's own group: a member of A
    // with an open subscription naming no group must not be pushed B's
    // traffic.
    const eventGroup = gated && !giftWrap ? groupIdOf(event) : null;
    const membership = new Map<string, boolean>();
    const mayReceive = (authed: string | undefined): boolean => {
      if (authed === undefined) return false;
      if (owner !== null && authed === owner) return true;
      if (ownerOnly) return false;
      if (eventGroup === null) return false;
      let member = membership.get(authed);
      if (member === undefined) {
        member = isGroupMember(this.sql, authed, eventGroup);
        membership.set(authed, member);
      }
      return member;
    };
    for (const ws of this.ctx.getWebSockets()) {
      // getWebSockets() with no tag includes live feed sockets, which carry
      // a LiveFeedState, not a ConnState; liveBroadcast serves them.
      if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) continue;
      const state = getState(ws);
      const authed = state.authedPubkey;
      if (giftWrap && authed !== undefined && authed !== owner) {
        // Their own mail, on a subscription that asked for it, and nothing
        // else: matchesAnyFilter then checks the wrap's `p` is theirs.
        for (const [subId, filters] of Object.entries(state.subs)) {
          const own = filters.filter((f) => f.kinds?.includes(GIFT_WRAP_KIND) && readsOnlyOwnMail(f, authed));
          if (own.length > 0 && matchesAnyFilter(event, own)) send(ws, ["EVENT", subId, event]);
        }
        continue;
      }
      if (gated && !mayReceive(authed)) continue;
      for (const [subId, filters] of Object.entries(state.subs)) {
        if (matchesAnyFilter(event, filters)) {
          send(ws, ["EVENT", subId, event]);
        }
      }
    }
  }

  // Pushes a redacted notice (kind, time, first 8 hex of id; never tags or
  // content) of a newly stored event to every live feed connection.
  //
  // The live feed has no authentication at all, so every viewer is the
  // unauthenticated case: gift wraps and group-partition events
  // (groups.ts isGroupEvent) are never sent, since even the redacted
  // notice would time each one to the second. There is deliberately no
  // owner or member case here: a live feed socket cannot be anybody.
  private liveBroadcast(event: NostrEvent): void {
    if (event.kind === GIFT_WRAP_KIND || isGroupEvent(event, groupHost(this.sql))) return;
    const live = this.ctx.getWebSockets(LIVE_FEED_TAG);
    if (live.length === 0) return;
    const notice = JSON.stringify({ kind: event.kind, created_at: event.created_at, id: event.id.slice(0, 8) });
    for (const ws of live) {
      ws.send(notice);
    }
  }

  // Ensures the alarm fires no later than this live feed connection's
  // expiry. An alarm, not a timer: the platform wakes an evicted object for
  // it and lets it hibernate again, where setTimeout would pin it in
  // memory. Only moves the alarm sooner, since alarm() reschedules for the
  // next expiry itself and each setAlarm is a row written.
  private async scheduleLiveFeedAlarm(): Promise<void> {
    const desired = Date.now() + LIVE_FEED_MAX_LIFETIME_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > desired) {
      await this.ctx.storage.setAlarm(desired);
    }
  }

  // The single DO alarm, with two jobs: the push fan-out, and closing live
  // feed connections past LIVE_FEED_MAX_LIFETIME_MS. Either may be why it
  // fired; neither may assume it was.
  override async alarm(): Promise<void> {
    return this.metered(() => this.alarmInner());
  }

  private async alarmInner(): Promise<void> {
    // Push first: it is the one with a deadline. Mail before group
    // traffic: it is for one person, and it is the reason most members
    // have push at all. The two share one invocation's subrequests.
    const inbox = await this.drainInboxPushes(MAX_PUSHES_PER_TICK);
    const moreGroupPushes = await this.drainPushOutbox(MAX_PUSHES_PER_TICK - inbox.spent);
    const morePushes = inbox.more || moreGroupPushes;

    const now = Date.now();
    let next: number | null = morePushes ? now + PUSH_ALARM_DELAY_MS : null;
    for (const ws of this.ctx.getWebSockets(LIVE_FEED_TAG)) {
      const expiresAt = getLiveFeedState(ws).connectedAt + LIVE_FEED_MAX_LIFETIME_MS;
      if (expiresAt <= now) {
        ws.close(1000, "live feed connection lifetime exceeded, reconnect");
      } else if (next === null || expiresAt < next) {
        next = expiresAt;
      }
    }
    // Whichever is sooner, in one setAlarm: scheduling for only one job
    // would strand the other.
    if (next !== null) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // The runtime reports reserved codes here (1005 no status, 1006 no
    // close frame, e.g. a dropped connection; 1015 TLS failure). Echoing
    // one back throws `Invalid WebSocket close code`, which would happen
    // on every abnormal disconnect, so those are answered with 1000.
    if (this.ctx.getTags(ws).includes(LIVE_FEED_TAG)) {
      noteClose("live", code, undefined, undefined);
    } else {
      const state = getState(ws);
      noteClose("nostr", code, state.connectedAt, state.reqs);
    }
    ws.close(RESERVED_CLOSE_CODES.has(code) ? NORMAL_CLOSURE : code, reason);
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close();
  }
}
