// Shared admin-route helpers.

import { cookies } from 'next/headers';
import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { verifySession, COOKIE_NAME, type AdminSession } from './auth.server';
import { json } from './security.server';

/** Resolve the signed-in admin, or null. */
export async function currentAdmin(): Promise<AdminSession | null> {
  const jar = await cookies();
  return verifySession(jar.get(COOKIE_NAME)?.value);
}

/**
 * Guard for admin API routes.
 *
 * Returns either the session or a ready-made 401 Response, so a route
 * body reads `if ('error' in guard) return guard.error;` and cannot
 * accidentally continue unauthenticated.
 */
export async function requireAdmin(): Promise<{ admin: AdminSession } | { error: Response }> {
  const admin = await currentAdmin();
  if (!admin) return { error: json({ error: 'Not signed in.' }, { status: 401 }) };
  return { admin };
}

/**
 * Record a consequential admin action.
 *
 * Approving an outbound email is a real decision with a real effect on a
 * customer, so it leaves a trail. Advisory: never fail the action because
 * the audit write failed.
 */
export async function audit(
  actor: string,
  action: string,
  target: { type: string; id: string },
  detail?: Record<string, unknown>
): Promise<void> {
  try {
    const db = supabaseAdmin();
    await withTimeout('admin audit', () =>
      db.from('admin_audit').insert({
        actor,
        action,
        target_type: target.type,
        target_id: target.id,
        detail: detail ?? null
      })
    );
  } catch (e) {
    console.error(`[audit] ${action} on ${target.type}:${target.id} — ${e instanceof Error ? e.message : e}`);
  }
}
