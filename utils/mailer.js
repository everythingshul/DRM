// utils/mailer.js — centralised email sender with automatic DB logging
'use strict';
const nodemailer = require('nodemailer');
const https     = require('https');
const { v4: uuidv4 } = require('uuid');

// Send via Brevo API (port 443 — never blocked by hosting providers)
async function sendViaBrevoApi(apiKey, { from, fromName, to, subject, html }) {
  const body = JSON.stringify({
    sender:   { email: from, name: fromName },
    to:       [{ email: to }],
    subject,
    htmlContent: html
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        'api-key':       apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data || '{}'));
        else reject(new Error(`Brevo API error ${res.statusCode}: ${data.slice(0,200)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send an email and write a record to email_log.
 *
 * @param {object} opts
 *   transporter  - nodemailer transporter
 *   orgId        - org this email belongs to
 *   to           - recipient address
 *   from         - sender string  "Name <addr>"
 *   subject      - email subject
 *   html         - email body HTML
 *   type         - 'receipt' | 'charge_success' | 'charge_failed' | 'expiry_warning' |
 *                  'scheduled' | 'test' | 'invite'
 *   donorId      - optional donor ID
 *   donationId   - optional donation ID
 *   headers      - optional extra headers (e.g. Postmark stream)
 */
async function sendMail(opts) {
  const { transporter, orgId, to, from, subject, html, type,
          donorId = null, donationId = null, headers = {},
          brevoApiKey = null, fromEmail = null, fromName = null } = opts;

  const { run } = require('../db/schema');
  const logId = uuidv4();

  try {
    if (brevoApiKey) {
      // Use Brevo API over HTTPS (port 443 — works on all hosting providers)
      await sendViaBrevoApi(brevoApiKey, {
        from: fromEmail || from.replace(/.*<(.+)>/, '$1').trim(),
        fromName: fromName || from.replace(/"?([^"<]+)"?\s*<.*/, '$1').trim(),
        to, subject, html
      });
    } else {
      await transporter.sendMail({ from, to, subject, html, headers });
    }
    run(`INSERT INTO email_log (id,org_id,to_email,subject,html_body,type,status,donor_id,donation_id)
         VALUES (?,?,?,?,?,?,'sent',?,?)`,
      [logId, orgId, to, subject, html||null, type, donorId, donationId]);
    console.log(`[email] ✓ ${type} → ${to}`);
    return { success: true };
  } catch(e) {
    run(`INSERT INTO email_log (id,org_id,to_email,subject,html_body,type,status,error,donor_id,donation_id)
         VALUES (?,?,?,?,?,?,'failed',?,?,?)`,
      [logId, orgId, to, subject, html||null, type, e.message, donorId, donationId]);
    console.error(`[email] ✗ ${type} → ${to} — ${e.message}`);
    throw e;
  }
}

/**
 * Build a nodemailer transporter from org email_settings row.
 * Returns null if neither Postmark nor Gmail SMTP is configured.
 */
function buildTransporter(settings) {
  if (!settings) return null;
  // Postmark
  if (settings.postmark_key) {
    return nodemailer.createTransport({
      host: 'smtp.postmarkapp.com', port: 587, secure: false,
      auth: { user: settings.postmark_key, pass: settings.postmark_key }
    });
  }
  // Gmail / Brevo / Resend / any SMTP
  if (settings.smtp_email && settings.smtp_password) {
    const port = parseInt(settings.smtp_port) || 587;
    return nodemailer.createTransport({
      host: settings.smtp_host || 'smtp.gmail.com',
      port: port,
      secure: port === 465,
      auth: { user: settings.smtp_email, pass: settings.smtp_password }
    });
  }
  return null;
}

function fromAddr(settings, orgName) {
  const name = settings?.from_name || orgName || 'DRM';
  const addr = settings?.smtp_email || 'noreply@everythingshul.com';
  return `"${name}" <${addr}>`;
}

function pmHeaders(settings) {
  return settings?.postmark_key ? { 'X-PM-Message-Stream': 'outbound' } : {};
}

module.exports = { sendMail, buildTransporter, fromAddr, pmHeaders, sendViaBrevoApi };
