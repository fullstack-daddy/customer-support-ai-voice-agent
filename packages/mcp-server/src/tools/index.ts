// Tool registry.
//
// One place that knows every tool's name, description, JSON schema, and
// handler. The MCP entrypoint and the smoke-test harness both read from
// here, so a tool can never be exposed over MCP but missing from the
// tests (or vice versa).
//
// Descriptions are written FOR THE MODEL. They say when to call the tool
// and, just as importantly, when not to — tool-use discipline is cheaper
// to enforce in a description than to correct in a system prompt.

import { z } from 'zod';
import {
  LookupCustomerInput, LookupTransactionInput, LookupPayoutInput,
  CreateSupportTicketInput, CreateEscalationInput, LogConversationEventInput,
  SearchKnowledgeBaseInput
} from '@relaypay/shared';
import type { ToolContext } from '../instrument.js';
import { lookupCustomer, lookupTransaction, lookupPayout } from './lookups.js';
import { createSupportTicket, createEscalation, logConversationEvent } from './writes.js';
import { searchKnowledgeBase } from './retrieval.js';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  handler: (ctx: ToolContext, input: unknown) => Promise<unknown>;
}

export const TOOLS: ToolDefinition[] = [
  {
    name: 'search_knowledge_base',
    description:
      'Search approved RelayPay documentation. Call this FIRST for any product, policy, pricing, ' +
      'timeline, or "how does X work" question. If it returns found:false, you must decline or ' +
      'escalate — never answer such a question from general knowledge.',
    schema: SearchKnowledgeBaseInput,
    handler: searchKnowledgeBase
  },
  {
    name: 'lookup_customer',
    description:
      'Look up a customer record. Only call this once the caller has given a customer ID, an email ' +
      'address, or a company name. Do not call it speculatively. If it returns multiple_matches, ask ' +
      'the caller which company is theirs — never pick one yourself.',
    schema: LookupCustomerInput,
    handler: lookupCustomer
  },
  {
    name: 'lookup_transaction',
    description:
      'Look up one transaction by its exact reference (format TXN-9001). Only call this when the ' +
      'caller has given you a reference. Matching is exact: there is no partial or fuzzy search for ' +
      'financial references.',
    schema: LookupTransactionInput,
    handler: lookupTransaction
  },
  {
    name: 'lookup_payout',
    description:
      'Look up one contractor or vendor payout by its exact payout reference (PAY-7001) or by the ' +
      'transaction reference it belongs to (TXN-9001). Only call this when the caller has given you ' +
      'one of those references.',
    schema: LookupPayoutInput,
    handler: lookupPayout
  },
  {
    name: 'create_support_ticket',
    description:
      'Open a support ticket so a human can follow up on a specific issue. Call this when the caller ' +
      'has a concrete problem that needs follow-up but does not require immediate human handoff. ' +
      'If the caller has given you their name and email, pass them as contact_name and contact_email ' +
      'so they receive a confirmation — ask for them if they have not. ' +
      'Calling it twice for the same issue in one conversation returns the existing ticket.',
    schema: CreateSupportTicketInput,
    handler: createSupportTicket
  },
  {
    name: 'create_escalation',
    description:
      'Hand the conversation to human support. Call this for account restrictions, compliance or ' +
      'verification matters, disputes, refunds, cancellations, or when the caller is frustrated. You ' +
      'need their name and email first. After this succeeds, stop troubleshooting and close warmly — ' +
      'use the follow_up_summary it returns verbatim.',
    schema: CreateEscalationInput,
    handler: createEscalation
  },
  {
    name: 'log_conversation_event',
    description:
      'Record a notable decision you made: an escalation being triggered, a ticket being raised, or a ' +
      'question you declined to answer. Use it for decisions worth reviewing later, not for every turn.',
    schema: LogConversationEventInput,
    handler: logConversationEvent
  }
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export {
  lookupCustomer, lookupTransaction, lookupPayout,
  createSupportTicket, createEscalation, logConversationEvent,
  searchKnowledgeBase
};
export { ensureConversation } from './writes.js';
