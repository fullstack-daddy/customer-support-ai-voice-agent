// Lookup tools: customer, transaction, payout.
//
// Shared discipline across all three:
//   - Input validated with Zod BEFORE any database access. A malformed
//     reference like `txn9001` or `TXN-ABCD` is rejected with a readable
//     message, never coerced or used to query.
//   - Financial references (transaction_id, payout_id) are matched
//     EXACTLY. No fuzzy matching, no partial matching, no "did you mean".
//     Guessing which payment a caller meant is precisely the failure the
//     PRD warns against.
//   - No raw database row is ever returned. Each tool maps explicitly to
//     the output shape, so the set of fields that can reach the model —
//     and therefore be spoken — is controlled here, in code.

import { supabaseAdmin, withTimeout, requiresEscalation } from '@relaypay/shared';
import {
  LookupCustomerInput, LookupTransactionInput, LookupPayoutInput,
  type LookupCustomerOutput, type LookupTransactionOutput, type LookupPayoutOutput
} from '@relaypay/shared';
import { instrumented, formatZodError, type ToolContext } from '../instrument.js';

// ---------------------------------------------------------------
// lookup_customer
// ---------------------------------------------------------------
export async function lookupCustomer(ctx: ToolContext, raw: unknown): Promise<LookupCustomerOutput> {
  return instrumented<LookupCustomerOutput>(
    ctx,
    'lookup_customer',
    'Find a customer record from safe identifying information',
    (raw ?? {}) as Record<string, unknown>,
    async () => {
      const parsed = LookupCustomerInput.safeParse(raw);
      if (!parsed.success) {
        return {
          payload: { found: false as const, reason: formatZodError(parsed.error.issues) },
          status: 'error' as const,
          resultSummary: 'invalid input'
        };
      }
      const { customer_id, email, company_name } = parsed.data;
      const db = supabaseAdmin();

      // Precedence: exact id > exact email > fuzzy company name. The most
      // precise identifier the caller gave us wins.
      let query = db
        .from('customers')
        .select('customer_id, company_name, plan, account_status, kyc_status, support_notes');

      if (customer_id) {
        query = query.eq('customer_id', customer_id.trim().toUpperCase());
      } else if (email) {
        query = query.ilike('contact_email', email.trim());
      } else {
        // Fuzzy only on company name, and only to build a disambiguation
        // list — never to auto-select a single "best" match.
        query = query.ilike('company_name', `%${(company_name ?? '').trim()}%`);
      }

      const res = await withTimeout('lookup_customer', () => query.limit(10));
      if (!res.ok) throw new Error(res.error);

      const rows = (res.data.data ?? []) as Array<{
        customer_id: string; company_name: string; plan: string;
        account_status: string; kyc_status: string; support_notes: string | null;
      }>;

      if (!rows.length) {
        return {
          payload: { found: false as const, reason: 'No customer matched the details provided.' },
          status: 'not_found' as const,
          resultSummary: 'no match'
        };
      }

      // More than one company-name match: hand back a safe disambiguation
      // list. Company name + id only — nothing sensitive, and enough for
      // the agent to ask "which of these is you?".
      if (rows.length > 1) {
        return {
          payload: {
            found: true as const,
            multiple_matches: true as const,
            candidates: rows.map((r) => ({ customer_id: r.customer_id, company_name: r.company_name }))
          },
          status: 'success' as const,
          resultSummary: `${rows.length} candidates returned for disambiguation`
        };
      }

      const c = rows[0]!;
      return {
        payload: {
          found: true as const,
          multiple_matches: false as const,
          customer_id: c.customer_id,
          company_name: c.company_name,
          plan: c.plan,
          account_status: c.account_status,
          kyc_status: c.kyc_status,
          // Renamed from `support_notes`. Routing signal only — the system
          // prompt forbids voicing or paraphrasing it.
          internal_flag: c.support_notes,
          requires_escalation: requiresEscalation(c)
        },
        status: 'success' as const,
        resultSummary: `matched ${c.customer_id} (${c.account_status}/${c.kyc_status})`
      };
    },
    (message) => ({ found: false as const, reason: `Lookup unavailable: ${message}` })
  );
}

// ---------------------------------------------------------------
// lookup_transaction — exact match only
// ---------------------------------------------------------------
export async function lookupTransaction(ctx: ToolContext, raw: unknown): Promise<LookupTransactionOutput> {
  return instrumented<LookupTransactionOutput>(
    ctx,
    'lookup_transaction',
    'Look up a transaction by exact reference',
    (raw ?? {}) as Record<string, unknown>,
    async () => {
      const parsed = LookupTransactionInput.safeParse(raw);
      if (!parsed.success) {
        return {
          payload: {
            found: false as const,
            // Phrased for the agent to relay: it explains the shape without
            // implying we searched and failed.
            reason: "That does not look like a valid transaction reference. RelayPay references look like TXN-9001."
          },
          status: 'error' as const,
          resultSummary: 'malformed transaction_id rejected before query'
        };
      }
      const id = parsed.data.transaction_id.trim().toUpperCase();
      const db = supabaseAdmin();

      const res = await withTimeout('lookup_transaction', () =>
        db
          .from('transactions')
          .select('transaction_id, customer_id, transaction_type, amount, currency, status, estimated_arrival, support_summary')
          .eq('transaction_id', id)
          .maybeSingle()
      );
      if (!res.ok) throw new Error(res.error);

      const t = res.data.data as {
        transaction_id: string; customer_id: string; transaction_type: string;
        amount: number; currency: string; status: string;
        estimated_arrival: string | null; support_summary: string | null;
      } | null;

      if (!t) {
        return {
          payload: { found: false as const, reason: `No transaction found with reference ${id}.` },
          status: 'not_found' as const,
          resultSummary: `${id} not found`
        };
      }

      return {
        payload: {
          found: true as const,
          transaction_id: t.transaction_id,
          customer_id: t.customer_id,
          type: t.transaction_type,
          status: t.status,
          amount: String(t.amount),
          currency: t.currency,
          estimated_arrival: t.estimated_arrival,
          support_summary: t.support_summary,
          requires_escalation: requiresEscalation(t)
        },
        status: 'success' as const,
        resultSummary: `${t.transaction_id} status=${t.status}`
      };
    },
    (message) => ({ found: false as const, reason: `Lookup unavailable: ${message}` })
  );
}

// ---------------------------------------------------------------
// lookup_payout — exact match only, by payout id or transaction id
// ---------------------------------------------------------------
export async function lookupPayout(ctx: ToolContext, raw: unknown): Promise<LookupPayoutOutput> {
  return instrumented<LookupPayoutOutput>(
    ctx,
    'lookup_payout',
    'Look up a payout by exact payout or transaction reference',
    (raw ?? {}) as Record<string, unknown>,
    async () => {
      const parsed = LookupPayoutInput.safeParse(raw);
      if (!parsed.success) {
        return {
          payload: {
            found: false as const,
            reason: "That does not look like a valid payout reference. RelayPay payout references look like PAY-7001."
          },
          status: 'error' as const,
          resultSummary: 'malformed payout/transaction id rejected before query'
        };
      }
      const { payout_id, transaction_id } = parsed.data;
      const db = supabaseAdmin();

      let q = db
        .from('payouts')
        .select('payout_id, status, scheduled_for, failure_reason, transaction_id');
      q = payout_id
        ? q.eq('payout_id', payout_id.trim().toUpperCase())
        : q.eq('transaction_id', (transaction_id ?? '').trim().toUpperCase());

      const res = await withTimeout('lookup_payout', () => q.maybeSingle());
      if (!res.ok) throw new Error(res.error);

      const p = res.data.data as {
        payout_id: string; status: string; scheduled_for: string | null;
        failure_reason: string | null; transaction_id: string | null;
      } | null;

      if (!p) {
        const ref = payout_id ?? transaction_id ?? 'the reference provided';
        return {
          payload: { found: false as const, reason: `No payout found for ${ref}.` },
          status: 'not_found' as const,
          resultSummary: `${ref} not found`
        };
      }

      // Pull the linked transaction's customer-safe summary so the agent
      // has documented wording to use instead of composing its own.
      let supportSummary: string | null = null;
      if (p.transaction_id) {
        const txRes = await withTimeout('lookup_payout:tx summary', () =>
          db.from('transactions').select('support_summary').eq('transaction_id', p.transaction_id!).maybeSingle()
        );
        if (txRes.ok) {
          supportSummary = (txRes.data.data as { support_summary: string | null } | null)?.support_summary ?? null;
        }
      }

      return {
        payload: {
          found: true as const,
          payout_id: p.payout_id,
          status: p.status,
          scheduled_for: p.scheduled_for,
          failure_reason: p.failure_reason,
          support_summary: supportSummary,
          requires_escalation: requiresEscalation({ status: p.status })
        },
        status: 'success' as const,
        resultSummary: `${p.payout_id} status=${p.status}`
      };
    },
    (message) => ({ found: false as const, reason: `Lookup unavailable: ${message}` })
  );
}
