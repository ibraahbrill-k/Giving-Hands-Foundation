# Medical Fund for Sylvia's Mum

A secure donation website built with **React (React Native Web)** + **Vite**, backed by **Supabase** with **Paystack** M-Pesa STK Push for Kenyan payments (KES).

## Project structure

```
├── index.html
├── src/                      # React Native Web UI
│   ├── App.tsx               # Fundraiser page
│   ├── lib/config.ts         # Campaign info, preset amounts, formatting
│   └── lib/supabase.ts       # Supabase client + edge function calls
├── supabase/
│   ├── migrations/0001_init.sql
│   └── functions/
│       ├── initiate-payment/   # Creates donation, triggers STK push
│       ├── verify-payment/     # Client polls this while waiting
│       └── paystack-webhook/   # Server-to-server truth (HMAC verified)
```

## How money is kept safe

1. **No secrets in the browser.** Only the Supabase anon key reaches the client. The Paystack secret key lives only in Supabase edge function env (`supabase secrets set`).
2. **Server-side validation.** Amount and phone are validated in the edge function — the client is never trusted.
3. **Paystack webhook signature check.** Every webhook is authenticated via HMAC-SHA512 of the raw body using the secret key. Forged webhooks are rejected with 401.
4. **Amount match on success.** A payment only counts as "success" if Paystack's reported amount AND currency exactly equal what we stored when creating the donation. Mismatches are flagged failed.
5. **Idempotency + double-credit guard.** Each donation has a unique reference; a DB trigger forbids reopening or double-finalizing a row (`supabase/migrations/0001_init.sql`).
6. **RLS lockdown.** `donations` table has zero policies for anon/authenticated — nobody can read donor phones or tamper with rows from the client. Totals are exposed through a `SECURITY DEFINER` function only.

## Setup

### 1. Supabase project
```bash
npm i -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push            # applies migrations/0001_init.sql
```

### 2. Paystack keys into Supabase env
```bash
supabase secrets set PAYSTACK_SECRET_KEY=sk_live_xxx      # sk_test_... first!
```

### 3. Deploy edge functions
```bash
supabase functions deploy initiate-payment
supabase functions deploy verify-payment
supabase functions deploy paystack-webhook
```

### 4. Register the webhook URL at Paystack
Dashboard → Settings → API Keys & Webhooks:
`https://YOUR-PROJECT.supabase.co/functions/v1/paystack-webhook`

### 5. Frontend config (already done)
The Supabase URL and publishable key are hardcoded in `src/lib/supabase.ts` — they are public by design, so no `.env` or Netlify environment variables are needed. Just push to GitHub and connect Netlify (build command `npm run build`, publish directory `dist`).

### 6. Run
```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build to dist/
```

## Payment flow (M-Pesa STK push)

1. Donor picks a preset amount (or types one ≥ KSh 50) and enters their Safaricom number.
2. **Donate Now** → `initiate-payment`: validates input, stores a `pending` donation, calls Paystack `POST /charge` with `currency: KES`, `mobile_money: { provider: mpesa }`.
3. Donator's phone gets an M-Pesa prompt → they enter their PIN.
4. Site polls `verify-payment`; Paystack also fires `charge.success` to the webhook. Whichever arrives first updates the row — both paths verify amounts against our stored record.
5. Progress bar refreshes from the raised-total function.

## Notes

- Test mode: use a Safaricom sandbox number per Paystack docs before going live.
- Switch the seeded fundraiser details in `src/lib/config.ts` and the DB seed in the migration once you have the verified recipient details.
- Manual M-Pesa fallback details are shown on the page ("Pay manually instead") — replace `MANUAL_MPESA` in `config.ts` with verified numbers.
