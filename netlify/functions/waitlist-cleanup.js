/**
 * Entre Waitlist Cleanup — Netlify Scheduled Function (daily, see netlify.toml)
 *
 * Privacy Policy retention rule: waitlist records are deleted 30 days after
 * someone unsubscribes — from our database and from Loops.
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   LOOPS_API_KEY
 */

const { createClient } = require('@supabase/supabase-js');

const LOOPS_API = 'https://app.loops.so/api/v1';
const RETENTION_DAYS = 30;

exports.handler = async () => {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: expired, error } = await sb
    .from('waitlist')
    .select('id, email')
    .lt('unsubscribed_at', cutoff);

  if (error) {
    console.error('[waitlist-cleanup] lookup failed:', error.message);
    return { statusCode: 500 };
  }

  let deleted = 0;
  for (const row of expired || []) {
    // Remove from Loops first; if that fails, keep the row so tomorrow's run retries
    const res = await fetch(`${LOOPS_API}/contacts/delete`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LOOPS_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: row.email }),
    }).catch(() => null);

    // 404 = already gone from Loops
    if (!res || (!res.ok && res.status !== 404)) {
      console.warn('[waitlist-cleanup] Loops delete failed, will retry:', res ? res.status : 'network');
      continue;
    }

    const { error: delErr } = await sb.from('waitlist').delete().eq('id', row.id);
    if (delErr) console.warn('[waitlist-cleanup] row delete failed:', delErr.message);
    else deleted++;
  }

  console.log(`[waitlist-cleanup] deleted ${deleted} of ${(expired || []).length} expired records`);
  return { statusCode: 200 };
};
