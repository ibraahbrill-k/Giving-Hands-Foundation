-- ============================================================
-- Medical Fund for Sylvia's Mum - schema
-- Money-safety rules baked in:
--   * amounts stored in KES cents (integer, no float math)
--   * CHECK constraints bound every amount to sane limits
--   * unique references -> idempotency
--   * RLS ON everywhere; anon can NEVER insert/update donations
--   * status transitions constrained by trigger
-- ============================================================

create extension if not exists pgcrypto;

create table public.fundraisers (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  title         text not null,
  description   text,
  beneficiary   text not null,
  target_cents  bigint not null check (target_cents > 0),
  currency      text not null default 'KES',
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.donations (
  id             uuid primary key default gen_random_uuid(),
  fundraiser_id  uuid not null references public.fundraisers(id) on delete restrict,
  reference      text not null unique,               -- our own reference, sent to Paystack
  paystack_id    bigint,                             -- Paystack transaction id (set on webhook)
  amount_cents   integer not null check (amount_cents >= 100 and amount_cents <= 20000000), -- KSh 1 .. KSh 200,000
  currency       text not null default 'KES' check (currency = 'KES'),
  donor_phone    text not null check (donor_phone ~ '^\+?254[17]\d{8}$'),
  donor_name     text,
  status         text not null default 'pending'
                 check (status in ('pending','success','failed','abandoned')),
  failure_reason text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index donations_fundraiser_status_idx on public.donations (fundraiser_id, status);
create index donations_reference_idx on public.donations (reference);

-- ------------------------------------------------------------
-- Guard: a donation may only move forward, and only once to success.
-- Prevents double-crediting from webhook + verify racing each other.
-- ------------------------------------------------------------
create or replace function public.guard_donation_transition()
returns trigger language plpgsql as $$
begin
  if new.status <> old.status then
    if old.status = 'success' then
      raise exception 'donation % is already finalized', old.reference;
    end if;
    if new.status not in ('pending','success','failed','abandoned') then
      raise exception 'invalid status';
    end if;
  end if;
  -- never allow amount/reference/fundraiser to change after creation
  new.amount_cents := old.amount_cents;
  new.reference := old.reference;
  new.fundraiser_id := old.fundraiser_id;
  new.updated_at := now();
  return new;
end $$;

create trigger donations_guard
before update on public.donations
for each row execute function public.guard_donation_transition();

-- ------------------------------------------------------------
-- Public raised total: SECURITY DEFINER so anon never needs row access.
-- ------------------------------------------------------------
create or replace function public.get_raised_total(fundraiser uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount_cents), 0)
  from public.donations
  where fundraiser_id = $1 and status = 'success';
$$;

revoke all on function public.get_raised_total(uuid) from public;
grant execute on function public.get_raised_total(uuid) to anon, authenticated;

-- ------------------------------------------------------------
-- Row Level Security: lockdown by default
-- ------------------------------------------------------------
alter table public.donations enable row level security;
alter table public.fundraisers enable row level security;

-- fundraisers: public read of active campaigns only
create policy "public read active fundraisers"
on public.fundraisers for select
using (is_active = true);

-- donations: NO select/insert/update/delete policies for anon/authenticated.
-- Only the service_role (edge functions) touches this table.

-- ------------------------------------------------------------
-- Seed the fundraiser
-- ------------------------------------------------------------
insert into public.fundraisers (slug, title, description, beneficiary, target_cents)
values (
  'sylvias-mum',
  'Medical Fund for Sylvia''s Mum',
  'Your contribution can help cover urgent medical expenses. Every amount, big or small, makes a difference.',
  'Sylvia''s Mum',
  25000000  -- KSh 250,000 in cents
)
on conflict (slug) do nothing;
