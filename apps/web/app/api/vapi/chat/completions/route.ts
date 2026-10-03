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

import { runAgentTurn, warmAgentSession } from '@relaypay/agent';
import { redactTranscript } from '@relaypay/shared';
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

/**
 * OpenAI-compatible SSE stream.
 *
 * Vapi's custom-LLM client expects Server-Sent Events: a sequence of
 * `data: {chunk}` lines terminated by `data: [DONE]`. Returning a plain
 * JSON body when it asked for a stream leaves the assistant silent for
 * the whole turn, which is indistinguishable from the backend being
 * down — exactly the failure that is hardest to diagnose from a call.
 *
 * The agent produces its answer in one piece, so there is no token
 * stream to forward. Emitting it sentence by sentence still helps: Vapi
 * hands each chunk to text-to-speech as it arrives, so the caller hears
 * the first sentence while the rest is still being written.
 */
function sseCompletion(text: string, model: string, conversationId: string): Response {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${conversationId}`;
  const created = Math.floor(Date.now() / 1000);

  const frame = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }]
    })}\n\n`;

  // Keep the punctuation with its sentence so TTS prosody survives.
  const sentences = text.match(/[^.!?]+[.!?]+[\s]*|[^.!?]+$/g) ?? [text];

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(frame({ role: 'assistant', content: '' }, null)));
      for (const sentence of sentences) {
        if (sentence) controller.enqueue(encoder.encode(frame({ content: sentence }, null)));
      }
      controller.enqueue(encoder.encode(frame({}, 'stop')));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform stops proxies buffering the stream into one lump.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    }
  });
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

  // Vapi normally asks for a stream. Honour whatever it asked for:
  // sending a plain JSON body to a client expecting SSE makes the
  // assistant stay silent for the entire turn.
  // Why a turn degraded, for the authenticated caller only.
  //
  // The spoken reply is deliberately vague — a caller must not hear
  // internals. But a failure that reads as "I'm having trouble" in audio
  // is almost impossible to diagnose from outside, and serverless logs
  // are not always to hand. This header is visible only to someone who
  // already holds VAPI_SERVER_SECRET, and Vapi ignores it.
  const respond = (text: string, degraded?: string) => {
    const res =
      body.stream === true
        ? sseCompletion(text, model, conversationId)
        : json(completion(text, model, conversationId));
    if (degraded) res.headers.set('x-relaypay-degraded', degraded.slice(0, 200));
    return res;
  };

  // The last user message is the turn to answer. Anything before it is
  // context. Vapi's own system message is dropped — our system prompt
  // comes from the agent package, not from the voice layer.
  const conversational = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  const lastUserIdx = conversational.map((m) => m.role).lastIndexOf('user');

  if (lastUserIdx === -1) {
    // No user turn yet (Vapi probes on connect). This is the moment to
    // start the agent subprocess: the caller is about to hear the
    // greeting, which buys several seconds of spawn time that would
    // otherwise be added to their first question.
    warmAgentSession(conversationId);

    // Return the greeting rather than running the agent for nothing.
    return respond(
      'Hi, thanks for calling RelayPay support. This call may be recorded for quality and support purposes. How can I help today?'
    );
  }

  // Redact at the EARLIEST possible point. A caller can read out a card
  // number or a one-time code at any moment, and no system prompt can stop
  // them — by the time text exists, the value has been captured. Scrubbing
  // here means it never reaches the model, the tools, or any log line.
  const rawUserMessage = flattenContent(conversational[lastUserIdx]!.content);
  const scrubbed = redactTranscript(rawUserMessage);
  if (scrubbed.redacted) {
    // Kinds only — logging the value would defeat the entire exercise.
    console.warn(`[vapi] redacted from caller turn on ${conversationId}: ${scrubbed.hits.map((h) => h.kind).join(', ')}`);
  }
  const userMessage = scrubbed.text;

  const history = conversational.slice(0, lastUserIdx).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: redactTranscript(flattenContent(m.content)).text
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

    return respond(result.text, result.degraded);
  } catch (e) {
    // Never hang or 500 back to Vapi — a 500 makes the assistant go
    // silent mid-call, which is the worst possible caller experience.
    // Speak a graceful fallback instead.
    console.error(`[vapi] turn threw on ${conversationId}: ${e instanceof Error ? e.message : e}`);
    return respond(
      "I'm sorry, I'm having trouble on my end right now. Let me arrange for a specialist to follow up with you — could I take your name and email address?",
      e instanceof Error ? e.message : String(e)
    );
  }
}

/** Vapi occasionally probes the URL. Answer without leaking anything. */
export async function GET(): Promise<Response> {
  return json({ status: 'ok', endpoint: 'vapi-custom-llm', note: 'POST an OpenAI-compatible chat/completions body.' });
}
