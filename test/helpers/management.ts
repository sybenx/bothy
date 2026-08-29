// Plumbing for the NIP-86 management endpoint (src/index.ts
// handleManagement). Unlike every other client path in this suite, this
// one is plain HTTP rather than a WebSocket, so it goes through the
// Worker's fetch handler directly instead of through helpers/socket.ts.
import { exports } from "cloudflare:workers";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { HTTP_AUTH_KIND } from "../../src/nip98";
import { MANAGEMENT_CONTENT_TYPE } from "../../src/nip86";
import { signEvent } from "./event";
import { OWNER_SECRET_KEY_HEX } from "./keys";

// NIP-86 puts the management API "on the same URI as the relay's
// websocket" -- the relay root, not a sub-path.
export const MANAGEMENT_URL = "https://example.com/";

export function bodyHash(body: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(body)));
}

// Each field overrides one part of the NIP-98 event or the request, so a
// reject-path test can break exactly one rule at a time and nothing else
// -- the accept path is the same code with no overrides passed.
export interface AuthOptions {
  secretKeyHex?: string;
  u?: string;
  methodTag?: string;
  payload?: string;
  kind?: number;
  createdAt?: number;
  omitPayloadTag?: boolean;
  omitAuthHeader?: boolean;
  authHeader?: string;
  ip?: string;
  requestUrl?: string;
}

export function nip98Header(body: string, opts: AuthOptions = {}): string {
  const tags: string[][] = [
    ["u", opts.u ?? MANAGEMENT_URL],
    ["method", opts.methodTag ?? "POST"],
  ];
  if (!opts.omitPayloadTag) tags.push(["payload", opts.payload ?? bodyHash(body)]);
  const event = signEvent(opts.secretKeyHex ?? OWNER_SECRET_KEY_HEX, {
    kind: opts.kind ?? HTTP_AUTH_KIND,
    tags,
    // Spread rather than pass undefined -- signEvent's own default (now)
    // is what an unspecified created_at should get.
    ...(opts.createdAt === undefined ? {} : { created_at: opts.createdAt }),
  });
  return `Nostr ${btoa(JSON.stringify(event))}`;
}

export interface ManagementReply {
  status: number;
  result?: unknown;
  error?: string;
}

// Management calls go through the same per-IP limiter as every other HTTP
// path (index.ts rateLimited(env.RATE_LIMIT_API, ...)), and this helper is
// shared by three test files that between them make well over a hundred
// calls. A caller that doesn't ask for a particular address used to fall
// through to no header at all, which index.ts reads as the literal string
// "unknown" -- so every one of those calls landed in the same bucket, and
// nothing kept that bucket under the shared 60/minute allowance as the
// suite grew (docs/test-notes.md). Auto-assigning a fresh address per call
// means no two calls can ever collide on "unknown" by omission; a test that
// wants a *specific* or *shared* address still gets one by passing `ip`
// explicitly (see the blockip tests below, which do this on purpose).
// Private-range and sequential rather than random, so a failure is
// reproducible and never mistaken for the 203.0.113.0/24 and 198.51.100.0/24
// addresses other tests use deliberately.
let nextSyntheticIp = 0;
function syntheticIp(): string {
  nextSyntheticIp++;
  return `10.${(nextSyntheticIp >> 16) & 0xff}.${(nextSyntheticIp >> 8) & 0xff}.${nextSyntheticIp & 0xff}`;
}

export async function callManagement(
  method: unknown,
  params: unknown[] = [],
  opts: AuthOptions = {},
): Promise<ManagementReply> {
  const body = JSON.stringify({ method, params });
  const headers: Record<string, string> = { "Content-Type": MANAGEMENT_CONTENT_TYPE };
  if (opts.authHeader !== undefined) headers.Authorization = opts.authHeader;
  else if (!opts.omitAuthHeader) headers.Authorization = nip98Header(body, opts);
  headers["CF-Connecting-IP"] = opts.ip ?? syntheticIp();

  const response = await exports.default.fetch(
    new Request(opts.requestUrl ?? MANAGEMENT_URL, { method: "POST", headers, body }),
  );
  // arrayBuffer, not json/text: workerd warns loudly about reading a
  // body whose content-type it doesn't recognize as text, and
  // application/nostr+json+rpc is exactly that.
  const text = new TextDecoder().decode(await response.arrayBuffer());
  const parsed = JSON.parse(text) as { result?: unknown; error?: string };
  return { status: response.status, ...parsed };
}
