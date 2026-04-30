/**
 * Entre Leaderboard — Public Netlify Function
 *
 * Returns the top referrers on the waitlist with masked emails.
 * No auth required — only non-sensitive, anonymised data is exposed.
 *
 * GET /.netlify/functions/leaderboard?limit=10
 *
 * Response: { leaders: [{ rank, email_masked, referral_count }] }
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

// "samra@entre.nyc" → "sa***@entre.nyc"
function maskEmail(email) {
  const at = email.indexOf('@');
  if (at < 0) return '***';
  const local  = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***@${domain}`;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  const params = event.queryStringParameters || {};
  const limit  = Math.min(parseInt(params.limit || '10', 10), 25);

  const { data, error } = await sb()
    .from('waitlist')
    .select('email, referral_count')
    .or('is_bot_flagged.is.null,is_bot_flagged.eq.false')
    .is('unsubscribed_at', null)
    .gt('referral_count', 0)
    .order('referral_count', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[entre-leaderboard]', error);
    return json(500, { error: 'Lookup failed' });
  }

  const leaders = (data || []).map((row, i) => ({
    rank:          i + 1,
    email_masked:  maskEmail(row.email),
    referral_count: row.referral_count,
  }));

  return json(200, { leaders });
};
