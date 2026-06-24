// utils/mailer.js — centralised email sender with automatic DB logging
'use strict';
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');

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
          donorId = null, donationId = null, headers = {} } = opts;

  // Always use the lazy require so we never have a circular dep at load time
  const { run } = require('../db/schema');
  const logId = uuidv4();

  try {
    await transporter.sendMail({ from, to, subject, html, headers });
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
  if (settings.postmark_key) {
    return nodemailer.createTransport({
      host: 'smtp.postmarkapp.com', port: 587, secure: false,
      auth: { user: settings.postmark_key, pass: settings.postmark_key }
    });
  }
  if (settings.smtp_email && settings.smtp_password) {
    return nodemailer.createTransport({
      host: settings.smtp_host || 'smtp.gmail.com',
      port: settings.smtp_port || 587,
      secure: false,
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

module.exports = { sendMail, buildTransporter, fromAddr, pmHeaders };
