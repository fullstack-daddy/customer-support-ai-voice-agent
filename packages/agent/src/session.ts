// Persistent agent sessions, warmed before the caller speaks.
//
// Why this exists
// ---------------
// query() spawns a Claude Code subprocess, and in one-shot mode that
// happens on every turn. Measured on a dev machine, a turn cost 34-68s
// and even a turn calling no tools cost 39s — the subprocess, not the
// model or the database. For a voice call that is fatal.
//
// In streaming-input mode the subprocess is spawned once and kept, so
// the cost is paid per CALL instead of per TURN. Measured the same way,
// turns on a warm session answered in 3.7-4.5s.
//
// The subprocess starts as soon as query() is called, but the CLI emits
// nothing until a user message arrives — there is no "ready" event to
// wait for. So warming is simply calling query() early, during the
// greeting, and letting the spawn overlap with the caller listening to
// it. Nothing waits on the result.

import { query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

/** Drop a session after this long without a turn. */
const IDLE_MS = 10 * 60 * 1000;

/** Hard ceiling on live subprocesses, so a leak cannot exhaust the host. */
const MAX_SESSIONS = 25;

/**
 * A queue the SDK consumes as its prompt.
 *
 * The SDK pulls from this; we push a message per caller turn. While the
 * queue is empty the pull parks on a promise, which is what keeps the
 * subprocess alive and idle between turns.
 */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) return;
    const msg = {
      type: 'user',
      parent_tool_use_id: null,
      message: { role: 'user', content: text }
    } as unknown as SDKUserMessage;

    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.items.push(msg);
  }

  close(): void {
    this.closed = true;
    let waiter;
    while ((waiter = this.waiters.shift())) {
      waiter({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.items.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      }
    };
  }
}

export interface AgentSession {
  conversationId: string;
  input: InputQueue;
  stream: AsyncGenerator<SDKMessage, void>;
  createdAt: number;
  lastUsed: number;
  turnsServed: number;
  /** One caller turn at a time; a voice call is strictly turn-based. */
  busy: boolean;
}

/**
 * Next's dev server re-evaluates route modules, so a module-level Map
 * would silently produce a second registry and leak the first one's
 * subprocesses. Pin it to globalThis.
 */
const REGISTRY: Map<string, AgentSession> = ((): Map<string, AgentSession> => {
  const g = globalThis as { __relaypayAgentSessions?: Map<string, AgentSession> };
  if (!g.__relaypayAgentSessions) g.__relaypayAgentSessions = new Map();
  return g.__relaypayAgentSessions;
})();

function sweepIdle(): void {
  const now = Date.now();
  for (const [id, s] of REGISTRY) {
    if (!s.busy && now - s.lastUsed > IDLE_MS) void disposeSession(id, 'idle');
  }
}

/**
 * Start a session for this conversation if one is not already running.
 *
 * Returns immediately. The subprocess spawns in the background; callers
 * must not await readiness because the CLI reports none.
 */
export function warmSession(conversationId: string, systemPrompt: string, maxTurns: number): AgentSession | null {
  sweepIdle();

  const existing = REGISTRY.get(conversationId);
  if (existing) return existing;

  if (REGISTRY.size >= MAX_SESSIONS) {
    // Evict the least recently used idle session rather than refusing.
    const idle = [...REGISTRY.entries()].filter(([, s]) => !s.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (idle) void disposeSession(idle[0], 'evicted');
    else {
      console.warn(`[agent] ${MAX_SESSIONS} sessions all busy; not warming ${conversationId}`);
      return null;
    }
  }

  const input = new InputQueue();
  let stream: AsyncGenerator<SDKMessage, void>;
  try {
    stream = query({
      prompt: input,
      options: buildOptions(systemPrompt, maxTurns, conversationId)
    }) as AsyncGenerator<SDKMessage, void>;
  } catch (e) {
    console.error(`[agent] could not warm ${conversationId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }

  const session: AgentSession = {
    conversationId,
    input,
    stream,
    createdAt: Date.now(),
    lastUsed: Date.now(),
    turnsServed: 0,
    busy: false
  };
  REGISTRY.set(conversationId, session);
  return session;
}

export function getSession(conversationId: string): AgentSession | undefined {
  return REGISTRY.get(conversationId);
}

export async function disposeSession(conversationId: string, reason = 'done'): Promise<void> {
  const session = REGISTRY.get(conversationId);
  if (!session) return;
  REGISTRY.delete(conversationId);
  try {
    session.input.close();
    await session.stream.return?.(undefined as never);
  } catch {
    // Already gone. Nothing useful to do with a dead subprocess.
  }
  console.log(`[agent] session ${conversationId} disposed (${reason}, ${session.turnsServed} turns)`);
}

export function sessionCount(): number {
  return REGISTRY.size;
}

/** Shared option set, so a warm session behaves exactly like a cold turn. */
let optionsBuilder:
  | ((systemPrompt: string, maxTurns: number, conversationId: string) => Record<string, unknown>)
  | null = null;

/** runtime.ts owns the option set; it registers it here to avoid a cycle. */
export function registerOptionsBuilder(
  fn: (systemPrompt: string, maxTurns: number, conversationId: string) => Record<string, unknown>
): void {
  optionsBuilder = fn;
}

function buildOptions(systemPrompt: string, maxTurns: number, conversationId: string): never {
  if (!optionsBuilder) throw new Error('agent session options builder was never registered');
  return optionsBuilder(systemPrompt, maxTurns, conversationId) as never;
}
