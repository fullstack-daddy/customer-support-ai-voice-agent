// Write tools: create_support_ticket, create_escalation, log_conversation_event.
//
// Two things worth calling out:
//
//  1. DEDUPLICATION is enforced twice — once here by looking for an
//     existing open record, and once in the database by a partial unique
//     index. Belt and braces: a race between two concurrent tool calls
//     would slip past the lookup, but the index catches it, and we then
//     read the winner back instead of surfacing a constraint error.
//
//  2. `follow_up_summary` is composed HERE, not by the model. escalation
//     -rules.md forbids promising timelines or outcomes; if the model
//     wrote this string it could invent "within 24 hours". Writing it in
//     the tool means the business controls the commitment.

import { randomUUID } from 'node:crypto';
import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import {
  CreateSupportTicketInput, CreateEscalationInput, LogConversationEventInput,
  type CreateSupportTicketOutput, type CreateEscalationOutput, type LogConversationEventOutput
} from '@relaypay/shared';
import { instrumented, formatZodError, type ToolContext } from '../instrument.js';

/** Short, readable, collision-resistant reference. */
function shortRef(prefix: string): string {
  return `${prefix}-${randomUUID().split('-')[0]!.toUpperCase()}`;
}

/**
 * Ensure a conversations row exists before anything foreign-keys to it.
 *
 * Tool-call ordering is not guaranteed — an escalation can arrive before
 * we have written the conversation row. Creating it lazily means a
 * logging or ticket call is never lost to a sequencing accident.
 */
export async function ensureConversation(conversationId: string, channel = 'text_eval'): Promise<void> {
  const db = supabaseAdmin();
  const res = await withTimeout('ensureConversation', () =>
    db.from('conversations').upsert(
      { conversation_id: conversationId, channel },
      { onConflict: 'conversation_id', ignoreDuplicates: true }
    )
  );
  if (!res.ok) throw new Error(`could not ensure conversation ${conversationId}: ${res.error}`);
}

// ---------------------------------------------------------------
// create_support_ticket
// ---------------------------------------------------------------
export async function createSupportTicket(ctx: ToolContext, raw: unknown): Promise<CreateSupportTicketOutput> {
  return instrumented<CreateSupportTicketOutput>(
    ctx,
    'create_support_ticket',
    'Log a support issue for human follow-up',
    (raw ?? {}) as Record<string, unknown>,
    async () => {
      const parsed = CreateSupportTicketInput.safeParse(raw);
      if (!parsed.success) {
        return {
          payload: { ticket_id: '', status: 'error' },
          status: 'error' as const,
          resultSummary: `invalid input: ${formatZodError(parsed.error.issues)}`
        };
      }
      const input = parsed.data;
      const db = supabaseAdmin();
      await ensureConversation(input.conversation_id);

      // Dedupe: an open ticket in the same conversation + category is the
      // same ticket. Return it rather than stacking duplicates.
      const existing = await withTimeout('ticket dedupe check', () =>
        db
          .from('support_tickets')
          .select('ticket_id, status')
          .eq('conversation_id', input.conversation_id)
          .eq('category', input.category)
          .eq('status', 'open')
          .maybeSingle()
      );
      if (existing.ok && existing.data.data) {
        const t = existing.data.data as { ticket_id: string; status: string };
        return {
          payload: { ticket_id: t.ticket_id, status: t.status, deduplicated: true },
          status: 'success' as const,
          resultSummary: `returned existing open ticket ${t.ticket_id}`
        };
      }

      const ticketId = shortRef('TICKET');
      const insert = await withTimeout('ticket insert', () =>
        db
          .from('support_tickets')
          .insert({
            ticket_id: ticketId,
            conversation_id: input.conversation_id,
            customer_id: input.customer_id ?? null,
            category: input.category,
            priority: input.priority,
            summary: input.summary,
            status: 'open'
          })
          .select('ticket_id, status')
          .single()
      );

      if (!insert.ok) throw new Error(insert.error);
      const err = (insert.data as { error?: { code?: string; message?: string } }).error;
      if (err) {
        // 23505 = unique violation: the partial index caught a race. Read
        // the winner back so the caller still gets a usable ticket id.
        if (err.code === '23505') {
          const raceWinner = await withTimeout('ticket race re-read', () =>
            db
              .from('support_tickets')
              .select('ticket_id, status')
              .eq('conversation_id', input.conversation_id)
              .eq('category', input.category)
              .eq('status', 'open')
              .maybeSingle()
          );
          if (raceWinner.ok && raceWinner.data.data) {
            const t = raceWinner.data.data as { ticket_id: string; status: string };
            return {
              payload: { ticket_id: t.ticket_id, status: t.status, deduplicated: true },
              status: 'success' as const,
              resultSummary: `race resolved to existing ticket ${t.ticket_id}`
            };
          }
        }
        throw new Error(err.message ?? 'ticket insert failed');
      }

      return {
        payload: { ticket_id: ticketId, status: 'open' },
        status: 'success' as const,
        resultSummary: `created ${ticketId} (${input.category}/${input.priority})`
      };
    },
    () => ({ ticket_id: '', status: 'error' })
  );
}

// ---------------------------------------------------------------
// create_escalation
// ---------------------------------------------------------------

/**
 * The exact sentence the agent is allowed to say about follow-up.
 *
 * Written here so it cannot drift. Note what it does NOT contain: no
 * hour count, no dispute outcome, no resolution promise. escalation
 * -rules.md forbids providing timelines for disputes or reviews and
 * forbids promising specific outcomes.
 */
function buildFollowUpSummary(hasPreferredTime: boolean): string {
  return hasPreferredTime
    ? 'A RelayPay specialist will follow up at the email address you provided, and will take your preferred time into account when arranging the call.'
    : 'A RelayPay specialist will follow up at the email address you provided.';
}

export async function createEscalation(ctx: ToolContext, raw: unknown): Promise<CreateEscalationOutput> {
  return instrumented<CreateEscalationOutput>(
    ctx,
    'create_escalation',
    'Hand the conversation to human support',
    (raw ?? {}) as Record<string, unknown>,
    async () => {
      const parsed = CreateEscalationInput.safeParse(raw);
      if (!parsed.success) {
        return {
          payload: {
            escalation_id: '',
            status: 'error',
            follow_up_summary: 'I could not complete that escalation. Let me take your details again.'
          },
          status: 'error' as const,
          resultSummary: `invalid input: ${formatZodError(parsed.error.issues)}`
        };
      }
      const input = parsed.data;
      const db = supabaseAdmin();
      await ensureConversation(input.conversation_id);

      const followUp = buildFollowUpSummary(Boolean(input.preferred_time));

      // Dedupe on (conversation, category) — repeated asks within one call
      // are the same escalation.
      const existing = await withTimeout('escalation dedupe check', () =>
        db
          .from('escalations')
          .select('escalation_id, status, follow_up_summary')
          .eq('conversation_id', input.conversation_id)
          .eq('category', input.category)
          .maybeSingle()
      );
      if (existing.ok && existing.data.data) {
        const e = existing.data.data as { escalation_id: string; status: string; follow_up_summary: string | null };
        return {
          payload: {
            escalation_id: e.escalation_id,
            status: e.status,
            follow_up_summary: e.follow_up_summary ?? followUp,
            deduplicated: true
          },
          status: 'success' as const,
          resultSummary: `returned existing escalation ${e.escalation_id}`
        };
      }

      const escalationId = shortRef('ESC');
      const insert = await withTimeout('escalation insert', () =>
        db
          .from('escalations')
          .insert({
            escalation_id: escalationId,
            conversation_id: input.conversation_id,
            customer_id: input.customer_id ?? null,
            user_name: input.user_name,
            user_email: input.user_email,
            category: input.category,
            reason: input.reason,
            preferred_time: input.preferred_time ?? null,
            call_booked: Boolean(input.preferred_time),
            follow_up_summary: followUp,
            status: 'open'
          })
          .select('escalation_id')
          .single()
      );

      if (!insert.ok) throw new Error(insert.error);
      const err = (insert.data as { error?: { code?: string; message?: string } }).error;
      if (err && err.code !== '23505') throw new Error(err.message ?? 'escalation insert failed');

      // Mark the conversation escalated so the agent's stop-condition can
      // be rehydrated on the next turn from state, not from model memory.
      await withTimeout('mark conversation escalated', () =>
        db.from('conversations').update({ final_status: 'escalated' }).eq('conversation_id', input.conversation_id)
      );

      return {
        payload: { escalation_id: escalationId, status: 'open', follow_up_summary: followUp },
        status: 'success' as const,
        resultSummary: `created ${escalationId} (${input.category}, call_booked=${Boolean(input.preferred_time)})`
      };
    },
    () => ({
      escalation_id: '',
      status: 'error',
      follow_up_summary: 'I could not complete that escalation just now. A specialist will still need to look at this.'
    })
  );
}

// ---------------------------------------------------------------
// log_conversation_event
// ---------------------------------------------------------------
export async function logConversationEvent(ctx: ToolContext, raw: unknown): Promise<LogConversationEventOutput> {
  return instrumented<LogConversationEventOutput>(
    ctx,
    'log_conversation_event',
    'Record a notable agent decision',
    (raw ?? {}) as Record<string, unknown>,
    async () => {
      const parsed = LogConversationEventInput.safeParse(raw);
      if (!parsed.success) {
        return {
          payload: { logged: false },
          status: 'error' as const,
          resultSummary: `invalid input: ${formatZodError(parsed.error.issues)}`
        };
      }
      const input = parsed.data;
      // Create the conversation if it does not exist yet, so an event is
      // never dropped because it arrived before the conversation row.
      await ensureConversation(input.conversation_id);

      const db = supabaseAdmin();
      const res = await withTimeout('event insert', () =>
        db.from('tool_calls').insert({
          conversation_id: input.conversation_id,
          tool_name: 'event',
          purpose: input.event_type,
          input_summary: `event_type=${input.event_type}`,
          result_summary: input.summary,
          status: 'success',
          latency_ms: 0
        })
      );
      if (!res.ok) throw new Error(res.error);

      return {
        payload: { logged: true },
        status: 'success' as const,
        resultSummary: `${input.event_type}: ${input.summary.slice(0, 120)}`
      };
    },
    () => ({ logged: false })
  );
}
