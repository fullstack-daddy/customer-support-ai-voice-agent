// Zod contracts for every MCP tool.
//
// These mirror assets/mcp-tool-requirements.md, which the brief calls "a
// contract, not a suggestion". Two deliberate, documented deviations:
//
//  1. `lookup_customer` output: the spec lists `support_notes`. In the seed
//     data that field holds INTERNAL ROUTING TEXT — e.g. CUS-1003 reads
//     "Account is under compliance review. Escalate account-specific
//     questions." That is an instruction aimed at the agent, not a sentence
//     to read to a caller. We return it as `internal_flag` so it is
//     structurally impossible to confuse with speakable output, and the
//     system prompt forbids voicing it. Renaming rather than dropping keeps
//     the routing signal the spec intended.
//
//  2. `lookup_customer` gains `multiple_matches` + `candidates` for the
//     ambiguous-company-name case. The spec has no shape for "two customers
//     match"; guessing between them is exactly the behaviour the PRD warns
//     against, so we return a safe disambiguation list instead.
//
// Everything else matches the spec field-for-field.

import { z } from 'zod';
import { ESCALATION_CATEGORIES, TICKET_PRIORITIES, ID_PATTERNS } from './constants.js';

// ---------------------------------------------------------------
// lookup_customer
// ---------------------------------------------------------------
export const LookupCustomerInput = z
  .object({
    customer_id: z.string().optional(),
    email: z.string().optional(),
    company_name: z.string().optional()
  })
  .refine(
    (v) => Boolean(v.customer_id || v.email || v.company_name),
    { message: 'Provide at least one of customer_id, email, or company_name.' }
  );
export type LookupCustomerInput = z.infer<typeof LookupCustomerInput>;

export const CustomerCandidate = z.object({
  customer_id: z.string(),
  company_name: z.string()
});

export const LookupCustomerOutput = z.union([
  z.object({ found: z.literal(false), reason: z.string().optional() }),
  z.object({
    found: z.literal(true),
    multiple_matches: z.literal(true),
    candidates: z.array(CustomerCandidate)
  }),
  z.object({
    found: z.literal(true),
    multiple_matches: z.literal(false).optional(),
    customer_id: z.string(),
    company_name: z.string(),
    plan: z.string(),
    account_status: z.string(),
    kyc_status: z.string(),
    /** INTERNAL ONLY — routing signal. Never spoken, never paraphrased. */
    internal_flag: z.string().nullable(),
    /** Derived: true when account_status/kyc_status demand a human. */
    requires_escalation: z.boolean()
  })
]);
export type LookupCustomerOutput = z.infer<typeof LookupCustomerOutput>;

// ---------------------------------------------------------------
// lookup_transaction — exact ID match only, never fuzzy
// ---------------------------------------------------------------
export const LookupTransactionInput = z.object({
  transaction_id: z
    .string()
    .regex(ID_PATTERNS.transaction, 'transaction_id must look like TXN-9001.')
});
export type LookupTransactionInput = z.infer<typeof LookupTransactionInput>;

export const LookupTransactionOutput = z.union([
  z.object({ found: z.literal(false), reason: z.string().optional() }),
  z.object({
    found: z.literal(true),
    transaction_id: z.string(),
    customer_id: z.string(),
    type: z.string(),
    status: z.string(),
    amount: z.string(),
    currency: z.string(),
    estimated_arrival: z.string().nullable(),
    support_summary: z.string().nullable(),
    requires_escalation: z.boolean()
  })
]);
export type LookupTransactionOutput = z.infer<typeof LookupTransactionOutput>;

// ---------------------------------------------------------------
// lookup_payout
// ---------------------------------------------------------------
export const LookupPayoutInput = z
  .object({
    payout_id: z.string().regex(ID_PATTERNS.payout, 'payout_id must look like PAY-7001.').optional(),
    transaction_id: z.string().regex(ID_PATTERNS.transaction, 'transaction_id must look like TXN-9001.').optional()
  })
  .refine((v) => Boolean(v.payout_id || v.transaction_id), {
    message: 'Provide either payout_id or transaction_id.'
  });
export type LookupPayoutInput = z.infer<typeof LookupPayoutInput>;

export const LookupPayoutOutput = z.union([
  z.object({ found: z.literal(false), reason: z.string().optional() }),
  z.object({
    found: z.literal(true),
    payout_id: z.string(),
    status: z.string(),
    scheduled_for: z.string().nullable(),
    failure_reason: z.string().nullable(),
    support_summary: z.string().nullable(),
    requires_escalation: z.boolean()
  })
]);
export type LookupPayoutOutput = z.infer<typeof LookupPayoutOutput>;

// ---------------------------------------------------------------
// create_support_ticket
// ---------------------------------------------------------------
export const CreateSupportTicketInput = z.object({
  customer_id: z.string().regex(ID_PATTERNS.customer).optional(),
  category: z.string().min(1, 'category is required.'),
  priority: z.enum(TICKET_PRIORITIES),
  summary: z.string().min(1, 'summary is required.'),
  conversation_id: z.string().min(1, 'conversation_id is required.'),
  // Optional: when the caller has given contact details, the ticket can
  // produce a confirmation email. Both are what the agent HEARD — they
  // are surfaced to the caller for correction before anything is sent.
  contact_name: z.string().optional(),
  contact_email: z.string().optional()
});
export type CreateSupportTicketInput = z.infer<typeof CreateSupportTicketInput>;

export const CreateSupportTicketOutput = z.object({
  ticket_id: z.string(),
  status: z.string(),
  /** True when an existing open ticket was returned instead of a new one. */
  deduplicated: z.boolean().optional()
});
export type CreateSupportTicketOutput = z.infer<typeof CreateSupportTicketOutput>;

// ---------------------------------------------------------------
// create_escalation
// ---------------------------------------------------------------
export const CreateEscalationInput = z.object({
  ticket_id: z.string().optional(),
  customer_id: z.string().regex(ID_PATTERNS.customer).optional(),
  user_name: z.string().min(1, 'user_name is required.'),
  user_email: z.string().email('user_email must be a valid email address.'),
  category: z.enum(ESCALATION_CATEGORIES),
  reason: z.string().min(1, 'reason is required.'),
  preferred_time: z.string().optional(),
  conversation_id: z.string().min(1, 'conversation_id is required.')
});
export type CreateEscalationInput = z.infer<typeof CreateEscalationInput>;

export const CreateEscalationOutput = z.object({
  escalation_id: z.string(),
  status: z.string(),
  /**
   * Written by the TOOL, not the model, so the agent cannot improvise a
   * commitment the business never authorised. escalation-rules.md forbids
   * promising timelines for disputes or reviews.
   */
  follow_up_summary: z.string(),
  deduplicated: z.boolean().optional()
});
export type CreateEscalationOutput = z.infer<typeof CreateEscalationOutput>;

// ---------------------------------------------------------------
// log_conversation_event
// ---------------------------------------------------------------
export const LogConversationEventInput = z.object({
  conversation_id: z.string().min(1, 'conversation_id is required.'),
  event_type: z.string().min(1, 'event_type is required.'),
  summary: z.string().min(1, 'summary is required.'),
  metadata: z.record(z.unknown()).optional()
});
export type LogConversationEventInput = z.infer<typeof LogConversationEventInput>;

export const LogConversationEventOutput = z.object({ logged: z.boolean() });
export type LogConversationEventOutput = z.infer<typeof LogConversationEventOutput>;

// ---------------------------------------------------------------
// search_knowledge_base
// ---------------------------------------------------------------
export const SearchKnowledgeBaseInput = z.object({
  query: z.string().min(2, 'query is required.'),
  conversation_id: z.string().optional()
});
export type SearchKnowledgeBaseInput = z.infer<typeof SearchKnowledgeBaseInput>;

export const KnowledgeChunk = z.object({
  id: z.string(),
  title: z.string(),
  section_path: z.string().nullable(),
  content: z.string(),
  score: z.number()
});

export const SearchKnowledgeBaseOutput = z.object({
  found: z.boolean(),
  retrieval_mode: z.string(),
  chunks: z.array(KnowledgeChunk),
  /** Present when found === false, explains why so the agent can decline well. */
  reason: z.string().optional()
});
export type SearchKnowledgeBaseOutput = z.infer<typeof SearchKnowledgeBaseOutput>;
