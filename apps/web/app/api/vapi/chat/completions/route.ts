// Vapi Custom LLM endpoint.
//
// Vapi is configured with model.provider = 'custom-llm' pointing here.
// Per turn it sends an OpenAI-compatible chat/completions request; we run
// the message through the Agent SDK (which does all the tool use,
// retrieval and decision logic) and return an OpenAI-compatible
// completion containing nothing but the sentence to speak.
//
// That direction of control is the whole architecture: Vapi never sees
// the MCP tools, Supabase, or the knowledge base. It handles audio and
// turn-taking; the agent handles support.
//
// Node runtime, NOT Edge — the Agent SDK spawns the MCP server as a
// child process, which Edge cannot do.

import { runAgentTurn } from '@relaypay/agent';
import { verifyVapiRequest, rateLimit, clientKey, json } from '@/lib/security.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Cost-abuse protection: a single caller cannot spin the agent forever. */
const RATE_LIMIT_TURNS = 40;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | { type: string; text?: string }[] | null;
}

interface VapiChatRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  /** Vapi includes call metadata; shapes vary by version so we probe. */
  call?: { id?: string; type?: string };
  metadata?: Record<string, unknown>;
}

/** Message content can be a string or a content-block array. Flatten it. */
function flattenContent(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : b.text ?? '')).join(' ').trim();
  }
  return '';
}

/**
 * Derive a stable conversation id.
 *
 * Prefer Vapi's call id so every turn of one phone call shares a row.
 * Falling back to a random id would split a single call across several
 * conversation records, which would make the audit trail useless.
 */
function resolveConversationId(body: VapiChatRequest, headers: Headers): string {
  const fromCall = body.call?.id;
  if (typeof fromCall === 'string' && fromCall) return `vapi-${fromCall}`;

  const fromMeta = body.metadata?.conversation_id ?? body.metadata?.call_id;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;

  const fromHeader = headers.get('x-call-id');
  if (fromHeader) return `vapi-${fromHeader}`;

  // Last resort. Logged loudly because it means multi-turn context breaks.
  const generated = `vapi-unknown-${Date.now()}`;
  console.warn(`[vapi] no call id on request; using ${generated}. Multi-turn context will not persist.`);
  return generated;
}

/** OpenAI-compatible non-streaming completion. */
function completion(text: string, model: string, conversationId: string) {
  return {
    id: `chatcmpl-${conversationId}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop'
      }
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();

  // 1. Authenticate BEFORE doing any work. This endpoint costs money.
  const authError = verifyVapiRequest(req.headers, rawBody);
  if (authError) {
    console.warn(`[vapi] rejected request: ${authError}`);
    return json({ error: { message: 'Unauthorized', type: 'invalid_request_error' } }, { status: 401 });
  }

  // 2. Rate limit per client.
  const limit = rateLimit(`vapi:${clientKey(req.headers)}`, RATE_LIMIT_TURNS, RATE_LIMIT_WINDOW_MS);
  if (!limit.ok) {
    return json(
      { error: { message: 'Rate limit exceeded', type: 'rate_limit_error' } },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } }
    );
  }

  let body: VapiChatRequest;
  try {
    body = JSON.parse(rawBody) as VapiChatRequest;
  } catch {
    return json({ error: { message: 'Malformed JSON', type: 'invalid_request_error' } }, { status: 400 });
  }

  const messages = body.messages ?? [];
  const conversationId = resolveConversationId(body, req.headers);
  const model = body.model ?? 'relaypay-support-agent';

  // The last user message is the turn to answer. Anything before it is
  // context. Vapi's own system message is dropped — our system prompt
  // comes from the agent package, not from the voice layer.
  const conversational = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastUserIdx = conversational.map((m) => m.role).lastIndexOf('user');

  if (lastUserIdx === -1) {
    // No user turn yet (Vapi sometimes probes on connect). Return the
    // greeting rather than running the agent for nothing.
    return json(
      completion(
        'Hi, thanks for calling RelayPay support. This call may be recorded for quality and support purposes. How can I help today?',
        model,
        conversationId
      )
    );
  }

  const userMessage = flattenContent(conversational[lastUserIdx]!.content);
  const history = conversational.slice(0, lastUserIdx).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: flattenContent(m.content)
  })).filter((m) => m.content);

  try {
    const result = await runAgentTurn({
      conversationId,
      userMessage,
      history,
      channel: body.call?.type === 'inboundPhoneCall' ? 'phone' : 'web_voice'
    });

    if (result.degraded) {
      // Surface degradation in logs; the caller still gets a usable reply.
      console.warn(`[vapi] degraded turn on ${conversationId}: ${result.degraded}`);
    }

    return json(completion(result.text, model, conversationId));
  } catch (e) {
    // Never hang or 500 back to Vapi — a 500 makes the assistant go
    // silent mid-call, which is the worst possible caller experience.
    // Speak a graceful fallback instead.
    console.error(`[vapi] turn threw on ${conversationId}: ${e instanceof Error ? e.message : e}`);
    return json(
      completion(
        "I'm sorry, I'm having trouble on my end right now. Let me arrange for a specialist to follow up with you — could I take your name and email address?",
        model,
        conversationId
      )
    );
  }
}

/** Vapi occasionally probes the URL. Answer without leaking anything. */
export async function GET(): Promise<Response> {
  return json({ status: 'ok', endpoint: 'vapi-custom-llm', note: 'POST an OpenAI-compatible chat/completions body.' });
}
