// The Fridge door (DMs docs/door-contract.md section 1, docs/fridge.md):
// everything on a home group's door lives here, as plain rows, and this is
// the only copy. Every app, calendar link, link page and the house screen
// reads and writes it here, so they all show the same thing. Chat and
// photos are not part of it and stay as they are.
//
// The methods (nip86.ts), each for people on the group's roster here:
//
//   doorput [gid, [{d, kind, set, at}, ...]]  -> {seq, refused}
//   doorlist [gid, since]                     -> {seq, items}
//   doorcount [gid]                           -> {events}
//   callink []        a member, or anyone in a group here
//   callinknew []     the same
//   callinkoff []     the same
//
// An ITEM is one row per item per group: an event, a birthday, a note, or a
// kind a later app adds (wish, news, ...). Its `kind` is fixed at its first
// write. `set` holds field values and `at` a stamp (ms) for each, the
// calendar wire's own change shape (calendar-wire.md). Each field keeps the
// value with the highest stamp; an equal stamp keeps what is stored, so
// replaying a write changes nothing. An item is removed when `removed` is
// true and its stamp is at least every other field's. Fields this file
// knows for a kind are checked; any other kind or field is stored and
// handed back exactly as written, so a newer app can put things on the door
// an older home has never heard of.
//
// `seq` is the group's own counter (home_groups.door_seq), raised on every
// stored change, and each changed item takes the new number. doorlist hands
// back every item above the reader's `since`, removed ones included, so an
// app keeps its copy current by asking for what is new.
//
// Telling people (relay.ts manage): every stored change sends a tiny notice
// (DOOR_NOTICE_KIND, below) to the group's connected members who asked for
// it, so an open door updates within a second; and a change that matters
// (changeMatters) wakes the other members' phones with push reason "door".
//
// GET /cal/<secret>.ics (index.ts) answers with the events and birthdays of
// every group the link's person is in now, so leaving or being removed from
// a group takes them out at the calendar app's next check. Deleting a group
// deletes its door (home-groups.ts deleteGroup).
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { memberOf, rosterPubkeys } from "./home-groups";
import { getRelayPubkey, signAsRelay } from "./relay-identity";
import { computeEventId } from "./validate";
import type { NostrEvent } from "./nostr";
import {
  DOOR_ITEMS_PER_CALL,
  DOOR_ITEMS_PER_GROUP,
  DOOR_ITEM_MAX_BYTES,
  DOOR_ITEM_MAX_FIELDS,
  CALENDAR_LINK_MAX_EVENTS,
  CALENDAR_LINK_PAST_DAYS,
} from "./limits";

export const DOOR_METHODS: readonly string[] = ["doorput", "doorlist", "doorcount", "callink", "callinknew", "callinkoff"];

// The live notice: "this group's door changed, it is now at seq N". An
// ephemeral kind, signed by this home's own key (relay-identity.ts), with
// the group in `h` and the number in `seq`, and nothing else: the app calls
// doorlist for the rest. Sent only to subscriptions that ask for this kind
// (live only, like the group kinds; relay.ts handleReqInner), so apps that
// do not know it never see one. Never stored, and refused when a client
// publishes one.
export const DOOR_NOTICE_KIND = 21490;

export const TITLE_MAX = 100;
export const PLACE_MAX = 200;
export const NOTE_MAX = 1000;
export const LINK_MAX = 500;
export const NAME_MAX = 100;

const GID_RE = /^[0-9a-f]{32}$/;
const D_RE = /^[0-9a-f]{1,64}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
// A web address as people paste one: no spaces or control characters.
const LINK_RE = /^[^\s\x00-\x1f\x7f]+$/;
// A calendar link's secret: 32 random bytes, base64url, 43 characters.
export const CAL_PATH = /^\/cal\/([A-Za-z0-9_-]{43})\.ics$/;

export type PlanTime = { date: string } | { local: string; tz: string };

export interface DoorItem {
  d: string;
  kind: string;
  fields: Record<string, unknown>;
  stamps: Record<string, number>;
  seq: number;
  updatedAt: number;
  updatedBy: string;
  createdBy: string;
  createdAt: number;
}

// What a stored change owes the people in the group (relay.ts manage):
// the live notice to their open apps, and a push to `wake` (the other
// members, when the change matters; otherwise nobody).
export interface DoorChange {
  gid: string;
  seq: number;
  wake: string[];
}

export interface DoorReply {
  result?: unknown;
  error?: string;
  door?: DoorChange;
}

// The fields this home checks, per kind. Anything else is kept as written.
export const KNOWN_FIELDS: Readonly<Record<string, readonly string[]>> = {
  event: ["title", "start", "end", "place", "note", "link", "removed"],
  birthday: ["who", "name", "month", "day", "year", "removed"],
  note: ["text", "removed"],
};

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function own(o: Record<string, unknown>, k: string): unknown {
  return Object.hasOwn(o, k) ? o[k] : undefined;
}

export function timeOf(x: unknown): PlanTime | null {
  if (!isObj(x)) return null;
  if (typeof x.date === "string" && DATE_RE.test(x.date)) return { date: x.date };
  if (typeof x.local === "string" && LOCAL_RE.test(x.local) && typeof x.tz === "string" && x.tz.length > 0 && x.tz.length <= 64) {
    return { local: x.local, tz: x.tz };
  }
  return null;
}

// Trimmed and cut to n characters, never inside a surrogate pair.
function clip(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

function optionalText(v: unknown, max: number): unknown {
  if (v === null) return null;
  return typeof v === "string" ? clip(v, max) || null : undefined;
}

function webLink(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t === "") return null;
  if (t.length > LINK_MAX || !LINK_RE.test(t)) return undefined;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? t : undefined;
  } catch {
    return undefined;
  }
}

// The most days a month can have; February's 29 so a leap-day birthday fits.
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function intIn(v: unknown, lo: number, hi: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi;
}

// A known field's value as stored, or undefined when it is not a valid
// value for that field (the whole item is then refused, as the wire
// ignores a bad change whole).
function knownValue(kind: string, f: string, v: unknown): unknown {
  if (f === "removed") return typeof v === "boolean" ? v : undefined;
  switch (`${kind}.${f}`) {
    case "event.title":
      return typeof v === "string" && v.trim().length > 0 ? clip(v, TITLE_MAX) : undefined;
    case "event.start":
      return timeOf(v) ?? undefined;
    case "event.end":
      return v === null ? null : (timeOf(v) ?? undefined);
    case "event.place":
      return optionalText(v, PLACE_MAX);
    case "event.note":
      return optionalText(v, NOTE_MAX);
    case "event.link":
      return webLink(v);
    case "birthday.who":
      return v === null ? null : typeof v === "string" && HEX64_RE.test(v) ? v : undefined;
    case "birthday.name":
      return optionalText(v, NAME_MAX);
    case "birthday.month":
      return intIn(v, 1, 12) ? v : undefined;
    case "birthday.day":
      return intIn(v, 1, 31) ? v : undefined;
    case "birthday.year":
      return v === null ? null : intIn(v, 1, 9999) ? v : undefined;
    case "note.text":
      return typeof v === "string" && v.trim().length > 0 ? clip(v, NOTE_MAX) : undefined;
  }
  return v;
}

export interface Incoming {
  d: string;
  kind: string | null;
  set: Record<string, unknown>;
  at: Record<string, number>;
}

// One {d, kind, set, at} from doorput, its shape checked, or null when it
// is not one. Values are checked once the item's kind is known (cleanSet).
export function parseIncoming(x: unknown): Incoming | null {
  if (!isObj(x) || typeof x.d !== "string" || !D_RE.test(x.d) || !isObj(x.set) || !isObj(x.at)) return null;
  let kind: string | null = null;
  if (x.kind !== undefined) {
    if (typeof x.kind !== "string" || !KIND_RE.test(x.kind)) return null;
    kind = x.kind;
  }
  const keys = Object.keys(x.set);
  if (keys.length === 0 || keys.length > DOOR_ITEM_MAX_FIELDS) return null;
  const at: Record<string, number> = {};
  for (const k of keys) {
    const s = own(x.at, k);
    if (!FIELD_RE.test(k) || typeof s !== "number" || !Number.isSafeInteger(s) || s < 0) return null;
    at[k] = s;
  }
  if (JSON.stringify({ set: x.set, at }).length > DOOR_ITEM_MAX_BYTES) return null;
  return { d: x.d, kind, set: x.set, at };
}

// The values of `set` for an item of `kind`: known fields checked (and
// trimmed), the rest untouched. Null when any known value is invalid.
export function cleanSet(kind: string, set: Record<string, unknown>): Record<string, unknown> | null {
  const known = KNOWN_FIELDS[kind] ?? [];
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    const value = known.includes(k) || k === "removed" ? knownValue(kind, k, v) : v;
    if (value === undefined) return null;
    out[k] = value;
  }
  // A day the month never has, when both arrive together.
  if (kind === "birthday" && typeof out.month === "number" && typeof out.day === "number" && out.day > MONTH_DAYS[out.month - 1]!) {
    return null;
  }
  return out;
}

// Field by field: the higher stamp wins; equal keeps what is stored.
// `changed` names the fields whose value a person would see move.
export function merge(
  fields: Record<string, unknown>,
  stamps: Record<string, number>,
  inc: { set: Record<string, unknown>; at: Record<string, number> },
): { fields: Record<string, unknown>; stamps: Record<string, number>; changed: Set<string> } {
  const f = { ...fields };
  const s = { ...stamps };
  const changed = new Set<string>();
  for (const k of Object.keys(inc.set)) {
    const stamp = inc.at[k]!;
    // Own properties only: a field may be called "constructor".
    if (Object.hasOwn(s, k) && stamp <= s[k]!) continue;
    if (JSON.stringify(own(f, k)) !== JSON.stringify(inc.set[k])) changed.add(k);
    f[k] = inc.set[k];
    s[k] = stamp;
  }
  return { fields: f, stamps: s, changed };
}

// The wire's removed rule: removed, with a stamp at least every other field's.
export function isRemoved(fields: Record<string, unknown>, stamps: Record<string, number>): boolean {
  if (own(fields, "removed") !== true) return false;
  const r = own(stamps, "removed") as number;
  return Object.entries(stamps).every(([k, v]) => k === "removed" || v <= r);
}

type Shape = { fields: Record<string, unknown>; stamps: Record<string, number> };

function eventShown(x: Shape | null): boolean {
  return x !== null && typeof x.fields.title === "string" && timeOf(x.fields.start) !== null && !isRemoved(x.fields, x.stamps);
}

function noteShown(x: Shape | null): boolean {
  return x !== null && typeof x.fields.text === "string" && !isRemoved(x.fields, x.stamps);
}

function eventOver(x: Shape, nowMs: number): boolean {
  return whenLines(timeOf(x.fields.start)!, timeOf(x.fields.end)).overMs <= nowMs;
}

// Whether a stored change is worth waking the other members' phones for
// (door-contract.md "Telling people"): a new event, an event's start or
// place moving, an event removed, a new note. Not birthdays, other edits or
// kinds this home does not know. An event already over is no news, which
// also keeps an app's one-time bring-over of old events quiet. An item
// coming back from removed counts as new.
export function changeMatters(kind: string, before: Shape | null, after: Shape, changed: ReadonlySet<string>, nowMs: number): boolean {
  if (kind === "event") {
    const was = eventShown(before);
    const is = eventShown(after);
    if (!was && is) return !eventOver(after, nowMs);
    if (was && !is) return !eventOver(before!, nowMs);
    if (was && is && (changed.has("start") || changed.has("place"))) {
      return !(eventOver(before!, nowMs) && eventOver(after, nowMs));
    }
    return false;
  }
  if (kind === "note") return !noteShown(before) && noteShown(after);
  return false;
}

function gidParam(params: unknown[]): string | null {
  const gid = params[0];
  return typeof gid === "string" && GID_RE.test(gid) ? gid : null;
}

const NOT_IN_GROUP = "you are not in this group";

export function doorSeq(sql: SqlStorage, gid: string): number {
  return sql.exec<{ s: number }>(`SELECT door_seq AS s FROM home_groups WHERE gid = ?`, gid).toArray()[0]?.s ?? 0;
}

type ItemRow = {
  d: string;
  kind: string;
  fields: string;
  stamps: string;
  seq: number;
  updated_at: number;
  updated_by: string;
  created_by: string;
  created_at: number;
};

function doorPut(sql: SqlStorage, params: unknown[], signer: string, nowSec: number): DoorReply {
  const gid = gidParam(params);
  if (gid === null) return { error: "doorput: the first parameter must be a group id" };
  if (memberOf(sql, gid, signer) === null) return { error: `doorput: ${NOT_IN_GROUP}` };
  const list = params[1];
  if (!Array.isArray(list) || list.length === 0) return { error: "doorput: the second parameter must be a list of items" };
  if (list.length > DOOR_ITEMS_PER_CALL) return { error: `doorput: at most ${DOOR_ITEMS_PER_CALL} items a call` };
  const first = doorSeq(sql, gid);
  let seq = first;
  let refused = 0;
  let matters = false;
  for (const raw of list) {
    const inc = parseIncoming(raw);
    if (inc === null) {
      refused++;
      continue;
    }
    const row = sql
      .exec<Pick<ItemRow, "kind" | "fields" | "stamps" | "updated_at">>(
        `SELECT kind, fields, stamps, updated_at FROM door_events WHERE gid = ? AND d = ?`,
        gid,
        inc.d,
      )
      .toArray()[0];
    // The kind is the first write's; a later write naming another is refused.
    if (row !== undefined && inc.kind !== null && inc.kind !== row.kind) {
      refused++;
      continue;
    }
    const kind = row?.kind ?? inc.kind ?? "event";
    const set = cleanSet(kind, inc.set);
    if (set === null) {
      refused++;
      continue;
    }
    const before: Shape | null = row === undefined ? null : { fields: JSON.parse(row.fields), stamps: JSON.parse(row.stamps) };
    const m = merge(before?.fields ?? {}, before?.stamps ?? {}, { set, at: inc.at });
    const stamps = JSON.stringify(m.stamps);
    // Nothing newer than what is here: not a change.
    if (row !== undefined && stamps === row.stamps) continue;
    const fields = JSON.stringify(m.fields);
    if (fields.length + stamps.length > DOOR_ITEM_MAX_BYTES || (row === undefined && !makeRoom(sql, gid))) {
      refused++;
      continue;
    }
    seq++;
    if (row === undefined) {
      sql.exec(
        `INSERT INTO door_events (gid, d, kind, fields, stamps, seq, updated_at, updated_by, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        gid,
        inc.d,
        kind,
        fields,
        stamps,
        seq,
        nowSec,
        signer,
        signer,
        nowSec,
      );
    } else {
      // updated_at moves only when something a person sees moved
      // (LAST-MODIFIED in calendar links).
      sql.exec(
        `UPDATE door_events SET fields = ?, stamps = ?, seq = ?, updated_at = ?, updated_by = ? WHERE gid = ? AND d = ?`,
        fields,
        stamps,
        seq,
        m.changed.size > 0 ? nowSec : row.updated_at,
        signer,
        gid,
        inc.d,
      );
    }
    if (!matters && changeMatters(kind, before, m, m.changed, nowSec * 1000)) matters = true;
  }
  if (seq === first) return { result: { seq, refused } };
  sql.exec(`UPDATE home_groups SET door_seq = ? WHERE gid = ?`, seq, gid);
  const wake = matters ? rosterPubkeys(sql, gid).filter((p) => p !== signer) : [];
  return { result: { seq, refused }, door: { gid, seq, wake } };
}

// A full door gives up the removed item whose last change is oldest for a
// new one. A reader that has not asked since before that item was removed
// keeps it until it next lists from 0; at DOOR_ITEMS_PER_GROUP that is
// years of a family's door.
function makeRoom(sql: SqlStorage, gid: string): boolean {
  const n = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM door_events WHERE gid = ?`, gid).one().n;
  if (n < DOOR_ITEMS_PER_GROUP) return true;
  const rows = sql
    .exec<{ d: string; fields: string; stamps: string }>(`SELECT d, fields, stamps FROM door_events WHERE gid = ? ORDER BY seq`, gid)
    .toArray();
  const gone = rows.find((r) => isRemoved(JSON.parse(r.fields), JSON.parse(r.stamps)));
  if (gone === undefined) return false;
  sql.exec(`DELETE FROM door_events WHERE gid = ? AND d = ?`, gid, gone.d);
  return true;
}

function itemOf(r: ItemRow): DoorItem {
  return {
    d: r.d,
    kind: r.kind,
    fields: JSON.parse(r.fields),
    stamps: JSON.parse(r.stamps),
    seq: r.seq,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

// Every item changed after `since`, oldest change first, and the door's
// seq now. A `since` above the door's seq (a reader holding a number from
// some other copy) answers as 0, so it heals instead of waiting.
function doorList(sql: SqlStorage, params: unknown[], signer: string): DoorReply {
  const gid = gidParam(params);
  if (gid === null) return { error: "doorlist: the first parameter must be a group id" };
  if (memberOf(sql, gid, signer) === null) return { error: `doorlist: ${NOT_IN_GROUP}` };
  const raw = params[1] ?? 0;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    return { error: "doorlist: the second parameter must be the seq you last saw, or 0" };
  }
  const seq = doorSeq(sql, gid);
  const since = raw > seq ? 0 : raw;
  const items = sql
    .exec<ItemRow>(
      `SELECT d, kind, fields, stamps, seq, updated_at, updated_by, created_by, created_at
         FROM door_events WHERE gid = ? AND seq > ? ORDER BY seq`,
      gid,
      since,
    )
    .toArray()
    .map(itemOf);
  return { result: { seq, items } };
}

// For an app's one-time bring-over of the events it used to keep itself.
function doorCount(sql: SqlStorage, params: unknown[], signer: string): DoorReply {
  const gid = gidParam(params);
  if (gid === null) return { error: "doorcount: the parameter must be a group id" };
  if (memberOf(sql, gid, signer) === null) return { error: `doorcount: ${NOT_IN_GROUP}` };
  const n = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM door_events WHERE gid = ? AND kind = 'event'`, gid).one().n;
  return { result: { events: n } };
}

// The live notice for one stored change (DOOR_NOTICE_KIND).
export function doorNotice(sql: SqlStorage, gid: string, seq: number, nowSec: number): NostrEvent {
  const unsigned = {
    pubkey: getRelayPubkey(sql),
    created_at: nowSec,
    kind: DOOR_NOTICE_KIND,
    tags: [
      ["h", gid],
      ["seq", String(seq)],
    ],
    content: "",
  };
  const id = computeEventId({ ...unsigned, id: "", sig: "" });
  return { ...unsigned, id, sig: signAsRelay(sql, id) };
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function newSecret(): string {
  return base64url(randomBytes(32));
}

export function linkOf(sql: SqlStorage, pubkey: string): string | null {
  return (
    sql.exec<{ secret: string }>(`SELECT secret FROM calendar_links WHERE pubkey = ?`, pubkey).toArray()[0]?.secret ?? null
  );
}

function setLink(sql: SqlStorage, pubkey: string, nowSec: number): string {
  const secret = newSecret();
  sql.exec(
    `INSERT INTO calendar_links (pubkey, secret, created_at) VALUES (?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET secret = excluded.secret, created_at = excluded.created_at`,
    pubkey,
    secret,
    nowSec,
  );
  return secret;
}

const linkReply = (secret: string): DoorReply => ({ result: { path: `/cal/${secret}.ics` } });

// callink: the person's link, made on the first call. callinknew: a new one,
// and the old one stops answering. callinkoff: none.
// `mayHave` is whether the signer is a member here or in a group here.
export function handleDoorCall(
  sql: SqlStorage,
  method: string,
  params: unknown[],
  signer: string,
  nowSec: number,
  mayHave: boolean,
): DoorReply {
  switch (method) {
    case "doorput":
      return doorPut(sql, params, signer, nowSec);
    case "doorlist":
      return doorList(sql, params, signer);
    case "doorcount":
      return doorCount(sql, params, signer);
    case "callink":
      if (!mayHave) return { error: `callink: ${NOT_IN_GROUP}` };
      return linkReply(linkOf(sql, signer) ?? setLink(sql, signer, nowSec));
    case "callinknew":
      if (!mayHave) return { error: `callinknew: ${NOT_IN_GROUP}` };
      return linkReply(setLink(sql, signer, nowSec));
    case "callinkoff":
      sql.exec(`DELETE FROM calendar_links WHERE pubkey = ?`, signer);
      return { result: true };
  }
  return { error: `unknown method ${method}` };
}

export function deleteCalendarLinkOf(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM calendar_links WHERE pubkey = ?`, pubkey);
}

export type LinkItem = DoorItem & { gid: string };

// Every event and birthday a link's person may see now: the doors of the
// groups they are on the roster of, newest change first. Null for no such
// link.
export function itemsForLink(sql: SqlStorage, secret: string): LinkItem[] | null {
  const who = sql.exec<{ pubkey: string }>(`SELECT pubkey FROM calendar_links WHERE secret = ?`, secret).toArray()[0];
  if (who === undefined) return null;
  const rows = sql
    .exec<ItemRow & { gid: string }>(
      `SELECT e.gid, e.d, e.kind, e.fields, e.stamps, e.seq, e.updated_at, e.updated_by, e.created_by, e.created_at
         FROM door_events e
         JOIN home_group_members m ON m.gid = e.gid AND m.pubkey = ?
         WHERE e.kind IN ('event', 'birthday')
         ORDER BY e.updated_at DESC`,
      who.pubkey,
    )
    .toArray();
  const seen = new Set<string>();
  const out: LinkItem[] = [];
  for (const r of rows) {
    if (seen.has(r.d)) continue;
    seen.add(r.d);
    out.push({ ...itemOf(r), gid: r.gid });
  }
  return out;
}

// The name a calendar shows for a birthday whose `who` is a member: their
// profile name here, only when they are on the same group's roster (so the
// link shows nobody the group's own apps would not). One indexed read.
export function memberNames(sql: SqlStorage): (gid: string, who: string) => string | null {
  return (gid, who) => {
    if (memberOf(sql, gid, who) === null) return null;
    const row = sql
      .exec<{ content: string }>(
        `SELECT content FROM events WHERE pubkey = ? AND kind = 0 AND is_group = 0 ORDER BY created_at DESC LIMIT 1`,
        who,
      )
      .toArray()[0];
    if (row === undefined) return null;
    try {
      const p = JSON.parse(row.content) as Record<string, unknown>;
      for (const k of ["display_name", "name"]) {
        const v = p[k];
        if (typeof v === "string" && v.trim()) return clip(v, NAME_MAX);
      }
    } catch {
      // Not a profile anyone can read; no name.
    }
    return null;
  };
}

// ---------------------------------------------------------------------
// The calendar file (RFC 5545). Timed events are written in UTC, worked
// out from the event's own wall time and zone, so daylight saving is
// settled here once and no VTIMEZONE is needed. All-day events are DATE
// values; the end is the day after the last day. Birthdays are yearly
// all-day entries.
// ---------------------------------------------------------------------

const CRLF = "\r\n";
const enc = new TextEncoder();

export function escapeText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

// Folds a content line at 75 octets, never inside a UTF-8 character.
export function foldLine(line: string): string {
  if (enc.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let cur = "";
  let curLen = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (curLen + n > limit) {
      parts.push(cur);
      cur = "";
      curLen = 0;
      limit = 74;
    }
    cur += ch;
    curLen += n;
  }
  parts.push(cur);
  return parts.join(CRLF + " ");
}

const pad = (n: number) => String(n).padStart(2, "0");

const offsetFormats = new Map<string, Intl.DateTimeFormat>();
// How far tz's wall clock is ahead of UTC at ms.
function zoneOffset(ms: number, tz: string): number {
  let f = offsetFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    offsetFormats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(ms)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

// The instant of a wall time in tz, the way phones read one: an unknown
// zone reads as UTC, a wall time skipped by a spring-forward moves on by
// the gap, and one that happens twice at a fall-back is the first.
export function zonedMs(local: string, tz: string): number {
  const [y, mo, d, hh, mi] = local.split(/[-T:]/).map(Number) as [number, number, number, number, number];
  const wall = Date.UTC(y, mo - 1, d, hh, mi);
  try {
    const before = zoneOffset(wall - 86400_000, tz);
    const after = zoneOffset(wall + 86400_000, tz);
    const fits = [before, after].map((o) => wall - o).filter((t) => zoneOffset(t, tz) === wall - t);
    return fits.length > 0 ? Math.min(...fits) : wall - before;
  } catch {
    return wall;
  }
}

function utcStamp(ms: number): string {
  const t = new Date(ms);
  return (
    `${t.getUTCFullYear()}${pad(t.getUTCMonth() + 1)}${pad(t.getUTCDate())}` +
    `T${pad(t.getUTCHours())}${pad(t.getUTCMinutes())}${pad(t.getUTCSeconds())}Z`
  );
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const HOUR_MS = 3600_000;

// DTSTART and DTEND, and when the event is over (ms), for the past cut-off.
export function whenLines(start: PlanTime, end: PlanTime | null): { lines: string[]; overMs: number } {
  if ("date" in start) {
    let last = start.date;
    if (end) {
      const endDay = "date" in end ? end.date : end.local.slice(0, 10);
      if (endDay > last) last = endDay;
    }
    const after = addDays(last, 1);
    return {
      lines: [`DTSTART;VALUE=DATE:${start.date.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${after.replace(/-/g, "")}`],
      overMs: Date.parse(`${after}T00:00:00Z`),
    };
  }
  const s = zonedMs(start.local, start.tz);
  const e0 = end && "local" in end ? zonedMs(end.local, end.tz) : null;
  const e = e0 !== null && e0 > s ? e0 : s + HOUR_MS;
  return { lines: [`DTSTART:${utcStamp(s)}`, `DTEND:${utcStamp(e)}`], overMs: e };
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// A birthday as a yearly all-day entry, or null when its month and day are
// not a date. It starts in the birth year when one is known (1900 on), else
// in 2000. A leap-day birthday repeats on February's last day, so it shows
// on the 28th in other years instead of only every fourth.
export function birthdayLines(fields: Record<string, unknown>): string[] | null {
  const month = own(fields, "month");
  const day = own(fields, "day");
  if (!intIn(month, 1, 12) || !intIn(day, 1, MONTH_DAYS[month - 1]!)) return null;
  const leapDay = month === 2 && day === 29;
  const known = own(fields, "year");
  let year = intIn(known, 1900, 9999) ? known : 2000;
  if (leapDay && !isLeap(year)) year = 2000;
  const date = `${year}-${pad(month)}-${pad(day)}`;
  return [
    `DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${addDays(date, 1).replace(/-/g, "")}`,
    leapDay ? "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1" : "RRULE:FREQ=YEARLY",
  ];
}

export interface CalendarFile {
  body: string;
  lastModified: number;
}

type Entry = { item: DoorItem; lines: string[] };

function eventEntry(ev: DoorItem, cutoff: number): Entry | null {
  const title = own(ev.fields, "title");
  const start = timeOf(own(ev.fields, "start"));
  if (typeof title !== "string" || start === null) return null;
  const when = whenLines(start, timeOf(own(ev.fields, "end")));
  if (when.overMs < cutoff) return null;
  const lines = [...when.lines, `SUMMARY:${escapeText(title)}`];
  const place = own(ev.fields, "place");
  const note = own(ev.fields, "note");
  const link = own(ev.fields, "link");
  if (typeof place === "string" && place) lines.push(`LOCATION:${escapeText(place)}`);
  const hasLink = typeof link === "string" && webLink(link) === link;
  const description = [typeof note === "string" ? note : "", hasLink ? link : ""].filter((x) => x).join("\n\n");
  if (description) lines.push(`DESCRIPTION:${escapeText(description)}`);
  if (hasLink) lines.push(`URL:${link}`);
  return { item: ev, lines };
}

function birthdayEntry(b: LinkItem | DoorItem, nameOf: (gid: string, who: string) => string | null): Entry | null {
  const when = birthdayLines(b.fields);
  if (when === null) return null;
  const who = own(b.fields, "who");
  const given = own(b.fields, "name");
  const fromWho = typeof who === "string" && "gid" in b ? nameOf(b.gid, who) : null;
  const name = fromWho ?? (typeof given === "string" && given ? given : null);
  return {
    item: b,
    lines: [...when, `SUMMARY:${escapeText(name === null ? "Birthday" : `${name}'s birthday`)}`, "TRANSP:TRANSPARENT"],
  };
}

const noNames = () => null;

// The whole file for a link. Removed items and events that ended more than
// CALENDAR_LINK_PAST_DAYS ago are left out, so the calendar app drops them;
// an event never complete (no title or start), or a birthday without a
// real date, is left out too.
export function calendarFile(
  items: (DoorItem | LinkItem)[],
  name: string,
  nowMs: number,
  nameOf: (gid: string, who: string) => string | null = noNames,
): CalendarFile {
  const cutoff = nowMs - CALENDAR_LINK_PAST_DAYS * 86400_000;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//bothy//calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(name)}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
  ];
  let lastModified = 0;
  let n = 0;
  const shown = items
    .filter((it) => !isRemoved(it.fields, it.stamps))
    .sort((a, b) => (a.d < b.d ? -1 : 1));
  for (const it of shown) {
    const entry = it.kind === "event" ? eventEntry(it, cutoff) : it.kind === "birthday" ? birthdayEntry(it, nameOf) : null;
    if (entry === null) continue;
    if (n++ >= CALENDAR_LINK_MAX_EVENTS) break;
    const changed = it.updatedAt * 1000;
    lastModified = Math.max(lastModified, changed);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${it.d}@dms`,
      `DTSTAMP:${utcStamp(changed)}`,
      `LAST-MODIFIED:${utcStamp(changed)}`,
      `SEQUENCE:${it.seq}`,
      ...entry.lines,
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return { body: lines.map(foldLine).join(CRLF) + CRLF, lastModified };
}

export function etagOf(body: string): string {
  return `"${bytesToHex(sha256(enc.encode(body))).slice(0, 32)}"`;
}
