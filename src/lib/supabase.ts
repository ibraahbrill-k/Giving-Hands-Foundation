import { createClient } from '@supabase/supabase-js';

// These two values are PUBLIC BY DESIGN (like the URL of any website).
// The publishable/anon key can only do what RLS policies allow.
// Real secrets (Paystack sk_...) live ONLY in Supabase edge function env.
export const SUPABASE_URL = 'https://pmzuajshiyxjhcirosky.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_j-1aNmeGRpjnteAAE03ccA_iV74_PGU';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const FUNCS = `${SUPABASE_URL}/functions/v1`;

export function initiatePayment(amount: number, phone: string, method: 'mobile' | 'card') {
  return fetch(`${FUNCS}/initiate-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount, phone, method }),
  }).then((r) => r.json());
}

export function verifyPayment(reference: string) {
  return fetch(`${FUNCS}/verify-payment?reference=${encodeURIComponent(reference)}`).then((r) =>
    r.json()
  );
}

export async function fetchRaisedTotal(): Promise<number> {
  const { data, error } = await supabase.rpc('get_raised_total', {
    fundraiser: (
      await supabase.from('fundraisers').select('id').eq('slug', 'sylvias-mum').single()
    ).data!.id,
  });
  if (error) return 0;
  return Number(data ?? 0);
}
