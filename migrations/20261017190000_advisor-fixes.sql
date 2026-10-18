-- Fixes from `insforge advisor scan`.

-- 1) is_manager() does not need SECURITY DEFINER: managers_read_self already
--    lets a user see their own row, which is all this check reads.
create or replace function public.is_manager()
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (select 1 from public.managers m where m.user_id = (select auth.uid()));
$$;

-- 2) Evaluate auth.uid() once per query instead of once per row.
drop policy if exists managers_read_self on public.managers;
create policy managers_read_self on public.managers
  for select to authenticated using (user_id = (select auth.uid()));

-- 3) Index foreign keys used in joins and cascading deletes.
create index if not exists payments_incident_idx      on public.payments (incident_id);
create index if not exists approvals_incident_idx     on public.approvals (incident_id);
create index if not exists approvals_approver_idx     on public.approvals (approver_id);
create index if not exists outreach_technician_idx    on public.outreach (technician_id);
create index if not exists quotes_technician_idx      on public.quotes (technician_id);
