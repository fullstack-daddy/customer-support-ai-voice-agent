-- ============================================================
-- 0001_seed_tables.sql
-- The three provided seed tables: customers, transactions, payouts.
--
-- Field lists come from assets/supabase-schema-and-seed-data.md.
-- CHECK constraint values are the EXACT strings present in
-- assets/seed-data/*.csv, plus the extra states the schema guide and
-- knowledge base imply (e.g. payout 'scheduled' and 'completed', which
-- the guide lists but the sample rows don't exercise).
--
-- Deliberately absent: `balance`. The knowledge base states that
-- automated and voice-based systems have no access to account balances.
-- Enforcing that structurally (the column does not exist) is stronger
-- than enforcing it with a prompt instruction the model could be talked
-- out of.
--
-- Idempotent: safe to re-run.
-- ============================================================

create extension if not exists "pgcrypto";

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- customers
-- ============================================================
create table if not exists public.customers (
  customer_id     text primary key,
  company_name    text not null,
  contact_name    text,
  contact_email   text,
  plan            text not null
                  check (plan in ('Starter', 'Growth', 'Scale')),
  account_status  text not null
                  check (account_status in ('active', 'restricted', 'pending verification')),
  region          text,
  kyc_status      text not null
                  check (kyc_status in ('pending', 'approved', 'review required')),
  -- INTERNAL ONLY. Contains routing instructions for the agent, e.g.
  -- "Escalate account-specific questions." The MCP layer surfaces this
  -- as `internal_flag`, never as speakable customer-facing text.
  support_notes   text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists customers_company_name_idx on public.customers (lower(company_name));
create index if not exists customers_email_idx        on public.customers (lower(contact_email));
create index if not exists customers_status_idx       on public.customers (account_status);

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

-- ============================================================
-- transactions
-- ============================================================
create table if not exists public.transactions (
  transaction_id      text primary key,
  customer_id         text not null references public.customers(customer_id) on delete cascade,
  transaction_type    text not null
                      check (transaction_type in ('incoming transfer', 'outgoing payout', 'invoice payment')),
  amount              numeric(14, 2) not null,
  currency            text not null,
  destination_country text,
  status              text not null
                      check (status in ('processing', 'completed', 'delayed', 'failed', 'review required')),
  -- Business timestamp from the seed file (date the transaction was raised),
  -- distinct from row_created_at which is when we loaded it.
  created_at          date,
  estimated_arrival   date,
  -- Customer-safe status summary. This IS speakable — it is written to be.
  support_summary     text,
  row_created_at      timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists transactions_customer_idx on public.transactions (customer_id);
create index if not exists transactions_status_idx   on public.transactions (status);

drop trigger if exists transactions_set_updated_at on public.transactions;
create trigger transactions_set_updated_at
  before update on public.transactions
  for each row execute function public.set_updated_at();

-- ============================================================
-- payouts
-- ============================================================
create table if not exists public.payouts (
  payout_id       text primary key,
  transaction_id  text references public.transactions(transaction_id) on delete cascade,
  customer_id     text references public.customers(customer_id) on delete cascade,
  recipient_name  text,
  amount          numeric(14, 2) not null,
  currency        text not null,
  status          text not null
                  check (status in ('scheduled', 'processing', 'completed', 'failed', 'review required')),
  scheduled_for   date,
  -- Customer-safe reason if failed. Speakable.
  failure_reason  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists payouts_transaction_idx on public.payouts (transaction_id);
create index if not exists payouts_customer_idx    on public.payouts (customer_id);
create index if not exists payouts_status_idx      on public.payouts (status);

drop trigger if exists payouts_set_updated_at on public.payouts;
create trigger payouts_set_updated_at
  before update on public.payouts
  for each row execute function public.set_updated_at();

-- ============================================================
-- RLS: default-deny on the seed tables too.
--
-- Same posture as the runtime tables. All reads go through the MCP
-- server using the service-role key from a server process. The browser
-- never queries these tables directly, so there is no permissive policy
-- to write. An anon-key client gets nothing, which is correct.
-- ============================================================
alter table public.customers    enable row level security;
alter table public.transactions enable row level security;
alter table public.payouts      enable row level security;
