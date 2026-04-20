/**
 * Entre — Loops Webhook Handler
 *
 * Listens for Loops events and syncs unsubscribe/bounce/spam data
 * back into the Supabase waitlist table so the admin dashboard stays
 * accurate when someone unsubscribes via a Loops broadcast email.
 *
 * POST /.netlify/functions/loops-webhook
 *
 * Events handled:
 *   contact.unsubscribed  — user clicked unsubscribe in a Loops email
 *   emailBounced          — hard bounce; marks as unsubscribed
 *   emailSpam             — spam complaint; marks as unsubscribed
 *
 * All three set unsubscribed_at + unsub_reason. Idempotent.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   LOOPS_WEBHOOK_SECRET  — signing secret from Loops dashboard
 */

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ─── Supabase ─────────────────────────────────────────────────

let _supabase;
function sb() {
  if (!_supabase) {
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return _supabase;
}

// ─── Webhook signature verification ───────────────────────────
//
// Loops signs payloads with HMAC-SHA256 using your webhook secret.
// The signature is sent in the x-loops-signature header as a hex digest.
// If LOOPS_WEBHOOK_SECRET is not set we skip verification and log a
// warning — set it in production.

function verifySignature(rawBody, headers) {
  const secret = process.env.LOOPS_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[loops-webhook] LOOPS_WEBHOOK_SECRET not set — skipping signature check');
    return true;
  }

  const signature = headers['x-loops-signature'];
  if (!signature) {
    console.warn('[loops-webhook] Missing x-loops-signature header');
    return false;
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// ─── Unsubscribe helper ───────────────────────────────────────

async function markUnsubscribed(email, reason) {
  const { data: rows, error: fetchErr } = await sb()
    .from('waitlist')
    .select('id, unsubscribed_at')
    .eq('email', email.toLowerCase())
    .limit(1);

  if (fetchErr) {
    console.error('[loops-webhook] fetch error:', fetchErr.message);
    return { skipped: false, error: fetchErr.message };
  }

  if (!rows || rows.length === 0) {
    console.log('[loops-webhook] email not in waitlist, skipping:', email);
    return { skipped: true };
  }

  const row = rows[0];

  if (row.unsubscribed_at) {
    console.log('[loops-webhook] already unsubscribed:', email);
    return { skipped: true, already: true };
  }

  const { error: updateErr } = await sb()
    .from('waitlist')
    .update({
      unsubscribed_at: new Date().toISOString(),
      unsub_reason:    reason,
    })
    .eq('id', row.id);

  if (updateErr) {
    console.error('[loops-webhook] update error:', updateErr.message);
    return { skipped: false, error: updateErr.message };
  }

  console.log('[loops-webhook] marked unsubscribed:', email, '|', reason);
  return { skipped: false };
}

// ─── Main handler ─────────────────────────────────────────────

exports.handler = async (event) => {
  // Loops sends a GET to verify the endpoint is reachable before saving it
  if (event.httpMethod === 'GET' || event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, body: 'ok' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.body || '';

  if (!verifySignature(rawBody, event.headers)) {
    return { statusCode: 401, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { type, data } = payload;
  console.log('[loops-webhook] received event:', type);

  // ── contact.unsubscribed ──────────────────────────────────
  if (type === 'contact.unsubscribed') {
    const email = data?.email;
    if (!email) return { statusCode: 200, body: 'ok' };
    await markUnsubscribed(email, 'unsubscribed via email');
    return { statusCode: 200, body: 'ok' };
  }

  // ── emailBounced ──────────────────────────────────────────
  if (type === 'emailBounced') {
    const email = data?.email;
    if (!email) return { statusCode: 200, body: 'ok' };
    await markUnsubscribed(email, 'hard email bounce');
    return { statusCode: 200, body: 'ok' };
  }

  // ── emailSpam ─────────────────────────────────────────────
  if (type === 'emailSpam') {
    const email = data?.email;
    if (!email) return { statusCode: 200, body: 'ok' };
    await markUnsubscribed(email, 'spam complaint');
    return { statusCode: 200, body: 'ok' };
  }

  // All other event types — acknowledge and ignore
  console.log('[loops-webhook] unhandled event type, ignoring:', type);
  return { statusCode: 200, body: 'ok' };
};
