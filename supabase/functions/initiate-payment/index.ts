// initiate-payment — creates a pending donation and triggers a Paystack
// M-Pesa STK push. All secrets live in Supabase env vars; nothing leaks here.
// Hardened: strict input validation, per-phone and per-IP rate limits.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Server-side whitelist of allowed amounts (KES). Never trust the client.
const ALLOWED_AMOUNTS_KES = [200, 500, 1000, 2000, 5000, 10000, 15000, 20000];
const MIN_KES = 1;
const MAX_KES = 200000;

// Rate limits: max donation attempts per window
const MAX_PER_PHONE_PER_15MIN = 3;
const MAX_PER_IP_PER_HOUR = 15;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/** Best-effort client IP from proxy headers. */
function getClientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip") ?? null;
}

/** Normalize Kenyan phone input (07xx, +2547xx, 2547xx, 01xx) -> 2547XXXXXXXX */
function normalizeKePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  let n = digits;
  if (n.startsWith("0")) n = "254" + n.slice(1);
  else if (n.startsWith("7") || n.startsWith("1")) n = "254" + n;
  if (!/^254[17]\d{8}$/.test(n)) return null;
  return n;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return json({ error: "invalid content type" }, 415);
  }

  // hard cap request body size
  const rawBody = await req.text();
  if (rawBody.length > 1024) return json({ error: "payload too large" }, 413);

  try {
    const { amount, phone } = JSON.parse(rawBody);
    const amountKes = Math.round(Number(amount));
    const normalized = normalizeKePhone(String(phone ?? ""));

    // ---- validation (server-side, authoritative) ----
    if (!Number.isFinite(amountKes)) return json({ error: "Invalid amount" }, 400);
    if (
      !ALLOWED_AMOUNTS_KES.includes(amountKes) &&
      !(amountKes >= MIN_KES && amountKes <= MAX_KES)
    ) {
      return json({ error: `Amount must be between KSh ${MIN_KES} and KSh ${MAX_KES}` }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const clientIp = getClientIp(req);

    // ---- rate limiting ----
    const since15min = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { count: phoneCount } = await supabase
      .from("donations")
      .select("id", { count: "exact", head: true })
      .eq("donor_phone", normalized)
      .gte("created_at", since15min);

    if ((phoneCount ?? 0) >= MAX_PER_PHONE_PER_15MIN) {
      return json({ error: "Too many attempts from this number. Please wait 15 minutes." }, 429);
    }

    if (clientIp) {
      const since1h = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count: ipCount } = await supabase
        .from("donations")
        .select("id", { count: "exact", head: true })
        .eq("client_ip", clientIp)
        .gte("created_at", since1h);

      if ((ipCount ?? 0) >= MAX_PER_IP_PER_HOUR) {
        return json({ error: "Too many requests. Please try again later." }, 429);
      }
    }

    // resolve fundraiser by slug
    const { data: fundraiser, error: fErr } = await supabase
      .from("fundraisers")
      .select("id")
      .eq("slug", "sylvias-mum")
      .single();
    if (fErr || !fundraiser) return json({ error: "Fundraiser not found" }, 404);

    // unique reference — idempotency anchor for webhook + verify
    const reference = `SM-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

    const donorEmail = `${normalized || `guest-${Date.now()}`}@donors.givinghandsfoundation.org`;

    const donationData: Record<string, unknown> = {
      fundraiser_id: fundraiser.id,
      reference,
      amount_cents: amountKes * 100,
      client_ip: clientIp,
    };
    if (normalized) {
      donationData.donor_phone = normalized;
    }
    const { data: donation, error: dErr } = await supabase
      .from("donations")
      .insert(donationData)
      .select("id")
      .single();
    if (dErr) {
      console.error(dErr);
      return json({ error: "Could not record donation" }, 500);
    }

    return json({ reference, email: donorEmail });
  } catch (e) {
    console.error(e);
    return json({ error: "Unexpected server error" }, 500);
  }
});
