/**
 * Entre Signup — Netlify Function
 *
 * Handles waitlist signups: inserts into Supabase, then creates a
 * Loops contact with waitlist stats. Loops picks up the new contact
 * via its "contact added" trigger and sends the signup email automatically.
 *
 * POST /.netlify/functions/signup
 * Body: { email, phone?, referred_by_code?, source, utm_*, pmf_response? }
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   LOOPS_API_KEY
 *
 * Loops setup (one-time, in Loops dashboard):
 *   Create a Loop with trigger: "Contact added"
 *   Merge tags available in the email: referralCode, waitlistPosition, referralLink
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

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Strip formatting characters so Loops can import the number cleanly.
// "(555) 123-4567" → "+15551234567", "555-123-4567" → "+15551234567"
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  // Prefix with +1 for 10-digit US numbers that don't already have a country code
  if (digits.length === 10) return `+1${digits}`;
  // Already has country code (11+ digits starting with 1 for US)
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // International or non-standard — just strip non-digits and keep as-is
  return `+${digits}`;
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

// ─── Loops helpers ────────────────────────────────────────────

const LOOPS_API = 'https://app.loops.so/api/v1';

function loopsHeaders() {
  if (!process.env.LOOPS_API_KEY) {
    throw new Error('LOOPS_API_KEY env var is not set — cannot sync contact to Loops');
  }
  return {
    'Authorization': `Bearer ${process.env.LOOPS_API_KEY}`,
    'Content-Type':  'application/json',
  };
}

// Create or update a contact in Loops Audiences. Custom properties
// (referralCode, waitlistPosition, etc.) become available as merge
// tags in Loops broadcast and transactional email templates.
async function loopsUpsertContact({ email, referral_code, waitlist_position, referral_count, subscribed = true }) {
  // Use snake_case keys — these become the {{merge_tag}} names in Loops templates
  const payload = { email, referral_code, waitlist_position, referral_count, subscribed };

  const res = await fetch(`${LOOPS_API}/contacts/create`, {
    method:  'POST',
    headers: loopsHeaders(),
    body:    JSON.stringify(payload),
  });

  if (res.status === 409) {
    // Contact already exists — update in place
    const upd = await fetch(`${LOOPS_API}/contacts/update`, {
      method:  'PUT',
      headers: loopsHeaders(),
      body:    JSON.stringify(payload),
    });
    if (!upd.ok) {
      const body = await upd.text();
      console.error('[entre-signup] Loops contact update failed:', upd.status, body);
    }
    return;
  }

  if (!res.ok) {
    const body = await res.text();
    console.error('[entre-signup] Loops contact create failed:', res.status, body);
    throw new Error(`Loops create failed: ${res.status} ${body}`);
  }

  console.log('[entre-signup] Loops contact created for:', email);
}


// ─── Main handler ─────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed' });
  }

  try {
  // ── body parse ──────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }

  const {
    email, phone,
    referred_by_code, source,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    pmf_response,
    _hp,
  } = body;

  if (!email || !email.includes('@')) {
    return json(400, { error: 'Valid email required' });
  }

  const referral_code = generateCode();

  // Honeypot: _hp is a hidden field real users never see or fill.
  // Any submission with it populated is a bot.
  const is_bot_flagged = !!_hp;

  const { error } = await sb().from('waitlist').insert({
    email:            email.trim().toLowerCase(),
    phone:            normalizePhone(phone),
    referral_code,
    referred_by_code: referred_by_code || null,
    source:           source || 'organic',
    utm_source:       utm_source    || null,
    utm_medium:       utm_medium    || null,
    utm_campaign:     utm_campaign  || null,
    utm_content:      utm_content   || null,
    utm_term:         utm_term      || null,
    pmf_response:     pmf_response  || null,
    is_bot_flagged:   is_bot_flagged,
  });

  if (error) {
    if (error.code === '23505') {
      // Duplicate email — check if they previously unsubscribed and want back in
      const { data: existing } = await sb()
        .from('waitlist')
        .select('id, referral_code, unsubscribed_at')
        .eq('email', email.trim().toLowerCase())
        .limit(1);

      if (existing && existing[0] && existing[0].unsubscribed_at) {
        // Re-subscribe: clear the unsubscribe fields, reuse their existing referral_code
        const existingCode = existing[0].referral_code;
        const { error: resubErr } = await sb()
          .from('waitlist')
          .update({
            unsubscribed_at: null,
            unsub_reason:    null,
            phone:           normalizePhone(phone),
            pmf_response:    pmf_response || null,
            utm_source:      utm_source   || null,
            utm_medium:      utm_medium   || null,
            utm_campaign:    utm_campaign || null,
            utm_content:     utm_content  || null,
            utm_term:        utm_term     || null,
          })
          .eq('id', existing[0].id);

        if (resubErr) {
          console.error('[entre-signup] re-subscribe error:', resubErr);
          return json(500, { error: resubErr.message });
        }

        const POSITION_OFFSET = 2000;
        let position = null;
        try {
          const { count: total } = await sb()
            .from('waitlist')
            .select('id', { count: 'exact', head: true })
            .or('is_bot_flagged.is.null,is_bot_flagged.eq.false')
            .is('unsubscribed_at', null);
          position = total !== null ? total + POSITION_OFFSET : null;
        } catch (e) {
          console.warn('[entre-signup] position lookup failed:', e.message);
        }

        // Re-activate contact in Loops
        await loopsUpsertContact({
          email:             email.trim().toLowerCase(),
          referral_code:     existingCode,
          waitlist_position: position ?? 1,
          referral_count:    0,
          subscribed:        true,
        }).catch(e => console.warn('[entre-signup] Loops upsert failed:', e.message));

        return json(200, { success: true, referral_code: existingCode, position });
      }

      // Genuine duplicate — still subscribed
      return json(409, { error: 'duplicate' });
    }
    console.error('[entre-signup]', error);
    return json(500, { error: error.message });
  }

  // Compute approximate waitlist position — new signups start at the back
  // (referrals will move them up over time). Position = total non-flagged rows.
  // POSITION_OFFSET is added to every displayed position to seed social proof.
  const POSITION_OFFSET = 2000;
  let position = null;
  try {
    const { count: total } = await sb()
      .from('waitlist')
      .select('id', { count: 'exact', head: true })
      .or('is_bot_flagged.is.null,is_bot_flagged.eq.false');
    position = total !== null ? total + POSITION_OFFSET : null;
  } catch (e) {
    console.warn('[entre-signup] position lookup failed:', e.message);
  }

  // Skip Loops entirely for bot-flagged signups — no confirmation email, no contact record
  if (is_bot_flagged) {
    console.log('[entre-signup] bot-flagged signup, skipping Loops:', email.trim().toLowerCase());
    return json(200, { success: true, referral_code, position: null });
  }

  // Create contact in Loops — the "contact added" Loop trigger handles the email
  await loopsUpsertContact({
    email:             email.trim().toLowerCase(),
    referral_code:     referral_code,
    waitlist_position: position ?? POSITION_OFFSET + 1,
    referral_count:    0,
  }).catch(e => console.warn('[entre-signup] Loops upsert failed:', e.message));

  // If this signup used a referral code, increment the referrer's count in Loops
  if (referred_by_code) {
    try {
      const { data: referrer } = await sb()
        .from('waitlist')
        .select('email')
        .eq('referral_code', referred_by_code)
        .is('unsubscribed_at', null)
        .limit(1);

      if (referrer && referrer[0]) {
        const { count: refCount } = await sb()
          .from('waitlist')
          .select('id', { count: 'exact', head: true })
          .eq('referred_by_code', referred_by_code)
          .or('is_bot_flagged.is.null,is_bot_flagged.eq.false')
          .is('unsubscribed_at', null);

        await loopsUpsertContact({
          email:          referrer[0].email,
          referral_count: refCount ?? 1,
        }).catch(e => console.warn('[entre-signup] Loops referrer update failed:', e.message));
      }
    } catch (e) {
      console.warn('[entre-signup] referrer count update failed:', e.message);
    }
  }

  return json(200, { success: true, referral_code, position });

  } catch (err) {
    console.error('[entre-signup] unhandled error:', err);
    return json(500, { error: err.message || 'Internal server error' });
  }
};
