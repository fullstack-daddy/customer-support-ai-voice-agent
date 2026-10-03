// One outbound record: compose, edit, approve-and-send, cancel.
//
// The approval gate lives here. Nothing in this system emails a customer
// without an admin pressing a button, and the send path is the only
// place `email_status` can become 'sent'.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { requireAdmin, audit } from '@/lib/admin.server';
import { composeTicketEmail, composeEscalationEmail, sendEmail, isPlausibleEmail } from '@/lib/email.server';
import { json } from '@/lib/security.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Approving a ticket sends mail through Resend; the default 10s
// function limit is not enough for a provider round trip.
export const maxDuration = 30;

type Kind = 'ticket' | 'escalation';
const TABLE: Record<Kind, string> = { ticket: 'support_tickets', escalation: 'escalations' };

function isKind(v: string): v is Kind {
  return v === 'ticket' || v === 'escalation';
}

async function loadRecord(kind: Kind, id: string) {
  const db = supabaseAdmin();
  const res = await withTimeout('admin: load record', () =>
    db.from(TABLE[kind]).select('*').eq('id', id).maybeSingle()
  );
  if (!res.ok) throw new Error(res.error);
  return (res.data as { data: Record<string, any> | null }).data;
}

/**
 * Build the draft from the record if one has not been composed yet.
 *
 * Composed lazily rather than at creation time so it always reflects the
 * CORRECTED contact details — the caller may have fixed a misheard email
 * after the ticket row was written.
 */
function draftFor(kind: Kind, rec: Record<string, any>) {
  if (kind === 'ticket') {
    return composeTicketEmail({
      ticketId: rec.ticket_id,
      contactName: rec.contact_name,
      contactEmail: rec.email_to ?? '',
      category: rec.category,
      summary: rec.summary
    });
  }
  return composeEscalationEmail({
    escalationId: rec.escalation_id,
    contactName: rec.user_name,
    contactEmail: rec.email_to ?? rec.user_email ?? '',
    category: rec.category,
    reason: rec.reason,
    preferredTime: rec.preferred_time
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
): Promise<Response> {
  const guard = await requireAdmin();
  if ('error' in guard) return guard.error;

  const { kind, id } = await params;
  if (!isKind(kind)) return json({ error: 'Unknown record type.' }, { status: 400 });

  const rec = await loadRecord(kind, id);
  if (!rec) return json({ error: 'Not found.' }, { status: 404 });

  // Hand back a draft even if none is stored, so the editor always opens
  // with something to review rather than an empty box.
  const stored = rec.email_subject && rec.email_body;
  const draft = stored
    ? { to: rec.email_to ?? '', subject: rec.email_subject, body: rec.email_body }
    : draftFor(kind, rec);

  return json({ record: rec, draft, composed: Boolean(stored) });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ kind: string; id: string }> }
): Promise<Response> {
  const guard = await requireAdmin();
  if ('error' in guard) return guard.error;
  const admin = guard.admin;

  const { kind, id } = await params;
  if (!isKind(kind)) return json({ error: 'Unknown record type.' }, { status: 400 });

  let body: { action?: string; to?: string; subject?: string; body?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: 'Malformed request.' }, { status: 400 });
  }

  const db = supabaseAdmin();
  const rec = await loadRecord(kind, id);
  if (!rec) return json({ error: 'Not found.' }, { status: 404 });

  const action = body.action ?? 'save';

  // ---- Save a draft edit --------------------------------------------
  if (action === 'save') {
    const to = String(body.to ?? '').trim();
    if (to && !isPlausibleEmail(to)) {
      return json({ error: "That doesn't look like a valid email address." }, { status: 400 });
    }
    const res = await withTimeout('admin: save draft', () =>
      db
        .from(TABLE[kind])
        .update({
          email_to: to || null,
          email_subject: String(body.subject ?? '').trim() || null,
          email_body: String(body.body ?? '').trim() || null,
          email_status: 'draft',
          email_error: null
        })
        .eq('id', id)
    );
    if (!res.ok) return json({ error: res.error }, { status: 500 });
    await audit(admin.email, 'email.draft.save', { type: kind, id });
    return json({ ok: true, email_status: 'draft' });
  }

  // ---- Cancel --------------------------------------------------------
  if (action === 'cancel') {
    const res = await withTimeout('admin: cancel email', () =>
      db.from(TABLE[kind]).update({ email_status: 'cancelled' }).eq('id', id)
    );
    if (!res.ok) return json({ error: res.error }, { status: 500 });
    await audit(admin.email, 'email.cancel', { type: kind, id });
    return json({ ok: true, email_status: 'cancelled' });
  }

  // ---- Approve and send ---------------------------------------------
  if (action === 'approve_send') {
    // Already sent? Refuse rather than double-send. An admin
    // double-clicking must not email a customer twice.
    if (rec.email_status === 'sent') {
      return json({ error: 'This has already been sent.', email_status: 'sent' }, { status: 409 });
    }

    const to = String(body.to ?? rec.email_to ?? '').trim();
    const subject = String(body.subject ?? rec.email_subject ?? '').trim();
    const text = String(body.body ?? rec.email_body ?? '').trim();

    if (!isPlausibleEmail(to)) {
      return json({ error: 'A valid recipient address is required before sending.' }, { status: 400 });
    }
    if (!subject || !text) {
      return json({ error: 'Subject and body cannot be empty.' }, { status: 400 });
    }

    const now = new Date().toISOString();

    // Mark 'sending' first. If the process dies mid-send, the record
    // shows it was in flight rather than looking like it was never tried.
    await withTimeout('admin: mark sending', () =>
      db
        .from(TABLE[kind])
        .update({
          email_to: to, email_subject: subject, email_body: text,
          email_status: 'sending', email_error: null,
          email_approved_by: admin.email, email_approved_at: now
        })
        .eq('id', id)
    );

    const result = await sendEmail({ to, subject, body: text });

    if (!result.ok) {
      await withTimeout('admin: mark failed', () =>
        db.from(TABLE[kind]).update({ email_status: 'failed', email_error: result.error ?? 'Unknown error' }).eq('id', id)
      );
      await audit(admin.email, 'email.send.failed', { type: kind, id }, { to, error: result.error });
      return json({ error: result.error, email_status: 'failed' }, { status: 502 });
    }

    await withTimeout('admin: mark sent', () =>
      db
        .from(TABLE[kind])
        .update({ email_status: 'sent', email_sent_at: new Date().toISOString(), email_provider_id: result.providerId ?? null, email_error: null })
        .eq('id', id)
    );
    await audit(admin.email, 'email.send', { type: kind, id }, { to, provider_id: result.providerId });

    return json({ ok: true, email_status: 'sent', provider_id: result.providerId });
  }

  return json({ error: `Unknown action: ${action}` }, { status: 400 });
}
