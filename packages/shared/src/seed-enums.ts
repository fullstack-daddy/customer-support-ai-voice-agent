// Enum values taken verbatim from assets/seed-data/*.csv and the field
// notes in assets/supabase-schema-and-seed-data.md. These mirror the SQL
// CHECK constraints in supabase/migrations/0001_seed_tables.sql — if you
// change one, change both.

export const PLANS = ['Starter', 'Growth', 'Scale'] as const;
export type Plan = (typeof PLANS)[number];

export const ACCOUNT_STATUSES = ['active', 'restricted', 'pending verification'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const KYC_STATUSES = ['pending', 'approved', 'review required'] as const;
export type KycStatus = (typeof KYC_STATUSES)[number];

export const TRANSACTION_TYPES = ['incoming transfer', 'outgoing payout', 'invoice payment'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_STATUSES = ['processing', 'completed', 'delayed', 'failed', 'review required'] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const PAYOUT_STATUSES = ['scheduled', 'processing', 'completed', 'failed', 'review required'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

/**
 * Account/transaction/payout states that mean "a human must handle this".
 * The agent consults these rather than pattern-matching on strings, so the
 * escalation trigger is one edit away from being tightened.
 *
 * Grounded in escalation-rules.md ("Reports an account restriction or
 * suspension", "Raises compliance or identity verification concerns").
 */
export const ESCALATION_TRIGGER_ACCOUNT_STATUSES: readonly AccountStatus[] = ['restricted'];
export const ESCALATION_TRIGGER_KYC_STATUSES: readonly KycStatus[] = ['review required'];
export const ESCALATION_TRIGGER_TRANSACTION_STATUSES: readonly TransactionStatus[] = ['review required'];
export const ESCALATION_TRIGGER_PAYOUT_STATUSES: readonly PayoutStatus[] = ['review required'];

/** True when a looked-up record is in a state the agent must escalate on. */
export function requiresEscalation(record: {
  account_status?: string;
  kyc_status?: string;
  status?: string;
}): boolean {
  return (
    (ESCALATION_TRIGGER_ACCOUNT_STATUSES as readonly string[]).includes(record.account_status ?? '') ||
    (ESCALATION_TRIGGER_KYC_STATUSES as readonly string[]).includes(record.kyc_status ?? '') ||
    (ESCALATION_TRIGGER_TRANSACTION_STATUSES as readonly string[]).includes(record.status ?? '')
  );
}
