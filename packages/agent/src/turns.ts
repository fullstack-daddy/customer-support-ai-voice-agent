// Turn persistence.
//
// The brief is explicit that `conversation_turns` must capture EVERY
// turn, written by the orchestration code — not by the model calling
// log_conversation_event. That tool is for notable decisions; this is
// the unconditional transcript. If the two disagree, this one is right,
// because the model cannot forget to call it.

import { supabaseAdmin, withTimeout } from '@relaypay/shared';
import type { AnswerType } from '@relaypay/shared';

export interface TurnRecord {
  conversationId: string;
  turnIndex: number;
  role: 'user' | 'assistant' | 'system';
  transcript?: string | null;
  response?: string | null;
  answerType?: AnswerType | null;
  confidenceNote?: string | null;
}

export async function writeTurn(turn: TurnRecord): Promise<void> {
  const db = supabaseAdmin();
  const res = await withTimeout('write turn', () =>
    db.from('conversation_turns').upsert(
      {
        conversation_id: turn.conversationId,
        turn_index: turn.turnIndex,
        role: turn.role,
        transcript: turn.transcript ?? null,
        response: turn.response ?? null,
        answer_type: turn.answerType ?? null,
        confidence_note: turn.confidenceNote ?? null
      },
      { onConflict: 'conversation_id,turn_index' }
    )
  );
  if (!res.ok) {
    // Non-fatal: losing a transcript row is bad, dropping the caller is worse.
    console.error(`[turns] failed to write turn ${turn.turnIndex}: ${res.error}`);
  }
}

/**
 * Classify what the agent just did, for `conversation_turns.answer_type`.
 *
 * Derived from the tools actually called plus the shape of the reply,
 * rather than asking the model to self-report. A model asked "what kind
 * of answer was that?" will sometimes say "direct_answer" about a turn
 * where it declined — deriving it from observed behaviour is harder to
 * get wrong and is what a reviewer actually wants to filter on.
 */
export function deriveAnswerType(opts: {
  toolsCalled: string[];
  replyText: string;
  retrievalFound: boolean | null;
}): AnswerType {
  const { toolsCalled, replyText, retrievalFound } = opts;

  if (toolsCalled.includes('create_escalation')) return 'escalation';

  // A reply that ends in a question, made no lookup, and did not ground
  // itself, is the agent asking for one more detail.
  const endsWithQuestion = /\?\s*$/.test(replyText.trim());
  const usedLookup = toolsCalled.some((t) => t.startsWith('lookup_'));
  if (endsWithQuestion && !usedLookup && retrievalFound !== true) return 'clarifying_question';

  // Retrieval ran and came back empty — anything said after that is a decline.
  if (retrievalFound === false) return 'decline';

  if (usedLookup || toolsCalled.includes('create_support_ticket')) return 'tool_result';

  return 'direct_answer';
}

/**
 * Flag the retrieval rows for this conversation as having informed the
 * answer. Called only when the reply demonstrably used retrieved text,
 * so `used_in_answer: false` stays meaningful — it marks retrieval that
 * ran and was then ignored, which is exactly the failure worth catching.
 */
export async function markRetrievalUsed(conversationId: string, chunkIds: string[]): Promise<void> {
  if (!chunkIds.length) return;
  const db = supabaseAdmin();
  const res = await withTimeout('mark retrieval used', () =>
    db
      .from('retrieval_logs')
      .update({ used_in_answer: true })
      .eq('conversation_id', conversationId)
      .is('used_in_answer', false)
  );
  if (!res.ok) console.error(`[turns] could not mark retrieval used: ${res.error}`);
}

/**
 * Accumulate token usage into conversations.metadata.
 *
 * Useful for the reflection sheet, and more importantly for spotting a
 * looping call before it gets expensive.
 */
export async function accumulateUsage(
  conversationId: string,
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
): Promise<void> {
  const db = supabaseAdmin();
  const read = await withTimeout('read usage', () =>
    db.from('conversations').select('metadata').eq('conversation_id', conversationId).maybeSingle()
  );
  if (!read.ok) return;

  const current = ((read.data as { data: { metadata: Record<string, unknown> } | null }).data?.metadata ?? {}) as {
    input_tokens?: number; output_tokens?: number; cost_usd?: number; turns?: number;
  };

  const next = {
    ...current,
    input_tokens: (current.input_tokens ?? 0) + usage.inputTokens,
    output_tokens: (current.output_tokens ?? 0) + usage.outputTokens,
    cost_usd: Number(((current.cost_usd ?? 0) + usage.costUsd).toFixed(6)),
    turns: (current.turns ?? 0) + 1
  };

  await withTimeout('write usage', () =>
    db.from('conversations').update({ metadata: next }).eq('conversation_id', conversationId)
  );
}
