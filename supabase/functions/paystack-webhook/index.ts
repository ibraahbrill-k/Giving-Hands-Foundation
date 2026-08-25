// paystack-webhook — server-to-server truth. Verifies HMAC-SHA512 signature
// with the secret key before touching anything. Paystack sends no auth header,
// so signature verification IS authentication here.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature");

  // ---- authenticate the caller via HMAC-SHA512 of raw body (constant-time) ----
  const expected = createHmac("sha512", PAYSTACK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature ?? "");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return new Response("invalid signature", { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  if (event.event !== "charge.success") {
    return new Response("ignored", { status: 200 }); // always 200 so Paystack doesn't retry-storm
  }

  const tx = event.data;
  const reference: string | undefined = tx?.reference;
  if (!reference) return new Response("no reference", { status: 200 });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    SERVICE_ROLE
  );

  // Amount check: trust only if Paystack's amount matches OUR stored amount.
  const { data: row } = await supabase
    .from("donations")
    .select("amount_cents, currency, status")
    .eq("reference", reference)
    .single();

  if (!row) return new Response("unknown reference", { status: 200 });

  if (tx.amount === row.amount_cents && tx.currency === row.currency) {
    // trigger guard prevents double-crediting / reopening a finalized row
    if (row.status !== "success") {
      await supabase
        .from("donations")
        .update({ status: "success", paystack_id: tx.id })
        .eq("reference", reference);
    }
  } else {
    // mismatch = potential fraud/tampering — mark failed, never credit
    await supabase
      .from("donations")
      .update({ status: "failed", failure_reason: "webhook amount/currency mismatch" })
      .eq("reference", reference);
  }

  return new Response("ok", { status: 200 });
});
