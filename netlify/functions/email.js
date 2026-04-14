/**
 * Entre Email API — Netlify Function
 *
 * Template CRUD and campaign sending via Resend.
 *
 * GET  /.netlify/functions/email?action=templates       — list all templates
 * GET  /.netlify/functions/email?action=send-history    — past campaign sends
 * POST /.netlify/functions/email?action=template-save   — create or update template
 *      body: { id?, name, subject, html_content }
 * POST /.netlify/functions/email?action=template-delete — delete template
 *      body: { id }
 * POST /.netlify/functions/email?action=send-campaign   — blast to a segment
 *      body: { template_id, subject_override?, segment }
 *      segments: 'all' | 'organic' | 'referral' | 'no_referrals'
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   ADMIN_PASSWORD
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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function json(status, body) {
  return { statusCode: status, headers: corsHeaders(), body: JSON.stringify(body) };
}

function checkAuth(event) {
  const header = event.headers['authorization'] || event.headers['Authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return token.length > 0 && token === process.env.ADMIN_PASSWORD;
}

// ─── Template handlers ────────────────────────────────────────────────────────

async function handleListTemplates() {
  const { data, error } = await sb()
    .from('email_templates')
    .select('id, name, subject, created_at, updated_at')
    .order('updated_at', { ascending: false });

  if (error) throw error;
  return json(200, { templates: data || [] });
}

async function handleTemplateSave(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { id, name, subject, html_content } = body;

  if (!name || !subject || !html_content) {
    return json(400, { error: 'name, subject, and html_content are required' });
  }

  if (id) {
    // Update existing
    const { data, error } = await sb()
      .from('email_templates')
      .update({ name, subject, html_content })
      .eq('id', id)
      .select('id, name, subject, updated_at')
      .single();

    if (error) throw error;
    return json(200, { template: data });
  } else {
    // Create new
    const { data, error } = await sb()
      .from('email_templates')
      .insert({ name, subject, html_content })
      .select('id, name, subject, created_at, updated_at')
      .single();

    if (error) throw error;
    return json(201, { template: data });
  }
}

async function handleTemplateDelete(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { id } = body;
  if (!id) return json(400, { error: 'id is required' });

  const { error } = await sb().from('email_templates').delete().eq('id', id);
  if (error) throw error;

  return json(200, { deleted: true });
}

// ─── Send history ─────────────────────────────────────────────────────────────

async function handleSendHistory() {
  const { data, error } = await sb()
    .from('email_sends')
    .select('id, template_name, subject, segment, recipient_count, sent_count, failed_count, status, sent_at')
    .order('sent_at', { ascending: false })
    .limit(50);

  if (error) throw error;
  return json(200, { sends: data || [] });
}

// ─── Campaign sending ─────────────────────────────────────────────────────────

async function fetchRecipients(segment) {
  let q = sb().from('waitlist').select('email').eq('is_bot_flagged', false);

  switch (segment) {
    case 'organic':
      q = q.eq('source', 'organic');
      break;
    case 'referral':
      q = q.eq('source', 'referral');
      break;
    case 'no_referrals':
      q = q.eq('referral_count', 0);
      break;
    case 'all':
    default:
      break;
  }

  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(r => r.email);
}

async function sendBatch(emails, subject, htmlContent) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not set');

  const messages = emails.map(email => ({
    from:     'Sam at Entre <howdy@mail.entre.nyc>',
    to:       email,
    subject,
    html:     htmlContent,
    reply_to: 'sam@entre.nyc',
  }));

  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(messages),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('[entre-email] Resend batch error:', err);
    return { sent: 0, failed: emails.length };
  }

  const result = await res.json();
  // Resend batch returns array of results
  const results = Array.isArray(result) ? result : (result.data || []);
  const failed = results.filter(r => r.error).length;
  return { sent: results.length - failed, failed };
}

async function handleSendCampaign(event) {
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON body' }); }

  const { template_id, subject_override, segment = 'all' } = body;

  if (!template_id) return json(400, { error: 'template_id is required' });
  if (!['all', 'organic', 'referral', 'no_referrals'].includes(segment)) {
    return json(400, { error: 'segment must be: all, organic, referral, or no_referrals' });
  }

  // Load template
  const { data: template, error: tErr } = await sb()
    .from('email_templates')
    .select('name, subject, html_content')
    .eq('id', template_id)
    .single();

  if (tErr || !template) return json(404, { error: 'Template not found' });

  const subject      = subject_override || template.subject;
  const html_content = template.html_content;

  // Fetch recipients
  const emails = await fetchRecipients(segment);
  if (emails.length === 0) {
    return json(200, { sent: 0, failed: 0, total: 0, message: 'No recipients in this segment' });
  }

  // Create send record (pending)
  const { data: sendRecord, error: sendErr } = await sb()
    .from('email_sends')
    .insert({
      template_id,
      template_name:   template.name,
      subject,
      segment,
      recipient_count: emails.length,
      status:          'sending',
    })
    .select('id')
    .single();

  if (sendErr) console.error('[entre-email] Failed to create send record:', sendErr);
  const sendId = sendRecord?.id;

  // Send in batches of 100
  const BATCH_SIZE = 100;
  let totalSent   = 0;
  let totalFailed = 0;

  for (let i = 0; i < emails.length; i += BATCH_SIZE) {
    const batch = emails.slice(i, i + BATCH_SIZE);
    const { sent, failed } = await sendBatch(batch, subject, html_content);
    totalSent   += sent;
    totalFailed += failed;
  }

  // Update send record to done
  if (sendId) {
    await sb()
      .from('email_sends')
      .update({
        sent_count:   totalSent,
        failed_count: totalFailed,
        status:       totalFailed === emails.length ? 'failed' : 'done',
      })
      .eq('id', sendId);
  }

  return json(200, {
    sent:   totalSent,
    failed: totalFailed,
    total:  emails.length,
  });
}

// ─── Recipient count preview ──────────────────────────────────────────────────

async function handleSegmentCount(event) {
  const segment = (event.queryStringParameters || {}).segment || 'all';
  const emails  = await fetchRecipients(segment);
  return json(200, { count: emails.length, segment });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (!checkAuth(event)) {
    return json(401, { error: 'Unauthorized' });
  }

  const action = (event.queryStringParameters || {}).action;

  try {
    if (event.httpMethod === 'GET'  && action === 'templates')       return await handleListTemplates();
    if (event.httpMethod === 'GET'  && action === 'send-history')    return await handleSendHistory();
    if (event.httpMethod === 'GET'  && action === 'segment-count')   return await handleSegmentCount(event);
    if (event.httpMethod === 'POST' && action === 'template-save')   return await handleTemplateSave(event);
    if (event.httpMethod === 'POST' && action === 'template-delete') return await handleTemplateDelete(event);
    if (event.httpMethod === 'POST' && action === 'send-campaign')   return await handleSendCampaign(event);
    return json(400, { error: `Unknown action: ${action}` });
  } catch (err) {
    console.error('[entre-email]', err);
    return json(500, { error: err.message || 'Internal server error' });
  }
};
