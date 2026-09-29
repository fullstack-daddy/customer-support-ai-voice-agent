// Agent runtime — one turn of a support conversation.
//
// API notes, verified against the installed @anthropic-ai/claude-agent-sdk
// type definitions rather than from memory:
//
//  - `systemPrompt` as a PLAIN STRING is a full custom override. The
//    `{ type: 'preset', preset: 'claude_code' }` form is what opts INTO
//    Claude Code's coding-assistant prompt. We want neither that prompt
//    nor its tools, so we pass our string directly.
//  - `mcpServers` is Record<string, McpStdioServerConfig>, where the
//    stdio config is `{ command, args?, env? }`.
//  - MCP tools surface to the model as `mcp__<server>__<tool>`.
//  - `permissionMode: 'bypassPermissions'` is required for unattended
//    operation; there is no human to approve a tool call mid-phone-call.
//    Safe here because `allowedTools` is an explicit allow-list of our
//    seven read/write-scoped tools and nothing else.
//  - The SDK spawns its own subprocess; the Claude Code CLI does not need
//    to be installed separately. It DOES need to be able to spawn a child
//    process, which is why the chat-completions route must run on the
//    Node runtime, not Edge.

import { resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_TURN_TIMEOUT_MS, MAX_AGENT_TURNS_PER_REQUEST, type AnswerType } from '@relaypay/shared';
import { buildSystemPrompt } from './system-prompt.js';
import { loadConversationState, rememberCustomer } from './state.js';
import { writeTurn, deriveAnswerType, accumulateUsage, markRetrievalUsed } from './turns.js';
import { ensureConversation } from '@relaypay/mcp-server/tools';

const MCP_SERVER_NAME = 'relaypay';

/** Absolute path to the compiled MCP entrypoint. Relative paths fail silently. */
function mcpEntrypoint(): string {
  if (process.env.RELAYPAY_MCP_ENTRYPOINT) return process.env.RELAYPAY_MCP_ENTRYPOINT;
  // From packages/agent/dist -> repo root -> packages/mcp-server/dist/index.js
  return resolve(process.cwd(), 'packages', 'mcp-server', 'dist', 'index.js');
}

const TOOL_NAMES = [
  'search_knowledge_base',
  'lookup_customer',
  'lookup_transaction',
  'lookup_payout',
  'create_support_ticket',
  'create_escalation',
  'log_conversation_event'
] as const;

const ALLOWED_TOOLS = TOOL_NAMES.map((t) => `mcp__${MCP_SERVER_NAME}__${t}`);

export interface AgentTurnInput {
  conversationId: string;
  /** What the caller just said. */
  userMessage: string;
  /** Prior turns, oldest first, for multi-turn context within the call. */
  history?: { role: 'user' | 'assistant'; content: string }[];
  channel?: 'web_voice' | 'phone' | 'text_eval';
}

export interface AgentTurnResult {
  text: string;
  answerType: AnswerType;
  toolsCalled: { name: string; input: Record<string, unknown> }[];
  escalated: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  /** Set when the turn failed and `text` is a graceful fallback. */
  degraded?: string;
}

/**
 * What we say when the model itself is unavailable.
 *
 * Deliberately routes toward a human rather than apologising and
 * stopping: if our agent cannot think, the caller still has a problem.
 */
const FALLBACK_TEXT =
  "I'm having trouble processing that right now. Let me get a specialist to follow up with you — " +
  'could I take your name and email address?';

/**
 * Flatten history plus the new message into a single prompt.
 *
 * The SDK supports session resumption, but a Vapi custom-LLM request is
 * stateless and gives us the whole history each turn, so replaying it is
 * both simpler and more robust to a process restart mid-call.
 */
function buildPrompt(input: AgentTurnInput): string {
  const history = input.history ?? [];
  if (!history.length) return input.userMessage;

  const transcript = history
    .map((m) => `${m.role === 'user' ? 'Customer' : 'You'}: ${m.content}`)
    .join('\n');

  return (
    `Conversation so far:\n${transcript}\n\n` +
    `Customer now says: ${input.userMessage}\n\n` +
    `Reply to what the customer just said.`
  );
}

export async function runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
  const { conversationId } = input;
  await ensureConversation(conversationId, input.channel ?? 'text_eval');

  const state = await loadConversationState(conversationId);
  const systemPrompt = buildSystemPrompt(state);

  // Record the caller's turn before we do anything that might fail, so a
  // crashed turn still leaves evidence of what was asked.
  await writeTurn({
    conversationId,
    turnIndex: state.turnCount,
    role: 'user',
    transcript: input.userMessage
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AGENT_TURN_TIMEOUT_MS);

  let text = '';
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let degraded: string | undefined;
  const toolsCalled: { name: string; input: Record<string, unknown> }[] = [];
  let retrievalFound: boolean | null = null;

  try {
    const stream = query({
      prompt: buildPrompt(input),
      options: {
        // Plain string = full custom system prompt, no Claude Code preset.
        systemPrompt,
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
        maxTurns: MAX_AGENT_TURNS_PER_REQUEST,
        abortController: controller,
        // No human is available to approve a tool call mid-call. Safe
        // because allowedTools is an explicit list of our seven tools.
        permissionMode: 'bypassPermissions',
        allowedTools: ALLOWED_TOOLS,
        // Belt and braces: strip the built-in toolset so the agent has no
        // filesystem, shell, or network access beyond our MCP server.
        disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'stdio',
            command: process.execPath,      // the running node binary
            args: [mcpEntrypoint()],
            env: {
              SUPABASE_URL: process.env.SUPABASE_URL ?? '',
              SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
              ...(process.env.VOYAGE_API_KEY ? { VOYAGE_API_KEY: process.env.VOYAGE_API_KEY } : {}),
              ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {})
            }
          }
        }
      }
    });

    for await (const message of stream) {
      if (message.type === 'assistant') {
        const content = (message as { message: { content: unknown[] } }).message?.content ?? [];
        for (const block of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
          if (block.type === 'text' && block.text) {
            // Later text blocks supersede earlier ones — the last one is
            // what the model settled on after its tool calls.
            text = block.text;
          }
          if (block.type === 'tool_use' && block.name) {
            const bare = block.name.replace(`mcp__${MCP_SERVER_NAME}__`, '');
            toolsCalled.push({ name: bare, input: (block.input ?? {}) as Record<string, unknown> });
          }
        }
      }

      // Tool results come back as user-role messages; sniff the retrieval
      // outcome so we can classify the answer type accurately.
      if (message.type === 'user') {
        const content = (message as { message: { content: unknown } }).message?.content;
        const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
        if (/"retrieval_mode"/.test(raw)) {
          retrievalFound = /"found"\s*:\s*true/.test(raw);
        }
      }

      if (message.type === 'result') {
        const r = message as {
          total_cost_usd?: number;
          usage?: { input_tokens?: number; output_tokens?: number };
          is_error?: boolean;
          subtype?: string;
        };
        costUsd = r.total_cost_usd ?? 0;
        inputTokens = r.usage?.input_tokens ?? 0;
        outputTokens = r.usage?.output_tokens ?? 0;
        // A result message is not automatically a success.
        if (r.is_error || (r.subtype && r.subtype !== 'success')) {
          degraded = `agent result: ${r.subtype ?? 'error'}`;
        }
      }
    }

    if (!text.trim()) {
      degraded = degraded ?? 'model produced no text';
      text = FALLBACK_TEXT;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    degraded = /abort/i.test(message) ? `timeout after ${AGENT_TURN_TIMEOUT_MS}ms` : message;
    text = FALLBACK_TEXT;
    console.error(`[agent] turn failed for ${conversationId}: ${degraded}`);
  } finally {
    clearTimeout(timer);
  }

  const escalated = state.escalated || toolsCalled.some((t) => t.name === 'create_escalation');
  const answerType = deriveAnswerType({
    toolsCalled: toolsCalled.map((t) => t.name),
    replyText: text,
    retrievalFound
  });

  await writeTurn({
    conversationId,
    turnIndex: state.turnCount + 1,
    role: 'assistant',
    response: text,
    answerType,
    confidenceNote: degraded
      ? `degraded: ${degraded}`
      : retrievalFound === false
        ? 'knowledge base returned no relevant chunk; declined rather than answering unsupported'
        : null
  });

  // Only mark retrieval as used when it actually found something AND the
  // agent did not fall through to a decline.
  if (retrievalFound === true && answerType !== 'decline') {
    await markRetrievalUsed(conversationId, ['*']);
  }

  // If a customer lookup identified the caller, remember it so later turns
  // do not ask for the identifier again.
  const lookup = toolsCalled.find((t) => t.name === 'lookup_customer');
  const lookedUpId = lookup?.input?.customer_id;
  if (typeof lookedUpId === 'string' && /^CUS-\d+$/.test(lookedUpId)) {
    await rememberCustomer(conversationId, lookedUpId);
  }

  await accumulateUsage(conversationId, { inputTokens, outputTokens, costUsd });

  return { text, answerType, toolsCalled, escalated, costUsd, inputTokens, outputTokens, degraded };
}
