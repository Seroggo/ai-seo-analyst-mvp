-- ============================================================
-- Migration: 20260704120000_enable_rls_on_topvisor_scope_cache
-- Description: Enable RLS on the scope cache table.
--
-- This cache table stores internal JSON payloads fetched from
-- TopVisor and must not have public policies. Access should be
-- controlled through Edge Functions or backend-only channels.
-- ============================================================

alter table public.topvisor_scope_cache enable row level security;