// Tool instrumentation.
//
// Every tool in this server is wrapped by `instrumented()`. Three
// guarantees it provides, which the brief requires:
//
//   1. EXACTLY ONE `tool_calls` row per invocation — success, not-found,
//      or error. Written in a `finally`, so a bug or an early return in a
//      tool body cannot skip the audit record.
//   2. NOTHING THROWS back through MCP. A thrown error is caught, logged,
//      and converted into a structured payload the agent can reason about.
//      One bad lookup must never kill a live phone call.
//   3. Input is SUMMARISED, never logged verbatim. Emails and names are
//      masked by `summariseToolInput`; unrecognised fields record their
//      presence and type, not their value.

import { supabaseAdmin, withTimeout, summariseToolInput, redactSecrets } from '@relaypay/shared';
import type { ToolCallStatus } from '@relaypay/shared';

export interface ToolContext {
  /** Conversation this call belongs to. Null for smoke tests / direct calls. */
  conversationId: string | null;
}

export interface InstrumentedResult<T> {
  payload: T;
  status: ToolCallStatus;
  /** Short human-readable description of the outcome for the audit row. */
  resultSummary: string;
}

/**
 * Persist one tool_calls row. Deliberately swallows its own failures: if
 * the audit write fails we log to stderr and carry on, because losing an
 * audit row is strictly better than dropping the customer's call.
 *
 * stderr (not stdout) because stdout is the MCP stdio transport — writing
 * there would corrupt the protocol stream.
 */
async function writeToolCallRow(row: {
  conversation_id: string | null;
  tool_name: string;
  purpose: string;
  input_summary: string;
  result_summary: string | null;
  status: ToolCallStatus;
  error_message: string | null;
  latency_ms: number;
}): Promise<void> {
  try {
    const db = supabaseAdmin();
    const res = await withTimeout('tool_calls insert', () => db.from('tool_calls').insert(row));
    if (!res.ok) {
      console.error(`[audit] failed to write tool_calls row for ${row.tool_name}: ${res.error}`);
    }
  } catch (e) {
    console.error(`[audit] tool_calls write threw for ${row.tool_name}: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Wrap a tool body with validation-safe error handling and audit logging.
 *
 * `fn` returns the payload plus how to describe it in the audit row. If
 * `fn` throws, we return `onError` as the payload so the agent still gets
 * a well-formed structured response.
 */
export async function instrumented<T>(
  ctx: ToolContext,
  toolName: string,
  purpose: string,
  rawInput: Record<string, unknown>,
  fn: () => Promise<InstrumentedResult<T>>,
  onError: (message: string) => T
): Promise<T> {
  const started = Date.now();
  const inputSummary = summariseToolInput(rawInput);

  let payload: T;
  let status: ToolCallStatus = 'success';
  let resultSummary: string | null = null;
  let errorMessage: string | null = null;

  try {
    const out = await fn();
    payload = out.payload;
    status = out.status;
    resultSummary = out.resultSummary;
  } catch (e) {
    status = 'error';
    errorMessage = redactSecrets(e instanceof Error ? e.message : String(e));
    resultSummary = 'tool threw; returned structured error to the agent';
    payload = onError(errorMessage);
    // stderr, never stdout — stdout carries the MCP protocol.
    console.error(`[tool:${toolName}] ${errorMessage}`);
  } finally {
    await writeToolCallRow({
      conversation_id: ctx.conversationId,
      tool_name: toolName,
      purpose,
      input_summary: inputSummary,
      result_summary: resultSummary,
      status,
      error_message: errorMessage,
      latency_ms: Date.now() - started
    });
  }

  return payload;
}

/**
 * Turn a Zod failure into the flat, readable message we hand back to the
 * agent. The agent uses this to ask the caller for a corrected reference,
 * so it has to read like a sentence, not a validation dump.
 */
export function formatZodError(issues: { path: (string | number)[]; message: string }[]): string {
  return issues
    .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message))
    .join('; ');
}
