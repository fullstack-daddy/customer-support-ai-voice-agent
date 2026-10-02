-- ============================================================
-- 0004_admin_and_email.sql
--
-- Three additions:
--   1. Ticket email drafts — composed when a ticket is created, edited
--      and approved by an admin, only then sent. Nothing leaves the
--      system without a human pressing the button.
--   2. Contact capture — what the agent HEARD for a caller's name and
--      email, held separately from what the human CONFIRMED. Speech
--      recognition mangles both constantly; writing the heard value
--      straight into a ticket is how you email a stranger.
--   3. Admin audit — who approved what, and when.
--
-- Idempotent.
-- ============================================================

create extension if not exists "pgcrypto";

-- ============================================================
-- Ticket email lifecycle
-- ============================================================
-- draft     — composed, not reviewed
-- approved  — admin reviewed and authorised sending
-- sending   — handed to the provider
-- sent      — provider accepted it
-- failed    — provider rejected it; error_message says why
-- cancelled — admin decided not to send
alter table public.support_tickets add column if not exists email_to          text;
alter table public.support_tickets add column if not exists email_subject     text;
alter table public.support_tickets add column if not exists email_body        text;
alter table public.support_tickets add column if not exists email_status      text not null default 'draft';
alter table public.support_tickets add column if not exists email_error       text;
alter table public.support_tickets add column if not exists email_approved_by text;
alter table public.support_tickets add column if not exists email_approved_at timestamptz;
alter table public.support_tickets add column if not exists email_sent_at     timestamptz;
alter table public.support_tickets add column if not exists email_provider_id text;
alter table public.support_tickets add column if not exists contact_name      text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'support_tickets_email_status_check'
  ) then
    alter table public.support_tickets
      add constraint support_tickets_email_status_check
      check (email_status in ('draft','approved','sending','sent','failed','cancelled'));
  end if;
end $$;

create index if not exists support_tickets_email_status_idx on public.support_tickets (email_status);
create index if not exists support_tickets_created_idx      on public.support_tickets (created_at desc);

-- Escalations get the same treatment: they also produce a follow-up the
-- customer should receive, and it should go through the same review gate.
alter table public.escalations add column if not exists email_to          text;
alter table public.escalations add column if not exists email_subject     text;
alter table public.escalations add column if not exists email_body        text;
alter table public.escalations add column if not exists email_status      text not null default 'draft';
alter table public.escalations add column if not exists email_error       text;
alter table public.escalations add column if not exists email_approved_by text;
alter table public.escalations add column if not exists email_approved_at timestamptz;
alter table public.escalations add column if not exists email_sent_at     timestamptz;
alter table public.escalations add column if not exists email_provider_id text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'escalations_email_status_check'
  ) then
    alter table public.escalations
      add constraint escalations_email_status_check
      check (email_status in ('draft','approved','sending','sent','failed','cancelled'));
  end if;
end $$;

create index if not exists escalations_email_status_idx on public.escalations (email_status);

-- ============================================================
-- contact_captures
--
-- What the agent heard, versus what the caller confirmed.
--
-- These are deliberately separate columns. STT routinely turns
-- "efua@accrastack.example" into "effu at accra stack example" and
-- "Mensah" into "Mensa". Treating the heard value as truth is how a
-- ticket gets emailed to the wrong address — or to nobody.
--
-- The caller sees the heard value in an editable field during the call
-- and corrects it. Only `confirmed_*` is ever used for sending.
-- ============================================================
create table if not exists public.contact_captures (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text not null references public.conversations(conversation_id) on delete cascade,
  -- What speech recognition produced.
  heard_name       text,
  heard_email      text,
  -- What the human corrected it to. Null until they confirm.
  confirmed_name   text,
  confirmed_email  text,
  -- pending   — shown to the caller, awaiting confirmation
  -- confirmed — caller accepted or corrected it
  -- skipped   — caller declined to give details
  status           text not null default 'pending'
                   check (status in ('pending','confirmed','skipped')),
  -- What the agent wanted the details FOR, so the UI can explain itself:
  -- 'ticket' | 'callback' | 'escalation'
  purpose          text,
  created_at       timestamptz not null default now(),
  confirmed_at     timestamptz,
  updated_at       timestamptz not null default now()
);
create index if not exists contact_captures_conv_idx   on public.contact_captures (conversation_id, created_at desc);
create index if not exists contact_captures_status_idx on public.contact_captures (status);

drop trigger if exists contact_captures_set_updated_at on public.contact_captures;
create trigger contact_captures_set_updated_at
  before update on public.contact_captures
  for each row execute function public.set_updated_at();

alter table public.contact_captures enable row level security;

-- ============================================================
-- admin_audit — who did what in the console
--
-- Approving an outbound email is a real action with a real consequence.
-- It gets an audit row.
-- ============================================================
create table if not exists public.admin_audit (
  id           uuid primary key default gen_random_uuid(),
  actor        text not null,
  action       text not null,
  target_type  text,
  target_id    text,
  detail       jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
create index if not exists admin_audit_target_idx  on public.admin_audit (target_type, target_id);

alter table public.admin_audit enable row level security;
