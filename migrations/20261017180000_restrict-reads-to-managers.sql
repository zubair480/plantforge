-- Anyone can sign in on the approval page with an email code, so "signed in"
-- must not mean "can read every incident, quote, payment and contractor email".
-- Reads are now limited to users listed in public.managers. Edge functions use
-- the server key and are unaffected.

create or replace function public.is_manager()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.managers m where m.user_id = auth.uid());
$$;

revoke all on function public.is_manager() from public, anon;
grant execute on function public.is_manager() to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['assets','technicians','incidents','incident_events','outreach',
                           'quotes','approvals','payments','evidence','readings']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read_authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_manager())',
      t || '_read_managers', t);
  end loop;
end $$;
