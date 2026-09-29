-- ============================================================
-- 0003_embeddings.sql
-- Optional embedding path for knowledge-base retrieval.
--
-- This is split from 0002 deliberately: if the `vector` extension is
-- unavailable on the target project, 0002 still applies and the system
-- runs on the lexical (full-text) fallback path with no code changes.
--
-- Dimension note: 1024 matches voyage-3 / voyage-3-lite. If you switch
-- to OpenAI text-embedding-3-small (1536), change the dimension here and
-- re-run; the retrieval code reads the dimension from config, it does
-- not assume 1024.
-- ============================================================

create extension if not exists vector;

alter table public.knowledge_chunks
  add column if not exists embedding vector(1024);

alter table public.knowledge_chunks
  add column if not exists embedding_model text;

-- IVFFlat needs data present to build a good index. Creating it on an
-- empty table is valid but the index is rebuilt after seeding by
-- `npm run seed`, which runs REINDEX once chunks exist.
create index if not exists knowledge_chunks_embedding_idx
  on public.knowledge_chunks
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- ============================================================
-- match_knowledge_chunks — cosine similarity search RPC
--
-- SECURITY INVOKER (the default) on purpose: this runs as whoever calls
-- it. Only the service role calls it, from server-side code. It is NOT
-- exposed to the anon role because RLS on knowledge_chunks denies all
-- access by default and there is no permissive policy.
-- ============================================================
create or replace function public.match_knowledge_chunks(
  query_embedding vector(1024),
  match_count     int default 5,
  min_score       float default 0.0
)
returns table (
  id           text,
  title        text,
  section_path text,
  content      text,
  summary      text,
  score        float
)
language sql
stable
as $$
  select
    kc.id,
    kc.title,
    kc.section_path,
    kc.content,
    kc.summary,
    1 - (kc.embedding <=> query_embedding) as score
  from public.knowledge_chunks kc
  where kc.embedding is not null
    and 1 - (kc.embedding <=> query_embedding) >= min_score
  order by kc.embedding <=> query_embedding
  limit greatest(1, least(match_count, 20));
$$;
