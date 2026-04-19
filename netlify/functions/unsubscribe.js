/**
 * Entre Unsubscribe — Netlify Function
 *
 * Marks a waitlist entry as unsubscribed (sets unsubscribed_at + unsub_reason).
 * Does NOT delete the row — preserves history for the admin Unsubscribers tab.
 *
 * POST /.netlify/functions/unsubscribe
 * Body: { email: string, reason: string }
 *
 * Responses:
 *   200 { success: true }               — unsubscribed
 *   200 { success: true, already: true }— was already unsubscribed (idempotent)
 *   400 { error: 'missing_fields' }     — email or reason absent
 *   404 { error: 'not_found' }          — email not in waitlist
 *   500 { error: '...' }               — unexpected error
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const { createClient } = require('@supabase/supabase-js');

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

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(status, body) {
  return { statusCode: status, headers: corsHeaders(), body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const email  = (body.email  || '').trim().toLowerCase();
  const reason = (body.reason || '').trim();

  if (!email || !email.includes('@') || !reason) {
    return json(400, { error: 'missing_fields' });
  }

  // Look up the subscriber
  const { data: rows, error: fetchErr } = await sb()
    .from('waitlist')
    .select('id, unsubscribed_at')
    .eq('email', email)
    .limit(1);

  if (fetchErr) {
    console.error('[entre-unsub] fetch error:', fetchErr);
    return json(500, { error: fetchErr.message });
  }

  if (!rows || rows.length === 0) {
    return json(404, { error: 'not_found' });
  }

  const row = rows[0];

  // Idempotent — already unsubscribed
  if (row.unsubscribed_at) {
    return json(200, { success: true, already: true });
  }

  // Mark as unsubscribed
  const { error: updateErr } = await sb()
    .from('waitlist')
    .update({ unsubscribed_at: new Date().toISOString(), unsub_reason: reason })
    .eq('id', row.id);

  if (updateErr) {
    console.error('[entre-unsub] update error:', updateErr);
    return json(500, { error: updateErr.message });
  }

  return json(200, { success: true });
};
