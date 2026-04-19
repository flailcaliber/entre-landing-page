/**
 * Entre Signup — Netlify Function
 *
 * Handles waitlist signups: inserts into Supabase, then fires a
 * confirmation email via Resend.
 *
 * POST /.netlify/functions/signup
 * Body: { email, phone?, referred_by_code?, source, utm_*, pmf_response? }
 *
 * Required Netlify env vars:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
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

// ─── Email template ───────────────────────────────────────────

function buildEmailHtml(referralCode, position) {
  const referralLink = `https://www.entre.nyc/?ref=${referralCode}`;
  const positionLine = position
    ? `You're currently <strong style="color:#131220;">#${position}</strong> on the waitlist.`
    : `You're on the waitlist.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <title>You're on the list — Entre</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;1,400&family=DM+Sans:wght@300;400;500&display=swap');
    body, table, td, p { margin: 0; padding: 0; }
    body { background-color: #f5f0eb; font-family: 'DM Sans', Helvetica, Arial, sans-serif; }
    img  { border: 0; display: block; }
    a    { color: inherit; }
  </style>
</head>
<body style="background-color:#f5f0eb; margin:0; padding:0;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f0eb;">
    <tr>
      <td align="center" style="padding: 40px 16px;">

        <!-- Card -->
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px; background-color:#ffffff; border-radius:16px; overflow:hidden; box-shadow: 0 2px 24px rgba(0,0,0,0.07);">

          <!-- Header -->
          <tr>
            <td style="background-color:#131220; padding: 36px 40px 32px;">
              <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 28px; font-weight: 400; color: #FFF8F0; margin: 0; letter-spacing: 0.01em;">
                entr<em style="font-style:italic; color:#9ED29E;">e</em>
              </p>
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 400; color: rgba(255,248,240,0.45); letter-spacing: 0.1em; text-transform: uppercase; margin: 6px 0 0;">
                Meet in the middle.
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 40px 40px 12px;">
              <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 30px; font-weight: 400; color: #131220; margin: 0 0 20px; line-height: 1.2;">
                You're on the list.
              </p>
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; color: #3d3a4e; line-height: 1.7; margin: 0 0 16px;">
                Thank you for signing up. Genuinely. Finding that perfect lunch spot during a busy work day is too complicated. We're on a mission to fix that. We're so glad you're along for the ride.
              </p>
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 15px; font-weight: 300; color: #3d3a4e; line-height: 1.7; margin: 0;">
                We're building an app that handles every ounce of logistics when it comes to lunch planning. We find restaurants in between you and your friends, curated to both your tastes, and handle timing/navigation so you can get back to where you need to be without making your boss mad. Ready to book in one tap. NYC first. More cities soon.
              </p>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding: 28px 40px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="border-top: 1px solid #ede8e2;"></td></tr>
              </table>
            </td>
          </tr>

          <!-- Referral / move up the line block -->
          <tr>
            <td style="padding: 0 40px 36px;">
              <!-- Position callout -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f0eb; border-radius:12px; margin-bottom:20px;">
                <tr>
                  <td style="padding: 18px 20px;">
                    <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 300; color: #3d3a4e; margin: 0 0 4px;">
                      ${positionLine}
                    </p>
                    <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 13px; font-weight: 300; color: #7a7585; margin: 0;">
                      Early access opens from the top of the list first. The more friends you bring along, the sooner you get in.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Move up CTA -->
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: #9ED29E; margin: 0 0 10px;">
                Move up the waitlist
              </p>
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 300; color: #3d3a4e; line-height: 1.6; margin: 0 0 16px;">
                Share your personal link. Every person who joins through your link bumps you up one spot — No limit!
              </p>

              <!-- Magic link CTA -->
              <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
                <tr>
                  <td style="border-radius:8px; background-color:#131220; border:1px solid #2d2b42;">
                    <a href="https://www.entre.nyc/waitlist?token=${referralCode}"
                       style="display:inline-block; font-family:'DM Sans',Helvetica,Arial,sans-serif; font-size:16px; font-weight:700; color:#FFF8F0; text-decoration:none; padding:12px 24px;">View your waitlist position</a>
                  </td>
                </tr>
              </table>

              <!-- Referral link box -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5f0eb; border: 1px solid #ede8e2; border-radius:10px; margin-bottom:16px;">
                <tr>
                  <td style="padding: 14px 18px;">
                    <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 500; color: #9b9490; letter-spacing: 0.08em; text-transform: uppercase; margin: 0 0 4px;">Your invite link</p>
                    <a href="${referralLink}" style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 400; color: #131220; text-decoration: none;">${referralLink}</a>
                  </td>
                </tr>
              </table>

              <!-- Share button -->
              <table cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="border-radius: 8px; background-color: #131220;">
                    <a href="https://twitter.com/intent/tweet?text=I%20just%20joined%20the%20Entre%20waitlist%20%E2%80%94%20a%20new%20app%20that%20figures%20out%20where%20you%20and%20your%20friends%20should%20grab%20lunch%20in%20NYC.%20Join%20me%3A%20${encodeURIComponent(referralLink)}"
                       style="display:inline-block; font-family:'DM Sans',Helvetica,Arial,sans-serif; font-size:13px; font-weight:500; color:#FFF8F0; text-decoration:none; padding:10px 20px;">
                      Share on X (Twitter)
                    </a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td style="padding: 0 40px 28px;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td style="border-top: 1px solid #ede8e2;"></td></tr>
              </table>
            </td>
          </tr>

          <!-- What's coming -->
          <tr>
            <td style="padding: 0 40px 36px;">
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; color: #9ED29E; margin: 0 0 16px;">
                What to expect
              </p>

              <!-- Item 1 -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                <tr>
                  <td width="24" valign="top" style="padding-top:2px;">
                    <div style="width:6px; height:6px; border-radius:50%; background-color:#9ED29E; margin-top:6px;"></div>
                  </td>
                  <td>
                    <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 300; color: #3d3a4e; line-height: 1.6; margin: 0;">
                      <strong style="font-weight:500; color:#131220;">Development updates</strong> — we'll keep you looped in on what we're building, milestones we hit, and the occasional behind-the-scenes look.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Item 2 -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:14px;">
                <tr>
                  <td width="24" valign="top" style="padding-top:2px;">
                    <div style="width:6px; height:6px; border-radius:50%; background-color:#9ED29E; margin-top:6px;"></div>
                  </td>
                  <td>
                    <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 300; color: #3d3a4e; line-height: 1.6; margin: 0;">
                      <strong style="font-weight:500; color:#131220;">Early access</strong> — doors open from the top of the waitlist first. Get your friends in and climb.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- Item 3 -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="24" valign="top" style="padding-top:2px;">
                    <div style="width:6px; height:6px; border-radius:50%; background-color:#9ED29E; margin-top:6px;"></div>
                  </td>
                  <td>
                    <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 300; color: #3d3a4e; line-height: 1.6; margin: 0;">
                      <strong style="font-weight:500; color:#131220;">No spam, ever</strong> — we'll only reach out when we actually have something worth saying.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Sign-off -->
          <tr>
            <td style="padding: 0 40px 36px;">
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 300; color: #3d3a4e; line-height: 1.6; margin: 0 0 4px;">
                Thanks again for joining. Sit tight :)
              </p>
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 400; color: #131220; margin: 0;">
                — Sam, Entre
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:#faf7f4; border-top: 1px solid #ede8e2; padding: 12px 40px;">
              <p style="font-family: 'DM Sans', Helvetica, Arial, sans-serif; font-size: 11px; color: #b5b0a8; line-height: 1.5; margin: 0;">
                You're receiving this because you signed up at <a href="https://www.entre.nyc" style="color:#9ED29E; text-decoration:none;">entre.nyc</a>. Questions? Reply to this email or reach us at <a href="mailto:hello@entre.nyc" style="color:#9ED29E; text-decoration:none;">hello@entre.nyc</a>.
                &nbsp;&nbsp;·&nbsp;&nbsp;<a href="https://www.entre.nyc/unsubscribe.html?email=${encodeURIComponent(email)}" style="color:#b5b0a8; text-decoration:underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ─── Send via Resend ──────────────────────────────────────────

async function sendConfirmation(email, referralCode, position) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[entre-signup] RESEND_API_KEY not set — skipping confirmation email');
    return;
  }

  // Wrapped in try/catch — email failure must never crash the signup handler
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from:     'Sam at Entre <howdy@mail.entre.nyc>',
        to:       email,
        subject:  "You're on the list — Entre",
        html:     buildEmailHtml(referralCode, position),
        reply_to: 'sam@entre.nyc',
        headers: {
          'List-Unsubscribe':      `<https://www.entre.nyc/unsubscribe.html?email=${encodeURIComponent(email)}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error('[entre-signup] Resend error:', err);
    }
  } catch (e) {
    console.error('[entre-signup] sendConfirmation threw:', e.message);
  }
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
  } = body;

  if (!email || !email.includes('@')) {
    return json(400, { error: 'Valid email required' });
  }

  const referral_code = generateCode();

  const { error } = await sb().from('waitlist').insert({
    email:            email.trim().toLowerCase(),
    phone:            phone || null,
    referral_code,
    referred_by_code: referred_by_code || null,
    source:           source || 'organic',
    utm_source:       utm_source    || null,
    utm_medium:       utm_medium    || null,
    utm_campaign:     utm_campaign  || null,
    utm_content:      utm_content   || null,
    utm_term:         utm_term      || null,
    pmf_response:     pmf_response  || null,
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
            phone:           phone || null,
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

        let position = null;
        try {
          const { count: total } = await sb()
            .from('waitlist')
            .select('id', { count: 'exact', head: true })
            .or('is_bot_flagged.is.null,is_bot_flagged.eq.false')
            .is('unsubscribed_at', null);
          position = total;
        } catch (e) {
          console.warn('[entre-signup] position lookup failed:', e.message);
        }

        await sendConfirmation(email.trim().toLowerCase(), existingCode, position);
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
  let position = null;
  try {
    const { count: total } = await sb()
      .from('waitlist')
      .select('id', { count: 'exact', head: true })
      .or('is_bot_flagged.is.null,is_bot_flagged.eq.false');
    position = total;
  } catch (e) {
    console.warn('[entre-signup] position lookup failed:', e.message);
  }

  // Fire confirmation email — non-blocking on failure
  await sendConfirmation(email.trim().toLowerCase(), referral_code, position);

  return json(200, { success: true, referral_code, position });

  } catch (err) {
    console.error('[entre-signup] unhandled error:', err);
    return json(500, { error: err.message || 'Internal server error' });
  }
};
