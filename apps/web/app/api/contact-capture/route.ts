// Live contact confirmation.
//
// GET  /api/contact-capture?conversation_id=…  → any pending capture
// PATCH /api/contact-capture                   → confirm or correct it
//
// This is the endpoint behind the editable name/email field that appears
// mid-call. It is deliberately NOT admin-gated: the person using it is
// the caller, confirming their own details during their own call.
//
// What stops it being an open read of anyone's data: you must already
// know the conversation id, which is a server-generated identifier tied
// to a live Vapi call, and the only fields it returns are the ones the
// caller just said out loud. There is no enumeration value here.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { json, rateLimit, clientKey } from '@/lib/security.server';
import { isPlausibleEmail } from '@/lib/email.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversation_id');
  if (!conversationId) return json({ error: 'conversation_id is required.' }, { status: 400 });

  const db = supabaseAdmin();
  const res = await withTimeout('contact capture: read', () =>
    db
      .from('contact_captures')
      .select('id, heard_name, heard_email, confirmed_name, confirmed_email, status, purpose, created_at')
      .eq('conversation_id', conversationId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(1)
  );
  if (!res.ok) return json({ error: res.error }, { status: 500 });

  const rows = ((res.data as { data: unknown[] | null }).data ?? []);
  return json({ pending: rows[0] ?? null });
}

export async function PATCH(req: Request): Promise<Response> {
  // Light throttle — this is unauthenticated by design, so it should not
  // be a free write loop.
  const limit = rateLimit(`capture:${clientKey(req.headers)}`, 60, 60_000);
  if (!limit.ok) return json({ error: 'Too many updates.' }, { status: 429 });

  let body: { id?: string; name?: string; email?: string; action?: 'confirm' | 'skip' };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Malformed request.' }, { status: 400 });
  }

  if (!body?.id) return json({ error: 'id is required.' }, { status: 400 });
  const db = supabaseAdmin();

  if (body.action === 'skip') {
    const res = await withTimeout('contact capture: skip', () =>
      db.from('contact_captures').update({ status: 'skipped', confirmed_at: new Date().toISOString() }).eq('id', body.id!)
    );
    if (!res.ok) return json({ error: res.error }, { status: 500 });
    return json({ ok: true, status: 'skipped' });
  }

  const name = String(body.name ?? '').trim();
  const email = String(body.email ?? '').trim();

  if (email && !isPlausibleEmail(email)) {
    return json({ error: "That doesn't look like a valid email address." }, { status: 400 });
  }

  const now = new Date().toISOString();
  const update = await withTimeout('contact capture: confirm', () =>
    db
      .from('contact_captures')
      .update({
        confirmed_name: name || null,
        confirmed_email: email || null,
        status: 'confirmed',
        confirmed_at: now
      })
      .eq('id', body.id!)
      .select('conversation_id, purpose')
      .single()
  );
  if (!update.ok) return json({ error: update.error }, { status: 500 });

  const row = (update.data as { data: { conversation_id: string; purpose: string | null } | null }).data;

  // Propagate the CORRECTED address onto whatever the agent created, so
  // the confirmation email goes where the caller actually said — not
  // where speech recognition guessed.
  if (row?.conversation_id && email) {
    const table = row.purpose === 'escalation' ? 'escalations' : 'support_tickets';
    const patch: Record<string, unknown> = { email_to: email };
    if (table === 'support_tickets' && name) patch.contact_name = name;
    if (table === 'escalations') {
      if (name) patch.user_name = name;
      patch.user_email = email;
    }
    await withTimeout('contact capture: propagate', () =>
      db.from(table).update(patch).eq('conversation_id', row.conversation_id).eq('email_status', 'draft')
    );
  }

  return json({ ok: true, status: 'confirmed' });
}
