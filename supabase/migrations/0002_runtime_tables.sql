-- ============================================================
-- 0002_runtime_tables.sql
-- Tables written at runtime by the agent / MCP server: the full audit
-- trail a reviewer needs to reconstruct any call.
--
-- Ordering note: this migration is 0002 because 0001 creates the seed
-- tables (customers / transactions / payouts) that `conversations` and
-- the ticket/escalation tables reference. 0001 is authored once the
-- field lists from assets/supabase-schema-and-seed-data.md are available.
--
-- Idempotent: safe to re-run.
-- ============================================================

create extension if not exists "pgcrypto";

-- Shared updated_at trigger function.
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
-- conversations — one row per call (voice or text-eval)
-- ============================================================
create table if not exists public.conversations (
  conversation_id    text primary key,
  channel            text not null default 'web_voice'
                     check (channel in ('web_voice', 'phone', 'text_eval')),
  -- Nullable on purpose: we never force a caller to identify themselves.
  caller_identifier  text,
  customer_id        text,
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  final_status       text
                     check (final_status in ('resolved', 'escalated', 'abandoned', 'declined')),
  summary            text,
  -- Catch-all: token/cost totals, vapi call id, model used, etc.
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists conversations_started_at_idx  on public.conversations (started_at desc);
create index if not exists conversations_final_status_idx on public.conversations (final_status);
create index if not exists conversations_customer_idx     on public.conversations (customer_id);

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ============================================================
-- conversation_turns — every turn, unconditionally
-- Written by the orchestration code, not by a model tool call, so a
-- model that forgets to log cannot create a gap in the transcript.
-- ============================================================
create table if not exists public.conversation_turns (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  text not null references public.conversations(conversation_id) on delete cascade,
  turn_index       int not null,
  role             text not null check (role in ('user', 'assistant', 'system')),
  transcript       text,
  response         text,
  answer_type      text
                   check (answer_type in ('direct_answer', 'clarifying_question', 'escalation', 'decline', 'tool_result')),
  confidence_note  text,
  created_at       timestamptz not null default now(),
  unique (conversation_id, turn_index)
);
create index if not exists conversation_turns_conv_idx on public.conversation_turns (conversation_id, turn_index);

-- ============================================================
-- retrieval_logs — one row per search_knowledge_base call
-- Written by the tool itself so retrieval is always recorded.
-- ============================================================
create table if not exists public.retrieval_logs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id text references public.conversations(conversation_id) on delete cascade,
  query           text not null,
  -- Array of {chunk_id, title, score, snippet} actually returned.
  chunks_used     jsonb not null default '[]'::jsonb,
  source_title    text,
  source_summary  text,
  result_count    int not null default 0,
  -- True only when the retrieved chunk actually informed the reply. Lets a
  -- reviewer catch retrieval that ran but was ignored by the model.
  used_in_answer  boolean not null default false,
  -- 'embedding' when pgvector similarity ran, 'lexical' when we fell back
  -- to Postgres full-text search, 'none' when retrieval was skipped.
  retrieval_mode  text not null default 'lexical'
                  check (retrieval_mode in ('embedding', 'lexical', 'none')),
  latency_ms      int,
  created_at      timestamptz not null default now()
);
create index if not exists retrieval_logs_conv_idx on public.retrieval_logs (conversation_id, created_at);
create index if not exists retrieval_logs_mode_idx on public.retrieval_logs (retrieval_mode);

-- ============================================================
-- tool_calls — one row per MCP tool invocation (success OR failure)
-- ============================================================
create table if not exists public.tool_calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id text references public.conversations(conversation_id) on delete cascade,
  tool_name       text not null,
  purpose         text,
  -- Human-readable SUMMARY, never the raw sensitive input verbatim.
  input_summary   text,
  result_summary  text,
  status          text not null default 'success'
                  check (status in ('success', 'not_found', 'error')),
  error_message   text,
  latency_ms      int,
  created_at      timestamptz not null default now()
);
create index if not exists tool_calls_conv_idx on public.tool_calls (conversation_id, created_at);
create index if not exists tool_calls_name_idx on public.tool_calls (tool_name);
create index if not exists tool_calls_status_idx on public.tool_calls (status);

-- ============================================================
-- support_tickets
-- ============================================================
create table if not exists public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  ticket_id       text not null unique,
  conversation_id text not null references public.conversations(conversation_id) on delete cascade,
  customer_id     text,
  category        text not null,
  priority        text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  summary         text not null,
  status          text not null default 'open'
                  check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists support_tickets_conv_idx     on public.support_tickets (conversation_id);
create index if not exists support_tickets_status_idx   on public.support_tickets (status);
create index if not exists support_tickets_customer_idx on public.support_tickets (customer_id);
-- Dedupe guard: at most one OPEN ticket per (conversation, category).
create unique index if not exists support_tickets_dedupe_idx
  on public.support_tickets (conversation_id, category)
  where status = 'open';

drop trigger if exists support_tickets_set_updated_at on public.support_tickets;
create trigger support_tickets_set_updated_at
  before update on public.support_tickets
  for each row execute function public.set_updated_at();

-- ============================================================
-- escalations
-- ============================================================
create table if not exists public.escalations (
  id                 uuid primary key default gen_random_uuid(),
  escalation_id      text not null unique,
  conversation_id    text not null references public.conversations(conversation_id) on delete cascade,
  customer_id        text,
  user_name          text not null,
  user_email         text not null,
  category           text not null
                     check (category in ('compliance', 'account', 'dispute', 'payment', 'other')),
  reason             text not null,
  preferred_time     text,
  call_booked        boolean not null default false,
  follow_up_summary  text,
  status             text not null default 'open'
                     check (status in ('open', 'scheduled', 'contacted', 'closed')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists escalations_conv_idx     on public.escalations (conversation_id);
create index if not exists escalations_status_idx   on public.escalations (status);
create index if not exists escalations_category_idx on public.escalations (category);
-- Dedupe guard: one escalation per (conversation, category).
create unique index if not exists escalations_dedupe_idx
  on public.escalations (conversation_id, category);

drop trigger if exists escalations_set_updated_at on public.escalations;
create trigger escalations_set_updated_at
  before update on public.escalations
  for each row execute function public.set_updated_at();

-- ============================================================
-- evaluations — one row per scenario run by scripts/eval
-- ============================================================
create table if not exists public.evaluations (
  id                   uuid primary key default gen_random_uuid(),
  scenario_id          text not null,
  scenario_description text,
  expected_behavior    text,
  actual_behavior      text,
  pass                 boolean not null default false,
  notes                text,
  conversation_id      text references public.conversations(conversation_id) on delete set null,
  run_at               timestamptz not null default now()
);
create index if not exists evaluations_scenario_idx on public.evaluations (scenario_id, run_at desc);
create index if not exists evaluations_pass_idx     on public.evaluations (pass);

-- ============================================================
-- knowledge_chunks — chunked knowledge base for retrieval
-- The `embedding` column is added separately in 0003 so this migration
-- still applies cleanly on a project without the `vector` extension.
-- ============================================================
create table if not exists public.knowledge_chunks (
  id            text primary key,
  title         text not null,
  section_path  text,
  content       text not null,
  summary       text,
  -- Generated tsvector powering the lexical fallback search path.
  search_tsv    tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                  setweight(to_tsvector('english', coalesce(content, '')), 'B')
                ) stored,
  updated_at    timestamptz not null default now()
);
create index if not exists knowledge_chunks_tsv_idx on public.knowledge_chunks using gin (search_tsv);

drop trigger if exists knowledge_chunks_set_updated_at on public.knowledge_chunks;
create trigger knowledge_chunks_set_updated_at
  before update on public.knowledge_chunks
  for each row execute function public.set_updated_at();

-- ============================================================
-- Row Level Security
--
-- Every table is RLS-enabled with NO permissive policies. The only
-- database access in this system is server-side using the service_role
-- key, which bypasses RLS by design. The browser never talks to Supabase
-- directly — the internal review dashboard goes through our own
-- authenticated Next.js API routes.
--
-- Consequence: if the anon key is ever used from a client, it gets
-- nothing. That is the intended default-deny posture. Do not add a
-- `USING (true)` policy here without documenting why in this file.
-- ============================================================
alter table public.conversations      enable row level security;
alter table public.conversation_turns enable row level security;
alter table public.retrieval_logs     enable row level security;
alter table public.tool_calls         enable row level security;
alter table public.support_tickets    enable row level security;
alter table public.escalations        enable row level security;
alter table public.evaluations        enable row level security;
alter table public.knowledge_chunks   enable row level security;
