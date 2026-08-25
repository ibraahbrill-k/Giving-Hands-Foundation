-- Fix fundraising target to KSh 150,000 (idempotent)
UPDATE public.fundraisers SET target_cents = 15000000 WHERE slug = 'sylvias-mum' AND target_cents <> 15000000;
