// Enums and constants shared across the MCP server, agent, and web app.
// Everything here is stated explicitly in the build brief; anything that
// depends on the asset files (transaction statuses, plans, KYC states) is
// deliberately NOT guessed here — see seed-enums.ts.

// ---- Conversation ------------------------------------------------------
export const CHANNELS = ['web_voice', 'phone', 'text_eval'] as const;
export type Channel = (typeof CHANNELS)[number];

export const FINAL_STATUSES = ['resolved', 'escalated', 'abandoned', 'declined'] as const;
export type FinalStatus = (typeof FINAL_STATUSES)[number];

/**
 * The four response paths from support-decision-rules.md, plus the
 * tool_result bookkeeping type. Order matters: the agent evaluates
 * escalation BEFORE attempting a direct answer.
 */
export const ANSWER_TYPES = [
  'direct_answer',
  'clarifying_question',
  'escalation',
  'decline',
  'tool_result'
] as const;
export type AnswerType = (typeof ANSWER_TYPES)[number];

export const TURN_ROLES = ['user', 'assistant', 'system'] as const;
export type TurnRole = (typeof TURN_ROLES)[number];

// ---- Escalation --------------------------------------------------------
export const ESCALATION_CATEGORIES = ['compliance', 'account', 'dispute', 'payment', 'other'] as const;
export type EscalationCategory = (typeof ESCALATION_CATEGORIES)[number];

export const ESCALATION_STATUSES = ['open', 'scheduled', 'contacted', 'closed'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

// ---- Tickets -----------------------------------------------------------
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

// ---- Tooling / retrieval ----------------------------------------------
export const TOOL_CALL_STATUSES = ['success', 'not_found', 'error'] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const RETRIEVAL_MODES = ['embedding', 'lexical', 'none'] as const;
export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];

/**
 * Below this cosine/rank score a retrieval hit is treated as irrelevant and
 * search_knowledge_base returns { found: false } — which routes the agent to
 * "decline gracefully" instead of answering from general knowledge.
 */
export const RETRIEVAL_MIN_SCORE = 0.35;
export const RETRIEVAL_TOP_K = 5;

// ---- ID shapes ---------------------------------------------------------
// Financial references are matched EXACTLY — never fuzzy. These patterns
// let a tool reject a malformed reference cleanly instead of querying with
// garbage or, worse, guessing which record the caller meant.
export const ID_PATTERNS = {
  customer: /^CUS-\d+$/,
  transaction: /^TXN-\d+$/,
  payout: /^PAY-\d+$/
} as const;

// ---- Timeouts / limits -------------------------------------------------
export const SUPABASE_TIMEOUT_MS = 5_000;
export const SUPABASE_RETRIES = 1;
export const AGENT_TURN_TIMEOUT_MS = 25_000;
export const MAX_AGENT_TURNS_PER_REQUEST = 12;

// ---- Brand (brand-direction.md, concretised in the build brief) --------
export const BRAND = {
  primary: '#16294B',    // deep blue
  accent: '#0F766E',     // teal
  background: '#F7F7F5', // off-white
  text: '#1A1A1A',
  muted: '#5B6472'
} as const;
