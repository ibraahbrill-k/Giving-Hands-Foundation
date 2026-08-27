# Better Life — Medical Fund for Sylvia's Mum

A secure donation website built with **React + TypeScript + Tailwind CSS** and **Vite**, backed by **Supabase** edge functions with **Paystack** handling M-Pesa, Airtel Money, and Visa/Mastercard payments in KES.

## Project structure

```
├── index.html                    # Entry point, fonts, favicon, Paystack Inline script
├── src/
│   ├── App.tsx                   # Fundraiser page, donation flow, thank-you screen
│   ├── index.css                 # Tailwind v4 theme (brand palette, animations)
│   ├── lib/config.ts             # Campaign info, preset amounts, network detection
│   └── lib/supabase.ts           # Supabase URL/key constants + edge function calls
├── public/images/                # logo.png, mpesa.png, airtel.png, visa.svg
└── supabase/
    ├── NGOs.sql                  # Complete database schema (single source of truth)
    ├── config.toml
    └── functions/
        ├── initiate-payment/     # Validates input, rate limits, starts charge/checkout
        ├── verify-payment/       # Polls Paystack for final status
        └── paystack-webhook/     # HMAC-verified server-to-server confirmation
```

## Payment methods supported

| Method | Flow |
|---|---|
| Safaricom M-Pesa | STK push to donor's phone, approved with PIN |
| Airtel Money | Prompt sent to donor's phone (073x / 075x numbers) |
| Visa / Mastercard | Secure Paystack-hosted popup on the page itself |

Network detection happens from the phone prefix; unsupported networks are pointed toward card payment.

## Security measures in place

1. **No payment secrets in the browser.** Only the Supabase publishable key reaches the client. The Paystack secret key lives exclusively in Supabase edge function secrets.
2. **Server-side validation.** Amounts and phone numbers are validated in the edge function; the client is never trusted.
3. **Rate limiting.** Maximum 3 attempts per phone per 15 minutes and 15 attempts per IP per hour, enforced server-side.
4. **HMAC-SHA512 webhook authentication.** Every webhook is verified with constant-time comparison against Paystack's signature header.
5. **Amount match on success.** A payment is only marked successful when Paystack's reported amount and currency exactly equal the stored values. Mismatches are flagged failed.
6. **Double-credit guard.** A database trigger prevents any donation row from being finalized twice or reopened after success.
7. **RLS lockdown.** The donations table has zero policies for anon/authenticated roles — donor data cannot be read or modified from the client. Totals are exposed through a `SECURITY DEFINER` function only.
8. **Only successful payments count.** "Raised so far" sums rows where `status = 'success'`, which requires Paystack confirmation.

## Database

`supabase/NGOs.sql` contains the complete schema — tables, indexes, guard trigger, RLS policies, raised-total function, and the seeded fundraiser (target KSh 150,000). It consolidates all earlier migrations into one file and can be pasted into the Supabase SQL editor to rebuild the database from scratch at any time.

## Setup

### 1. Supabase
```bash
npm i -g supabase
supabase login
supabase link --project-ref pmzuajshiyxjhcirosky
```
Then paste `supabase/NGOs.sql` into the Supabase SQL editor and run it.

### 2. Paystack secret key
```bash
supabase secrets set PAYSTACK_SECRET_KEY=sk_live_xxx
```

### 3. Deploy edge functions
```bash
supabase functions deploy initiate-payment
supabase functions deploy verify-payment
supabase functions deploy paystack-webhook
```

### 4. Register the webhook in Paystack
Dashboard → Settings → API Keys & Webhooks → Webhook URL:
`https://pmzuajshiyxjhcirosky.supabase.co/functions/v1/paystack-webhook`
(Test Webhook URL for test keys, Live Webhook URL for live keys.)

### 5. Frontend
The Supabase URL and publishable key are hardcoded in `src/lib/supabase.ts` — they are public by design, so no environment variables are required anywhere. Netlify build settings: command `npm run build`, publish directory `dist`.

## Running locally
```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build to dist/
```

## Testing in Paystack test mode

- **M-Pesa:** only the official test number succeeds instantly — `0710 000 000`. Other numbers receive a gateway decline.
- **Airtel Money:** charges start but the sandbox declines completion; full verification works with live keys.
- **Card:** test card `4084 0840 8408 4081`, any future expiry, CVV `408`, PIN `0000`.

Test transactions never move real money and are recorded separately from live ones.

## Go-live checklist

1. Wipe test data: `DELETE FROM public.donations;`
2. `supabase secrets set PAYSTACK_SECRET_KEY=sk_live_xxx`
3. Set the **Live Webhook URL** in Paystack to the same functions URL
4. Confirm Netlify auto-deploys from GitHub (`main` branch)
5. Make one small live donation as final end-to-end confirmation
