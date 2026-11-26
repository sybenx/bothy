// Home groups: the DMs app's groups with a group key (dms
// docs/next-round/groups.md). Not NIP-29 (src/nip29.ts), which stays paused
// and untouched.
//
// What bothy keeps for a group:
//   - the ROSTER: who is in, who is admin, two settings. Changed only by a
//     SIGNED CHANGE (kind 1491) from a member allowed to make it, applied one
//     at a time against the version it names. bothy's own key signs only
//     removals (cut off, erased), leaves and "longest-standing member is now
//     admin": bothy may remove, never add, so a member's app that checks the
//     chain knows nobody was slipped in.
//   - each member's ENVELOPE of each key epoch, sealed by whoever made the
//     key. bothy cannot open one.
//   - the group's TRAFFIC, sealed messages (kind 1490, throwaway signer) and
//     the changes, numbered from the home's one running seq.
//
// Nothing here enters `events`, so no REQ, broadcast or live feed path built
// for public or NIP-29 data can serve a group message. Reads are groupsince
// (stored, with seq) and a live-only REQ answered by relay.ts.
import { computeEventId, verifySignature } from "./validate";
import type { NostrEvent } from "./nostr";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { getRelayPubkey, signAsRelay } from "./relay-identity";
import { INVITE_MAX_TTL_SECONDS } from "./limits";
import { isPubkeyBanned, isRemovedOnPurpose, roleOf, storagePubkey } from "./storage";

export const GROUP_MESSAGE_KIND = 1490;
export const GROUP_CHANGE_KIND = 1491;
export const GROUP_KINDS: readonly number[] = [GROUP_MESSAGE_KIND, GROUP_CHANGE_KIND];

// ---------------------------------------------------------------------
// THE OPEN OWNER DECISIONS (groups.md "Owner decisions"), in one place.
// Each is built to the design's default or Messenger's behaviour until
// Aaron answers.
// ---------------------------------------------------------------------
export const GROUP_DECISIONS = {
  // 3 (answered 2026-11-23: yes): people from outside this home may be
  // added, as guests who can use only that group here.
  guests: true,
  // 4 (open): someone cut off from the home (unallowpubkey, banpubkey,
  // eraseme) leaves every group on it, and cannot be added back while cut off.
  cutOffLeavesGroups: true,
  // 7 (answered 2026-11-23: 100; raised 2026-11-26: 500): the most people
  // in one group, the keeper not counted. At 500 a message still costs one
  // stored row plus, per member with push, a push-queue check and write
  // (relay.ts wakeOnly); pushes past MAX_PUSHES_PER_TICK go on the next tick.
  maxMembers: 500,
  // 2 (answered 2026-11-23: the box ALWAYS holds every group's key, no
  // opt-out) and 9. The keeper is the home's storage service (setstorage's
  // key): every group on the home has it in its envelopes (keeperPlus), and
  // no group can keep it out. A home with no storage has no keeper, and its
  // groups are basic.
  keeperIsStorage: true,
} as const;

// 6 (open) and 1 (answered 2026-11-23: on, all of the past) are group
// settings the creator's app proposes; bothy enforces
// whatever the roster says. These are what a group gets when its create
// change says nothing.
export const DEFAULT_GROUP_SETTINGS: GroupSettings = { onlyAdminsAdd: false, history: true };

export interface GroupSettings {
  onlyAdminsAdd: boolean;
  history: boolean;
}

const GID_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
// A sealed key: NIP-44 of about 150 bytes plus a little JSON. Generous.
const MAX_ENVELOPE_CHARS = 1024;
// A change is signed now, not replayed from long ago.
const CHANGE_MAX_AGE_SECONDS = 600;
export const MAX_GROUPSINCE = 500;
const FORMER_KEPT_SECONDS = 30 * 86400;

export const GROUP_CHANGED_MESSAGE = "groupchange: the group changed while you were changing it";
export const NOT_IN_GROUP_MESSAGE = "you are not in this group";

type Op = "create" | "add" | "remove" | "admin" | "unadmin" | "settings" | "key" | "leave" | "link" | "unlink" | "join";
const MEMBER_OPS: readonly Op[] = ["add", "remove", "admin", "unadmin", "settings", "key", "link", "unlink"];

export interface GroupOutboxEntry {
  gid: string;
  event: NostrEvent;
  // Who gets the content-free wake: everyone affected but the actor.
  wake: string[];
}

export interface GroupReply {
  result?: unknown;
  error?: string;
  version?: number;
  groupOutbox?: GroupOutboxEntry[];
  // People to wake with no event to deliver (a key sealed to them).
  wake?: string[];
}

type GroupRow = {
  gid: string;
  version: number;
  epoch: number;
  needs_key: number;
  settings: string;
};

type MemberRow = {
  pubkey: string;
  role: string;
  from_seq: number;
  joined_at: number;
  join_epoch?: number;
  pending_key?: number;
};

function err(message: string): GroupReply {
  return { error: message };
}

function groupRow(sql: SqlStorage, gid: string): GroupRow | null {
  return (
    sql
      .exec<GroupRow>(`SELECT gid, version, epoch, needs_key, settings FROM home_groups WHERE gid = ?`, gid)
      .toArray()[0] ?? null
  );
}

function membersOf(sql: SqlStorage, gid: string): MemberRow[] {
  return sql
    .exec<MemberRow>(
      `SELECT pubkey, role, from_seq, joined_at, join_epoch, pending_key FROM home_group_members WHERE gid = ? ORDER BY from_seq, pubkey`,
      gid,
    )
    .toArray();
}

export function memberOf(sql: SqlStorage, gid: string, pubkey: string): MemberRow | null {
  return (
    sql
      .exec<MemberRow>(
        `SELECT pubkey, role, from_seq, joined_at, join_epoch, pending_key FROM home_group_members WHERE gid = ? AND pubkey = ?`,
        gid,
        pubkey,
      )
      .toArray()[0] ?? null
  );
}

export function rosterPubkeys(sql: SqlStorage, gid: string): string[] {
  return sql
    .exec<{ pubkey: string }>(`SELECT pubkey FROM home_group_members WHERE gid = ?`, gid)
    .toArray()
    .map((r) => r.pubkey);
}

// In any group here: what lets someone from outside the home register push
// and read and write that group (a guest).
export function isInAnyGroup(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM home_group_members WHERE pubkey = ? LIMIT 1`, pubkey).toArray().length > 0;
}

export function groupEpoch(sql: SqlStorage, gid: string): number | null {
  return groupRow(sql, gid)?.epoch ?? null;
}

function parseSettings(text: string): GroupSettings {
  try {
    const value = JSON.parse(text) as Partial<GroupSettings>;
    return {
      onlyAdminsAdd: value.onlyAdminsAdd === true,
      history: value.history !== false,
    };
  } catch {
    return { ...DEFAULT_GROUP_SETTINGS };
  }
}

// Reads may start at a member's from_seq. On a home with a keeper and the
// switch on (the default) they read everything; with no keeper new members
// start from when they joined, whatever the switch says.

// The box that keeps every group's keys on this home (GROUP_DECISIONS), or null.
export function keeperOf(sql: SqlStorage): string | null {
  if (!GROUP_DECISIONS.keeperIsStorage) return null;
  const pk = storagePubkey(sql);
  return pk !== null && HEX64_RE.test(pk) ? pk : null;
}
function startsFromJoin(sql: SqlStorage, settings: GroupSettings): boolean {
  return !settings.history || keeperOf(sql) === null;
}

// ---------------------------------------------------------------------
// The home's running number, shared with gift wraps (storage.ts
// insertEventRow, schema.ts mail_usage.seq). Group bytes count against the
// sender's mail share and the home's total; `n` (a recipient's waiting
// wraps) is left alone.
// ---------------------------------------------------------------------

function nextSeq(sql: SqlStorage): number {
  return (sql.exec<{ seq: number }>(`SELECT seq FROM mail_usage WHERE pubkey = '*'`).toArray()[0]?.seq ?? 0) + 1;
}

function chargeBytes(sql: SqlStorage, keys: string[], bytes: number, seq: number | null): void {
  for (const key of ["*", ...keys]) {
    sql.exec(
      `INSERT INTO mail_usage (pubkey, bytes, n, seq) VALUES (?, MAX(?, 0), 0, ?)
         ON CONFLICT(pubkey) DO UPDATE SET bytes = MAX(bytes + ?, 0), seq = MAX(seq, excluded.seq)`,
      key,
      bytes,
      key === "*" && seq !== null ? seq : 0,
      bytes,
    );
  }
}

function storeGroupEvent(
  sql: SqlStorage,
  gid: string,
  event: NostrEvent,
  sender: string,
  version: number | null,
  nowSec: number,
): number {
  const text = JSON.stringify(event);
  const seq = nextSeq(sql);
  sql.exec(
    `INSERT INTO home_group_events (seq, gid, id, kind, sender, version, stored_at, bytes, event)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    seq,
    gid,
    event.id,
    event.kind,
    sender,
    version,
    nowSec,
    text.length,
    text,
  );
  // A change is charged to the home only: it is the group's, not a message.
  chargeBytes(sql, event.kind === GROUP_MESSAGE_KIND ? [sender] : [], text.length, seq);
  return seq;
}

export function groupEventExists(sql: SqlStorage, id: string): boolean {
  return sql.exec(`SELECT 1 FROM home_group_events WHERE id = ? LIMIT 1`, id).toArray().length > 0;
}

// A sealed message from `sender`, already checked by relay.ts: stored with
// the next home number. Returns the seq.
export function storeGroupMessage(sql: SqlStorage, gid: string, event: NostrEvent, sender: string, nowSec: number): number {
  return storeGroupEvent(sql, gid, event, sender, null, nowSec);
}

// ---------------------------------------------------------------------
// Signed changes
// ---------------------------------------------------------------------

interface ParsedChange {
  event: NostrEvent;
  op: Op;
  targets: string[];
  settings: GroupSettings | null;
}

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}

// The shape every member-signed change must have. `method` prefixes the
// refusal so an app can tell which call said it.
function parseChange(
  method: string,
  raw: unknown,
  gid: string,
  baseVersion: number,
  signer: string,
  nowSec: number,
): ParsedChange | string {
  const e = raw as NostrEvent | null;
  if (
    typeof e !== "object" ||
    e === null ||
    typeof e.id !== "string" ||
    typeof e.pubkey !== "string" ||
    typeof e.sig !== "string" ||
    typeof e.kind !== "number" ||
    typeof e.created_at !== "number" ||
    typeof e.content !== "string" ||
    !Array.isArray(e.tags) ||
    !e.tags.every((t) => Array.isArray(t) && t.every((v) => typeof v === "string"))
  ) {
    return `${method}: the change must be a signed event`;
  }
  if (e.kind !== GROUP_CHANGE_KIND) return `${method}: the change must be kind ${GROUP_CHANGE_KIND}`;
  if (e.pubkey !== signer) return `${method}: the change must be signed by you`;
  if (Math.abs(nowSec - e.created_at) > CHANGE_MAX_AGE_SECONDS) {
    return `${method}: the change must be made within ${CHANGE_MAX_AGE_SECONDS} seconds`;
  }
  if (computeEventId(e) !== e.id || !verifySignature(e)) return `${method}: the change's signature is invalid`;
  if (tagValue(e, "h") !== gid) return `${method}: the change's h tag must be this group`;
  if (tagValue(e, "v") !== String(baseVersion)) return `${method}: the change's v tag must be the version it was made on`;
  const op = tagValue(e, "op") as Op | undefined;
  if (op === undefined || !(["create", "join", ...MEMBER_OPS] as string[]).includes(op)) {
    return `${method}: the change's op must be one of create, join, ${MEMBER_OPS.join(", ")}`;
  }
  const targets = [...new Set(e.tags.filter((t) => t[0] === "p").map((t) => t[1] ?? ""))];
  if (!targets.every((p) => HEX64_RE.test(p))) return `${method}: every p tag must be a 64-character hex pubkey`;
  let settings: GroupSettings | null = null;
  if (op === "create" || op === "settings") {
    let parsed: unknown = {};
    if (e.content !== "") {
      try {
        parsed = JSON.parse(e.content);
      } catch {
        parsed = null;
      }
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return `${method}: the change's content must be the settings, {"onlyAdminsAdd", "history"}`;
    }
    const s = parsed as Record<string, unknown>;
    settings = {
      onlyAdminsAdd: typeof s.onlyAdminsAdd === "boolean" ? s.onlyAdminsAdd : DEFAULT_GROUP_SETTINGS.onlyAdminsAdd,
      history: typeof s.history === "boolean" ? s.history : DEFAULT_GROUP_SETTINGS.history,
    };
  }
  return { event: e, op, targets, settings };
}

interface Envelopes {
  epoch: number;
  keys: { to: string; blob: string }[];
}

function parseEnvelopes(method: string, raw: unknown): Envelopes | string | null {
  if (raw === undefined || raw === null) return null;
  const shape = `${method}: envelopes must be {"epoch": n, "keys": [{"to": "<hex>", "blob": "<sealed key>"}]}`;
  if (typeof raw !== "object" || Array.isArray(raw)) return shape;
  const r = raw as { epoch?: unknown; keys?: unknown };
  if (typeof r.epoch !== "number" || !Number.isInteger(r.epoch) || r.epoch < 1 || !Array.isArray(r.keys)) return shape;
  const keys: { to: string; blob: string }[] = [];
  const seen = new Set<string>();
  for (const k of r.keys as unknown[]) {
    const entry = k as { to?: unknown; blob?: unknown } | null;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.to !== "string" ||
      !HEX64_RE.test(entry.to) ||
      typeof entry.blob !== "string" ||
      entry.blob === "" ||
      entry.blob.length > MAX_ENVELOPE_CHARS
    ) {
      return shape;
    }
    if (seen.has(entry.to)) return `${method}: one envelope per person`;
    seen.add(entry.to);
    keys.push({ to: entry.to, blob: entry.blob });
  }
  return { epoch: r.epoch, keys };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

// Who may never be put in a group here: someone cut off from the home.
// Outsiders who were never members are guests (GROUP_DECISIONS.guests).
function cutOffReason(sql: SqlStorage, owner: string | null, pubkey: string): string | null {
  if (pubkey === owner) return null;
  const formerlyRemoved =
    sql
      .exec(`SELECT 1 FROM former_members WHERE pubkey = ? AND reason = 'removed'`, pubkey)
      .toArray().length > 0;
  if (isPubkeyBanned(sql, pubkey) || isRemovedOnPurpose(sql, pubkey) || formerlyRemoved) {
    return "that person was cut off from this home and cannot be added";
  }
  if (!GROUP_DECISIONS.guests && roleOf(sql, pubkey, owner) === "none") {
    return "only people in this home can be added here";
  }
  return null;
}

function storeKeys(sql: SqlStorage, gid: string, from: string, envelopes: Envelopes): void {
  for (const k of envelopes.keys) {
    sql.exec(
      `INSERT OR REPLACE INTO home_group_keys (gid, epoch, member, from_key, blob) VALUES (?, ?, ?, ?, ?)`,
      gid,
      envelopes.epoch,
      k.to,
      from,
      k.blob,
    );
  }
}

// A change bothy itself makes and signs (leave, a removal it was told to
// make, a promotion), so the chain stays one list of signed events.
function relayChange(sql: SqlStorage, gid: string, version: number, op: Op, target: string, reason: string, nowSec: number): NostrEvent {
  const unsigned = {
    pubkey: getRelayPubkey(sql),
    created_at: nowSec,
    kind: GROUP_CHANGE_KIND,
    tags: [
      ["h", gid],
      ["v", String(version)],
      ["op", op],
      ["p", target],
      ["reason", reason],
    ],
    content: "",
  };
  const id = computeEventId({ ...unsigned, id: "", sig: "" });
  return { ...unsigned, id, sig: signAsRelay(sql, id) };
}

function bumpVersion(sql: SqlStorage, gid: string, version: number): void {
  sql.exec(`UPDATE home_groups SET version = ? WHERE gid = ?`, version, gid);
}

function recordFormer(sql: SqlStorage, gid: string, pubkey: string, by: string, op: string, version: number, nowSec: number): void {
  sql.exec(`DELETE FROM home_group_members WHERE gid = ? AND pubkey = ?`, gid, pubkey);
  sql.exec(`DELETE FROM home_group_keys WHERE gid = ? AND member = ?`, gid, pubkey);
  sql.exec(
    `INSERT OR REPLACE INTO home_group_former (gid, pubkey, by_key, op, version, at) VALUES (?, ?, ?, ?, ?, ?)`,
    gid,
    pubkey,
    by,
    op,
    version,
    nowSec,
  );
}

// After people leave: if no admin is left, the longest-standing member (added
// earliest, then by key: from_seq, pubkey)
// becomes one (bothy-signed); if nobody is left, the group goes.
function settleAfterLeaving(sql: SqlStorage, gid: string, nowSec: number, outbox: GroupOutboxEntry[]): void {
  const members = membersOf(sql, gid);
  if (members.length === 0) {
    deleteGroup(sql, gid, nowSec);
    return;
  }
  if (members.some((m) => m.role === "admin")) return;
  const heir = members[0]!;
  const group = groupRow(sql, gid)!;
  const version = group.version + 1;
  const event = relayChange(sql, gid, version - 1, "admin", heir.pubkey, "promoted", nowSec);
  sql.exec(`UPDATE home_group_members SET role = 'admin' WHERE gid = ? AND pubkey = ?`, gid, heir.pubkey);
  bumpVersion(sql, gid, version);
  storeGroupEvent(sql, gid, event, event.pubkey, version, nowSec);
  outbox.push({ gid, event, wake: members.map((m) => m.pubkey) });
}

function deleteGroup(sql: SqlStorage, gid: string, nowSec: number): void {
  // Give the senders their bytes back.
  const charged = sql
    .exec<{ sender: string; kind: number; bytes: number }>(
      `SELECT sender, kind, SUM(bytes) AS bytes FROM home_group_events WHERE gid = ? GROUP BY sender, kind`,
      gid,
    )
    .toArray();
  for (const row of charged) {
    chargeBytes(sql, row.kind === GROUP_MESSAGE_KIND ? [row.sender] : [], -row.bytes, null);
  }
  sql.exec(`DELETE FROM home_group_events WHERE gid = ?`, gid);
  sql.exec(`DELETE FROM home_group_keys WHERE gid = ?`, gid);
  sql.exec(`DELETE FROM home_group_members WHERE gid = ?`, gid);
  stopLinks(sql, gid, null, nowSec);
  sql.exec(`DELETE FROM home_groups WHERE gid = ?`, gid);
}

// A guest with no group left here has no reason to keep devices here.
function dropGuestDevices(sql: SqlStorage, owner: string | null, pubkeys: readonly string[]): void {
  for (const pubkey of pubkeys) {
    if (roleOf(sql, pubkey, owner) !== "none" || isInAnyGroup(sql, pubkey)) continue;
    sql.exec(`DELETE FROM push_subscriptions WHERE pubkey = ?`, pubkey);
    sql.exec(`DELETE FROM fcm_tokens WHERE pubkey = ?`, pubkey);
    sql.exec(`DELETE FROM inbox_push WHERE pubkey = ?`, pubkey);
  }
}

// One person leaves one group (groupleave, or a removal bothy makes).
function leaveOne(
  sql: SqlStorage,
  gid: string,
  pubkey: string,
  op: "leave" | "remove",
  reason: string,
  nowSec: number,
  outbox: GroupOutboxEntry[],
): void {
  const group = groupRow(sql, gid);
  if (group === null || memberOf(sql, gid, pubkey) === null) return;
  const before = rosterPubkeys(sql, gid);
  const version = group.version + 1;
  const event = relayChange(sql, gid, group.version, op, pubkey, reason, nowSec);
  bumpVersion(sql, gid, version);
  sql.exec(`UPDATE home_groups SET needs_key = 1 WHERE gid = ?`, gid);
  storeGroupEvent(sql, gid, event, event.pubkey, version, nowSec);
  recordFormer(sql, gid, pubkey, event.pubkey, op, version, nowSec);
  outbox.push({ gid, event, wake: op === "leave" ? before.filter((p) => p !== pubkey) : before });
  settleAfterLeaving(sql, gid, nowSec, outbox);
}

// The removal hook (nip86.ts unallowpubkey, banpubkey, eraseme): each of
// these people leaves every group on this home, by a bothy-signed removal.
export function removeFromAllGroups(
  sql: SqlStorage,
  owner: string | null,
  pubkeys: readonly string[],
  reason: "cutoff" | "erased",
  nowSec: number,
): GroupOutboxEntry[] {
  const outbox: GroupOutboxEntry[] = [];
  if (!GROUP_DECISIONS.cutOffLeavesGroups && reason === "cutoff") return outbox;
  for (const pubkey of pubkeys) {
    const gids = sql
      .exec<{ gid: string }>(`SELECT gid FROM home_group_members WHERE pubkey = ?`, pubkey)
      .toArray()
      .map((r) => r.gid);
    for (const gid of gids) leaveOne(sql, gid, pubkey, "remove", reason, nowSec, outbox);
  }
  dropGuestDevices(sql, owner, pubkeys);
  return outbox;
}

// ---------------------------------------------------------------------
// The NIP-86 calls. index.ts lets any signature reach these (guests are
// not home members); each checks the roster itself.
// ---------------------------------------------------------------------

export const HOME_GROUP_METHODS: readonly string[] = [
  "groupcreate",
  "groupchange",
  "groupinfo",
  "mygroups",
  "groupkeys",
  "groupleave",
  "groupsince",
  "groupjoin",
  "groupseal",
  "keepergroups",
  "groupkept",
];

// The calls only the keeper (the home's storage service key) may make.
export const KEEPER_METHODS: readonly string[] = ["keepergroups", "groupkept"];

export function handleGroupCall(
  sql: SqlStorage,
  owner: string | null,
  method: string,
  params: unknown[],
  signer: string,
  nowSec: number,
): GroupReply {
  switch (method) {
    case "groupcreate":
      return groupCreate(sql, owner, params, signer, nowSec);
    case "groupchange":
      return groupChange(sql, owner, params, signer, nowSec);
    case "groupinfo":
      return groupInfo(sql, params, signer);
    case "mygroups":
      return myGroups(sql, signer, nowSec);
    case "groupkeys":
      return groupKeys(sql, params, signer);
    case "groupleave":
      return groupLeave(sql, owner, params, signer, nowSec);
    case "groupsince":
      return groupSince(sql, params, signer);
    case "groupjoin":
      return groupJoin(sql, owner, params, signer, nowSec);
    case "groupseal":
      return groupSeal(sql, params, signer);
    case "keepergroups":
      return keeperGroups(sql, signer);
    case "groupkept":
      return groupKept(sql, params, signer, nowSec);
  }
  return err(`unknown group method ${method}`);
}

function gidParam(params: unknown[]): string | null {
  const gid = params[0];
  return typeof gid === "string" && GID_RE.test(gid) ? gid : null;
}

function groupCreate(sql: SqlStorage, owner: string | null, params: unknown[], signer: string, nowSec: number): GroupReply {
  if (roleOf(sql, signer, owner) === "none") return err("groupcreate: only people in this home can start a group here");
  const gid = gidParam(params);
  if (gid === null) return err("groupcreate takes [gid (32 hex), change, envelopes]");
  if (groupRow(sql, gid) !== null) return err("groupcreate: a group with that id already exists");
  const change = parseChange("groupcreate", params[1], gid, 0, signer, nowSec);
  if (typeof change === "string") return err(change);
  if (change.op !== "create") return err("groupcreate: the change's op must be create");
  const others = change.targets.filter((p) => p !== signer);
  if (others.length + 1 > GROUP_DECISIONS.maxMembers) {
    return err(`groupcreate: a group can have at most ${GROUP_DECISIONS.maxMembers} people`);
  }
  for (const p of others) {
    const why = cutOffReason(sql, owner, p);
    if (why !== null) return err(`groupcreate: ${why}`);
  }
  const envelopes = parseEnvelopes("groupcreate", params[2]);
  if (typeof envelopes === "string") return err(envelopes);
  const roster = [signer, ...others];
  if (envelopes === null || envelopes.epoch !== 1 || !sameSet(envelopes.keys.map((k) => k.to), keeperPlus(sql, roster))) {
    return err("groupcreate: envelopes must be epoch 1, one for each person in the group");
  }
  const settings = change.settings ?? DEFAULT_GROUP_SETTINGS;
  sql.exec(
    `INSERT INTO home_groups (gid, version, epoch, needs_key, settings, created_at, created_by) VALUES (?, 1, 1, 0, ?, ?, ?)`,
    gid,
    JSON.stringify(settings),
    nowSec,
    signer,
  );
  const seq = storeGroupEvent(sql, gid, change.event, signer, 1, nowSec);
  for (const p of roster) {
    sql.exec(
      `INSERT INTO home_group_members (gid, pubkey, role, from_seq, joined_at, join_epoch) VALUES (?, ?, ?, ?, ?, 1)`,
      gid,
      p,
      p === signer ? "admin" : "member",
      seq,
      nowSec,
    );
  }
  storeKeys(sql, gid, signer, envelopes);
  return { result: { version: 1, epoch: 1, seq }, groupOutbox: [{ gid, event: change.event, wake: others }] };
}

function keeperPlus(sql: SqlStorage, roster: readonly string[]): string[] {
  const keeper = keeperOf(sql);
  return keeper === null || roster.includes(keeper) ? [...roster] : [...roster, keeper];
}

function groupChange(sql: SqlStorage, owner: string | null, params: unknown[], signer: string, nowSec: number): GroupReply {
  const gid = gidParam(params);
  const version = params[1];
  if (gid === null || typeof version !== "number" || !Number.isInteger(version)) {
    return err("groupchange takes [gid, version, change, envelopes?]");
  }
  const group = groupRow(sql, gid);
  // The keeper is in no roster, and may make one change: a new key.
  const keeping = signer === keeperOf(sql);
  const me = group === null ? null : memberOf(sql, gid, signer) ?? (keeping ? { pubkey: signer, role: "keeper", from_seq: 0, joined_at: 0 } : null);
  if (group === null || me === null) return err(`groupchange: ${NOT_IN_GROUP_MESSAGE}`);
  if (version !== group.version) return { error: GROUP_CHANGED_MESSAGE, version: group.version };
  const change = parseChange("groupchange", params[2], gid, version, signer, nowSec);
  if (typeof change === "string") return err(change);
  if (change.op === "create") return err("groupchange: a group is created with groupcreate");
  if (change.op === "join") return err("groupchange: joining with a link is groupjoin");
  if (me.role === "keeper" && change.op !== "key") return err("groupchange: the box may only change the key");
  const envelopes = parseEnvelopes("groupchange", params[3]);
  if (typeof envelopes === "string") return err(envelopes);

  const settings = parseSettings(group.settings);
  const members = membersOf(sql, gid);
  const roster = members.map((m) => m.pubkey);
  const admins = members.filter((m) => m.role === "admin").map((m) => m.pubkey);
  const isAdmin = me.role === "admin";
  const t = change.targets;
  let after = roster;

  switch (change.op) {
    case "add": {
      if (settings.onlyAdminsAdd && !isAdmin) return err("groupchange: only admins can add people to this group");
      if (t.length === 0) return err("groupchange: name who to add in p tags");
      const fresh = t.filter((p) => !roster.includes(p));
      if (fresh.length !== t.length) return err("groupchange: someone you are adding is already in the group");
      if (roster.length + fresh.length > GROUP_DECISIONS.maxMembers) {
        return err(`groupchange: a group can have at most ${GROUP_DECISIONS.maxMembers} people`);
      }
      for (const p of fresh) {
        const why = cutOffReason(sql, owner, p);
        if (why !== null) return err(`groupchange: ${why}`);
      }
      after = [...roster, ...fresh];
      break;
    }
    case "remove": {
      if (!isAdmin) return err("groupchange: only admins can remove people");
      if (t.length === 0) return err("groupchange: name who to remove in p tags");
      if (t.includes(signer)) return err("groupchange: to leave yourself, use groupleave");
      if (!t.every((p) => roster.includes(p))) return err("groupchange: someone you are removing is no longer in the group");
      after = roster.filter((p) => !t.includes(p));
      break;
    }
    case "admin": {
      if (!isAdmin) return err("groupchange: only admins can make admins");
      if (t.length === 0 || !t.every((p) => roster.includes(p))) {
        return err("groupchange: someone you are making an admin is no longer in the group");
      }
      break;
    }
    case "unadmin": {
      if (!isAdmin) return err("groupchange: only admins can change admins");
      if (t.length === 0 || !t.every((p) => admins.includes(p))) return err("groupchange: that person is not an admin");
      if (admins.filter((p) => !t.includes(p)).length === 0) return err("groupchange: a group needs at least one admin");
      break;
    }
    case "settings": {
      if (!isAdmin) return err("groupchange: only admins can change the group's settings");
      break;
    }
    case "key":
      if (envelopes === null) return err("groupchange: a key change carries the new envelopes");
      break;
    // A join link: the app keeps the code, the chain keeps its sha256, so
    // every member's app can check a later join against a link an admin made.
    // A link with an `until` tag stops then (at most GROUP_LINK_MAX_SECONDS
    // away), and also lets people new to this home in when its maker is in
    // the home (nip86.ts redeeminvite).
    case "link":
    case "unlink": {
      if (!isAdmin) return err("groupchange: only admins can make or stop join links");
      const hash = tagValue(change.event, "code-hash");
      if (hash === undefined || !HEX64_RE.test(hash)) return err("groupchange: a link change carries its code's sha256 in a code-hash tag");
      if (change.op === "unlink" && !linkOn(sql, gid, hash)) return err("groupchange: that link is not active");
      if (change.op === "link") {
        const until = linkUntil(change.event, nowSec);
        if (typeof until === "string") return err(until);
      }
      break;
    }
  }

  // The key. A new epoch covers everyone after the change; the current
  // epoch may be handed only to people being added, and only while new
  // members may see earlier messages. Adding with the switch off needs a
  // new key; a removal without one leaves needsKey for the next sender.
  let newEpoch: number | null = null;
  if (envelopes !== null) {
    const to = envelopes.keys.map((k) => k.to);
    if (envelopes.epoch === group.epoch + 1) {
      if (!sameSet(to, keeperPlus(sql, after))) {
        return err("groupchange: a new key needs exactly one envelope for each person in the group after the change");
      }
      newEpoch = envelopes.epoch;
    } else if (envelopes.epoch === group.epoch && change.op === "add" && settings.history) {
      if (!sameSet(to, after.filter((p) => !roster.includes(p)))) {
        return err("groupchange: envelopes of the current key go only to the people being added");
      }
    } else {
      return err(`groupchange: envelopes must be for epoch ${group.epoch + 1}`);
    }
  } else if (change.op === "add") {
    return err("groupchange: adding people carries their envelopes");
  }
  if (change.op === "add" && !settings.history && newEpoch === null) {
    return err("groupchange: this group starts new people from when they join, so adding them needs a new key");
  }

  const nextVersion = group.version + 1;
  bumpVersion(sql, gid, nextVersion);
  const seq = storeGroupEvent(sql, gid, change.event, signer, nextVersion, nowSec);
  switch (change.op) {
    case "add":
      for (const p of t) {
        sql.exec(
          `INSERT INTO home_group_members (gid, pubkey, role, from_seq, joined_at, join_epoch) VALUES (?, ?, 'member', ?, ?, ?)`,
          gid,
          p,
          seq,
          nowSec,
          newEpoch ?? group.epoch,
        );
        sql.exec(`DELETE FROM home_group_former WHERE gid = ? AND pubkey = ?`, gid, p);
      }
      break;
    case "remove":
      for (const p of t) recordFormer(sql, gid, p, signer, "remove", nextVersion, nowSec);
      break;
    case "admin":
      for (const p of t) sql.exec(`UPDATE home_group_members SET role = 'admin' WHERE gid = ? AND pubkey = ?`, gid, p);
      break;
    case "unadmin":
      for (const p of t) sql.exec(`UPDATE home_group_members SET role = 'member' WHERE gid = ? AND pubkey = ?`, gid, p);
      break;
    case "settings":
      sql.exec(`UPDATE home_groups SET settings = ? WHERE gid = ?`, JSON.stringify(change.settings), gid);
      break;
    case "link": {
      const until = linkUntil(change.event, nowSec) as number | null;
      const home = until !== null && roleOf(sql, signer, owner) !== "none" ? 1 : 0;
      sql.exec(
        `INSERT INTO home_group_links (gid, hash, made_by, version, until, home) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(gid, hash) DO UPDATE SET made_by = excluded.made_by, version = excluded.version,
             until = excluded.until, home = excluded.home, off_at = NULL`,
        gid,
        tagValue(change.event, "code-hash"),
        signer,
        nextVersion,
        until,
        home,
      );
      break;
    }
    case "unlink":
      stopLinks(sql, gid, tagValue(change.event, "code-hash")!, nowSec);
      break;
  }
  if (envelopes !== null) storeKeys(sql, gid, signer, envelopes);
  if (newEpoch !== null) {
    sql.exec(`UPDATE home_groups SET epoch = ?, needs_key = 0 WHERE gid = ?`, newEpoch, gid);
  } else if (change.op === "remove") {
    sql.exec(`UPDATE home_groups SET needs_key = 1 WHERE gid = ?`, gid);
  }
  const wake = [...new Set([...roster, ...after])].filter((p) => p !== signer);
  const after2 = groupRow(sql, gid)!;
  return {
    result: { version: after2.version, epoch: after2.epoch, seq, needsKey: after2.needs_key === 1 },
    groupOutbox: [{ gid, event: change.event, wake }],
  };
}

function groupInfo(sql: SqlStorage, params: unknown[], signer: string): GroupReply {
  const gid = gidParam(params);
  if (gid === null) return err("groupinfo takes [gid, sinceVersion?]");
  const since = typeof params[1] === "number" ? params[1] : 0;
  const group = groupRow(sql, gid);
  if (group === null || (memberOf(sql, gid, signer) === null && signer !== keeperOf(sql))) return err(`groupinfo: ${NOT_IN_GROUP_MESSAGE}`);
  const chain = sql
    .exec<{ version: number; seq: number; stored_at: number; event: string }>(
      `SELECT version, seq, stored_at, event FROM home_group_events
        WHERE gid = ? AND kind = ? AND version > ? ORDER BY seq`,
      gid,
      GROUP_CHANGE_KIND,
      since,
    )
    .toArray()
    .map((r) => ({ version: r.version, seq: r.seq, storedAt: r.stored_at, event: JSON.parse(r.event) as NostrEvent }));
  return {
    result: {
      version: group.version,
      epoch: group.epoch,
      needsKey: group.needs_key === 1,
      settings: parseSettings(group.settings),
      keeper: keeperOf(sql),
      relay: getRelayPubkey(sql),
      members: membersOf(sql, gid).map((m) => ({
        pubkey: m.pubkey,
        role: m.role,
        fromSeq: m.from_seq,
        joinedAt: m.joined_at,
        joinEpoch: m.join_epoch,
        pendingKey: m.pending_key === 1,
      })),
      // Epochs the keeper has no envelope of (groups older than the box):
      // a member's app that holds them seals them to it with groupseal.
      keeperMissing: keeperMissing(sql, gid, group.epoch),
      chain,
    },
  };
}

function lastSeq(sql: SqlStorage, gid: string): number {
  return (
    sql.exec<{ seq: number | null }>(`SELECT MAX(seq) AS seq FROM home_group_events WHERE gid = ?`, gid).toArray()[0]
      ?.seq ?? 0
  );
}

function myGroups(sql: SqlStorage, signer: string, nowSec: number): GroupReply {
  sql.exec(`DELETE FROM home_group_former WHERE pubkey = ? AND at < ?`, signer, nowSec - FORMER_KEPT_SECONDS);
  const current = sql
    .exec<{ gid: string; role: string; version: number; epoch: number; needs_key: number }>(
      `SELECT m.gid AS gid, m.role AS role, g.version AS version, g.epoch AS epoch, g.needs_key AS needs_key
         FROM home_group_members m JOIN home_groups g ON g.gid = m.gid WHERE m.pubkey = ?`,
      signer,
    )
    .toArray()
    .map((r) => ({
      gid: r.gid,
      version: r.version,
      epoch: r.epoch,
      lastSeq: lastSeq(sql, r.gid),
      role: r.role,
      needsKey: r.needs_key === 1,
    }));
  const former = sql
    .exec<{ gid: string; by_key: string; op: string; version: number; at: number }>(
      `SELECT gid, by_key, op, version, at FROM home_group_former WHERE pubkey = ?`,
      signer,
    )
    .toArray()
    .map((r) => ({ gid: r.gid, removed: { by: r.by_key, op: r.op, version: r.version, at: r.at } }));
  return { result: [...current, ...former] };
}

function groupKeys(sql: SqlStorage, params: unknown[], signer: string): GroupReply {
  const gid = gidParam(params);
  if (gid === null) return err("groupkeys takes [gid, sinceEpoch]");
  const since = typeof params[1] === "number" ? params[1] : 0;
  if (memberOf(sql, gid, signer) === null && signer !== keeperOf(sql)) return err(`groupkeys: ${NOT_IN_GROUP_MESSAGE}`);
  return {
    result: sql
      .exec<{ epoch: number; from_key: string; blob: string }>(
        `SELECT epoch, from_key, blob FROM home_group_keys WHERE gid = ? AND member = ? AND epoch > ? ORDER BY epoch`,
        gid,
        signer,
        since,
      )
      .toArray()
      .map((r) => ({ epoch: r.epoch, from: r.from_key, blob: r.blob })),
  };
}

function groupLeave(sql: SqlStorage, owner: string | null, params: unknown[], signer: string, nowSec: number): GroupReply {
  const gid = gidParam(params);
  if (gid === null) return err("groupleave takes [gid]");
  if (memberOf(sql, gid, signer) === null) return err(`groupleave: ${NOT_IN_GROUP_MESSAGE}`);
  const outbox: GroupOutboxEntry[] = [];
  leaveOne(sql, gid, signer, "leave", "left", nowSec, outbox);
  dropGuestDevices(sql, owner, [signer]);
  return { result: { left: true }, groupOutbox: outbox };
}

function groupSince(sql: SqlStorage, params: unknown[], signer: string): GroupReply {
  const gid = gidParam(params);
  const after = params[1];
  const limitParam = params[2];
  if (gid === null || typeof after !== "number" || !Number.isInteger(after) || after < 0) {
    return err(`groupsince takes [gid, afterSeq, limit (1 to ${MAX_GROUPSINCE})]`);
  }
  const limit =
    typeof limitParam === "number" && Number.isInteger(limitParam) && limitParam >= 1
      ? Math.min(limitParam, MAX_GROUPSINCE)
      : MAX_GROUPSINCE;
  const group = groupRow(sql, gid);
  const keeping = signer === keeperOf(sql);
  const me = group === null ? null : memberOf(sql, gid, signer);
  if (group === null || (me === null && !keeping)) return err(`groupsince: ${NOT_IN_GROUP_MESSAGE}`);
  const from = me !== null && startsFromJoin(sql, parseSettings(group.settings)) ? Math.max(after, me.from_seq - 1) : after;
  return {
    result: sql
      .exec<{ seq: number; stored_at: number; event: string }>(
        `SELECT seq, stored_at, event FROM home_group_events WHERE gid = ? AND seq > ? ORDER BY seq LIMIT ?`,
        gid,
        from,
        limit,
      )
      .toArray()
      .map((r) => ({ seq: r.seq, storedAt: r.stored_at, event: JSON.parse(r.event) as NostrEvent })),
  };
}

// ---------------------------------------------------------------------
// Join links and the keeper (groups.md 3 and 6). The box keeps every
// group's keys (GROUP_DECISIONS): it seals the key to someone who joined
// from a link, hands new members the earlier keys, makes the new key after
// a leave, and backs up every message (groupkept).
// ---------------------------------------------------------------------

// The longest a link with an `until` lasts: the longest a home invite
// lasts, since it is one.
export const GROUP_LINK_MAX_SECONDS = INVITE_MAX_TTL_SECONDS;

// A link change's `until`: null when it has none, the time when it is a
// whole number in (now, now + GROUP_LINK_MAX_SECONDS], else the refusal.
function linkUntil(event: NostrEvent, nowSec: number): number | null | string {
  const raw = tagValue(event, "until");
  if (raw === undefined) return null;
  const until = Number(raw);
  if (!/^[0-9]+$/.test(raw) || until <= nowSec || until > nowSec + GROUP_LINK_MAX_SECONDS) {
    return `groupchange: a link's until tag must be a time within ${GROUP_LINK_MAX_SECONDS / 86400} days`;
  }
  return until;
}

// Made and not turned off (an expired link may still be turned off).
function linkOn(sql: SqlStorage, gid: string, hash: string): boolean {
  return sql.exec(`SELECT 1 FROM home_group_links WHERE gid = ? AND hash = ? AND off_at IS NULL`, gid, hash).toArray().length > 0;
}

// On, and not past its `until`: someone may join with it now.
function linkActive(sql: SqlStorage, gid: string, hash: string, nowSec: number): boolean {
  return (
    sql
      .exec(
        `SELECT 1 FROM home_group_links WHERE gid = ? AND hash = ? AND off_at IS NULL AND (until IS NULL OR until > ?)`,
        gid,
        hash,
        nowSec,
      )
      .toArray().length > 0
  );
}

// Turns off one link (or every link of the group, `hash` null). A link
// that let someone into the home is kept, off, so its maker's count of
// invite places stays right (schema.ts home_group_links).
function stopLinks(sql: SqlStorage, gid: string, hash: string | null, nowSec: number): void {
  const which = hash === null ? "" : " AND hash = ?";
  const args = hash === null ? [gid] : [gid, hash];
  sql.exec(`DELETE FROM home_group_links WHERE gid = ?${which} AND home_joined = 0`, ...args);
  sql.exec(`UPDATE home_group_links SET off_at = COALESCE(off_at, ?) WHERE gid = ?${which}`, nowSec, ...args);
}

// The link a code opens for someone new to this home (nip86.ts
// redeeminvite), or null: on, not expired, made to admit to the home, its
// group still there with room for one more, and under its own cap of
// home joins. The caller checks the maker's invite places.
export function homeLinkFor(sql: SqlStorage, code: string, nowSec: number): { gid: string; hash: string; madeBy: string } | null {
  if (!CODE_RE.test(code)) return null;
  const hash = sha256Hex(code);
  const row = sql
    .exec<{ gid: string; made_by: string; home_joined: number }>(
      `SELECT gid, made_by, home_joined FROM home_group_links
        WHERE hash = ? AND home = 1 AND off_at IS NULL AND until > ?`,
      hash,
      nowSec,
    )
    .toArray()[0];
  if (row === undefined || groupRow(sql, row.gid) === null) return null;
  if (row.home_joined >= GROUP_DECISIONS.maxMembers) return null;
  if (rosterPubkeys(sql, row.gid).length + 1 > GROUP_DECISIONS.maxMembers) return null;
  return { gid: row.gid, hash, madeBy: row.made_by };
}

export function countHomeLinkJoin(sql: SqlStorage, gid: string, hash: string): void {
  sql.exec(`UPDATE home_group_links SET home_joined = home_joined + 1 WHERE gid = ? AND hash = ?`, gid, hash);
}

// Whether `pubkey` may come in by a link: not cut off from this home.
export function mayJoinByLink(sql: SqlStorage, owner: string | null, pubkey: string): boolean {
  return cutOffReason(sql, owner, pubkey) === null;
}

function sha256Hex(text: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(text)));
}

const CODE_RE = /^[0-9a-f]{32}$/;
export const LINK_REFUSAL = "groupjoin: this link cannot be used. Ask whoever sent it for a new one.";

// groupjoin [gid, code] answers {version, members} for a live link; with
// the joiner's signed join change on that version, they are in, waiting
// for a key (pendingKey) until the keeper or a member's app seals it.
function groupJoin(sql: SqlStorage, owner: string | null, params: unknown[], signer: string, nowSec: number): GroupReply {
  const gid = gidParam(params);
  const code = params[1];
  if (gid === null || typeof code !== "string" || !CODE_RE.test(code)) return err("groupjoin takes [gid, code, change?]");
  const group = groupRow(sql, gid);
  if (group === null || !linkActive(sql, gid, sha256Hex(code), nowSec)) return err(LINK_REFUSAL);
  if (memberOf(sql, gid, signer) !== null) return { result: { version: group.version, epoch: group.epoch, member: true } };
  const why = cutOffReason(sql, owner, signer);
  if (why !== null) return err(LINK_REFUSAL);
  const roster = rosterPubkeys(sql, gid);
  if (roster.length + 1 > GROUP_DECISIONS.maxMembers) return err(`groupjoin: a group can have at most ${GROUP_DECISIONS.maxMembers} people`);
  if (params[2] === undefined || params[2] === null) return { result: { version: group.version, members: roster.length } };
  const version = typeof (params[2] as NostrEvent)?.tags === "object" ? Number(tagValue(params[2] as NostrEvent, "v")) : NaN;
  if (version !== group.version) return { error: GROUP_CHANGED_MESSAGE.replace("groupchange", "groupjoin"), version: group.version };
  const change = parseChange("groupjoin", params[2], gid, group.version, signer, nowSec);
  if (typeof change === "string") return err(change);
  if (change.op !== "join" || tagValue(change.event, "code") !== code) return err("groupjoin: the change must be a join naming this link's code");
  const nextVersion = group.version + 1;
  bumpVersion(sql, gid, nextVersion);
  const seq = storeGroupEvent(sql, gid, change.event, signer, nextVersion, nowSec);
  sql.exec(
    `INSERT INTO home_group_members (gid, pubkey, role, from_seq, joined_at, join_epoch, pending_key) VALUES (?, ?, 'member', ?, ?, ?, 1)`,
    gid,
    signer,
    seq,
    nowSec,
    group.epoch,
  );
  sql.exec(`DELETE FROM home_group_former WHERE gid = ? AND pubkey = ?`, gid, signer);
  return {
    result: { version: nextVersion, epoch: group.epoch, seq, pendingKey: true },
    groupOutbox: [{ gid, event: change.event, wake: roster }],
  };
}

// The epochs one member may hold: all of them while new members see
// earlier messages (on a home with a keeper), else from the one they joined in.
function firstEpochFor(sql: SqlStorage, settings: GroupSettings, m: MemberRow): number {
  return startsFromJoin(sql, settings) ? Math.max(1, m.join_epoch ?? 1) : 1;
}

function hasEnvelope(sql: SqlStorage, gid: string, member: string, epoch: number): boolean {
  return sql.exec(`SELECT 1 FROM home_group_keys WHERE gid = ? AND member = ? AND epoch = ?`, gid, member, epoch).toArray().length > 0;
}

function keeperMissing(sql: SqlStorage, gid: string, epoch: number): number[] {
  const keeper = keeperOf(sql);
  if (keeper === null) return [];
  const missing: number[] = [];
  for (let e = 1; e <= epoch; e++) if (!hasEnvelope(sql, gid, keeper, e)) missing.push(e);
  return missing;
}

// groupseal [gid, [{to, epoch, blob}]]: envelopes for people who lack one
// (a link join, a new member's earlier keys, the keeper's keys of a group
// older than the box). From the keeper or anyone in the group; an envelope
// already there is kept.
function groupSeal(sql: SqlStorage, params: unknown[], signer: string): GroupReply {
  const gid = gidParam(params);
  const raw = params[1];
  if (gid === null || !Array.isArray(raw) || raw.length === 0 || raw.length > 1000) {
    return err("groupseal takes [gid, [{to, epoch, blob}]]");
  }
  const group = groupRow(sql, gid);
  const keeper = keeperOf(sql);
  const keeping = signer === keeper;
  if (group === null || (!keeping && memberOf(sql, gid, signer) === null)) return err(`groupseal: ${NOT_IN_GROUP_MESSAGE}`);
  const settings = parseSettings(group.settings);
  let sealed = 0;
  const woken = new Set<string>();
  for (const k of raw as unknown[]) {
    const e = k as { to?: unknown; epoch?: unknown; blob?: unknown } | null;
    if (
      typeof e !== "object" || e === null || typeof e.to !== "string" || !HEX64_RE.test(e.to) ||
      typeof e.epoch !== "number" || !Number.isInteger(e.epoch) || e.epoch < 1 || e.epoch > group.epoch ||
      typeof e.blob !== "string" || e.blob === "" || e.blob.length > MAX_ENVELOPE_CHARS
    ) {
      return err('groupseal: each envelope is {"to": "<hex>", "epoch": n, "blob": "<sealed key>"} for an epoch the group has had');
    }
    if (e.to === keeper) {
      if (keeping) return err("groupseal: the box does not seal to itself");
    } else {
      const m = memberOf(sql, gid, e.to);
      if (m === null) return err("groupseal: someone you are sealing to is not in the group");
      if (e.epoch < firstEpochFor(sql, settings, m)) return err("groupseal: this group starts new people from when they join");
    }
    if (hasEnvelope(sql, gid, e.to, e.epoch)) continue;
    sql.exec(
      `INSERT INTO home_group_keys (gid, epoch, member, from_key, blob) VALUES (?, ?, ?, ?, ?)`,
      gid,
      e.epoch,
      e.to,
      signer,
      e.blob,
    );
    sealed++;
    if (e.epoch === group.epoch) {
      sql.exec(`UPDATE home_group_members SET pending_key = 0 WHERE gid = ? AND pubkey = ?`, gid, e.to);
    }
    if (e.to !== keeper) woken.add(e.to);
  }
  return { result: { sealed }, wake: [...woken] };
}

// keepergroups []: every group on the home, and what the keeper owes each.
function keeperGroups(sql: SqlStorage, signer: string): GroupReply {
  if (signer !== keeperOf(sql)) return err("keepergroups is only for this home's box");
  const groups = sql
    .exec<{ gid: string; version: number; epoch: number; needs_key: number; settings: string; kept_seq: number | null }>(
      `SELECT gid, version, epoch, needs_key, settings, kept_seq FROM home_groups`,
    )
    .toArray();
  return {
    result: groups.map((g) => {
      const settings = parseSettings(g.settings);
      const members = membersOf(sql, g.gid);
      // Envelopes the keeper could seal now: epochs it holds that a member lacks.
      const owed = members
        .map((m) => {
          const epochs: number[] = [];
          for (let e = firstEpochFor(sql, settings, m); e <= g.epoch; e++) {
            if (!hasEnvelope(sql, g.gid, m.pubkey, e)) epochs.push(e);
          }
          return { pubkey: m.pubkey, epochs };
        })
        .filter((o) => o.epochs.length > 0);
      return {
        gid: g.gid,
        version: g.version,
        epoch: g.epoch,
        needsKey: g.needs_key === 1,
        lastSeq: lastSeq(sql, g.gid),
        keptSeq: g.kept_seq ?? 0,
        history: settings.history,
        members: members.map((m) => ({ pubkey: m.pubkey, fromSeq: m.from_seq, joinEpoch: m.join_epoch ?? 1 })),
        owed,
      };
    }),
  };
}

// The keeper has every message through `throughSeq`: messages older than
// GROUP_KEPT_SECONDS may go from bothy (the box serves them from then on).
export const GROUP_KEPT_SECONDS = 30 * 86400;

function groupKept(sql: SqlStorage, params: unknown[], signer: string, nowSec: number): GroupReply {
  if (signer !== keeperOf(sql)) return err("groupkept is only for this home's box");
  const gid = gidParam(params);
  const through = params[1];
  if (gid === null || typeof through !== "number" || !Number.isInteger(through) || through < 0) {
    return err("groupkept takes [gid, throughSeq]");
  }
  if (groupRow(sql, gid) === null) return err(`groupkept: ${NOT_IN_GROUP_MESSAGE}`);
  sql.exec(`UPDATE home_groups SET kept_seq = MAX(COALESCE(kept_seq, 0), ?) WHERE gid = ?`, through, gid);
  const old = sql
    .exec<{ seq: number; sender: string; bytes: number }>(
      `SELECT seq, sender, bytes FROM home_group_events WHERE gid = ? AND kind = ? AND seq <= ? AND stored_at < ?`,
      gid,
      GROUP_MESSAGE_KIND,
      through,
      nowSec - GROUP_KEPT_SECONDS,
    )
    .toArray();
  for (const row of old) {
    sql.exec(`DELETE FROM home_group_events WHERE seq = ?`, row.seq);
    chargeBytes(sql, [row.sender], -row.bytes, null);
  }
  return { result: { kept: through, dropped: old.length } };
}
