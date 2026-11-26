// Vouching: getting back into an account on a new phone when the passkey
// is gone too (DMs' recovery layer 2). Someone the person trusts checks a
// short code with them, by call or in person, and approves; a day later
// this relay hands the new phone a copy of the key.
//
// That needs a copy this relay can open. The passkey-locked vault rows
// (src/vault.ts, blob v:2) are not one, so a member's app also keeps a
// second, vouch-only copy here: their key sealed with NIP-44 to this
// relay's own key (relay-identity.ts, NIP-11 `self`), blob
//
//   {"v": 3, "seal": "box", "pubkey": <hex>, "ct": <NIP-44 payload of the hex key>}
//
// The home's owner accepted, for now, that the box can open these: anyone
// holding this relay's storage (its secret key lives in the same database)
// can. vaultlist marks the copy box-readable so it is never mistaken for a
// passkey row. A split key (Keykin, layer 3) replaces it later.
//
// The methods (nip86.ts, index.ts):
//
//   vouchput [copy]                        member: keep my vouch copy
//   vouchdelete []                         member: drop it
//   vouchers []                            member: who may vouch for me
//   addvoucher [pubkey]                    member: name a member who may
//   removevoucher [pubkey]                 member
//   vouchrequests []                       member: requests I may approve
//   vouchapprove [pubkey, key]             member: approve one, by its one-time key
//   vouchdecline [pubkey, key]             member
//   myvouch []                             member: my open request and past ones
//   vouchcancel []                         member: cancel my open request
//   vouchask [pubkey, key]                 anyone, unsigned
//   vouchstatus [pubkey, key, token]       anyone, unsigned
//
// Who may vouch for a member: the owner and the admins, and the members
// they named themselves; never the member. A named voucher who leaves the
// home stops being one (storage.ts unallowPubkey), and every check is
// made again at the moment of release, so a voucher removed or demoted
// during the wait releases nothing.
//
// The two unsigned methods answer the same way for everyone. That is not
// the whole of what a stranger can learn: a stored request sends
// messages, which move the public counts on /api/stats, so someone who
// watches those around an ask can tell that a key is a member here with
// a copy. The README says so. vouchask answers every well-formed
// call the same way, {token, code, expiresAt}, whether a request was
// stored or not, and the token carries its own time and MAC so a request
// that was never stored can be asked about like one that was. A request is
// stored only for a current member with a vouch copy and no open request;
// otherwise nothing is stored and the token simply lapses. Both answers
// are held to the vault's time floor in the Worker (index.ts).
//
// One open request per account: a second ask while one is open is not
// stored (it would let someone race the real person's code). A voucher
// who sees a code nobody showed them declines it, which frees the place.
// What a stranger can learn: a request a voucher declined closes before
// its time, which an unstored one never does. That needs a person in the
// home to act on it, and is accepted.
import { schnorr } from "@noble/curves/secp256k1.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { npubEncode } from "./bech32";
import {
  mailBytesPerMember,
  mailStorageBytes,
  VOUCH_COPY_MAX_BYTES,
  VOUCH_HISTORY_PER_MEMBER,
  VOUCH_PICKUP_SECONDS,
  VOUCH_RELEASE_DELAY_SECONDS,
  VOUCH_REQUEST_TTL_SECONDS,
  VOUCHERS_PER_MEMBER,
  vaultStorageBytes,
  vouchEnabled,
} from "./limits";
import { nip44Decrypt, nip44Encrypt, wrapDirectMessage } from "./nip44";
import type { NostrEvent } from "./nostr";
import { getRelayPubkey, relayConversationKey, signAsRelay } from "./relay-identity";
import { isAdmin, listAdmins, mailRoom, roleOf, storeEvent, wrapBytes } from "./storage";
import { fromBase64url, toBase64url, VAULT_FULL_MESSAGE } from "./vault";

export { vouchEnabled };

export const VOUCH_OFF_MESSAGE = "this home does not take vouching";

const HEX64 = /^[0-9a-f]{64}$/;

// A 64-character hex x-only key that is a point on the curve, so NIP-44
// can encrypt to it.
export function isUsableKey(value: unknown): value is string {
  if (typeof value !== "string" || !HEX64.test(value)) return false;
  try {
    schnorr.utils.lift_x(BigInt("0x" + value));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// The vouch copy.
// ---------------------------------------------------------------------

export const VOUCH_COPY_V = 3;
export const VOUCH_COPY_SEAL = "box";

// The key inside a vouch copy, as 64 hex characters, or null if this
// relay cannot open it or it is not `pubkey`'s key.
export function openVouchCopy(sql: SqlStorage, pubkey: string, copy: unknown): string | null {
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) return null;
  const c = copy as Record<string, unknown>;
  if (c.v !== VOUCH_COPY_V || c.seal !== VOUCH_COPY_SEAL || c.pubkey !== pubkey || typeof c.ct !== "string") {
    return null;
  }
  let secret: string;
  try {
    secret = nip44Decrypt(c.ct, relayConversationKey(sql, pubkey));
  } catch {
    return null;
  }
  if (!HEX64.test(secret)) return null;
  try {
    if (bytesToHex(schnorr.getPublicKey(hexToBytes(secret))) !== pubkey) return null;
  } catch {
    return null;
  }
  return secret;
}

// vouchput: checked by opening it, so a copy that could never be handed
// over is refused now rather than discovered on the day it is needed.
export function storeVouchCopy(
  sql: SqlStorage,
  env: Env,
  signer: string,
  value: unknown,
  nowSec: number,
): string | null {
  let copy: unknown = value;
  if (typeof copy === "string") {
    try {
      copy = JSON.parse(copy);
    } catch {
      return "vouchput: the copy must be a JSON object";
    }
  }
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) {
    return "vouchput: the copy must be a JSON object";
  }
  const text = JSON.stringify(copy);
  const size = new TextEncoder().encode(text).length;
  if (size > VOUCH_COPY_MAX_BYTES) return `vouchput: the copy can be at most ${VOUCH_COPY_MAX_BYTES} bytes`;
  if ((copy as { pubkey?: unknown }).pubkey !== signer) return "vouchput: the copy must name your own pubkey";
  if (openVouchCopy(sql, signer, copy) === null) {
    return 'vouchput: the copy must be {"v": 3, "seal": "box", "pubkey", "ct"}, your key sealed to this home\'s key';
  }
  const cap = vaultStorageBytes(env);
  if (cap !== null) {
    const existing =
      sql.exec<{ size: number }>(`SELECT size FROM vouch_copies WHERE pubkey = ?`, signer).toArray()[0]?.size ?? 0;
    if (vaultBytesUsed(sql) - existing + size > cap) return VAULT_FULL_MESSAGE;
  }
  sql.exec(
    `INSERT INTO vouch_copies (pubkey, blob, size, added_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(pubkey) DO UPDATE SET blob = excluded.blob, size = excluded.size, updated_at = excluded.updated_at`,
    signer,
    text,
    size,
    nowSec,
    nowSec,
  );
  return null;
}

// The vault's share of the budget covers both kinds of copy.
export function vaultBytesUsed(sql: SqlStorage): number {
  return (
    sql
      .exec<{ n: number }>(
        `SELECT (SELECT COALESCE(SUM(size), 0) FROM vault) + (SELECT COALESCE(SUM(size), 0) FROM vouch_copies) AS n`,
      )
      .toArray()[0]?.n ?? 0
  );
}

export function deleteVouchCopy(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM vouch_copies WHERE pubkey = ?`, pubkey);
}

function hasVouchCopy(sql: SqlStorage, pubkey: string): boolean {
  return sql.exec(`SELECT 1 FROM vouch_copies WHERE pubkey = ?`, pubkey).toArray().length > 0;
}

// The vouch copy as vaultlist shows it: no hash and no credential, so an
// app that only knows passkey rows passes over it.
export interface VouchListEntry {
  seal: "box";
  boxReadable: true;
  vouch: true;
  addedAt: number;
  updatedAt: number;
}

export function vouchListEntry(sql: SqlStorage, pubkey: string): VouchListEntry | null {
  const row = sql
    .exec<{ added_at: number; updated_at: number }>(
      `SELECT added_at, updated_at FROM vouch_copies WHERE pubkey = ?`,
      pubkey,
    )
    .toArray()[0];
  if (row === undefined) return null;
  return { seal: "box", boxReadable: true, vouch: true, addedAt: row.added_at, updatedAt: row.updated_at };
}

// ---------------------------------------------------------------------
// Vouchers.
// ---------------------------------------------------------------------

export type VoucherWhy = "owner" | "admin" | "named";

// May `voucher` vouch for `member`, now.
//
// Nobody is let into an account above their own standing: the owner's
// account opens only for people the owner named, and an admin's only for
// the owner or people that admin named. Without this an admin could ask
// for the owner's account from a key of their own, approve it themselves,
// and hold the owner's key a day later (vouchask is unsigned).
export function mayVouch(sql: SqlStorage, owner: string | null, voucher: string, member: string): boolean {
  if (voucher === member) return false;
  const memberIsOwner = owner !== null && member === owner;
  if (!memberIsOwner) {
    if (owner !== null && voucher === owner) return true;
    if (isAdmin(sql, voucher) && !isAdmin(sql, member)) return true;
  }
  if (roleOf(sql, voucher, owner) === "none") return false;
  return sql.exec(`SELECT 1 FROM vouchers WHERE member = ? AND voucher = ?`, member, voucher).toArray().length > 0;
}

// Everyone who may vouch for `member` (the same rule as mayVouch), the
// owner first, then admins, then the people they named, each once.
export function vouchersFor(
  sql: SqlStorage,
  owner: string | null,
  member: string,
): { pubkey: string; why: VoucherWhy; addedAt: number | null }[] {
  const out: { pubkey: string; why: VoucherWhy; addedAt: number | null }[] = [];
  const seen = new Set([member]);
  if (owner !== null && !seen.has(owner)) {
    seen.add(owner);
    out.push({ pubkey: owner, why: "owner", addedAt: null });
  }
  const byStanding = !(owner !== null && member === owner) && !isAdmin(sql, member);
  for (const a of byStanding ? listAdmins(sql) : []) {
    if (seen.has(a.pubkey)) continue;
    seen.add(a.pubkey);
    out.push({ pubkey: a.pubkey, why: "admin", addedAt: null });
  }
  const named = sql
    .exec<{ voucher: string; added_at: number }>(
      `SELECT voucher, added_at FROM vouchers WHERE member = ? ORDER BY added_at ASC, voucher ASC`,
      member,
    )
    .toArray();
  for (const n of named) {
    if (seen.has(n.voucher) || roleOf(sql, n.voucher, owner) === "none") continue;
    seen.add(n.voucher);
    out.push({ pubkey: n.voucher, why: "named", addedAt: n.added_at });
  }
  return out;
}

export function addVoucher(
  sql: SqlStorage,
  owner: string | null,
  member: string,
  voucher: string,
  nowSec: number,
): string | null {
  if (voucher === member) return "addvoucher: you can't vouch for yourself";
  if (roleOf(sql, voucher, owner) === "none") return "addvoucher: they need to be in this home";
  const named = sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vouchers WHERE member = ?`, member).toArray()[0]?.n ?? 0;
  const already = sql.exec(`SELECT 1 FROM vouchers WHERE member = ? AND voucher = ?`, member, voucher).toArray().length > 0;
  if (!already && named >= VOUCHERS_PER_MEMBER) {
    return `addvoucher: at most ${VOUCHERS_PER_MEMBER} people each. Remove one first.`;
  }
  sql.exec(
    `INSERT INTO vouchers (member, voucher, added_at) VALUES (?, ?, ?) ON CONFLICT(member, voucher) DO NOTHING`,
    member,
    voucher,
    nowSec,
  );
  return null;
}

export function removeVoucher(sql: SqlStorage, member: string, voucher: string): void {
  sql.exec(`DELETE FROM vouchers WHERE member = ? AND voucher = ?`, member, voucher);
}

// ---------------------------------------------------------------------
// The code both screens show: six digits from the account and the new
// phone's one-time key, so a voucher approving a different phone's
// request sees a different code.
// ---------------------------------------------------------------------

export function vouchCode(pubkey: string, key: string): string {
  const digest = sha256(new TextEncoder().encode(`bothy vouch code v1:${pubkey}:${key}`));
  const n = new DataView(digest.buffer, digest.byteOffset).getUint32(0) % 1_000_000;
  return n.toString().padStart(6, "0");
}

// ---------------------------------------------------------------------
// Tokens: a 4-byte ask time (seconds, big-endian) and the first 16 bytes
// of an HMAC over the account, the one-time key and that time, under a
// key only this relay has (relay-identity.ts relayDerivedKey). Issuing
// one writes nothing.
// ---------------------------------------------------------------------

export const VOUCH_TOKEN_KEY_LABEL = "bothy vouch token v1";

function tokenMac(tokenKey: Uint8Array, pubkey: string, key: string, askedAt: number): Uint8Array {
  const body = new Uint8Array(68);
  body.set(hexToBytes(pubkey), 0);
  body.set(hexToBytes(key), 32);
  new DataView(body.buffer).setUint32(64, askedAt);
  return hmac(sha256, tokenKey, body).subarray(0, 16);
}

export function issueToken(tokenKey: Uint8Array, pubkey: string, key: string, askedAt: number): string {
  const out = new Uint8Array(20);
  new DataView(out.buffer).setUint32(0, askedAt);
  out.set(tokenMac(tokenKey, pubkey, key, askedAt), 4);
  return toBase64url(out);
}

// The ask time a token was issued with, or null if this relay did not
// issue it for this account and key.
export function readToken(tokenKey: Uint8Array, pubkey: string, key: string, token: unknown): number | null {
  const bytes = fromBase64url(token);
  if (bytes === null || bytes.length !== 20) return null;
  const askedAt = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
  const mac = tokenMac(tokenKey, pubkey, key, askedAt);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= mac[i]! ^ bytes[4 + i]!;
  return diff === 0 ? askedAt : null;
}

// ---------------------------------------------------------------------
// Requests.
// ---------------------------------------------------------------------

export type VouchRequestRow = {
  id: number;
  pubkey: string;
  key: string;
  asked_at: number;
  approved_by: string | null;
  approved_at: number | null;
  release_at: number | null;
  released_at: number | null;
  closed_at: number | null;
  closed_by: string | null;
  closed_why: string | null;
};

// waiting: for a voucher. approved: a voucher said yes, the delay runs.
// ready: the delay is over, the new phone may collect. closed: declined,
// cancelled, lapsed, collected window over, or its approval stopped
// counting.
export type VouchState = "waiting" | "approved" | "ready" | "closed";

export function stateOf(row: VouchRequestRow, nowSec: number): VouchState {
  if (row.closed_at !== null) return "closed";
  if (row.approved_at === null || row.release_at === null) {
    return nowSec < row.asked_at + VOUCH_REQUEST_TTL_SECONDS ? "waiting" : "closed";
  }
  if (nowSec < row.release_at) return "approved";
  return nowSec < row.release_at + VOUCH_PICKUP_SECONDS ? "ready" : "closed";
}

const isOpen = (state: VouchState) => state !== "closed";

const REQUEST_COLUMNS =
  "id, pubkey, key, asked_at, approved_by, approved_at, release_at, released_at, closed_at, closed_by, closed_why";

function latestRequest(sql: SqlStorage, pubkey: string): VouchRequestRow | null {
  return (
    sql
      .exec<VouchRequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM vouch_requests WHERE pubkey = ? ORDER BY asked_at DESC, id DESC LIMIT 1`,
        pubkey,
      )
      .toArray()[0] ?? null
  );
}

function openRequest(sql: SqlStorage, pubkey: string, nowSec: number): VouchRequestRow | null {
  const row = latestRequest(sql, pubkey);
  return row !== null && isOpen(stateOf(row, nowSec)) ? row : null;
}

function closeRequest(sql: SqlStorage, id: number, nowSec: number, by: string | null, why: string): void {
  sql.exec(
    `UPDATE vouch_requests SET closed_at = ?, closed_by = ?, closed_why = ? WHERE id = ? AND closed_at IS NULL`,
    nowSec,
    by,
    why,
    id,
  );
}

// A message from this relay to one person, as join requests are sent
// (join-requests.ts): NIP-17, sealed with the relay's key, stored in their
// mailbox here. A voucher's is skipped when their mailbox has no room (the
// same thing is always in vouchrequests); the account's own is always kept.
export const VOUCH_TAG = "bothy";

function notice(
  sql: SqlStorage,
  env: Env,
  recipient: string,
  kind: string,
  account: string,
  content: string,
  nowSec: number,
): NostrEvent | null {
  const { wrap } = wrapDirectMessage({
    senderPubkey: getRelayPubkey(sql),
    senderConversationKey: relayConversationKey(sql, recipient),
    signSeal: (id) => signAsRelay(sql, id),
    recipientPubkey: recipient,
    content,
    tags: [[VOUCH_TAG, kind, account]],
    nowSec,
  });
  const fits = mailRoom(
    sql,
    [recipient],
    wrapBytes(wrap.content, JSON.stringify(wrap.tags)),
    mailStorageBytes(env),
    mailBytesPerMember(env),
  );
  // The account's own warning is what makes the 24-hour wait worth
  // anything, so it is stored even when their mailbox is full: it is a
  // few hundred bytes, and asks are limited to 3 an hour per account.
  if (fits !== "ok" && recipient !== account) return null;
  return storeEvent(sql, wrap, nowSec).stored ?? null;
}

const mention = (pubkey: string) => `nostr:${npubEncode(pubkey)}`;

export function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}

export const VOUCH_DELAY_WORDS = "24 hours";

export function askedText(account: string, code: string): string {
  return [
    `Someone is asking to get back into this account on a new phone:`,
    mention(account),
    `Call them or see them in person, and check that their new phone shows ${spaced(code)}. If it does, approve it in DMs. If you don't know about it, decline it.`,
  ].join("\n\n");
}

export const ASKED_OWN_TEXT =
  "Someone asked to get back into your account on a new phone. If that wasn't you, cancel it in DMs on this phone.";

export function approvedOwnText(approver: string): string {
  return [
    `Someone approved a new phone for your account:`,
    mention(approver),
    `It gets in after ${VOUCH_DELAY_WORDS}. If that wasn't you, cancel it in DMs on this phone before then.`,
  ].join("\n\n");
}

export function releasedOwnText(approver: string): string {
  return [`A new phone got into your account. It was let in by:`, mention(approver)].join("\n\n");
}

export const VOUCH_ASK_USAGE = "vouchask takes [the account's pubkey, a one-time key], as 64-character hex";

export interface AskInput {
  pubkey: string;
  key: string;
}

export function parseAsk(params: unknown[]): AskInput | null {
  const [pubkey, key] = params;
  if (typeof pubkey !== "string" || !HEX64.test(pubkey) || !isUsableKey(key) || key === pubkey) return null;
  return { pubkey, key };
}

// vouchask: the same answer whether or not anything was stored.
export function askVouch(
  sql: SqlStorage,
  env: Env,
  owner: string | null,
  tokenKey: Uint8Array,
  input: AskInput,
  nowSec: number,
): { result: { token: string; code: string; expiresAt: number }; outbox: NostrEvent[] } {
  const result = {
    token: issueToken(tokenKey, input.pubkey, input.key, nowSec),
    code: vouchCode(input.pubkey, input.key),
    expiresAt: nowSec + VOUCH_REQUEST_TTL_SECONDS,
  };
  const outbox: NostrEvent[] = [];
  const stores =
    vouchEnabled(env) &&
    owner !== null &&
    roleOf(sql, input.pubkey, owner) !== "none" &&
    hasVouchCopy(sql, input.pubkey) &&
    openRequest(sql, input.pubkey, nowSec) === null;
  if (!stores) return { result, outbox };

  sql.exec(`INSERT INTO vouch_requests (pubkey, key, asked_at) VALUES (?, ?, ?)`, input.pubkey, input.key, nowSec);
  pruneHistory(sql, input.pubkey);
  for (const v of vouchersFor(sql, owner, input.pubkey)) {
    const sent = notice(sql, env, v.pubkey, "vouchrequest", input.pubkey, askedText(input.pubkey, result.code), nowSec);
    if (sent !== null) outbox.push(sent);
  }
  const own = notice(sql, env, input.pubkey, "vouchasked", input.pubkey, ASKED_OWN_TEXT, nowSec);
  if (own !== null) outbox.push(own);
  return { result, outbox };
}

function pruneHistory(sql: SqlStorage, pubkey: string): void {
  sql.exec(
    `DELETE FROM vouch_requests WHERE pubkey = ? AND id NOT IN
       (SELECT id FROM vouch_requests WHERE pubkey = ? ORDER BY asked_at DESC, id DESC LIMIT ?)`,
    pubkey,
    pubkey,
    VOUCH_HISTORY_PER_MEMBER,
  );
}

export type StatusAnswer =
  | { state: "waiting"; expiresAt: number }
  | { state: "approved"; releaseAt: number }
  | { state: "ready"; copy: { v: 1; pubkey: string; box: string; ct: string } }
  | { state: "closed" };

// vouchstatus. A token this relay issued but never stored a request for
// answers "waiting" until its time runs out, exactly like a stored one
// nobody has approved.
export function vouchStatus(
  sql: SqlStorage,
  env: Env,
  owner: string | null,
  tokenKey: Uint8Array,
  params: unknown[],
  nowSec: number,
): { result: StatusAnswer; outbox: NostrEvent[] } | null {
  const [pubkey, key, token] = params;
  if (typeof pubkey !== "string" || !HEX64.test(pubkey) || typeof key !== "string" || !HEX64.test(key)) return null;
  const askedAt = readToken(tokenKey, pubkey, key, token);
  if (askedAt === null) return null;
  const outbox: NostrEvent[] = [];
  const row =
    sql
      .exec<VouchRequestRow>(
        `SELECT ${REQUEST_COLUMNS} FROM vouch_requests WHERE pubkey = ? AND key = ? AND asked_at = ?`,
        pubkey,
        key,
        askedAt,
      )
      .toArray()[0] ?? null;
  if (row === null) {
    return {
      result:
        nowSec < askedAt + VOUCH_REQUEST_TTL_SECONDS
          ? { state: "waiting", expiresAt: askedAt + VOUCH_REQUEST_TTL_SECONDS }
          : { state: "closed" },
      outbox,
    };
  }
  const state = stateOf(row, nowSec);
  if (state === "waiting") return { result: { state, expiresAt: row.asked_at + VOUCH_REQUEST_TTL_SECONDS }, outbox };
  if (state === "closed") return { result: { state }, outbox };

  // Approved or ready: everything that made the approval count must
  // still hold.
  const stillCounts =
    vouchEnabled(env) &&
    row.approved_by !== null &&
    roleOf(sql, pubkey, owner) !== "none" &&
    mayVouch(sql, owner, row.approved_by, pubkey);
  if (!stillCounts) {
    closeRequest(sql, row.id, nowSec, null, "approval-lapsed");
    return { result: { state: "closed" }, outbox };
  }
  if (state === "approved") return { result: { state, releaseAt: row.release_at! }, outbox };

  const stored = sql
    .exec<{ blob: string }>(`SELECT blob FROM vouch_copies WHERE pubkey = ?`, pubkey)
    .toArray()[0];
  const secret = stored === undefined ? null : openVouchCopy(sql, pubkey, JSON.parse(stored.blob) as unknown);
  if (secret === null) {
    closeRequest(sql, row.id, nowSec, null, "no-copy");
    return { result: { state: "closed" }, outbox };
  }
  const ct = nip44Encrypt(secret, relayConversationKey(sql, key));
  if (row.released_at === null) {
    sql.exec(`UPDATE vouch_requests SET released_at = ? WHERE id = ?`, nowSec, row.id);
    const own = notice(sql, env, pubkey, "vouchreleased", pubkey, releasedOwnText(row.approved_by!), nowSec);
    if (own !== null) outbox.push(own);
  }
  return { result: { state: "ready", copy: { v: 1, pubkey, box: getRelayPubkey(sql), ct } }, outbox };
}

export interface VoucherView {
  pubkey: string;
  key: string;
  code: string;
  askedAt: number;
  expiresAt: number;
  state: VouchState;
  approvedBy: string | null;
  approvedAt: number | null;
  releaseAt: number | null;
  // Set once the new phone has collected the copy. The request stays open
  // through the pickup window, so apps use this to stop offering Cancel.
  releasedAt: number | null;
}

function view(row: VouchRequestRow, nowSec: number): VoucherView {
  return {
    pubkey: row.pubkey,
    key: row.key,
    code: vouchCode(row.pubkey, row.key),
    askedAt: row.asked_at,
    expiresAt: row.asked_at + VOUCH_REQUEST_TTL_SECONDS,
    state: stateOf(row, nowSec),
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    releaseAt: row.release_at,
    releasedAt: row.released_at,
  };
}

// vouchrequests: every open request the caller may vouch for, newest first.
export function requestsFor(sql: SqlStorage, owner: string | null, voucher: string, nowSec: number): VoucherView[] {
  return sql
    .exec<VouchRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM vouch_requests WHERE closed_at IS NULL AND asked_at > ? ORDER BY asked_at DESC, id DESC`,
      nowSec - VOUCH_REQUEST_TTL_SECONDS - VOUCH_RELEASE_DELAY_SECONDS - VOUCH_PICKUP_SECONDS,
    )
    .toArray()
    .filter((row) => isOpen(stateOf(row, nowSec)) && mayVouch(sql, owner, voucher, row.pubkey))
    .map((row) => view(row, nowSec));
}

export type DecideOutcome =
  | { ok: true; releaseAt: number | null; outbox: NostrEvent[] }
  | { ok: false; error: string };

// vouchapprove and vouchdecline. The request is named by its account and
// one-time key: approving names the phone whose code was checked.
export function decideVouch(
  sql: SqlStorage,
  env: Env,
  owner: string | null,
  voucher: string,
  params: unknown[],
  approve: boolean,
  nowSec: number,
): DecideOutcome {
  const method = approve ? "vouchapprove" : "vouchdecline";
  const [pubkey, key] = params;
  if (typeof pubkey !== "string" || !HEX64.test(pubkey) || typeof key !== "string" || !HEX64.test(key)) {
    return { ok: false, error: `${method} takes [the account's pubkey, the new phone's key], as hex` };
  }
  if (!mayVouch(sql, owner, voucher, pubkey)) return { ok: false, error: `${method}: you can't vouch for this account` };
  const row = openRequest(sql, pubkey, nowSec);
  if (row === null || row.key !== key) return { ok: false, error: `${method}: that request is no longer open` };
  if (!approve) {
    closeRequest(sql, row.id, nowSec, voucher, "declined");
    return { ok: true, releaseAt: null, outbox: [] };
  }
  if (row.approved_at !== null) return { ok: false, error: "vouchapprove: someone already approved it" };
  const releaseAt = nowSec + VOUCH_RELEASE_DELAY_SECONDS;
  sql.exec(
    `UPDATE vouch_requests SET approved_by = ?, approved_at = ?, release_at = ? WHERE id = ?`,
    voucher,
    nowSec,
    releaseAt,
    row.id,
  );
  const outbox: NostrEvent[] = [];
  const own = notice(sql, env, pubkey, "vouchapproved", pubkey, approvedOwnText(voucher), nowSec);
  if (own !== null) outbox.push(own);
  return { ok: true, releaseAt, outbox };
}

export interface MyVouch {
  open: VoucherView | null;
  past: {
    key: string;
    askedAt: number;
    approvedBy: string | null;
    approvedAt: number | null;
    releasedAt: number | null;
    closedAt: number | null;
    closedBy: string | null;
    why: string | null;
  }[];
}

// myvouch: the caller's open request, and every past one kept, newest
// first. A past request with releasedAt is a phone that got in.
export function myVouch(sql: SqlStorage, pubkey: string, nowSec: number): MyVouch {
  const rows = sql
    .exec<VouchRequestRow>(
      `SELECT ${REQUEST_COLUMNS} FROM vouch_requests WHERE pubkey = ? ORDER BY asked_at DESC, id DESC`,
      pubkey,
    )
    .toArray();
  let open: VoucherView | null = null;
  const past: MyVouch["past"] = [];
  for (const row of rows) {
    const state = stateOf(row, nowSec);
    if (open === null && isOpen(state)) {
      open = view(row, nowSec);
      continue;
    }
    past.push({
      key: row.key,
      askedAt: row.asked_at,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      releasedAt: row.released_at,
      closedAt: row.closed_at,
      closedBy: row.closed_by,
      why: row.closed_why ?? (row.released_at !== null ? "released" : "lapsed"),
    });
  }
  return { open, past };
}

// vouchcancel: the account's own devices close its open request, in any
// state up to the copy being collected.
export function cancelVouch(sql: SqlStorage, pubkey: string, nowSec: number): boolean {
  const row = openRequest(sql, pubkey, nowSec);
  if (row === null) return false;
  closeRequest(sql, row.id, nowSec, pubkey, "cancelled");
  return true;
}
