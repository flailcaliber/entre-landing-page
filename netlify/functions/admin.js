/**
 * Entre Admin API — Netlify Function
 *
 * All routes require: Authorization: Bearer <ADMIN_PASSWORD>
 *
 * GET  /.netlify/functions/admin?action=analytics        — dashboard stats
 * GET  /.netlify/functions/admin?action=list             — paginated subscriber list
 * GET  /.netlify/functions/admin?action=list&page=2&search=gmail
 * GET  /.netlify/functions/admin?action=export           — download CSV
 * POST /.netlify/functions/admin?action=import           — body: { emails: string[] }
 * GET  /.netlify/functions/admin?action=referral-stats   — full referral analytics
 * GET  /.netlify/functions/admin?action=waitlist-queue   — queue ranked by position
 * GET  /.netlify/functions/admin?action=unsubscribers    — paginated list of unsubscribed users
 *
 * Required Netlify env vars:
 *   SUPABASE_URL             (same as EXPO_PUBLIC_SUPABASE_URL)
 *   SUPABASE_SERVICE_ROLE_KEY (from Supabase dashboard → Settings → API)
 *   ADMIN_PASSWORD           (any strong password you choose)
 */

const { createClient } = require('@supabase/supabase-js');

// Lazy-init Supabase client (avoids cold-start cost on auth failures)
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

// ─── Helpers ──────────────────────────────────────────────────

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(status, body) {
  return {
    statusCode: status,
    headers: corsHeaders(),
    body: JSON.stringify(body),
  };
}

function checkAuth(event) {
  const header = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token.length > 0 && token === process.env.ADMIN_PASSWORD;
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function groupByCount(arr, key) {
  return arr.reduce((acc, item) => {
    const val = item[key] || 'unknown';
    acc[val] = (acc[val] || 0) + 1;
    return acc;
  }, {});
}

function computeByWeek(rows) {
  const weeks = {};
  (rows || []).forEach(r => {
    const d = new Date(r.created_at);
    const dow = d.getUTCDay(); // 0=Sun
    const daysToMonday = dow === 0 ? 6 : dow - 1;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysToMonday));
    const key = monday.toISOString().split('T')[0];
    weeks[key] = (weeks[key] || 0) + 1;
  });
  return Object.entries(weeks)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-16)
    .map(([week, count]) => ({ week, count }));
}

// ─── Route handlers ───────────────────────────────────────────

async function handleList(event) {
  const params = event.queryStringParameters || {};
  const page   = Math.max(1, parseInt(params.page || '1', 10));
  const limit  = 50;
  const offset = (page - 1) * limit;
  const search = (params.search || '').trim();

  let q = sb()
    .from('waitlist')
    .select(
      'id, email, phone, source, referral_code, referred_by_code, referral_count, city, pmf_response, utm_source, utm_medium, utm_campaign, is_bot_flagged, created_at',
      { count: 'exact' }
    )
    .is('unsubscribed_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) q = q.ilike('email', `%${search}%`);

  const { data, error, count } = await q;
  if (error) throw error;

  return json(200, { subscribers: data, total: count, page, limit, pages: Math.ceil((count || 0) / limit) });
}

async function handleAnalytics() {
  const now  = Date.now();
  const t7   = new Date(now - 7  * 86400000).toISOString();
  const t14  = new Date(now - 14 * 86400000).toISOString();

  const [allRes, thisWeekRes, lastWeekRes, pvRes, topRefRes, unsubRes] = await Promise.all([
    sb().from('waitlist').select('source, utm_source, city, referral_count, created_at').is('unsubscribed_at', null),
    // Exclude imports from weekly growth — they skew the metric
    sb().from('waitlist').select('id', { count: 'exact', head: true }).neq('source', 'imported').is('unsubscribed_at', null).gte('created_at', t7),
    sb().from('waitlist').select('id', { count: 'exact', head: true }).neq('source', 'imported').is('unsubscribed_at', null).gte('created_at', t14).lt('created_at', t7),
    sb().from('page_views').select('id', { count: 'exact', head: true }),
    sb().from('waitlist')
      .select('email, referral_code, referral_count')
      .gt('referral_count', 0)
      .is('unsubscribed_at', null)
      .order('referral_count', { ascending: false })
      .limit(10),
    sb().from('waitlist').select('id', { count: 'exact', head: true }).not('unsubscribed_at', 'is', null),
  ]);

  for (const r of [allRes, thisWeekRes, lastWeekRes, pvRes, topRefRes, unsubRes]) {
    if (r.error) throw r.error;
  }

  const all          = allRes.data || [];
  const total        = all.length;
  const organic      = all.filter(r => r.source !== 'imported');
  const thisWeek     = thisWeekRes.count || 0;
  const lastWeek     = lastWeekRes.count || 0;
  const pageViews    = pvRes.count       || 0;

  // Viral coefficient — only meaningful for organic subscribers
  const totalReferrals = organic.reduce((s, r) => s + (r.referral_count || 0), 0);
  const viralK = organic.length > 0 ? (totalReferrals / organic.length).toFixed(2) : '0.00';

  // Week-over-week growth (organic only)
  const wowGrowth = lastWeek > 0
    ? (((thisWeek - lastWeek) / lastWeek) * 100).toFixed(1)
    : null;

  // Conversion rate uses organic signups only (imports didn't come from the landing page)
  const convRate = pageViews > 0
    ? ((organic.length / pageViews) * 100).toFixed(1)
    : null;

  return json(200, {
    total,
    totalOrganic: organic.length,
    thisWeek,
    lastWeek,
    wowGrowth,
    pageViews,
    convRate,
    viralK,
    unsubCount:   unsubRes.count || 0,
    bySource:     groupByCount(all, 'source'),
    byUtm:        groupByCount(organic.filter(r => r.utm_source), 'utm_source'),
    byCity:       groupByCount(organic.filter(r => r.city), 'city'),
    byWeek:       computeByWeek(organic),   // chart shows organic growth only
    topReferrers: topRefRes.data || [],
  });
}

async function handleHistory() {
  const { data, error } = await sb()
    .from('waitlist')
    .select('created_at, source')
    .order('created_at', { ascending: true });

  if (error) throw error;

  const byWeek  = {};
  const byMonth = {};

  (data || []).forEach(r => {
    const d      = new Date(r.created_at);
    const source = r.source || 'organic';

    // Week key (ISO Monday)
    const dow         = d.getUTCDay();
    const toMonday    = dow === 0 ? 6 : dow - 1;
    const monday      = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - toMonday));
    const weekKey     = monday.toISOString().split('T')[0];

    if (!byWeek[weekKey]) byWeek[weekKey] = { week: weekKey, total: 0, organic: 0, referral: 0, imported: 0 };
    byWeek[weekKey].total++;
    if      (source === 'imported') byWeek[weekKey].imported++;
    else if (source === 'referral') byWeek[weekKey].referral++;
    else                            byWeek[weekKey].organic++;

    // Month key
    const monthKey = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth[monthKey]) byMonth[monthKey] = { month: monthKey, total: 0, organic: 0, referral: 0, imported: 0 };
    byMonth[monthKey].total++;
    if      (source === 'imported') byMonth[monthKey].imported++;
    else if (source === 'referral') byMonth[monthKey].referral++;
    else                            byMonth[monthKey].organic++;
  });

  const weeks  = Object.values(byWeek).sort((a, b) => a.week.localeCompare(b.week));
  const months = Object.values(byMonth).sort((a, b) => a.month.localeCompare(b.month));

  // Add running cumulative totals
  let cumOrganic = 0, cumTotal = 0;
  weeks.forEach(w => {
    cumOrganic += w.organic + w.referral;
    cumTotal   += w.total;
    w.cumOrganic = cumOrganic;
    w.cumTotal   = cumTotal;
  });

  let cumOrganicM = 0, cumTotalM = 0;
  months.forEach(m => {
    cumOrganicM += m.organic + m.referral;
    cumTotalM   += m.total;
    m.cumOrganic = cumOrganicM;
    m.cumTotal   = cumTotalM;
  });

  return json(200, { byWeek: weeks, byMonth: months });
}

async function handleImport(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const raw = body.emails;
  if (!Array.isArray(raw) || raw.length === 0) {
    return json(400, { error: 'Provide { emails: string[] } in request body' });
  }

  const records = [];
  const skipped = [];

  for (const item of raw) {
    const email = (typeof item === 'string' ? item : item?.email || '').trim().toLowerCase();
    if (!email || !email.includes('@') || !email.includes('.')) {
      skipped.push(email || '(empty)');
      continue;
    }
    records.push({ email, referral_code: generateCode(), source: 'imported' });
  }

  if (records.length === 0) {
    return json(400, { error: 'No valid email addresses found', skipped });
  }

  // Use upsert with ignoreDuplicates so existing emails are silently skipped
  const { error } = await sb().from('waitlist').upsert(records, {
    onConflict: 'email',
    ignoreDuplicates: true,
  });
  if (error) throw error;

  return json(200, {
    imported: records.length,
    skipped_invalid: skipped.length,
    total_provided: raw.length,
  });
}

async function handleReferralStats() {
  const [allRes, topRes] = await Promise.all([
    sb().from('waitlist')
      .select('email, referral_code, referral_count, source, created_at')
      .eq('is_bot_flagged', false)
      .is('unsubscribed_at', null),
    sb().from('waitlist')
      .select('email, referral_code, referral_count, created_at')
      .gt('referral_count', 0)
      .is('unsubscribed_at', null)
      .order('referral_count', { ascending: false })
      .limit(25),
  ]);

  if (allRes.error) throw allRes.error;
  if (topRes.error) throw topRes.error;

  const all   = allRes.data || [];
  const total = all.length;

  const totalReferrals   = all.reduce((s, r) => s + (r.referral_count || 0), 0);
  const usersWithRefs    = all.filter(r => (r.referral_count || 0) >= 1).length;
  const avgReferrals     = total > 0 ? (totalReferrals / total).toFixed(2) : '0.00';
  const topReferrerCount = topRes.data?.[0]?.referral_count || 0;

  // Distribution buckets
  const dist = { '0': 0, '1-2': 0, '3-5': 0, '6-10': 0, '10+': 0 };
  all.forEach(r => {
    const n = r.referral_count || 0;
    if      (n === 0)       dist['0']++;
    else if (n <= 2)        dist['1-2']++;
    else if (n <= 5)        dist['3-5']++;
    else if (n <= 10)       dist['6-10']++;
    else                    dist['10+']++;
  });

  return json(200, {
    total,
    totalReferrals,
    usersWithRefs,
    avgReferrals,
    topReferrerCount,
    distribution: dist,
    topReferrers: topRes.data || [],
  });
}

async function handleWaitlistQueue(event) {
  const params = event.queryStringParameters || {};
  const page   = Math.max(1, parseInt(params.page || '1', 10));
  const limit  = 50;
  const offset = (page - 1) * limit;
  const search = (params.search || '').trim();

  // Fetch all non-flagged rows to compute rank client-side
  // (Supabase JS client doesn't support window functions directly)
  let q = sb()
    .from('waitlist')
    .select('email, referral_code, referral_count, source, created_at', { count: 'exact' })
    .or('is_bot_flagged.is.null,is_bot_flagged.eq.false')
    .is('unsubscribed_at', null)
    .order('referral_count', { ascending: false })
    .order('created_at',     { ascending: true });

  if (search) q = q.ilike('email', `%${search}%`);

  // For ranked pagination we need all rows when searching, otherwise use range
  let data, count, error;
  if (search) {
    ({ data, count, error } = await q);
    if (error) throw error;
    // Assign positions 1..n for filtered view (relative rank within results)
    const ranked = (data || []).map((r, i) => ({ ...r, position: offset + i + 1 }));
    const slice  = ranked.slice(offset, offset + limit);
    return json(200, { queue: slice, total: count || 0, page, limit, pages: Math.ceil((count || 0) / limit) });
  } else {
    ({ data, count, error } = await q.range(offset, offset + limit - 1));
    if (error) throw error;
    const ranked = (data || []).map((r, i) => ({ ...r, position: offset + i + 1 }));
    return json(200, { queue: ranked, total: count || 0, page, limit, pages: Math.ceil((count || 0) / limit) });
  }
}

async function handleExport() {
  const { data, error } = await sb()
    .from('waitlist')
    .select('email, phone, source, referral_code, referred_by_code, referral_count, city, pmf_response, utm_source, utm_medium, utm_campaign, is_bot_flagged, created_at')
    .is('unsubscribed_at', null)
    .order('created_at', { ascending: false });

  if (error) throw error;

  const cols = ['email', 'phone', 'source', 'referral_code', 'referred_by_code', 'referral_count', 'city', 'pmf_response', 'utm_source', 'utm_medium', 'utm_campaign', 'is_bot_flagged', 'created_at'];
  const escape = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [cols.join(','), ...(data || []).map(r => cols.map(c => escape(r[c])).join(','))].join('\n');

  return {
    statusCode: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="entre_waitlist.csv"',
    },
    body: csv,
  };
}

async function handleUnsubscribers(event) {
  const params = event.queryStringParameters || {};
  const page   = Math.max(1, parseInt(params.page || '1', 10));
  const limit  = 50;
  const offset = (page - 1) * limit;
  const search = (params.search || '').trim();

  let q = sb()
    .from('waitlist')
    .select(
      'email, unsub_reason, unsubscribed_at, source, referral_count',
      { count: 'exact' }
    )
    .not('unsubscribed_at', 'is', null)
    .order('unsubscribed_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) q = q.ilike('email', `%${search}%`);

  const { data, error, count } = await q;
  if (error) throw error;

  return json(200, { unsubscribers: data, total: count, page, limit, pages: Math.ceil((count || 0) / limit) });
}

async function handleDelete(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0) {
    return json(400, { error: 'Provide { ids: string[] }' });
  }

  const { error } = await sb().from('waitlist').delete().in('id', ids);
  if (error) throw error;

  return json(200, { deleted: ids.length });
}

// ─── Main handler ─────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (!checkAuth(event)) {
    return json(401, { error: 'Unauthorized' });
  }

  const action = (event.queryStringParameters || {}).action;

  try {
    if (event.httpMethod === 'GET'  && action === 'list')            return await handleList(event);
    if (event.httpMethod === 'GET'  && action === 'analytics')       return await handleAnalytics();
    if (event.httpMethod === 'GET'  && action === 'history')         return await handleHistory();
    if (event.httpMethod === 'POST' && action === 'import')          return await handleImport(event);
    if (event.httpMethod === 'GET'  && action === 'export')          return await handleExport();
    if (event.httpMethod === 'GET'  && action === 'referral-stats')  return await handleReferralStats();
    if (event.httpMethod === 'GET'  && action === 'waitlist-queue')  return await handleWaitlistQueue(event);
    if (event.httpMethod === 'POST' && action === 'delete')          return await handleDelete(event);
    if (event.httpMethod === 'GET'  && action === 'unsubscribers')   return await handleUnsubscribers(event);
    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[entre-admin]', err);
    return json(500, { error: err.message || 'Internal server error' });
  }
};
