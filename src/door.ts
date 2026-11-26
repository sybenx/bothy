// The Fridge door's events, kept readable, and each person's calendar link
// (DMs docs/fridge.md section 7, docs/calendar-wire.md "The home's copy").
//
// A home group's events also travel sealed among its members (kind 14192
// inside the group's traffic, home-groups.ts). The DMs apps additionally
// write each event here as plain fields, so this home can build a calendar
// the phone's own calendar app can follow by itself: Apple's and Google's
// calendar servers fetch a plain link and cannot open anything sealed.
// Chat and photos stay sealed as before; only the door's events are here.
//
// The methods (nip86.ts):
//
//   doorput [gid, [{d, set, at}, ...]]   anyone on the group's roster here
//   doorcount [gid]                      the same
//   callink []                           a member, or anyone in a group here
//   callinknew []                        the same
//   callinkoff []                        the same
//
// doorput carries the wire's own change shape (calendar-wire.md): `set`
// holds field values and `at` a stamp (ms) for each. Each field keeps the
// value with the highest stamp; an equal stamp keeps what is stored, so
// replaying a write changes nothing. Removal follows the wire's rule: an
// event is removed when `removed` is true and its stamp is at least every
// other field's.
//
// GET /cal/<secret>.ics (index.ts) answers with every event of every group
// the link's person is in now, so leaving or being removed from a group
// takes its events out on the calendar app's next check, and deleting a
// group deletes its events (home-groups.ts deleteGroup).
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { memberOf } from "./home-groups";
import {
  DOOR_EVENTS_PER_CALL,
  DOOR_EVENTS_PER_GROUP,
  DOOR_EVENT_MAX_BYTES,
  CALENDAR_LINK_MAX_EVENTS,
  CALENDAR_LINK_PAST_DAYS,
} from "./limits";

export const DOOR_METHODS: readonly string[] = ["doorput", "doorcount", "callink", "callinknew", "callinkoff"];

export const TITLE_MAX = 100;
export const PLACE_MAX = 200;
export const NOTE_MAX = 1000;

const GID_RE = /^[0-9a-f]{32}$/;
const D_RE = /^[0-9a-f]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;
// A calendar link's secret: 32 random bytes, base64url, 43 characters.
export const CAL_PATH = /^\/cal\/([A-Za-z0-9_-]{43})\.ics$/;

export type PlanTime = { date: string } | { local: string; tz: string };

export interface DoorEvent {
  d: string;
  fields: Record<string, unknown>;
  stamps: Record<string, number>;
  seq: number;
  updatedAt: number;
}

interface Reply {
  result?: unknown;
  error?: string;
}

const FIELDS = ["title", "start", "end", "place", "note", "removed"] as const;
type Field = (typeof FIELDS)[number];

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function timeOf(x: unknown): PlanTime | null {
  if (!isObj(x)) return null;
  if (typeof x.date === "string" && DATE_RE.test(x.date)) return { date: x.date };
  if (typeof x.local === "string" && LOCAL_RE.test(x.local) && typeof x.tz === "string" && x.tz.length > 0 && x.tz.length <= 64) {
    return { local: x.local, tz: x.tz };
  }
  return null;
}

// A field's value as stored, or undefined when it is not a valid value for
// that field (the whole event is then refused, as the wire ignores a bad
// change whole).
function fieldValue(f: Field, v: unknown): unknown {
  switch (f) {
    case "title":
      return typeof v === "string" && v.trim().length > 0 ? v.trim().slice(0, TITLE_MAX) : undefined;
    case "start":
      return timeOf(v) ?? undefined;
    case "end":
      return v === null ? null : (timeOf(v) ?? undefined);
    case "place":
      return v === null ? null : typeof v === "string" ? v.trim().slice(0, PLACE_MAX) || null : undefined;
    case "note":
      return v === null ? null : typeof v === "string" ? v.trim().slice(0, NOTE_MAX) || null : undefined;
    case "removed":
      return typeof v === "boolean" ? v : undefined;
  }
}

interface Incoming {
  d: string;
  set: Partial<Record<Field, unknown>>;
  at: Partial<Record<Field, number>>;
}

// One {d, set, at} from doorput, or null when it is not one. Unknown fields
// are left out, as the wire keeps but ignores them.
export function parseIncoming(x: unknown): Incoming | null {
  if (!isObj(x) || typeof x.d !== "string" || !D_RE.test(x.d) || !isObj(x.set) || !isObj(x.at)) return null;
  const set: Partial<Record<Field, unknown>> = {};
  const at: Partial<Record<Field, number>> = {};
  for (const f of FIELDS) {
    if (!(f in x.set)) continue;
    const s = x.at[f];
    if (typeof s !== "number" || !Number.isSafeInteger(s) || s < 0) return null;
    const v = fieldValue(f, x.set[f]);
    if (v === undefined) return null;
    set[f] = v;
    at[f] = s;
  }
  if (Object.keys(set).length === 0) return null;
  if (JSON.stringify({ set, at }).length > DOOR_EVENT_MAX_BYTES) return null;
  return { d: x.d.toLowerCase(), set, at };
}

// Field by field: the higher stamp wins; equal keeps what is stored.
export function merge(
  fields: Record<string, unknown>,
  stamps: Record<string, number>,
  inc: Incoming,
): { fields: Record<string, unknown>; stamps: Record<string, number>; changed: boolean } {
  const f = { ...fields };
  const s = { ...stamps };
  let changed = false;
  for (const k of Object.keys(inc.set) as Field[]) {
    const stamp = inc.at[k]!;
    if (stamp > (s[k] ?? 0)) {
      if (JSON.stringify(f[k]) !== JSON.stringify(inc.set[k])) changed = true;
      f[k] = inc.set[k];
      s[k] = stamp;
    }
  }
  return { fields: f, stamps: s, changed };
}

// The wire's removed rule: removed, with a stamp at least every other field's.
export function isRemoved(fields: Record<string, unknown>, stamps: Record<string, number>): boolean {
  if (fields.removed !== true) return false;
  const r = stamps.removed ?? 0;
  return Object.entries(stamps).every(([k, v]) => k === "removed" || v <= r);
}

function gidParam(params: unknown[]): string | null {
  const gid = params[0];
  return typeof gid === "string" && GID_RE.test(gid) ? gid : null;
}

const NOT_IN_GROUP = "you are not in this group";

function doorPut(sql: SqlStorage, params: unknown[], signer: string, nowSec: number): Reply {
  const gid = gidParam(params);
  if (gid === null) return { error: "doorput: the first parameter must be a group id" };
  if (memberOf(sql, gid, signer) === null) return { error: `doorput: ${NOT_IN_GROUP}` };
  const list = params[1];
  if (!Array.isArray(list) || list.length === 0) return { error: "doorput: the second parameter must be a list of events" };
  if (list.length > DOOR_EVENTS_PER_CALL) return { error: `doorput: at most ${DOOR_EVENTS_PER_CALL} events a call` };
  let stored = 0;
  let refused = 0;
  for (const raw of list) {
    const inc = parseIncoming(raw);
    if (inc === null) {
      refused++;
      continue;
    }
    const row = sql
      .exec<{ fields: string; stamps: string; seq: number; updated_at: number }>(
        `SELECT fields, stamps, seq, updated_at FROM door_events WHERE gid = ? AND d = ?`,
        gid,
        inc.d,
      )
      .toArray()[0];
    if (row === undefined) {
      if (!makeRoom(sql, gid)) {
        refused++;
        continue;
      }
      const m = merge({}, {}, inc);
      sql.exec(
        `INSERT INTO door_events (gid, d, fields, stamps, seq, updated_at, updated_by) VALUES (?, ?, ?, ?, 0, ?, ?)`,
        gid,
        inc.d,
        JSON.stringify(m.fields),
        JSON.stringify(m.stamps),
        nowSec,
        signer,
      );
      stored++;
      continue;
    }
    const m = merge(JSON.parse(row.fields), JSON.parse(row.stamps), inc);
    if (JSON.stringify(m.stamps) === row.stamps) continue;
    // SEQUENCE in the calendar moves only when something a person sees moved.
    sql.exec(
      `UPDATE door_events SET fields = ?, stamps = ?, seq = ?, updated_at = ?, updated_by = ? WHERE gid = ? AND d = ?`,
      JSON.stringify(m.fields),
      JSON.stringify(m.stamps),
      m.changed ? row.seq + 1 : row.seq,
      m.changed ? nowSec : row.updated_at,
      signer,
      gid,
      inc.d,
    );
    stored++;
  }
  return { result: { stored, refused } };
}

// A full group's door gives up its longest-removed event for a new one.
function makeRoom(sql: SqlStorage, gid: string): boolean {
  const n = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM door_events WHERE gid = ?`, gid).one().n;
  if (n < DOOR_EVENTS_PER_GROUP) return true;
  const rows = sql
    .exec<{ d: string; fields: string; stamps: string }>(
      `SELECT d, fields, stamps FROM door_events WHERE gid = ? ORDER BY updated_at`,
      gid,
    )
    .toArray();
  const gone = rows.find((r) => isRemoved(JSON.parse(r.fields), JSON.parse(r.stamps)));
  if (gone === undefined) return false;
  sql.exec(`DELETE FROM door_events WHERE gid = ? AND d = ?`, gid, gone.d);
  return true;
}

function doorCount(sql: SqlStorage, params: unknown[], signer: string): Reply {
  const gid = gidParam(params);
  if (gid === null) return { error: "doorcount: the parameter must be a group id" };
  if (memberOf(sql, gid, signer) === null) return { error: `doorcount: ${NOT_IN_GROUP}` };
  const n = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM door_events WHERE gid = ?`, gid).one().n;
  return { result: { events: n } };
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

const linkReply = (secret: string): Reply => ({ result: { path: `/cal/${secret}.ics` } });

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
): Reply {
  switch (method) {
    case "doorput":
      return doorPut(sql, params, signer, nowSec);
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

// Every event a link's person may see now: the doors of the groups they
// are on the roster of, newest first, capped. Null for no such link.
export function eventsForLink(sql: SqlStorage, secret: string): DoorEvent[] | null {
  const who = sql.exec<{ pubkey: string }>(`SELECT pubkey FROM calendar_links WHERE secret = ?`, secret).toArray()[0];
  if (who === undefined) return null;
  const rows = sql
    .exec<{ d: string; fields: string; stamps: string; seq: number; updated_at: number }>(
      `SELECT e.d, e.fields, e.stamps, e.seq, e.updated_at FROM door_events e
         JOIN home_group_members m ON m.gid = e.gid AND m.pubkey = ?
         ORDER BY e.updated_at DESC`,
      who.pubkey,
    )
    .toArray();
  const seen = new Set<string>();
  const out: DoorEvent[] = [];
  for (const r of rows) {
    if (seen.has(r.d)) continue;
    seen.add(r.d);
    out.push({ d: r.d, fields: JSON.parse(r.fields), stamps: JSON.parse(r.stamps), seq: r.seq, updatedAt: r.updated_at });
  }
  return out;
}

// ---------------------------------------------------------------------
// The calendar file (RFC 5545). Timed events are written in UTC, worked
// out from the event's own wall time and zone, so daylight saving is
// settled here once and no VTIMEZONE is needed. All-day events are DATE
// values; the end is the day after the last day.
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
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
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

export interface CalendarFile {
  body: string;
  lastModified: number;
}

// The whole file for a link. Removed events and events that ended more
// than CALENDAR_LINK_PAST_DAYS ago are left out, so the calendar app drops
// them; an event never complete (no title or start) is left out too.
export function calendarFile(events: DoorEvent[], name: string, nowMs: number): CalendarFile {
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
  const shown = events
    .map((ev) => ({ ev, title: ev.fields.title, start: timeOf(ev.fields.start) }))
    .filter((x) => typeof x.title === "string" && x.start !== null && !isRemoved(x.ev.fields, x.ev.stamps))
    .sort((a, b) => (a.ev.d < b.ev.d ? -1 : 1));
  for (const { ev, title, start } of shown) {
    const when = whenLines(start!, timeOf(ev.fields.end));
    if (when.overMs < cutoff) continue;
    if (n++ >= CALENDAR_LINK_MAX_EVENTS) break;
    const changed = ev.updatedAt * 1000;
    lastModified = Math.max(lastModified, changed);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.d}@dms`,
      `DTSTAMP:${utcStamp(changed)}`,
      `LAST-MODIFIED:${utcStamp(changed)}`,
      `SEQUENCE:${ev.seq}`,
      ...when.lines,
      `SUMMARY:${escapeText(title as string)}`,
    );
    if (typeof ev.fields.place === "string" && ev.fields.place) lines.push(`LOCATION:${escapeText(ev.fields.place)}`);
    if (typeof ev.fields.note === "string" && ev.fields.note) lines.push(`DESCRIPTION:${escapeText(ev.fields.note)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return { body: lines.map(foldLine).join(CRLF) + CRLF, lastModified };
}

export function etagOf(body: string): string {
  return `"${bytesToHex(sha256(enc.encode(body))).slice(0, 32)}"`;
}
