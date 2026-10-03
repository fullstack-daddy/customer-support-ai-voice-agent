-- ============================================================
-- DESTRUCTIVE RESET — read this before running it.
--
-- Drops EVERY table, view, materialised view, sequence and
-- function in the `public` schema of whichever project you run
-- it against. There is no undo and Supabase does not keep a
-- copy. Confirm you are in the right project first:
--     Supabase dashboard -> top-left project switcher.
--
-- This exists because the RelayPay project shared a database
-- with an earlier project whose tables (leads, runs, users,
-- tool_calls, metrics, insights, breakdowns, report_*,
-- cleaned_records) collided with this one — `tool_calls` is
-- defined by both.
--
-- Extensions are deliberately left installed: 0002/0003 need
-- pgcrypto and vector, and dropping them would also drop the
-- vector type the knowledge base depends on.
--
-- Run this ONCE, then run the migrations in order:
--     0001_seed_tables.sql
--     0002_runtime_tables.sql
--     0003_embeddings.sql
--     0004_admin_and_email.sql
-- then `npm run seed` from the repo root.
-- ============================================================

do $$
declare
  r record;
begin
  -- Views first, so dropping tables underneath them is quiet.
  for r in
    select table_name from information_schema.views
    where table_schema = 'public'
  loop
    execute format('drop view if exists public.%I cascade', r.table_name);
  end loop;

  for r in
    select matviewname from pg_matviews where schemaname = 'public'
  loop
    execute format('drop materialized view if exists public.%I cascade', r.matviewname);
  end loop;

  for r in
    select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('drop table if exists public.%I cascade', r.tablename);
  end loop;

  -- Routines left behind by the previous project, e.g. rls_auto_enable.
  -- Skip anything owned by an extension: those belong to vector/pgcrypto
  -- and dropping them would break the extension.
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and not exists (
        select 1 from pg_depend d
        where d.objid = p.oid and d.deptype = 'e'
      )
  loop
    execute format('drop function if exists %s cascade', r.sig);
  end loop;

  for r in
    select sequence_name from information_schema.sequences
    where sequence_schema = 'public'
  loop
    execute format('drop sequence if exists public.%I cascade', r.sequence_name);
  end loop;
end $$;

-- Should return no rows.
select table_name from information_schema.tables where table_schema = 'public';
