// Internal review: everything about one conversation.
//
// Returns the full audit trail a reviewer needs to reconstruct a call:
// turns, tool calls, retrieval, tickets, escalations.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { verifyInternalSecret, json } from '@/lib/security.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const url = new URL(req.url);
  const authError = verifyInternalSecret(req.headers, url);
  if (authError) return json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const db = supabaseAdmin();

  const [conv, turns, tools, retrieval, tickets, escalations] = await Promise.all([
    withTimeout('d: conversation', () =>
      db.from('conversations').select('*').eq('conversation_id', id).maybeSingle()
    ),
    withTimeout('d: turns', () =>
      db.from('conversation_turns').select('*').eq('conversation_id', id).order('turn_index', { ascending: true })
    ),
    withTimeout('d: tools', () =>
      db.from('tool_calls').select('*').eq('conversation_id', id).order('created_at', { ascending: true })
    ),
    withTimeout('d: retrieval', () =>
      db.from('retrieval_logs').select('*').eq('conversation_id', id).order('created_at', { ascending: true })
    ),
    withTimeout('d: tickets', () =>
      db.from('support_tickets').select('*').eq('conversation_id', id)
    ),
    withTimeout('d: escalations', () =>
      db.from('escalations').select('*').eq('conversation_id', id)
    )
  ]);

  if (!conv.ok) return json({ error: conv.error }, { status: 500 });
  const conversation = (conv.data as { data: unknown }).data;
  if (!conversation) return json({ error: 'Not found' }, { status: 404 });

  const rows = <T,>(r: { ok: boolean; data?: unknown }): T[] =>
    r.ok ? (((r.data as { data: T[] | null }).data ?? [])) : [];

  return json({
    conversation,
    turns: rows(turns),
    tool_calls: rows(tools),
    retrieval_logs: rows(retrieval),
    tickets: rows(tickets),
    escalations: rows(escalations)
  });
}
