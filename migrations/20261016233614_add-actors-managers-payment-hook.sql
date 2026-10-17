-- 1) Record who moved an incident (agent, manager, stripe, ...) in the timeline.
-- 2) Managers allowed to approve spend, with a per-approval limit.
-- 3) Mark payments and incidents paid from verified Stripe webhook events.

alter table public.incidents
  add column last_actor text not null default 'system',
  add column last_note  text;

create or replace function public.incidents_guard_status()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'DETECTED' then
      raise exception 'new incidents must start in DETECTED (got %)', new.status;
    end if;
    insert into public.incident_events (incident_id, from_status, to_status, actor, detail)
    values (new.id, null, 'DETECTED', coalesce(nullif(new.last_actor, 'system'), 'ignition'),
            coalesce(new.last_note, new.alarm_message));
    return new;
  end if;

  new.updated_at := now();
  if new.status is distinct from old.status then
    if not public.incident_transition_allowed(old.status, new.status) then
      raise exception 'illegal incident transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'VERIFIED' then
      new.verified_at := now();
    end if;
    insert into public.incident_events (incident_id, from_status, to_status, actor, detail)
    values (new.id, old.status, new.status, new.last_actor, new.last_note);
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------

create table public.managers (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  display_name      text,
  spend_limit_cents integer not null default 50000 check (spend_limit_cents > 0),
  created_at        timestamptz not null default now()
);

alter table public.managers enable row level security;
revoke all on public.managers from anon;
revoke insert, update, delete on public.managers from authenticated;
grant select on public.managers to authenticated;
create policy managers_read_self on public.managers
  for select to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------

create or replace function public.fulfill_maintenance_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment_id text;
  p public.payments%rowtype;
  q_available timestamptz;
begin
  if new.provider <> 'stripe'
     or new.processing_status <> 'processed'
     or new.event_type not in ('checkout.session.completed', 'checkout.session.async_payment_succeeded') then
    return new;
  end if;

  v_payment_id := new.payload -> 'data' -> 'object' -> 'metadata' ->> 'payment_id';
  if v_payment_id is null then
    return new;  -- not one of ours
  end if;
  if coalesce(new.payload -> 'data' -> 'object' ->> 'payment_status', '') <> 'paid' then
    return new;
  end if;

  update public.payments
     set status = 'paid',
         paid_at = coalesce(new.processed_at, now()),
         stripe_payment_intent_id = coalesce(stripe_payment_intent_id,
                                     new.payload -> 'data' -> 'object' ->> 'payment_intent')
   where id::text = v_payment_id
     and status = 'pending'
  returning * into p;

  if p.id is null then
    return new;  -- already processed (idempotent)
  end if;

  update public.incidents
     set status = 'PAID', last_actor = 'stripe',
         last_note = format('Paid %s %s (checkout %s)', p.amount_cents / 100.0, upper(p.currency),
                            p.stripe_checkout_session_id)
   where id = p.incident_id and status = 'APPROVED';

  -- Booking follows payment: use the contractor's offered arrival time.
  select q.available_at into q_available
    from public.approvals a join public.quotes q on q.id = a.quote_id
   where a.id = p.approval_id;

  update public.incidents
     set status = 'SCHEDULED', scheduled_for = q_available, last_actor = 'system',
         last_note = 'Repair scheduled for ' || coalesce(q_available::text, 'time to be confirmed')
   where id = p.incident_id and status = 'PAID';

  return new;
end;
$$;

create trigger fulfill_maintenance_payment_from_webhook
  after insert or update on payments.webhook_events
  for each row execute function public.fulfill_maintenance_payment();
