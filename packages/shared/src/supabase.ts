// Server-only Supabase client factory.
//
// The service-role key bypasses RLS by design. That is acceptable ONLY
// because this client is constructed exclusively in server processes (the
// MCP server, the agent package, Next.js route handlers) and never ships
// to the browser. The guard below makes the violation loud rather than
// silent if someone imports this from a client component.

import { createRequire } from 'node:module';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { serverEnv } from './env.js';
import { SUPABASE_TIMEOUT_MS, SUPABASE_RETRIES } from './constants.js';

let cached: SupabaseClient | null = null;

/**
 * Supply a WebSocket implementation to supabase-js on Node < 22.
 *
 * createClient() builds a RealtimeClient eagerly, and that constructor
 * throws "Node.js 20 detected without native WebSocket support" when
 * there is no global WebSocket. We never open a realtime subscription,
 * but the throw happens at construction, so EVERY database call fails —
 * which surfaces on a live call as the agent being unable to look
 * anything up, with the real cause buried in a subprocess exit code.
 *
 * Node 22+ has a native WebSocket, so this returns undefined there and
 * supabase-js uses the built-in one.
 */
function realtimeTransport(): unknown {
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined') return undefined;
  try {
    return createRequire(import.meta.url)('ws');
  } catch {
    // Let supabase-js raise its own, more specific error.
    return undefined;
  }
}

export function supabaseAdmin(): SupabaseClient {
  if (typeof window !== 'undefined') {
    throw new Error('supabaseAdmin() was called in the browser. The service-role key must stay server-side.');
  }
  if (cached) return cached;
  const env = serverEnv();
  const transport = realtimeTransport();
  cached = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'relaypay-support-agent' } },
    ...(transport ? { realtime: { transport: transport as never } } : {})
  });
  return cached;
}

/**
 * Run a Supabase query with a hard timeout and one retry on transient
 * network failures, then fail soft. Every tool in the MCP server routes
 * its database access through this so a hung connection can never freeze
 * a live phone call.
 *
 * Returns a discriminated result rather than throwing, so callers are
 * forced to handle the failure path explicitly.
 */
export async function withTimeout<T>(
  label: string,
  fn: () => PromiseLike<T>,
  { timeoutMs = SUPABASE_TIMEOUT_MS, retries = SUPABASE_RETRIES } = {}
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let lastError = 'unknown error';

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await Promise.race([
        Promise.resolve(fn()),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        )
      ]);
      return { ok: true, data };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      const transient = /timed out|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(lastError);
      if (!transient || attempt === retries) break;
    }
  }
  return { ok: false, error: lastError };
}
