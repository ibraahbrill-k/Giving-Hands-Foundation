// verify-payment — client polls this while waiting for the STK push result.
// The ONLY source of truth is Paystack itself (never the client).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const url = new URL(req.url);
    const reference = url.searchParams.get("reference");
    // strict reference format — blocks arbitrary input from reaching the DB query
    if (!reference || !/^SM-\d{13}-[a-f0-9]{8}$/.test(reference)) {
      return json({ error: "invalid reference" }, 400);
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: donation } = await supabase
      .from("donations")
      .select("status, amount_cents")
      .eq("reference", reference)
      .single();

    if (donation?.status === "success" || donation?.status === "failed") {
      return json({
        status: donation.status,
        ...(donation.status === "success" ? { amount: donation.amount_cents } : {}),
      });
    }

    // Ask Paystack directly
    const psRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SECRET}` } }
    );
    const psData = await psRes.json();

    if (psData.status && psData.data?.status === "success") {
      // Defense-in-depth: only trust success when Paystack's recorded amount
      // matches what we created AND currency is KES.
      const { data: row } = await supabase
        .from("donations")
        .select("amount_cents, currency, status")
        .eq("reference", reference)
        .single();

      if (
        row &&
        row.status !== "success" &&
        psData.data.amount === row.amount_cents &&
        psData.data.currency === row.currency
      ) {
        await supabase
          .from("donations")
          .update({ status: "success", paystack_id: psData.data.id })
          .eq("reference", reference);
        return json({ status: "success", amount: row.amount_cents });
      }
      if (row?.status === "success") {
        return json({ status: "success", amount: row.amount_cents });
      }
      return json({ error: "amount mismatch - flagged" }, 409);
    }

    if (psData.status && ["failed", "abandoned"].includes(psData.data?.status)) {
      await supabase
        .from("donations")
        .update({ status: psData.data.status })
        .eq("reference", reference)
        .neq("status", "success");
      return json({ status: psData.data.status });
    }

    return json({ status: "pending" }); // still awaiting PIN entry
  } catch (e) {
    console.error(e);
    return json({ error: "verification error" }, 500);
  }
});
