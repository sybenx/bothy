// Android push through Firebase Cloud Messaging (FCM HTTP v1), beside web
// push (push.ts). An Android app that is not a browser cannot take a web
// push subscription, so it registers an FCM token instead (nip86.ts
// subscribefcm) and the relay sends it a data message when mail arrives.
//
// What a message carries is the same rule as web push: the kind, the room
// name (already public) and the app's own label, never a sender, text or
// conversation. It is a DATA message, never a "notification" block, so the
// app decides what to show, and HIGH priority so Android delivers it at
// once. It still passes through Google; that is what FCM is.
//
// Auth is a Google service account: the owner stores its JSON as the
// FCM_SERVICE_ACCOUNT secret. The relay signs a short JWT with the
// account's RSA key (WebCrypto, RS256), trades it for an OAuth access
// token, and keeps that token until shortly before it expires. Unset is a
// supported state: no `fcm` on NIP-11, subscribefcm refused, nothing sent.

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

// How long a minted access token is reused: Google issues them for an
// hour; this stops a minute short so one never expires mid-send.
const TOKEN_REUSE_MARGIN_SECONDS = 60;

// The same hour web push gives a message (limits.ts PUSH_TTL_SECONDS).
const FCM_TTL = "3600s";

export interface ServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKeyPem: string;
  keyId: string | null;
  tokenUri: string;
}

// The parts of the service-account JSON that are needed, or null when the
// secret is unset or is not one. Malformed is logged once and treated as
// off, like a malformed VAPID key.
const parsed = new Map<string, ServiceAccount | null>();

export function serviceAccount(env: Env): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  if (parsed.has(raw)) return parsed.get(raw)!;
  let account: ServiceAccount | null = null;
  try {
    const json = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof json.project_id === "string" &&
      typeof json.client_email === "string" &&
      typeof json.private_key === "string" &&
      json.private_key.includes("PRIVATE KEY")
    ) {
      account = {
        projectId: json.project_id,
        clientEmail: json.client_email,
        privateKeyPem: json.private_key,
        keyId: typeof json.private_key_id === "string" ? json.private_key_id : null,
        tokenUri: typeof json.token_uri === "string" ? json.token_uri : DEFAULT_TOKEN_URI,
      };
    }
  } catch {
    account = null;
  }
  if (account === null) {
    console.warn("FCM_SERVICE_ACCOUNT is set but is not a Google service-account JSON; Android push is off");
  }
  parsed.set(raw, account);
  return account;
}

export function fcmConfigured(env: Env): boolean {
  return serviceAccount(env) !== null;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const utf8 = new TextEncoder();

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

// The signed assertion Google trades for an access token (RFC 7523).
export async function buildAssertion(account: ServiceAccount, nowSec: number): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", ...(account.keyId ? { kid: account.keyId } : {}) };
  const claims = {
    iss: account.clientEmail,
    scope: FCM_SCOPE,
    aud: account.tokenUri,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const input = `${base64Url(utf8.encode(JSON.stringify(header)))}.${base64Url(utf8.encode(JSON.stringify(claims)))}`;
  const key = await importPrivateKey(account.privateKeyPem);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8.encode(input)));
  return `${input}.${base64Url(signature)}`;
}

// One access token per service account, in memory. An evicted object
// mints a new one, which is one request.
const accessTokens = new Map<string, { token: string; expiresAt: number }>();

export function forgetAccessToken(account: ServiceAccount): void {
  accessTokens.delete(account.clientEmail);
}

export async function accessToken(account: ServiceAccount, nowSec: number): Promise<string | null> {
  const cached = accessTokens.get(account.clientEmail);
  if (cached && cached.expiresAt - TOKEN_REUSE_MARGIN_SECONDS > nowSec) return cached.token;
  try {
    const response = await fetch(account.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: await buildAssertion(account, nowSec),
      }).toString(),
    });
    if (!response.ok) {
      console.warn(
        `fcm: Google refused the service account (${response.status}); no Android push this round`,
      );
      return null;
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") return null;
    const lifetime = typeof body.expires_in === "number" ? body.expires_in : 3600;
    accessTokens.set(account.clientEmail, { token: body.access_token, expiresAt: nowSec + lifetime });
    return body.access_token;
  } catch {
    return null;
  }
}

// Whether a token needs minting before the next send, so the caller can
// count that request against its subrequest budget.
export function needsAccessToken(account: ServiceAccount, nowSec: number): boolean {
  const cached = accessTokens.get(account.clientEmail);
  return !(cached && cached.expiresAt - TOKEN_REUSE_MARGIN_SECONDS > nowSec);
}

// What a send resolved to. "gone": the token is dead for good (404, or
// UNREGISTERED in the error details) and should be deleted. "auth": the
// access token was refused, so the cached one is dropped. Anything else
// is "failed" and keeps the token, as web push does.
export type FcmOutcome = "sent" | "gone" | "auth" | "failed";

export function fcmMessage(token: string, data: Record<string, string>): unknown {
  return { message: { token, data, android: { priority: "HIGH", ttl: FCM_TTL } } };
}

export async function sendFcm(
  account: ServiceAccount,
  accessTokenValue: string,
  token: string,
  data: Record<string, string>,
): Promise<FcmOutcome> {
  try {
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${account.projectId}/messages:send`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessTokenValue}`, "Content-Type": "application/json" },
        body: JSON.stringify(fcmMessage(token, data)),
      },
    );
    if (response.ok) return "sent";
    if (response.status === 401 || response.status === 403) return "auth";
    if (response.status === 404) return "gone";
    const body = (await response.json().catch(() => null)) as {
      error?: { details?: { errorCode?: string }[] };
    } | null;
    if (body?.error?.details?.some((d) => d.errorCode === "UNREGISTERED")) return "gone";
    return "failed";
  } catch {
    return "failed";
  }
}

// The web push payload as FCM data, whose values must all be strings:
// {"kind", "room", "label"?} and nothing else.
export function fcmData(payload: { kind: string; room: string; label?: string }): Record<string, string> {
  return {
    kind: payload.kind,
    room: payload.room,
    ...(payload.label === undefined ? {} : { label: payload.label }),
  };
}
