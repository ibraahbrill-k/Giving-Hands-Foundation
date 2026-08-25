-- Hardening: support rate limiting
alter table public.donations add column if not exists client_ip text;

create index if not exists donations_phone_created_idx
  on public.donations (donor_phone, created_at desc);

create index if not exists donations_ip_created_idx
  on public.donations (client_ip, created_at desc);
