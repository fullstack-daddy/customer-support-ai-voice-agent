// Ticket + escalation history for the admin console.
//
// Both tables are returned in one shape so the UI can show a single
// unified queue — an admin reviewing outbound mail does not care whether
// the record started life as a ticket or an escalation, only that
// something is waiting on them.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { requireAdmin } from '@/lib/admin.server';
import { emailConfigured } from '@/lib/email.server';
import { json } from '@/lib/security.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export interface OutboundRecord {
  kind: 'ticket' | 'escalation';
  id: string;
  ref: string;
  conversation_id: string;
  category: string;
  priority?: string | null;
  summary: string;
  contact_name: string | null;
  email_to: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_status: string;
  email_error: string | null;
  email_sent_at: string | null;
  email_approved_by: string | null;
  status: string;
  created_at: string;
}

export async function GET(req: Request): Promise<Response> {
  const guard = await requireAdmin();
  if ('error' in guard) return guard.error;

  const url = new URL(req.url);
  const filter = url.searchParams.get('email_status');
  const db = supabaseAdmin();

  const [tickets, escalations] = await Promise.all([
    withTimeout('admin: tickets', () =>
      db.from('support_tickets').select('*').order('created_at', { ascending: false }).limit(200)
    ),
    withTimeout('admin: escalations', () =>
      db.from('escalations').select('*').order('created_at', { ascending: false }).limit(200)
    )
  ]);

  const rows = <T,>(r: { ok: boolean; data?: unknown }): T[] =>
    r.ok ? (((r.data as { data: T[] | null }).data ?? [])) : [];

  const out: OutboundRecord[] = [
    ...rows<Record<string, any>>(tickets).map((t) => ({
      kind: 'ticket' as const,
      id: t.id,
      ref: t.ticket_id,
      conversation_id: t.conversation_id,
      category: t.category,
      priority: t.priority,
      summary: t.summary,
      contact_name: t.contact_name ?? null,
      email_to: t.email_to ?? null,
      email_subject: t.email_subject ?? null,
      email_body: t.email_body ?? null,
      email_status: t.email_status ?? 'draft',
      email_error: t.email_error ?? null,
      email_sent_at: t.email_sent_at ?? null,
      email_approved_by: t.email_approved_by ?? null,
      status: t.status,
      created_at: t.created_at
    })),
    ...rows<Record<string, any>>(escalations).map((e) => ({
      kind: 'escalation' as const,
      id: e.id,
      ref: e.escalation_id,
      conversation_id: e.conversation_id,
      category: e.category,
      priority: null,
      summary: e.reason,
      contact_name: e.user_name ?? null,
      email_to: e.email_to ?? e.user_email ?? null,
      email_subject: e.email_subject ?? null,
      email_body: e.email_body ?? null,
      email_status: e.email_status ?? 'draft',
      email_error: e.email_error ?? null,
      email_sent_at: e.email_sent_at ?? null,
      email_approved_by: e.email_approved_by ?? null,
      status: e.status,
      created_at: e.created_at
    }))
  ].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const filtered = filter ? out.filter((r) => r.email_status === filter) : out;

  return json({
    records: filtered,
    counts: {
      total: out.length,
      draft: out.filter((r) => r.email_status === 'draft').length,
      approved: out.filter((r) => r.email_status === 'approved').length,
      sent: out.filter((r) => r.email_status === 'sent').length,
      failed: out.filter((r) => r.email_status === 'failed').length
    },
    email: emailConfigured()
  });
}
