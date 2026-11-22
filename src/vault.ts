// The restore vault: each member's passkey-locked copy of their key, which
// this relay stores and cannot open (DMs' fingerprint restore, modelled on
// WhatsApp's passkey-encrypted backups).
//
// The person's passkey app holds a passkey for the RP ID `dms.aaro.cc`.
// Its PRF output locks a copy of their key on their phone; the locked copy
// (the "blob") is stored here, one row per passkey, keyed by the hex
// sha256 of the passkey's credential id. A new phone gets it back with a
// passkey assertion: no key, no signature, no membership needed, since a
// new phone has none of those yet.
//
// The methods (nip86.ts, index.ts):
//
//   vaultput [hash, {credentialId, publicKey, alg, blob, label}]   member
//   vaultlist []                                                    member
//   vaultdelete [hash]                                              member
//   vaultchallenge []                                               anyone, unsigned
//   vaultopen [hash, assertion]                                     anyone, unsigned
//
// The public key arrives on the member-signed vaultput as SPKI with its
// COSE algorithm, so nothing here parses CBOR or attestation.
//
// The two unsigned methods must not tell a stranger who has an account
// here. For a known and an unknown credential id, vaultopen gives the same
// answer (one fixed body for every failure), does the same work (an
// unknown hash is checked against a fixed dummy key), spends the challenge
// either way, counts the per-hash rate limit either way, and is held to a
// fixed time floor in the Worker (limits.ts VAULT_OPEN_FLOOR_MS).
// vaultchallenge takes no credential id at all, so it cannot differ by one.
//
// WebAuthn is verified here directly (ES256, EdDSA and RS256 over
// WebCrypto) rather than with @simplewebauthn/server: that library wants a
// COSE public key, which would mean parsing CBOR somewhere, and everything
// else it does (attestation, registration) is not needed.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { oneLine } from "./join-requests";
import {
  VAULT_BLOB_MAX_BYTES,
  VAULT_CHALLENGE_TTL_SECONDS,
  VAULT_LABEL_MAX_LENGTH,
  VAULT_ROW_MAX_BYTES,
  VAULT_ROWS_PER_MEMBER,
  vaultStorageBytes,
} from "./limits";

// The RP ID every DMs passkey is made for, on every home: the passkey
// belongs to the app, not to the home, so a friend's bothy accepts it with
// no setup.
export const VAULT_RP_ID = "dms.aaro.cc";

// Where a DMs assertion may come from: the web app, and the two Android
// apps (release cc.aaro.dms and debug cc.aaro.dms.debug), as
// `android:apk-key-hash:` plus the unpadded base64url SHA-256 of the
// signing certificate. env PASSKEY_ORIGINS adds to these, never replaces.
export const DEFAULT_PASSKEY_ORIGINS: readonly string[] = [
  "https://dms.aaro.cc",
  // 79:F6:D7:53:46:F9:78:73:C4:42:0A:B5:B8:F7:35:A0:CC:AC:F3:AF:A6:1E:FD:60:18:46:91:08:C4:1D:6E:EF
  "android:apk-key-hash:efbXU0b5eHPEQgq1uPc1oMys86-mHv1gGEaRCMQdbu8",
  // 45:87:63:71:86:3E:72:1D:35:74:D2:D5:90:92:B8:08:FF:A8:03:55:83:DB:3D:64:23:25:E8:5E:51:7C:CC:EE
  "android:apk-key-hash:RYdjcYY-ch01dNLVkJK4CP-oA1WD2z1kIyXoXlF8zO4",
];

export function passkeyOrigins(env: Env): Set<string> {
  const origins = new Set(DEFAULT_PASSKEY_ORIGINS);
  for (const extra of (env.PASSKEY_ORIGINS ?? "").split(",")) {
    const origin = extra.trim();
    if (origin !== "") origins.add(origin);
  }
  return origins;
}

// Every vaultopen failure, whatever the reason: no row, a wrong
// signature, a spent or forged challenge, a malformed call. Stable, and
// the only failure an app can see besides the rate limit.
export const VAULT_NOT_FOUND = "not found";

// The rate limits' answer (relay.ts), for vaultchallenge and vaultopen.
// Counted the same whether a row exists or not, so it says nothing about
// one.
export const VAULT_RATE_LIMITED = "rate limited: too many tries. Try again in a few minutes.";

// vaultput's answer when the vault's share of the budget is used up.
export const VAULT_FULL_MESSAGE = "blocked: this home's restore storage is full";

// COSE algorithm identifiers (RFC 9053 / IANA COSE registry).
export const COSE_ES256 = -7;
export const COSE_EDDSA = -8;
export const COSE_RS256 = -257;
const SUPPORTED_ALGS = new Set([COSE_ES256, COSE_EDDSA, COSE_RS256]);

// ---------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------

const B64URL_RE = /^[A-Za-z0-9_-]*={0,2}$/;

export function fromBase64url(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || !B64URL_RE.test(value)) return null;
  const plain = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (plain.length % 4 === 1) return null;
  try {
    const binary = atob(plain + "=".repeat((4 - (plain.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------------
// Challenges: 16 random bytes, a 4-byte expiry (seconds, big-endian) and
// the first 16 bytes of an HMAC over both under a key only this relay has
// (relay-identity.ts relayDerivedKey). Issuing writes nothing; spending
// one writes its nonce to `vault_spent`.
// ---------------------------------------------------------------------

export const VAULT_CHALLENGE_KEY_LABEL = "bothy restore vault challenge v1";

const NONCE_BYTES = 16;
const MAC_BYTES = 16;
const CHALLENGE_BYTES = NONCE_BYTES + 4 + MAC_BYTES;

export function issueChallenge(key: Uint8Array, nowSec: number): string {
  const body = new Uint8Array(NONCE_BYTES + 4);
  body.set(randomBytes(NONCE_BYTES), 0);
  new DataView(body.buffer).setUint32(NONCE_BYTES, nowSec + VAULT_CHALLENGE_TTL_SECONDS);
  const challenge = new Uint8Array(CHALLENGE_BYTES);
  challenge.set(body, 0);
  challenge.set(hmac(sha256, key, body).subarray(0, MAC_BYTES), body.length);
  return toBase64url(challenge);
}

// The nonce and expiry of a challenge this relay issued and that has not
// expired, or null. Says nothing about whether it was spent.
export function readChallenge(
  key: Uint8Array,
  challenge: string,
  nowSec: number,
): { nonce: string; expiresAt: number } | null {
  const bytes = fromBase64url(challenge);
  if (bytes === null || bytes.length !== CHALLENGE_BYTES) return null;
  const body = bytes.subarray(0, NONCE_BYTES + 4);
  const mac = hmac(sha256, key, body).subarray(0, MAC_BYTES);
  if (!sameBytes(mac, bytes.subarray(NONCE_BYTES + 4))) return null;
  const expiresAt = new DataView(bytes.buffer, bytes.byteOffset).getUint32(NONCE_BYTES);
  if (expiresAt <= nowSec) return null;
  return { nonce: bytesToHex(bytes.subarray(0, NONCE_BYTES)), expiresAt };
}

// Spends a challenge's nonce. False if it was already spent.
export function spendChallenge(sql: SqlStorage, nonce: string, expiresAt: number): boolean {
  const cursor = sql.exec(
    `INSERT INTO vault_spent (nonce, expires_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING`,
    nonce,
    expiresAt,
  );
  cursor.toArray();
  return cursor.rowsWritten > 0;
}

// Cron: forget spent nonces whose challenge has expired anyway.
export function sweepSpentChallenges(sql: SqlStorage, nowSec: number): void {
  sql.exec(`DELETE FROM vault_spent WHERE expires_at <= ?`, nowSec);
}

// ---------------------------------------------------------------------
// The assertion: PublicKeyCredential.toJSON() of a navigator.credentials.get
// (web), or Credential Manager's authenticationResponseJson (Android).
// ---------------------------------------------------------------------

export interface ParsedAssertion {
  credentialId: Uint8Array;
  clientDataJSON: Uint8Array;
  clientData: { type: unknown; challenge: unknown; origin: unknown; crossOrigin: unknown };
  authData: Uint8Array;
  signature: Uint8Array;
  userHandle: Uint8Array | null;
}

export function parseAssertion(value: unknown): ParsedAssertion | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as { id?: unknown; rawId?: unknown; type?: unknown; response?: unknown };
  if (raw.type !== undefined && raw.type !== "public-key") return null;
  const credentialId = fromBase64url(raw.rawId ?? raw.id);
  if (credentialId === null || credentialId.length === 0 || credentialId.length > 1023) return null;
  const response = raw.response as
    | { clientDataJSON?: unknown; authenticatorData?: unknown; signature?: unknown; userHandle?: unknown }
    | undefined;
  if (typeof response !== "object" || response === null) return null;
  const clientDataJSON = fromBase64url(response.clientDataJSON);
  const authData = fromBase64url(response.authenticatorData);
  const signature = fromBase64url(response.signature);
  if (clientDataJSON === null || authData === null || signature === null) return null;
  if (authData.length < 37 || signature.length === 0 || signature.length > 1024) return null;
  let userHandle: Uint8Array | null = null;
  if (response.userHandle !== undefined && response.userHandle !== null && response.userHandle !== "") {
    userHandle = fromBase64url(response.userHandle);
    if (userHandle === null) return null;
  }
  let clientData: unknown;
  try {
    clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));
  } catch {
    return null;
  }
  if (typeof clientData !== "object" || clientData === null) return null;
  const cd = clientData as Record<string, unknown>;
  return {
    credentialId,
    clientDataJSON,
    clientData: { type: cd.type, challenge: cd.challenge, origin: cd.origin, crossOrigin: cd.crossOrigin },
    authData,
    signature,
    userHandle,
  };
}

const RP_ID_HASH = sha256(new TextEncoder().encode(VAULT_RP_ID));
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;

// Everything about the assertion but the signature, the challenge and
// the row: type, origin, RP ID hash, user present and user verified.
export function assertionShapeOk(parsed: ParsedAssertion, origins: Set<string>): boolean {
  const cd = parsed.clientData;
  if (cd.type !== "webauthn.get") return false;
  if (typeof cd.origin !== "string" || !origins.has(cd.origin)) return false;
  if (cd.crossOrigin === true) return false;
  if (!sameBytes(parsed.authData.subarray(0, 32), RP_ID_HASH)) return false;
  const flags = parsed.authData[32]!;
  return (flags & FLAG_UP) !== 0 && (flags & FLAG_UV) !== 0;
}

export function signCount(authData: Uint8Array): number {
  return new DataView(authData.buffer, authData.byteOffset).getUint32(33);
}

// ---------------------------------------------------------------------
// Keys and signatures (WebCrypto).
// ---------------------------------------------------------------------

function importParams(alg: number): { name: string; namedCurve?: string; hash?: string } | null {
  if (alg === COSE_ES256) return { name: "ECDSA", namedCurve: "P-256" };
  if (alg === COSE_EDDSA) return { name: "Ed25519" };
  if (alg === COSE_RS256) return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return null;
}

// The key, or null if `spki` is not a public key of that algorithm (RSA
// keys below 2048 bits are refused).
// The fixed DER prefixes of a P-256 (uncompressed point) and an Ed25519
// SPKI. Checked byte for byte, because WebCrypto implementations differ on
// whether an import checks the key's algorithm OID (workerd's Ed25519
// import does not).
const P256_SPKI_PREFIX = hexToBytes("3059301306072a8648ce3d020106082a8648ce3d030107034200");
const ED25519_SPKI_PREFIX = hexToBytes("302a300506032b6570032100");

function hasPrefix(bytes: Uint8Array, prefix: Uint8Array, total: number): boolean {
  return bytes.length === total && sameBytes(bytes.subarray(0, prefix.length), prefix);
}

export async function importVaultKey(spki: Uint8Array, alg: number): Promise<CryptoKey | null> {
  const params = importParams(alg);
  if (params === null) return null;
  if (alg === COSE_ES256 && !hasPrefix(spki, P256_SPKI_PREFIX, 91)) return null;
  if (alg === COSE_EDDSA && !hasPrefix(spki, ED25519_SPKI_PREFIX, 44)) return null;
  try {
    const key = await crypto.subtle.importKey("spki", spki, params, false, ["verify"]);
    if (alg === COSE_RS256) {
      const bits = (key.algorithm as { modulusLength?: number }).modulusLength ?? 0;
      if (!(bits >= 2048)) return null;
    }
    return key;
  } catch {
    return null;
  }
}

// An ECDSA signature as WebAuthn gives it (ASN.1 DER SEQUENCE of two
// INTEGERs) in the raw r||s form WebCrypto verifies. Malformed input
// gives 64 zero bytes, which verifies against nothing.
export function derToRawEcdsa(der: Uint8Array): Uint8Array {
  const out = new Uint8Array(64);
  try {
    let i = 0;
    if (der[i++] !== 0x30) return out;
    const seqLen = der[i++]!;
    if (seqLen & 0x80) i += seqLen & 0x7f;
    for (let part = 0; part < 2; part++) {
      if (der[i++] !== 0x02) return new Uint8Array(64);
      const len = der[i++]!;
      let int = der.subarray(i, i + len);
      i += len;
      while (int.length > 32 && int[0] === 0) int = int.subarray(1);
      if (int.length > 32) return new Uint8Array(64);
      out.set(int, part * 32 + (32 - int.length));
    }
    return out;
  } catch {
    return new Uint8Array(64);
  }
}

export async function verifyVaultSignature(
  key: CryptoKey,
  alg: number,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    if (alg === COSE_ES256) {
      return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRawEcdsa(signature), data);
    }
    if (alg === COSE_EDDSA) return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
    return await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature, data);
  } catch {
    return false;
  }
}

// What an unknown hash is checked against, so the signature check runs
// whether or not a row exists. Throwaway public keys whose private halves
// were never kept. The algorithm is guessed from the signature's length,
// which is the caller's own input: 64 bytes is EdDSA, 256 or more RSA,
// anything else ECDSA.
const DUMMY_KEYS: Record<number, string> = {
  [COSE_ES256]:
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEvF5DIL9TN62Fqiu8W2AS9v1rHVIuAPwZKm0otmoq5eUIe8BD6_KuKgnbz1ieM4OswaEaZTLNv_O4P9_HBpvs1g",
  [COSE_EDDSA]: "MCowBQYDK2VwAyEAFs5wNhJ6Klz6jlB4ovoigZtLoyUj4PgjVqcAexr89Ac",
  [COSE_RS256]:
    "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArJ2teqgMubITCmyEARic_fqC8iXSEFx4pk7rGAjzPJvZNXYe8bci4TCDsqYPYmaPrWSNk7rlG5TDkvdoVOAmBpFNkRfwu68R_5LoydXGS1KB-9h-gof5nLmwTy_HcTUynZu2g-VfHjHBM8c-s3sWQkWqPKR33ixz21gUO5WcAJ11Hd0CAfhKDyD__0lfE_FhyZgD6Uswn_L9wWjPwUy_HG2FlLRYrCSzc208Z33YOlqIChPOvKQyzRSYK2jO9zegdoW8paygB7Z1oO96pQph9KDS8JbwFtvt_yG8S2cA8pCG70YqUmKLgs49T38-KfRtU8T2PCGudRFSF4yOjVxpBwIDAQAB",
};

export function dummyKeyFor(signature: Uint8Array): { spki: string; alg: number } {
  const alg = signature.length === 64 ? COSE_EDDSA : signature.length >= 256 ? COSE_RS256 : COSE_ES256;
  return { spki: DUMMY_KEYS[alg]!, alg };
}

// ---------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------

const HASH_RE = /^[0-9a-f]{64}$/;

export function isVaultHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

export type VaultRow = {
  hash: string;
  pubkey: string;
  credential_id: string;
  public_key: string;
  alg: number;
  blob: string;
  counter: number;
};

export function vaultRow(sql: SqlStorage, hash: string): VaultRow | null {
  return (
    sql
      .exec<VaultRow>(
        `SELECT hash, pubkey, credential_id, public_key, alg, blob, counter FROM vault WHERE hash = ?`,
        hash,
      )
      .toArray()[0] ?? null
  );
}

export function recordVaultUse(sql: SqlStorage, hash: string, counter: number, nowSec: number): void {
  sql.exec(`UPDATE vault SET counter = ?, last_used_at = ? WHERE hash = ?`, counter, nowSec, hash);
}

// With the member (eraseme), or at the end of their grace.
export function deleteVaultRowsOf(sql: SqlStorage, pubkey: string): void {
  sql.exec(`DELETE FROM vault WHERE pubkey = ?`, pubkey);
}

export interface VaultPutInput {
  hash: string;
  credentialId: string;
  publicKey: Uint8Array;
  publicKeyText: string;
  alg: number;
  blob: string;
  label: string | null;
  size: number;
}

const utf8Length = (value: string) => new TextEncoder().encode(value).length;

// vaultput's parameters, checked as far as can be done without WebCrypto
// (relay.ts manage then imports the key). A refusal message otherwise.
export function parseVaultPut(params: unknown[], signer: string): VaultPutInput | string {
  const [hash, fields] = params;
  if (!isVaultHash(hash)) return "vaultput: the first parameter must be the hex sha256 of the credential id";
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return 'vaultput takes [hash, {"credentialId", "publicKey", "alg", "blob", "label"}]';
  }
  const f = fields as Record<string, unknown>;
  const credentialBytes = fromBase64url(f.credentialId);
  if (credentialBytes === null || credentialBytes.length === 0 || credentialBytes.length > 1023) {
    return "vaultput: credentialId must be the passkey's credential id, base64url";
  }
  if (bytesToHex(sha256(credentialBytes)) !== hash) {
    return "vaultput: the hash must be the sha256 of the credential id";
  }
  const publicKey = fromBase64url(f.publicKey);
  if (publicKey === null || publicKey.length === 0) {
    return "vaultput: publicKey must be the passkey's public key, SPKI in base64url";
  }
  if (typeof f.alg !== "number" || !SUPPORTED_ALGS.has(f.alg)) {
    return "vaultput: alg must be -7 (ES256), -8 (EdDSA) or -257 (RS256)";
  }
  // The locked copy, as a JSON object (a string holding one is taken too).
  // Stored as its JSON text, which is what the size cap counts, and given
  // back as an object by vaultopen.
  let blob: unknown = f.blob;
  if (typeof blob === "string") {
    try {
      blob = JSON.parse(blob);
    } catch {
      return "vaultput: blob must be the locked copy, a JSON object";
    }
  }
  if (typeof blob !== "object" || blob === null || Array.isArray(blob)) {
    return "vaultput: blob must be the locked copy, a JSON object";
  }
  const blobText = JSON.stringify(blob);
  if (utf8Length(blobText) > VAULT_BLOB_MAX_BYTES) {
    return `vaultput: blob can be at most ${VAULT_BLOB_MAX_BYTES} bytes`;
  }
  const b = blob as Record<string, unknown>;
  if (b.v !== 2 || typeof b.iv !== "string" || typeof b.ct !== "string") {
    return 'vaultput: blob must be {"v": 2, "pubkey", "cred", "iv", "ct"}';
  }
  if (b.pubkey !== signer) return "vaultput: the blob must name your own pubkey";
  const blobCred = fromBase64url(b.cred);
  if (blobCred === null || bytesToHex(blobCred) !== bytesToHex(credentialBytes)) {
    return "vaultput: the blob must name this credential";
  }
  let label: string | null = null;
  if (f.label !== undefined && f.label !== null) {
    if (typeof f.label !== "string") return "vaultput: label must be a string";
    label = oneLine(f.label);
    if (label.length > VAULT_LABEL_MAX_LENGTH) {
      return `vaultput: label can be at most ${VAULT_LABEL_MAX_LENGTH} characters`;
    }
    if (label === "") label = null;
  }
  const credentialId = toBase64url(credentialBytes);
  const publicKeyText = toBase64url(publicKey);
  const size = credentialId.length + publicKeyText.length + utf8Length(blobText) + (label === null ? 0 : utf8Length(label));
  if (size > VAULT_ROW_MAX_BYTES) return `vaultput: a row can be at most ${VAULT_ROW_MAX_BYTES} bytes`;
  return { hash, credentialId, publicKey, publicKeyText, alg: f.alg, blob: blobText, label, size };
}

// Stores a checked vaultput (the key already imported). A refusal
// message, or null when stored.
export function storeVaultRow(
  sql: SqlStorage,
  env: Env,
  input: VaultPutInput,
  signer: string,
  nowSec: number,
): string | null {
  const existing = sql
    .exec<{ pubkey: string; size: number; public_key: string }>(
      `SELECT pubkey, size, public_key FROM vault WHERE hash = ?`,
      input.hash,
    )
    .toArray()[0];
  if (existing !== undefined && existing.pubkey !== signer) {
    return "vaultput: this passkey belongs to another account";
  }
  if (existing === undefined) {
    const mine =
      sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM vault WHERE pubkey = ?`, signer).toArray()[0]?.n ?? 0;
    if (mine >= VAULT_ROWS_PER_MEMBER) {
      return `vaultput: at most ${VAULT_ROWS_PER_MEMBER} passkeys each. Remove one first.`;
    }
  }
  const cap = vaultStorageBytes(env);
  if (cap !== null) {
    const used = sql.exec<{ n: number }>(`SELECT COALESCE(SUM(size), 0) AS n FROM vault`).toArray()[0]?.n ?? 0;
    if (used - (existing?.size ?? 0) + input.size > cap) return VAULT_FULL_MESSAGE;
  }
  // A new public key starts its signature counter again.
  const keepCounter = existing !== undefined && existing.public_key === input.publicKeyText;
  sql.exec(
    `INSERT INTO vault (hash, pubkey, credential_id, public_key, alg, blob, label, size, counter, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET public_key = excluded.public_key, alg = excluded.alg,
         blob = excluded.blob, label = excluded.label, size = excluded.size,
         counter = ${keepCounter ? "vault.counter" : "0"}, updated_at = excluded.updated_at`,
    input.hash,
    signer,
    input.credentialId,
    input.publicKeyText,
    input.alg,
    input.blob,
    input.label,
    input.size,
    nowSec,
    nowSec,
  );
  return null;
}

export interface VaultListEntry {
  hash: string;
  credentialId: string;
  // SPKI, base64url: lets a phone that restored re-lock with one passkey
  // get instead of making a new passkey.
  publicKey: string;
  alg: number;
  label: string | null;
  addedAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
}

// The signer's rows, oldest first, without their blobs.
export function listVaultRows(sql: SqlStorage, signer: string): VaultListEntry[] {
  return sql
    .exec<{
      hash: string;
      credential_id: string;
      public_key: string;
      alg: number;
      label: string | null;
      added_at: number;
      updated_at: number;
      last_used_at: number | null;
    }>(
      `SELECT hash, credential_id, public_key, alg, label, added_at, updated_at, last_used_at FROM vault
        WHERE pubkey = ? ORDER BY added_at ASC, hash ASC`,
      signer,
    )
    .toArray()
    .map((r) => ({
      hash: r.hash,
      credentialId: r.credential_id,
      publicKey: r.public_key,
      alg: r.alg,
      label: r.label,
      addedAt: r.added_at,
      updatedAt: r.updated_at,
      lastUsedAt: r.last_used_at,
    }));
}

// Idempotent, and only ever the signer's own row.
export function deleteVaultRow(sql: SqlStorage, hash: string, signer: string): void {
  sql.exec(`DELETE FROM vault WHERE hash = ? AND pubkey = ?`, hash, signer);
}

// ---------------------------------------------------------------------
// vaultopen. The caller (relay.ts) has applied the rate limits; the
// Worker holds the time floor. Returns the blob, or null for every kind
// of failure.
//
// The work is the same whether the row exists: the challenge is read and
// spent first, the row looked up, and the signature verified against the
// row's key or a dummy one. Only then are the results combined.
// ---------------------------------------------------------------------

export async function openVault(
  sql: SqlStorage,
  env: Env,
  challengeKey: Uint8Array,
  hash: string,
  assertionValue: unknown,
  nowSec: number,
): Promise<string | null> {
  const parsed = parseAssertion(assertionValue);
  if (parsed === null) return null;

  // Spent on every call that names a live challenge, found or not.
  const challenge =
    typeof parsed.clientData.challenge === "string"
      ? readChallenge(challengeKey, parsed.clientData.challenge, nowSec)
      : null;
  const challengeOk = challenge !== null && spendChallenge(sql, challenge.nonce, challenge.expiresAt);

  const row = vaultRow(sql, hash);
  const keySource = row !== null ? { spki: row.public_key, alg: row.alg } : dummyKeyFor(parsed.signature);
  const spki = fromBase64url(keySource.spki) ?? new Uint8Array(0);
  const key = await importVaultKey(spki, keySource.alg);
  const signed = new Uint8Array(parsed.authData.length + 32);
  signed.set(parsed.authData, 0);
  signed.set(sha256(parsed.clientDataJSON), parsed.authData.length);
  const signatureOk = key !== null && (await verifyVaultSignature(key, keySource.alg, parsed.signature, signed));

  const shapeOk = assertionShapeOk(parsed, passkeyOrigins(env));
  const idOk = bytesToHex(sha256(parsed.credentialId)) === hash;
  const count = signCount(parsed.authData);
  if (row === null || !challengeOk || !signatureOk || !shapeOk || !idOk) return null;
  if ((count !== 0 || row.counter !== 0) && count <= row.counter) return null;
  if (parsed.userHandle !== null && !sameBytes(parsed.userHandle, hexToBytes(row.pubkey))) return null;
  recordVaultUse(sql, hash, count, nowSec);
  return row.blob;
}
