-- Allow card donors without a mobile number
alter table public.donations alter column donor_phone drop not null;

alter table public.donations drop constraint if exists donations_donor_phone_check;

alter table public.donations
  add constraint donations_donor_phone_check
  check (donor_phone is null or donor_phone ~ '^\+?254[17]\d{8}$');
