// utils/mailer.js — centralised email sender with automatic DB logging
'use strict';
const nodemailer = require('nodemailer');
const https      = require('https');
const { v4: uuidv4 } = require('uuid');

// ── Brevo REST API sender (HTTPS port 443 — works on all hosting providers) ───
async function sendViaBrevoApi(apiKey, { from, fromName, to, subject, html }) {
  const body = JSON.stringify({
    sender:      { email: from, name: fromName || 'DRM' },
    to:          [{ email: to }],
    subject,
    htmlContent: html
  });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.brevo.com',
      path:     '/v3/smtp/email',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'api-key':        apiKey,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(JSON.parse(data || '{}'));
        } else {
          reject(new Error(`Brevo API ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Build nodemailer transporter from email_settings row ─────────────────────
function buildTransporter(settings) {
  if (!settings?.smtp_email || !settings?.smtp_password) return null;
  const port = parseInt(settings.smtp_port) || 587;
  return nodemailer.createTransport({
    host:   settings.smtp_host || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth:   { user: settings.smtp_email, pass: settings.smtp_password }
  });
}

function fromAddr(settings, orgName) {
  const name = settings?.from_name || orgName || 'DRM';
  const addr = settings?.smtp_email || 'noreply@everythingshul.com';
  return `"${name}" <${addr}>`;
}

// ── Send an email — uses Brevo API if key set, otherwise SMTP ─────────────────
// Logs every attempt (success or fail) to email_log table
async function sendMail(opts) {
  const {
    settings,          // full email_settings row — used to decide provider
    orgId,
    to, from, subject, html,
    type       = 'general',
    donorId    = null,
    donationId = null
  } = opts;

  const { run } = require('../db/schema');
  const logId   = uuidv4();

  try {
    if (settings?.brevo_api_key) {
      // Parse from address into parts
      const emailMatch = from.match(/<(.+)>/);
      const nameMatch  = from.match(/^"?([^"<]+)"?\s*</);
      const fromEmail  = emailMatch ? emailMatch[1] : (settings.smtp_email || from);
      const fromName   = nameMatch  ? nameMatch[1].trim() : (settings.from_name || 'DRM');
      await sendViaBrevoApi(settings.brevo_api_key, { from: fromEmail, fromName, to, subject, html });
    } else {
      // SMTP fallback
      const transporter = buildTransporter(settings);
      if (!transporter) throw new Error('No email provider configured');
      await transporter.sendMail({ from, to, subject, html });
    }

    run(`INSERT INTO email_log (id,org_id,to_email,subject,html_body,type,status,donor_id,donation_id)
         VALUES (?,?,?,?,?,'sent',?,?,?)`,
      [logId, orgId, to, subject, html||null, type, donorId, donationId]);
    console.log(`[email] ✓ ${type} → ${to}`);
    return { success: true };

  } catch(e) {
    run(`INSERT INTO email_log (id,org_id,to_email,subject,html_body,type,status,error,donor_id,donation_id)
         VALUES (?,?,?,?,?,'failed',?,?,?)`,
      [logId, orgId, to, subject, html||null, type, e.message, donorId, donationId]);
    console.error(`[email] ✗ ${type} → ${to} — ${e.message}`);
    throw e;
  }
}

module.exports = { sendMail, buildTransporter, fromAddr, sendViaBrevoApi };
