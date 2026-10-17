-- Managers create Stripe Checkout sessions with their own login (InsForge
-- requires a user token). Allow them to create and read only their own.

alter table payments.stripe_checkout_sessions enable row level security;

create policy "managers create their checkout sessions"
on payments.stripe_checkout_sessions
for insert
to authenticated
with check (
  subject_type = 'user'
  and subject_id = auth.uid()::text
  and exists (select 1 from public.managers m where m.user_id = auth.uid())
);

create policy "managers read their checkout sessions"
on payments.stripe_checkout_sessions
for select
to authenticated
using (subject_type = 'user' and subject_id = auth.uid()::text);
