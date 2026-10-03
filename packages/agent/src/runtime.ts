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

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AGENT_TURN_TIMEOUT_MS, MAX_AGENT_TURNS_PER_REQUEST, type AnswerType } from '@relaypay/shared';
import { buildSystemPrompt, buildStateNotes } from './system-prompt.js';
import { getSession, disposeSession, registerOptionsBuilder, warmSession } from './session.js';
import { loadConversationState, rememberCustomer } from './state.js';
import { writeTurn, deriveAnswerType, accumulateUsage, markRetrievalUsed } from './turns.js';
import { ensureConversation } from '@relaypay/mcp-server/tools';

const MCP_SERVER_NAME = 'relaypay';

/**
 * Absolute path to the compiled MCP entrypoint.
 *
 * This used to resolve against process.cwd(), which is only the repo
 * root when you happen to run from there. Under `next dev` the cwd is
 * apps/web, so the path pointed at apps/web/packages/... — which does
 * not exist. The SDK then failed to start the MCP server and the whole
 * subprocess exited with code 1, meaning every turn that needed a tool
 * died while turns the model could answer unaided still worked. On a
 * call that reads as "I can't reach our support system".
 *
 * Resolve from this module's own location instead, so it does not
 * matter who started the process or from where. The cwd path is kept
 * last as a fallback for bundlers that rewrite import.meta.url.
 */
function mcpEntrypoint(): string {
  if (process.env.RELAYPAY_MCP_ENTRYPOINT) return process.env.RELAYPAY_MCP_ENTRYPOINT;

  const candidates: string[] = [];
  try {
    // packages/agent/dist -> packages/agent -> packages -> mcp-server
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(resolve(here, '..', '..', 'mcp-server', 'dist', 'index.js'));
    candidates.push(resolve(here, '..', '..', '..', 'mcp-server', 'dist', 'index.js'));
  } catch {
    // import.meta.url unavailable; fall through to the cwd guess.
  }
  candidates.push(resolve(process.cwd(), 'packages', 'mcp-server', 'dist', 'index.js'));

  const found = candidates.find((c) => existsSync(c));
  if (found) return found;

  // Say so loudly. The alternative is a subprocess that exits 1 with no
  // explanation anywhere near the actual cause.
  console.error(
    '[agent] MCP entrypoint not found. Looked in: ' +
      candidates.join(' | ') +
      '. Run `npm run build` at the repo root, or set RELAYPAY_MCP_ENTRYPOINT to the absolute path.'
  );
  return candidates[candidates.length - 1]!;
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

interface Accumulator {
  text: string;
  toolsCalled: { name: string; input: Record<string, unknown> }[];
  retrievalFound: boolean | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  degraded?: string;
}

/**
 * The SDK option set, shared by the warm and cold paths so a session
 * behaves identically to a one-shot turn. The abort controller is NOT
 * here: aborting is per-turn on the cold path, but on a session it would
 * kill the subprocess the next turn depends on.
 */
/**
 * Which Claude Code executable the SDK should run.
 *
 * Normally none: the SDK picks its per-platform native binary, which is
 * the only configuration where MCP tools actually attach. Forcing the
 * bundled cli.js instead was tried to fit Vercel's 250MB function limit
 * (the native package is ~238MB) and does NOT work — the agent starts,
 * but the MCP server never registers and it loops on ToolSearch without
 * ever finding lookup_transaction. See docs/deploying.md.
 *
 * CLAUDE_CODE_EXECUTABLE stays as an escape hatch for hosts that ship
 * their own build.
 */
function claudeCodeExecutable(): string | undefined {
  return process.env.CLAUDE_CODE_EXECUTABLE || undefined;
}

function agentOptions(systemPrompt: string, maxTurns: number, conversationId: string): Record<string, unknown> {
  const executable = claudeCodeExecutable();
  return {
    // Plain string = full custom system prompt, no Claude Code preset.
    systemPrompt,
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    // Haiku by default: this is a voice line, where latency is part of
    // correctness. Measured on a warmed session, warm turns averaged
    // 9.2s against 14.6s for Sonnet, with the same answers, and it held
    // all four security probes in scripts/test-agent-security.ts
    // (prompt extraction, tool disclosure, balance invention, authority
    // bypass). Set CLAUDE_MODEL to override.
    model: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',
    maxTurns,
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
          // Authoritative conversation id. The MCP server prefers this
          // over anything the model puts in the tool arguments, so a
          // ticket cannot be filed against an invented conversation.
          RELAYPAY_CONVERSATION_ID: conversationId,
          SUPABASE_URL: process.env.SUPABASE_URL ?? '',
          SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
          ...(process.env.VOYAGE_API_KEY ? { VOYAGE_API_KEY: process.env.VOYAGE_API_KEY } : {}),
          ...(process.env.OPENAI_API_KEY ? { OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {})
        }
      }
    }
  };
}

// session.ts needs these options but must not import this module back.
registerOptionsBuilder(agentOptions);

/**
 * Fold one SDK message into the accumulator.
 *
 * Returns true when the turn is finished. On a session the stream does
 * not end between turns, so `result` is the only signal that this
 * caller's turn is complete.
 */
function collect(message: SDKMessageLike, acc: Accumulator): boolean {
  if (message.type === 'assistant') {
    const content = (message as unknown as { message: { content: unknown[] } }).message?.content ?? [];
    for (const block of content as { type: string; text?: string; name?: string; input?: unknown }[]) {
      if (block.type === 'text' && block.text) {
        // Later text blocks supersede earlier ones — the last one is
        // what the model settled on after its tool calls.
        acc.text = block.text;
      }
      if (block.type === 'tool_use' && block.name) {
        const bare = block.name.replace(`mcp__${MCP_SERVER_NAME}__`, '');
        acc.toolsCalled.push({ name: bare, input: (block.input ?? {}) as Record<string, unknown> });
      }
    }
  }

  // Tool results come back as user-role messages; sniff the retrieval
  // outcome so we can classify the answer type accurately.
  if (message.type === 'user') {
    const content = (message as unknown as { message: { content: unknown } }).message?.content;
    const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    if (/"retrieval_mode"/.test(raw)) {
      acc.retrievalFound = /"found"\s*:\s*true/.test(raw);
    }
  }

  if (message.type === 'result') {
    const r = message as unknown as {
      total_cost_usd?: number;
      usage?: { input_tokens?: number; output_tokens?: number };
      is_error?: boolean;
      subtype?: string;
    };
    acc.costUsd = r.total_cost_usd ?? 0;
    acc.inputTokens = r.usage?.input_tokens ?? 0;
    acc.outputTokens = r.usage?.output_tokens ?? 0;
    // A result message is not automatically a success.
    if (r.is_error || (r.subtype && r.subtype !== 'success')) {
      acc.degraded = `agent result: ${r.subtype ?? 'error'}`;
    }
    return true;
  }

  return false;
}

type SDKMessageLike = { type: string } & Record<string, unknown>;

/**
 * A session serves a whole call, so its turn budget is the per-turn
 * budget several times over. Exceeding it surfaces as a result subtype
 * of error_max_turns, which disposes the session and sends the next
 * turn down the cold path.
 */
const SESSION_MAX_TURNS = MAX_AGENT_TURNS_PER_REQUEST * 8;

/**
 * Start the subprocess for a call before the caller has said anything.
 *
 * Call this the moment a call begins — on the greeting, or earlier from
 * the client. It returns immediately; the spawn overlaps with whatever
 * the caller is listening to. Safe to call repeatedly: a conversation
 * that already has a session keeps it.
 *
 * The session is created with the BASE prompt only, because escalation,
 * tickets and caller identity are not known yet. runAgentTurn sends
 * those as per-turn notes instead.
 */
export function warmAgentSession(conversationId: string): void {
  const blank = { conversationId, escalated: false, ticketIds: [], knownCustomerId: null, turnCount: 0 };
  warmSession(conversationId, buildSystemPrompt(blank), SESSION_MAX_TURNS);
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

  const acc: Accumulator = {
    text: '',
    toolsCalled: [],
    retrievalFound: null,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    degraded: undefined
  };

  try {
    const session = getSession(conversationId);

    if (session && !session.busy) {
      // Warm path: the subprocess is already up. Send only what is new —
      // the session holds the conversation, so replaying history here
      // would duplicate it.
      session.busy = true;
      try {
        const notes = buildStateNotes(state);
        const seed = session.turnsServed === 0 ? buildPrompt(input) : input.userMessage;
        session.input.push(notes ? `${notes}

${seed}` : seed);

        while (true) {
          const next = await Promise.race([
            session.stream.next(),
            new Promise<'timeout'>((resolve) =>
              setTimeout(() => resolve('timeout'), AGENT_TURN_TIMEOUT_MS)
            )
          ]);

          if (next === 'timeout') {
            // The subprocess is mid-turn and cannot be rewound, so the
            // session is no longer trustworthy. Drop it; the next turn
            // starts a fresh one.
            void disposeSession(conversationId, 'turn timeout');
            throw new Error(`timeout after ${AGENT_TURN_TIMEOUT_MS}ms`);
          }
          if (next.done) break;
          if (collect(next.value, acc)) break;
        }

        session.turnsServed += 1;
        session.lastUsed = Date.now();

        // A session that has spent its turn budget cannot serve another
        // one, so retire it rather than failing every later turn.
        if (acc.degraded && /max_turns/i.test(acc.degraded)) {
          void disposeSession(conversationId, 'turn budget exhausted');
        }
      } finally {
        session.busy = false;
      }
    } else {
      // Cold path: one subprocess for this turn only. Correct, just slow.
      const stream = query({
        prompt: buildPrompt(input),
        options: { ...agentOptions(systemPrompt, MAX_AGENT_TURNS_PER_REQUEST, conversationId), abortController: controller }
      });
      for await (const message of stream) {
        if (collect(message, acc)) break;
      }
    }

    text = acc.text;
    costUsd = acc.costUsd;
    inputTokens = acc.inputTokens;
    outputTokens = acc.outputTokens;
    retrievalFound = acc.retrievalFound;
    toolsCalled.push(...acc.toolsCalled);
    degraded = acc.degraded;

    if (!text.trim()) {
      degraded = degraded ?? 'model produced no text';
      text = FALLBACK_TEXT;
    }

  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    degraded = /abort/i.test(message) ? `timeout after ${AGENT_TURN_TIMEOUT_MS}ms` : message;
    text = FALLBACK_TEXT;
    console.error(`[agent] turn failed for ${conversationId}: ${degraded}`);
    // The SDK wraps subprocess failures; the useful detail (stderr,
    // exit signal) hangs off the error object, not its message.
    const extra = e as Record<string, unknown>;
    for (const key of ['stderr', 'stdout', 'code', 'exitCode', 'signal', 'cause']) {
      if (extra?.[key] !== undefined) console.error(`[agent] ${key}:`, extra[key]);
    }
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
