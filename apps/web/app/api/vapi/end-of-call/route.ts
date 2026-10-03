// Vapi end-of-call-report webhook.
//
// Finalises the conversations row: ended_at, final_status, summary.
//
// Deliberately tolerant about payload shape — Vapi's report envelope has
// moved between versions, so we probe several paths for the same values
// rather than hard-binding to one and silently recording nothing when it
// changes.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import { verifyVapiRequest, json } from '@/lib/security.server';
import { disposeSession } from '@relaypay/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface VapiEndOfCall {
  message?: {
    type?: string;
    endedReason?: string;
    summary?: string;
    transcript?: string;
    call?: { id?: string };
    artifact?: { transcript?: string; summary?: string };
    analysis?: { summary?: string };
  };
  call?: { id?: string };
}

function pick<T>(...values: (T | undefined | null)[]): T | null {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return null;
}

/**
 * Map Vapi's endedReason onto our final_status vocabulary.
 *
 * `escalated` is NOT derived from here — it is set by create_escalation
 * when the escalation actually happens, and we must not overwrite it with
 * a generic 'resolved' just because the call hung up normally.
 */
function deriveFinalStatus(endedReason: string | null, hadTurns: boolean): 'resolved' | 'abandoned' | 'declined' {
  if (!hadTurns) return 'abandoned';
  if (!endedReason) return 'resolved';
  const r = endedReason.toLowerCase();
  if (r.includes('silence') || r.includes('no-answer') || r.includes('timeout') || r.includes('customer-did-not')) {
    return 'abandoned';
  }
  return 'resolved';
}

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  const authError = verifyVapiRequest(req.headers, rawBody);
  if (authError) {
    console.warn(`[end-of-call] rejected: ${authError}`);
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: VapiEndOfCall;
  try {
    body = JSON.parse(rawBody) as VapiEndOfCall;
  } catch {
    return json({ error: 'Malformed JSON' }, { status: 400 });
  }

  const msg = body.message ?? {};
  // Only act on the end-of-call report; Vapi posts other message types here too.
  if (msg.type && msg.type !== 'end-of-call-report') {
    return json({ ok: true, ignored: msg.type });
  }

  const callId = pick(msg.call?.id, body.call?.id);
  if (!callId) {
    console.warn('[end-of-call] report carried no call id; cannot finalise');
    return json({ ok: false, reason: 'no call id' });
  }
  const conversationId = `vapi-${callId}`;

  // The call is over, so the agent subprocess for it is dead weight.
  // Sessions also expire on idle, but that would keep a subprocess
  // alive for minutes after every call for no reason.
  void disposeSession(conversationId, 'call ended');

  const summary = pick(msg.analysis?.summary, msg.artifact?.summary, msg.summary);
  const endedReason = pick(msg.endedReason);

  const db = supabaseAdmin();

  // Did this call get anywhere? Used to distinguish abandoned from resolved.
  const turnsRes = await withTimeout('end-of-call: turn count', () =>
    db.from('conversation_turns').select('id').eq('conversation_id', conversationId).limit(1)
  );
  const hadTurns = turnsRes.ok && (((turnsRes.data as { data: unknown[] | null }).data ?? []).length > 0);

  // Read current status first — never clobber 'escalated'.
  const existing = await withTimeout('end-of-call: read conversation', () =>
    db.from('conversations').select('final_status').eq('conversation_id', conversationId).maybeSingle()
  );
  const current = existing.ok
    ? (existing.data as { data: { final_status: string | null } | null }).data?.final_status ?? null
    : null;

  const finalStatus = current === 'escalated' ? 'escalated' : deriveFinalStatus(endedReason, hadTurns);

  const update = await withTimeout('end-of-call: finalise', () =>
    db
      .from('conversations')
      .update({
        ended_at: new Date().toISOString(),
        final_status: finalStatus,
        ...(summary ? { summary } : {})
      })
      .eq('conversation_id', conversationId)
  );

  if (!update.ok) {
    console.error(`[end-of-call] failed to finalise ${conversationId}: ${update.error}`);
    // 200 anyway: a non-2xx makes Vapi retry, and a retry will not fix a
    // database problem. We have logged it; that is the actionable part.
    return json({ ok: false, reason: 'db write failed' });
  }

  return json({ ok: true, conversation_id: conversationId, final_status: finalStatus });
}
