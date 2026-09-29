// Standalone MCP smoke test.
//
//   npm run mcp:smoke
//
// Calls every tool directly against seeded Supabase data and prints
// pass/fail. This exists so the MCP server can be verified on its own,
// before Vapi or the Agent SDK are in the picture — when something
// breaks later, this tells you in seconds whether the data layer is the
// problem.
//
// Requires: migrations applied + `npm run seed` run.

import { randomUUID } from 'node:crypto';
import {
  lookupCustomer, lookupTransaction, lookupPayout,
  createSupportTicket, createEscalation, logConversationEvent,
  searchKnowledgeBase, ensureConversation
} from '../src/tools/index.js';
import type { ToolContext } from '../src/instrument.js';

const conversationId = `smoke-${randomUUID().slice(0, 8)}`;
const ctx: ToolContext = { conversationId };

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); if (detail !== undefined) console.log(`        ${JSON.stringify(detail).slice(0, 400)}`); }
}

async function section(title: string, fn: () => Promise<void>) {
  console.log(`\n${title}`);
  try { await fn(); }
  catch (e) { failed++; console.log(`  FAIL  section threw: ${e instanceof Error ? e.message : e}`); }
}

async function main() {
  console.log(`RelayPay MCP smoke test  (conversation ${conversationId})`);
  await ensureConversation(conversationId, 'text_eval');

  await section('lookup_customer', async () => {
    const byId = await lookupCustomer(ctx, { customer_id: 'CUS-1001' });
    check('finds CUS-1001 by id', byId.found === true && 'company_name' in byId && byId.company_name === 'LagosLedger', byId);
    check('exposes no support_notes field', !('support_notes' in byId), Object.keys(byId));
    check('carries internal_flag instead', byId.found === true && 'internal_flag' in byId, Object.keys(byId));

    const restricted = await lookupCustomer(ctx, { customer_id: 'CUS-1003' });
    check(
      'CUS-1003 (restricted, review required) flags escalation',
      restricted.found === true && 'requires_escalation' in restricted && restricted.requires_escalation === true,
      restricted
    );

    const byEmail = await lookupCustomer(ctx, { email: 'amara@lagosledger.example' });
    check('finds by email', byEmail.found === true && 'customer_id' in byEmail && byEmail.customer_id === 'CUS-1001', byEmail);

    const missing = await lookupCustomer(ctx, { customer_id: 'CUS-9999' });
    check('unknown id returns found:false', missing.found === false, missing);

    const noArgs = await lookupCustomer(ctx, {});
    check('rejects empty input', noArgs.found === false, noArgs);
  });

  await section('lookup_transaction', async () => {
    const ok = await lookupTransaction(ctx, { transaction_id: 'TXN-9001' });
    check('finds TXN-9001', ok.found === true && 'status' in ok && ok.status === 'processing', ok);
    check('returns customer-safe summary', ok.found === true && Boolean(ok.support_summary), ok);

    const review = await lookupTransaction(ctx, { transaction_id: 'TXN-9003' });
    check('TXN-9003 (review required) flags escalation', review.found === true && review.requires_escalation === true, review);

    const malformed = await lookupTransaction(ctx, { transaction_id: 'txn9001' });
    check('rejects malformed txn9001', malformed.found === false, malformed);

    const malformed2 = await lookupTransaction(ctx, { transaction_id: 'TXN-ABCD' });
    check('rejects malformed TXN-ABCD', malformed2.found === false, malformed2);

    const missing = await lookupTransaction(ctx, { transaction_id: 'TXN-0000' });
    check('unknown reference returns found:false', missing.found === false, missing);
  });

  await section('lookup_payout', async () => {
    const byId = await lookupPayout(ctx, { payout_id: 'PAY-7002' });
    check('finds PAY-7002', byId.found === true && 'status' in byId && byId.status === 'review required', byId);
    check('PAY-7002 flags escalation', byId.found === true && byId.requires_escalation === true, byId);

    const byTxn = await lookupPayout(ctx, { transaction_id: 'TXN-9004' });
    check('finds payout via TXN-9004', byTxn.found === true && 'payout_id' in byTxn && byTxn.payout_id === 'PAY-7003', byTxn);
    check('failed payout carries a customer-safe reason', byTxn.found === true && Boolean(byTxn.failure_reason), byTxn);

    const noArgs = await lookupPayout(ctx, {});
    check('rejects empty input', noArgs.found === false, noArgs);
  });

  await section('search_knowledge_base', async () => {
    const fees = await searchKnowledgeBase(ctx, { query: 'What fees does RelayPay charge for international payments?', conversation_id: conversationId });
    check('retrieves fee guidance (scenario 1)', fees.found === true && fees.chunks.length > 0, { mode: fees.retrieval_mode, n: fees.chunks.length });
    check('fee chunk mentions corridor', fees.found === true && fees.chunks.some((c) => /corridor/i.test(c.content)), fees.chunks.map((c) => c.title));

    const timelines = await searchKnowledgeBase(ctx, { query: 'can you guarantee my payout arrives tomorrow morning', conversation_id: conversationId });
    check('retrieves no-guarantee policy (scenario 8)', timelines.found === true, timelines.chunks?.map((c) => c.title));

    const nonsense = await searchKnowledgeBase(ctx, { query: 'zzzz qqqq xyzzy plugh frobnicate', conversation_id: conversationId });
    check('irrelevant query returns found:false', nonsense.found === false, nonsense);
    check('found:false carries a reason the agent can act on', nonsense.found === false && Boolean(nonsense.reason), nonsense);
  });

  await section('create_support_ticket', async () => {
    const first = await createSupportTicket(ctx, {
      conversation_id: conversationId,
      category: 'invoice',
      priority: 'normal',
      summary: 'Invoice payment failed and needs review.',
      customer_id: 'CUS-1002'
    });
    check('creates a ticket', Boolean(first.ticket_id), first);

    const second = await createSupportTicket(ctx, {
      conversation_id: conversationId,
      category: 'invoice',
      priority: 'normal',
      summary: 'Duplicate request for the same issue.',
      customer_id: 'CUS-1002'
    });
    check('deduplicates within the conversation', second.ticket_id === first.ticket_id, { first: first.ticket_id, second: second.ticket_id });

    const bad = await createSupportTicket(ctx, { conversation_id: conversationId, category: 'x', priority: 'catastrophic', summary: 's' });
    check('rejects an invalid priority', bad.ticket_id === '', bad);
  });

  await section('create_escalation', async () => {
    const esc = await createEscalation(ctx, {
      conversation_id: conversationId,
      user_name: 'Efua Mensah',
      user_email: 'efua@accrastack.example',
      category: 'compliance',
      reason: 'Account restricted, caller needs a specialist.',
      customer_id: 'CUS-1003'
    });
    check('creates an escalation', Boolean(esc.escalation_id), esc);
    check('returns a follow-up summary written by the tool', Boolean(esc.follow_up_summary), esc.follow_up_summary);
    check(
      'follow-up promises no timeline',
      !/\b(\d+\s*(hour|day|business day)|24|48)\b/i.test(esc.follow_up_summary),
      esc.follow_up_summary
    );

    const dupe = await createEscalation(ctx, {
      conversation_id: conversationId,
      user_name: 'Efua Mensah',
      user_email: 'efua@accrastack.example',
      category: 'compliance',
      reason: 'Asked again in the same call.'
    });
    check('deduplicates per conversation+category', dupe.escalation_id === esc.escalation_id, { first: esc.escalation_id, second: dupe.escalation_id });

    const badEmail = await createEscalation(ctx, {
      conversation_id: conversationId,
      user_name: 'Test',
      user_email: 'not-an-email',
      category: 'account',
      reason: 'test'
    });
    check('rejects a malformed email', badEmail.escalation_id === '', badEmail);
  });

  await section('log_conversation_event', async () => {
    const ok = await logConversationEvent(ctx, {
      conversation_id: conversationId,
      event_type: 'escalation_triggered',
      summary: 'Escalated to compliance after account restriction was reported.'
    });
    check('logs an event', ok.logged === true, ok);

    const lazy = await logConversationEvent(ctx, {
      conversation_id: `smoke-lazy-${randomUUID().slice(0, 6)}`,
      event_type: 'declined',
      summary: 'Conversation row did not exist yet; must be created lazily.'
    });
    check('creates the conversation row lazily', lazy.logged === true, lazy);

    const bad = await logConversationEvent(ctx, { conversation_id: '', event_type: '', summary: '' });
    check('rejects empty input', bad.logged === false, bad);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(`\nSmoke test crashed: ${e instanceof Error ? e.stack : e}`);
  process.exitCode = 1;
});
