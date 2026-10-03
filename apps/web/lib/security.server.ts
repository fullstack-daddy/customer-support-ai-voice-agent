// Server-only security helpers.
//
// The `.server.ts` suffix is load-bearing: scripts/check-secrets.mjs
// treats it as one of the few places under apps/web allowed to touch
// privileged env vars.

import { timingSafeEqual, createHmac } from 'node:crypto';
import { allowedOrigins } from '@relaypay/shared';

// ---------------------------------------------------------------
// Shared-secret verification for Vapi webhooks
// ---------------------------------------------------------------

/** Constant-time compare that tolerates different lengths without leaking. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Still burn a comparison so timing does not reveal the length mismatch.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Verify an inbound Vapi request.
 *
 * This endpoint triggers Claude API spend, so it must not be callable by
 * anyone who discovers the URL. Vapi sends the configured secret on a
 * header; we accept the two header names Vapi has used, plus an HMAC
 * signature form if one is configured.
 *
 * Returns null when valid, or a reason string when it should be rejected.
 */
export function verifyVapiRequest(headers: Headers, rawBody?: string): string | null {
  const expected = process.env.VAPI_SERVER_SECRET;
  if (!expected) {
    // Fail CLOSED. An unset secret must not mean "allow everyone".
    return 'server misconfigured: VAPI_SERVER_SECRET is not set';
  }

  const provided =
    headers.get('x-vapi-secret') ??
    headers.get('x-vapi-signature') ??
    headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    null;

  if (!provided) {
    // Name the headers that arrived, never their values. Without this a
    // rejection says only "missing secret header", which cannot
    // distinguish "Vapi was never given a secret" from "Vapi sent it
    // under a name we do not read".
    const candidates = [...headers.keys()].filter((k) => k.startsWith('x-vapi') || k === 'authorization');
    return `missing secret header (auth headers seen: ${candidates.length ? candidates.join(', ') : 'none'})`;
  }

  if (safeEqual(provided, expected)) return null;

  // Also accept an HMAC-SHA256 of the raw body, for the signature style.
  if (rawBody) {
    const computed = createHmac('sha256', expected).update(rawBody).digest('hex');
    if (safeEqual(provided, computed)) return null;
  }

  // Say which header carried it, so a mismatch points at the field to
  // fix: the model's API key, or the Server URL secret.
  const via = headers.get('x-vapi-secret')
    ? 'x-vapi-secret'
    : headers.get('x-vapi-signature')
      ? 'x-vapi-signature'
      : 'authorization';
  return `secret mismatch (sent via ${via})`;
}

/** Gate for the internal review dashboard and its API routes. */
export function verifyInternalSecret(headers: Headers, url: URL): string | null {
  const expected = process.env.INTERNAL_REVIEW_SECRET;
  if (!expected) return 'server misconfigured: INTERNAL_REVIEW_SECRET is not set';

  const provided =
    headers.get('x-internal-secret') ??
    url.searchParams.get('key') ??
    // Basic auth, so a browser can be pointed at it directly.
    (() => {
      const auth = headers.get('authorization');
      if (!auth?.startsWith('Basic ')) return null;
      try {
        const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
        return decoded.split(':')[1] ?? null;
      } catch { return null; }
    })();

  if (!provided) return 'missing internal secret';
  return safeEqual(provided, expected) ? null : 'secret mismatch';
}

// ---------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------

/**
 * Fixed-window in-memory limiter.
 *
 * Scoped to one process, which is the honest limitation: behind multiple
 * instances each gets its own window. For cost-abuse protection on a
 * demo deployment that is adequate; a production multi-instance
 * deployment should move this to Redis or Supabase. Documented in the
 * README rather than pretended away.
 */
interface Bucket { count: number; resetAt: number; }
const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  bucket.count += 1;
  if (bucket.count > limit) {
    return { ok: false, remaining: 0, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }
  return { ok: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
}

/** Periodically drop expired buckets so the map cannot grow unbounded. */
if (typeof setInterval !== 'undefined') {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }, 60_000);
  // Do not hold the process open in a serverless context.
  if (typeof timer === 'object' && 'unref' in timer) (timer as { unref: () => void }).unref();
}

/** Best-effort client identity for rate-limit bucketing. */
export function clientKey(headers: Headers, fallback = 'unknown'): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    headers.get('x-real-ip') ??
    fallback
  );
}

// ---------------------------------------------------------------
// CORS
// ---------------------------------------------------------------

/**
 * Restricted CORS. Never '*'.
 *
 * Vapi's servers call the webhook endpoints server-to-server, which is
 * not subject to CORS — so the allow-list only needs to cover our own
 * frontend origins.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = allowedOrigins();
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-internal-secret',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
}

export function json(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) }
  });
}
