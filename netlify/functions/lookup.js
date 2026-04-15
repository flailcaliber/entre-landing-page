/**
 * Entre Waitlist Lookup — Public Netlify Function
 *
 * No auth required. Returns only safe, non-sensitive fields.
 *
 * GET /.netlify/functions/lookup?email=user@example.com
 * GET /.netlify/functions/lookup?token=ABC123   (referral code as magic-link token)
 *
 * Response: { referral_code, referral_count, position }
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

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(status, body) {
  return { statusCode: status, headers: cors(), body: JSON.stringify(body) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const params = event.queryStringParameters || {};
  const email  = (params.email  || '').trim().toLowerCase();
  const token  = (params.token  || '').trim().toUpperCase();

  if (!email && !token) {
    return json(400, { error: 'Provide email or token' });
  }

  // Look up the subscriber
  let q = sb()
    .from('waitlist')
    .select('referral_code, referral_count, created_at')
    .or('is_bot_flagged.is.null,is_bot_flagged.eq.false');

  if (token) q = q.eq('referral_code', token);
  else       q = q.eq('email', email);

  const { data, error } = await q.maybeSingle();

  if (error) {
    console.error('[entre-lookup]', error);
    return json(500, { error: 'Lookup failed' });
  }
  if (!data) {
    return json(404, { error: 'not_found' });
  }

  // Compute position:
  // Count users with more referrals, plus users with same referrals but earlier signup
  const [aheadByCount, aheadByDate] = await Promise.all([
    sb()
      .from('waitlist')
      .select('id', { count: 'exact', head: true })
      .or('is_bot_flagged.is.null,is_bot_flagged.eq.false')
      .gt('referral_count', data.referral_count || 0),
    sb()
      .from('waitlist')
      .select('id', { count: 'exact', head: true })
      .or('is_bot_flagged.is.null,is_bot_flagged.eq.false')
      .eq('referral_count', data.referral_count || 0)
      .lt('created_at', data.created_at),
  ]);

  const position = (aheadByCount.count || 0) + (aheadByDate.count || 0) + 1;

  return json(200, {
    referral_code:  data.referral_code,
    referral_count: data.referral_count || 0,
    position,
  });
};
