// Conversation state, rehydrated from Supabase each turn.
//
// Why read this from the database instead of keeping it in memory:
//
//  1. The custom-LLM endpoint is stateless per request. Vapi sends a
//     message history, not our internal flags.
//  2. A model asked to "remember you already escalated" will sometimes
//     not. escalation-rules.md says the agent must stop troubleshooting
//     after escalation, so that has to be enforced from state we control.
//  3. If the process restarts mid-call, the next turn still knows what
//     happened in the previous ones.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';

export interface ConversationState {
  conversationId: string;
  escalated: boolean;
  ticketIds: string[];
  knownCustomerId: string | null;
  turnCount: number;
}

export async function loadConversationState(conversationId: string): Promise<ConversationState> {
  const empty: ConversationState = {
    conversationId,
    escalated: false,
    ticketIds: [],
    knownCustomerId: null,
    turnCount: 0
  };

  const db = supabaseAdmin();

  const [escRes, ticketRes, convRes, turnRes] = await Promise.all([
    withTimeout('state: escalations', () =>
      db.from('escalations').select('escalation_id').eq('conversation_id', conversationId).limit(1)
    ),
    withTimeout('state: tickets', () =>
      db.from('support_tickets').select('ticket_id').eq('conversation_id', conversationId)
    ),
    withTimeout('state: conversation', () =>
      db.from('conversations').select('customer_id, final_status').eq('conversation_id', conversationId).maybeSingle()
    ),
    withTimeout('state: turn count', () =>
      db.from('conversation_turns').select('turn_index').eq('conversation_id', conversationId).order('turn_index', { ascending: false }).limit(1)
    )
  ]);

  // Every read fails soft. A state read that errors must not take down the
  // call — we proceed with the conservative default (not escalated), and
  // the tools' own dedupe protection still prevents duplicate records.
  if (escRes.ok) {
    const rows = (escRes.data as { data: unknown[] | null }).data ?? [];
    empty.escalated = rows.length > 0;
  }
  if (ticketRes.ok) {
    const rows = ((ticketRes.data as { data: { ticket_id: string }[] | null }).data ?? []);
    empty.ticketIds = rows.map((r) => r.ticket_id);
  }
  if (convRes.ok) {
    const row = (convRes.data as { data: { customer_id: string | null; final_status: string | null } | null }).data;
    empty.knownCustomerId = row?.customer_id ?? null;
    if (row?.final_status === 'escalated') empty.escalated = true;
  }
  if (turnRes.ok) {
    const rows = ((turnRes.data as { data: { turn_index: number }[] | null }).data ?? []);
    empty.turnCount = rows.length ? (rows[0]!.turn_index + 1) : 0;
  }

  return empty;
}

/** Record the customer id once a lookup identifies the caller. */
export async function rememberCustomer(conversationId: string, customerId: string): Promise<void> {
  const db = supabaseAdmin();
  await withTimeout('remember customer', () =>
    db.from('conversations').update({ customer_id: customerId }).eq('conversation_id', conversationId)
  );
}
