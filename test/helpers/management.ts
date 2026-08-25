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

export async function callManagement(
  method: unknown,
  params: unknown[] = [],
  opts: AuthOptions = {},
): Promise<ManagementReply> {
  const body = JSON.stringify({ method, params });
  const headers: Record<string, string> = { "Content-Type": MANAGEMENT_CONTENT_TYPE };
  if (opts.authHeader !== undefined) headers.Authorization = opts.authHeader;
  else if (!opts.omitAuthHeader) headers.Authorization = nip98Header(body, opts);
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;

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
