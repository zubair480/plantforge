-- Maintenance incident backend: assets, incidents, technicians, quotes,
-- approvals, payments, evidence, plant readings, and an audit timeline.
-- All writes go through edge functions using the server key; signed-in
-- users (the manager page) can read.

-- ---------------------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------------------

create table public.assets (
  id            text primary key,                 -- e.g. 'PUMP-101'
  name          text not null,
  location      text not null,
  asset_type    text not null,                    -- 'centrifugal_pump'
  scada_tags    jsonb not null default '{}'::jsonb, -- {"flow":"[default]Pump101/Flow", ...}
  flow_min_lpm  numeric not null default 0,       -- healthy flow threshold for verification
  created_at    timestamptz not null default now()
);

create table public.technicians (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  company      text,
  email        text not null unique,
  trades       text[] not null default '{}',      -- {'mechanical','electrical'}
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Incidents and their state machine
-- ---------------------------------------------------------------------------

create sequence public.incident_number_seq start 101;

create table public.incidents (
  id                 text primary key default ('INC-' || nextval('public.incident_number_seq')),
  asset_id           text not null references public.assets(id),
  alarm_id           text not null,               -- Ignition alarm identifier
  severity           text not null default 'high' check (severity in ('low','medium','high','critical')),
  alarm_message      text,
  tag_snapshot       jsonb not null default '{}'::jsonb, -- small: {"flow":0,"run_cmd":true,"fault":true}
  status             text not null default 'DETECTED' check (status in (
                       'DETECTED','DIAGNOSED','QUOTES_REQUESTED','QUOTE_RECEIVED',
                       'APPROVAL_PENDING','APPROVED','PAID','SCHEDULED',
                       'REPAIR_REPORTED','VERIFYING','VERIFIED',
                       'VERIFICATION_FAILED','ESCALATED','CANCELLED')),
  diagnosis          text,
  recommended_trade  text,
  scheduled_for      timestamptz,
  detected_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  verified_at        timestamptz
);

-- Duplicate alarm events for the same open alarm must not create a second incident.
create unique index incidents_open_alarm_uniq
  on public.incidents (asset_id, alarm_id)
  where status not in ('VERIFIED','CANCELLED');

create index incidents_status_idx on public.incidents (status);

-- Append-only audit timeline (filled by trigger + edge functions).
create table public.incident_events (
  id           bigserial primary key,
  incident_id  text not null references public.incidents(id) on delete cascade,
  from_status  text,
  to_status    text,
  actor        text not null default 'system',   -- 'system','agent','manager','technician','ignition'
  detail       text,
  created_at   timestamptz not null default now()
);

create index incident_events_incident_idx on public.incident_events (incident_id, created_at);

-- Allowed status transitions. Anything else is rejected by the database itself,
-- so no client (including an over-eager agent) can skip approval or payment.
create or replace function public.incident_transition_allowed(from_s text, to_s text)
returns boolean
language sql
immutable
as $$
  select to_s = 'CANCELLED' or (from_s, to_s) in (
    ('DETECTED','DIAGNOSED'),
    ('DIAGNOSED','QUOTES_REQUESTED'),
    ('QUOTES_REQUESTED','QUOTE_RECEIVED'),
    ('QUOTE_RECEIVED','APPROVAL_PENDING'),
    ('QUOTE_RECEIVED','QUOTES_REQUESTED'),
    ('APPROVAL_PENDING','APPROVED'),
    ('APPROVAL_PENDING','QUOTE_RECEIVED'),       -- manager rejected the quote
    ('APPROVED','PAID'),
    ('PAID','SCHEDULED'),
    ('SCHEDULED','REPAIR_REPORTED'),
    ('REPAIR_REPORTED','VERIFYING'),
    ('VERIFYING','VERIFIED'),
    ('VERIFYING','VERIFICATION_FAILED'),
    ('VERIFICATION_FAILED','SCHEDULED'),
    ('ESCALATED','DIAGNOSED'),
    ('ESCALATED','QUOTES_REQUESTED')
  ) or (to_s = 'ESCALATED' and from_s not in ('VERIFIED','CANCELLED'));
$$;

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
    values (new.id, null, 'DETECTED', 'ignition', new.alarm_message);
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
    insert into public.incident_events (incident_id, from_status, to_status)
    values (new.id, old.status, new.status);
  end if;
  return new;
end;
$$;

create trigger incidents_guard_status_ins
  after insert on public.incidents
  for each row execute function public.incidents_guard_status();

create trigger incidents_guard_status_upd
  before update on public.incidents
  for each row execute function public.incidents_guard_status();

-- ---------------------------------------------------------------------------
-- Contractor communication and quotes
-- ---------------------------------------------------------------------------

-- One row per email sent to a technician; used to match inbound replies.
create table public.outreach (
  id                 uuid primary key default gen_random_uuid(),
  incident_id        text not null references public.incidents(id) on delete cascade,
  technician_id      uuid not null references public.technicians(id),
  primitive_email_id text unique,                 -- id of the sent email in Primitive
  sent_at            timestamptz not null default now(),
  replied_at         timestamptz,
  unique (incident_id, technician_id)
);

create table public.quotes (
  id                 uuid primary key default gen_random_uuid(),
  incident_id        text not null references public.incidents(id) on delete cascade,
  technician_id      uuid not null references public.technicians(id),
  amount_cents       integer check (amount_cents > 0),  -- null if the reply had no price
  currency           text not null default 'usd',
  available_at       timestamptz,
  scope              text,
  is_complete        boolean not null default false,    -- price + availability + scope present
  status             text not null default 'received' check (status in ('received','selected','rejected')),
  source_email_id    text unique,                       -- inbound Primitive email id (idempotency)
  created_at         timestamptz not null default now()
);

create index quotes_incident_idx on public.quotes (incident_id);

-- ---------------------------------------------------------------------------
-- Approvals and payments (the money guardrails)
-- ---------------------------------------------------------------------------

create table public.approvals (
  id                     uuid primary key default gen_random_uuid(),
  incident_id            text not null references public.incidents(id) on delete cascade,
  quote_id               uuid not null unique references public.quotes(id),
  approver_id            uuid not null references auth.users(id),
  decision               text not null check (decision in ('approved','rejected')),
  approved_amount_cents  integer not null check (approved_amount_cents > 0),
  approved_scope         text,
  created_at             timestamptz not null default now()
);

-- An approval must match the exact quote amount and belong to the same incident.
create or replace function public.approvals_check_quote()
returns trigger
language plpgsql
as $$
declare
  q public.quotes%rowtype;
begin
  select * into q from public.quotes where id = new.quote_id;
  if q.incident_id <> new.incident_id then
    raise exception 'quote % does not belong to incident %', new.quote_id, new.incident_id;
  end if;
  if q.amount_cents is null or q.amount_cents <> new.approved_amount_cents then
    raise exception 'approved amount % does not match quote amount %',
      new.approved_amount_cents, q.amount_cents;
  end if;
  return new;
end;
$$;

create trigger approvals_check_quote
  before insert or update on public.approvals
  for each row execute function public.approvals_check_quote();

create table public.payments (
  id                          uuid primary key default gen_random_uuid(),
  incident_id                 text not null references public.incidents(id) on delete cascade,
  approval_id                 uuid not null unique references public.approvals(id), -- one payment per approval
  amount_cents                integer not null check (amount_cents > 0),
  currency                    text not null default 'usd',
  status                      text not null default 'pending' check (status in ('pending','paid','failed')),
  stripe_checkout_session_id  text unique,
  stripe_payment_intent_id    text unique,
  idempotency_key             text not null unique,
  created_at                  timestamptz not null default now(),
  paid_at                     timestamptz
);

-- A payment can only exist for an approved approval, for exactly the approved amount.
create or replace function public.payments_check_approval()
returns trigger
language plpgsql
as $$
declare
  a public.approvals%rowtype;
begin
  select * into a from public.approvals where id = new.approval_id;
  if a.decision <> 'approved' then
    raise exception 'approval % is not approved', new.approval_id;
  end if;
  if a.approved_amount_cents <> new.amount_cents or a.incident_id <> new.incident_id then
    raise exception 'payment does not match approval % (amount or incident)', new.approval_id;
  end if;
  return new;
end;
$$;

create trigger payments_check_approval
  before insert or update on public.payments
  for each row execute function public.payments_check_approval();

-- ---------------------------------------------------------------------------
-- Evidence and plant readings (for verification)
-- ---------------------------------------------------------------------------

create table public.evidence (
  id           uuid primary key default gen_random_uuid(),
  incident_id  text not null references public.incidents(id) on delete cascade,
  kind         text not null check (kind in ('repair_report','photo','reading','note')),
  storage_url  text,
  storage_key  text,
  notes        text,
  submitted_by text,
  created_at   timestamptz not null default now()
);

create index evidence_incident_idx on public.evidence (incident_id);

-- Tag snapshots pushed by Ignition (the cloud never polls the plant).
create table public.readings (
  id           bigserial primary key,
  asset_id     text not null references public.assets(id),
  flow_lpm     numeric,
  run_cmd      boolean,
  fault        boolean,
  recorded_at  timestamptz not null default now()
);

create index readings_asset_time_idx on public.readings (asset_id, recorded_at desc);

-- ---------------------------------------------------------------------------
-- Access control: signed-in users read; writes only via server key.
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['assets','technicians','incidents','incident_events','outreach',
                           'quotes','approvals','payments','evidence','readings']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke insert, update, delete on public.%I from anon, authenticated', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_read_authenticated', t);
  end loop;
end $$;
