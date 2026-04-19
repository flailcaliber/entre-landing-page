/**
 * Entre — Resend Webhook Handler
 *
 * Listens for Resend events and syncs unsubscribe/bounce/complaint
 * data back into the Supabase waitlist table so the admin dashboard
 * stays accurate even when someone unsubscribes via a broadcast email.
 *
 * POST /.netlify/functions/resend-webhook
 *
 * Events handled:
 *   contact.deleted       — user clicked unsubscribe in a broadcast (Resend's event name)
 *   email.bounced         — hard bounce (bad address); marks as unsubscribed
 *   email.complained      — spam complaint; marks as unsubscribed
 *
 * All three set unsubscribed_at + unsub_reason. Idempotent.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_WEBHOOK_SECRET   — signing secret from Resend dashboard (starts with whsec_)
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

// ─── Webhook signature verification (Svix / Resend) ──────────
//
// Resend uses Svix to sign webhook payloads. The algorithm:
//   1. Concatenate:  svix-id + "." + svix-timestamp + "." + raw body
//   2. HMAC-SHA256 with the base64-decoded signing secret
//   3. Base64-encode the result
//   4. Compare against the "v1,<sig>" values in svix-signature header
//
// If RESEND_WEBHOOK_SECRET is not set we skip verification and log a
// warning — useful during local testing, but set it in production.

function verifySignature(rawBody, headers) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('[resend-webhook] RESEND_WEBHOOK_SECRET not set — skipping signature check');
    return true;
  }

  const svixId        = headers['svix-id'];
  const svixTimestamp = headers['svix-timestamp'];
  const svixSignature = headers['svix-signature'];

  if (!svixId || !svixTimestamp || !svixSignature) {
    console.warn('[resend-webhook] Missing svix headers');
    return false;
  }

  // Reject payloads older than 5 minutes (replay protection)
  const now = Math.floor(Date.now() / 1000);
  const ts  = parseInt(svixTimestamp, 10);
  if (Math.abs(now - ts) > 300) {
    console.warn('[resend-webhook] Timestamp too old:', ts);
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const secretBytes   = Buffer.from(secret.replace('whsec_', ''), 'base64');
  const expected      = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // svix-signature can be a space-separated list of "v1,<sig>" pairs
  const signatures = svixSignature.split(' ').map(s => s.replace('v1,', '').trim());
  return signatures.some(sig => sig === expected);
}

// ─── Unsubscribe helper ───────────────────────────────────────

async function markUnsubscribed(email, reason) {
  const { data: rows, error: fetchErr } = await sb()
    .from('waitlist')
    .select('id, unsubscribed_at')
    .eq('email', email.toLowerCase())
    .limit(1);

  if (fetchErr) {
    console.error('[resend-webhook] fetch error:', fetchErr.message);
    return { skipped: false, error: fetchErr.message };
  }

  if (!rows || rows.length === 0) {
    // Email not in our waitlist — could be a test address; not an error
    console.log('[resend-webhook] email not in waitlist, skipping:', email);
    return { skipped: true };
  }

  const row = rows[0];

  if (row.unsubscribed_at) {
    // Already unsubscribed — idempotent, nothing to do
    console.log('[resend-webhook] already unsubscribed:', email);
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
    console.error('[resend-webhook] update error:', updateErr.message);
    return { skipped: false, error: updateErr.message };
  }

  console.log('[resend-webhook] marked unsubscribed:', email, '|', reason);
  return { skipped: false };
}

// ─── Main handler ─────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const rawBody = event.body || '';

  // Verify the request is genuinely from Resend
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
  console.log('[resend-webhook] received event:', type);

  // ── contact.deleted ───────────────────────────────────────
  if (type === 'contact.deleted') {
    const email = data?.contact?.email;
    if (!email) {
      console.warn('[resend-webhook] contact.unsubscribed missing email in payload');
      return { statusCode: 200, body: 'ok' };
    }
    await markUnsubscribed(email, 'unsubscribed via email broadcast');
    return { statusCode: 200, body: 'ok' };
  }

  // ── email.bounced ─────────────────────────────────────────
  if (type === 'email.bounced') {
    // Only act on hard bounces — soft bounces (mailbox full, etc.) are transient
    const bounceType = data?.bounce?.type || '';
    if (bounceType !== 'hard') {
      console.log('[resend-webhook] soft bounce, ignoring:', data?.to?.[0]);
      return { statusCode: 200, body: 'ok' };
    }
    const email = data?.to?.[0];
    if (!email) return { statusCode: 200, body: 'ok' };
    await markUnsubscribed(email, 'hard email bounce');
    return { statusCode: 200, body: 'ok' };
  }

  // ── email.complained ──────────────────────────────────────
  if (type === 'email.complained') {
    const email = data?.to?.[0];
    if (!email) return { statusCode: 200, body: 'ok' };
    await markUnsubscribed(email, 'spam complaint');
    return { statusCode: 200, body: 'ok' };
  }

  // All other event types — acknowledge and ignore
  console.log('[resend-webhook] unhandled event type, ignoring:', type);
  return { statusCode: 200, body: 'ok' };
};
