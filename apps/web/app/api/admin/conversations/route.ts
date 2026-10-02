// Internal review: list conversations.
//
// The browser never talks to Supabase. It calls this route, which reads
// server-side with the service role and returns only the fields the
// dashboard needs. That is the hard rule from the brief: no direct
// client-to-Supabase access with a privileged key.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { json } from '@/lib/security.server';
import { requireAdmin } from '@/lib/admin.server';
import { sweepStaleConversations } from '@/lib/sweep.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  const guard = await requireAdmin();
  if ('error' in guard) return guard.error;
  const url = new URL(req.url);

  // Opportunistic cleanup of calls whose end-of-call report never arrived.
  await sweepStaleConversations().catch(() => {});

  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
  const db = supabaseAdmin();

  const res = await withTimeout('internal: list conversations', () =>
    db
      .from('conversations')
      .select('conversation_id, channel, started_at, ended_at, final_status, summary, customer_id, metadata')
      .order('started_at', { ascending: false })
      .limit(limit)
  );
  if (!res.ok) return json({ error: res.error }, { status: 500 });

  const conversations = ((res.data as { data: unknown[] | null }).data ?? []);

  // Counts per conversation, so the list can show activity without the
  // dashboard issuing N queries.
  const ids = (conversations as { conversation_id: string }[]).map((c) => c.conversation_id);
  const counts: Record<string, { turns: number; tools: number; tickets: number; escalations: number }> = {};
  for (const id of ids) counts[id] = { turns: 0, tools: 0, tickets: 0, escalations: 0 };

  if (ids.length) {
    const [turns, tools, tickets, escalations] = await Promise.all([
      withTimeout('c: turns', () => db.from('conversation_turns').select('conversation_id').in('conversation_id', ids)),
      withTimeout('c: tools', () => db.from('tool_calls').select('conversation_id').in('conversation_id', ids)),
      withTimeout('c: tickets', () => db.from('support_tickets').select('conversation_id').in('conversation_id', ids)),
      withTimeout('c: escalations', () => db.from('escalations').select('conversation_id').in('conversation_id', ids))
    ]);
    const tally = (r: typeof turns, key: keyof (typeof counts)[string]) => {
      if (!r.ok) return;
      for (const row of ((r.data as { data: { conversation_id: string }[] | null }).data ?? [])) {
        const bucket = counts[row.conversation_id];
        if (bucket) bucket[key] += 1;
      }
    };
    tally(turns, 'turns');
    tally(tools, 'tools');
    tally(tickets, 'tickets');
    tally(escalations, 'escalations');
  }

  return json({ conversations, counts });
}
