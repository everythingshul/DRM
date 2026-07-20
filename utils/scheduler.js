// utils/scheduler.js - Autopay, scheduled charges, emails
// Uses Sola (Cardknox) for CC processing — no Stripe
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const nodemailer = require('nodemailer');
const mailer    = require('./mailer');
const { ccSale: chargeToken } = require('./sola');
const tzUtil = require('./tz');

function getTransporter(settings) {
  if (!settings?.smtp_email) {
    console.log('[email] No SMTP email configured — skipping.');
    return null;
  }
  if (!settings?.smtp_password) {
    console.log('[email] No SMTP password configured — skipping.');
    return null;
  }
  const port = parseInt(settings.smtp_port) || 587;
  return nodemailer.createTransport({
    host: settings.smtp_host || 'smtp.gmail.com',
    port: port,
    secure: port === 465,
    auth: { user: settings.smtp_email, pass: settings.smtp_password }
  });
}

function interpolateTemplate(template, vars) {
  return template
    .replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] || '')  // {{var}} format
    .replace(/\{(\w+)\}/g,     (_, key) => vars[key] || ''); // {var} legacy format
}

async function sendReceiptEmail(donor, donation, org) {
  try {
    if (donor.donation_emails_paused) {
      console.log(`[receipt] Skipping — donation emails paused for donor ${donor.id}`);
      return;
    }


    const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [org.id]);
    if (!settings?.brevo_api_key && !settings?.smtp_email) {
      console.log(`[receipt] Skipping — no email provider configured for org ${org.id}. Add Brevo API key or Gmail SMTP in Email Settings.`);
      return;
    }
    if (!settings?.brevo_api_key && !settings?.smtp_email && !settings?.smtp_password) {
      console.log(`[receipt] Skipping — no email credentials for org ${org.id}.`);
      return;
    }
    if (settings.donation_emails_paused) {
      console.log(`[receipt] Skipping — donation emails paused for org ${org.id}`);
      return;
    }
    if (!donor.email) {
      console.log(`[receipt] Skipping — donor ${donor.id} (${donor.first_name} ${donor.last_name}) has no email address`);
      return;
    }
    const provider = settings.brevo_api_key ? 'api.brevo.com (Brevo API)' : `${settings.smtp_host||'smtp.gmail.com'}:${settings.smtp_port||587}`;
    console.log(`[receipt] Attempting to send to ${donor.email} via ${provider}`);

    const useBrevoApi = !!settings.brevo_api_key;
    const transporter = useBrevoApi ? null : mailer.buildTransporter(settings);
    if (!useBrevoApi && !transporter) {
      console.log('[receipt] No email provider configured — add Brevo API key or Gmail SMTP in Email Settings');
      return;
    }

    // Use default receipt template from designer if set, else fall back to plain
    const defaultTpl = get('SELECT * FROM email_templates WHERE org_id=? AND is_default_receipt=1', [org.id]);
    const pm = donation.payment_method_id ? get('SELECT * FROM payment_methods WHERE id = ?', [donation.payment_method_id]) : null;

    const vars = {
      donor_number:   donor.donor_number || '',
      title:          donor.title || '',
      hebrew_title:   donor.hebrew_title || '',
      first_name:     donor.first_name,
      last_name:      donor.last_name,
      hebrew_name:    donor.hebrew_full_name || '',
      amount:         `$${parseFloat(donation.amount).toFixed(2)}`,
      date:           tzUtil.fmtDateInTz(donation.donation_date, tzUtil.getOrgTimezone(org.id)),
      transaction_id: donation.transaction_id || 'N/A',
      method:         (donation.method||'').replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase()),
      last_four:      pm?.last_four || '',
      org_name:       org.name
    };

    let html, subject;
    if (defaultTpl) {
      const { renderBlocks } = require('../routes/email-templates');
      const blocks = (() => { try { return JSON.parse(defaultTpl.blocks||'[]'); } catch { return []; } })();
      html    = renderBlocks(blocks, vars);
      subject = defaultTpl.subject.replace(/\{\{(\w+)\}\}/g, (_,k)=>vars[k]||'');
    } else {
      subject = `Donation Receipt - ${org.name}`;
      html = interpolateTemplate(settings.receipt_template || `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
          <p>Dear {{title}} {{first_name}} {{last_name}},</p>
          <p>Thank you for your generous donation of <strong>{{amount}}</strong> on {{date}}.</p>
          <table style="width:100%;border-collapse:collapse;margin:12px 0">
            <tr><td style="padding:6px 0;color:#666">Donor ID:</td><td style="padding:6px 0">#{{donor_number}}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Amount:</td><td style="padding:6px 0;font-weight:bold">{{amount}}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Date:</td><td style="padding:6px 0">{{date}}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Method:</td><td style="padding:6px 0">{{method}}</td></tr>
            <tr><td style="padding:6px 0;color:#666">Transaction ID:</td><td style="padding:6px 0">{{transaction_id}}</td></tr>
          </table>
          <p style="font-size:12px;color:#888;border-top:1px solid #eee;padding-top:10px">
            Tax ID: 11-6076986 &nbsp;|&nbsp; {{org_name}}<br>
            No goods or services were provided in exchange for this donation.
          </p>
          <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center">
            <div style="font-size:10px;color:#9ca3af;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px">Powered By</div>
            <a href="https://everythingshul.com" target="_blank" style="text-decoration:none">
              <img src="https://drm.everythingshul.com/img/logo.png" alt="EverythingShul"
                style="height:28px;width:auto;display:block;margin:0 auto;opacity:0.75">
            </a>
          </div>
        </div>`, vars);
    }

    await mailer.sendMail({
      settings, orgId: org.id,
      to: donor.email,
      from: `"${settings.from_name || org.name}" <${settings.smtp_email || 'noreply@everythingshul.com'}>`,
      subject, html,
      type: 'receipt',
      donorId: donor.id, donationId: donation.id
    });
    run('UPDATE donations SET receipt_sent = 1 WHERE id = ?', [donation.id]);
  } catch (e) {
    console.error(`[receipt] ✗ FAILED to ${donor?.email} — ${e.message}`);
  }
}

async function sendChargeNotificationToOwner(org, donor, donation, success, failReason) {
  try {
    const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [org.id]);
    if (!settings?.smtp_email) return;

    const admins = all(`
      SELECT u.email, u.full_name FROM users u
      JOIN org_users ou ON u.id = ou.user_id
      WHERE ou.org_id = ? AND ou.role = 'admin'
    `, [org.id]);

    const transporter = getTransporter(settings);
    if (!transporter || !admins.length) return;

    const amount = donation?.amount ? `$${parseFloat(donation.amount).toFixed(2)}` : 'N/A';
    const donorName = `${donor.first_name} ${donor.last_name}`;

    const subject = success
      ? `✅ Charge Processed — ${donorName} ${amount}`
      : `❌ Charge FAILED — ${donorName} ${amount}`;

    const poweredBy = `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #e5e7eb;text-align:center">
      <div style="font-size:10px;color:#9ca3af;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:8px">Powered By</div>
      <a href="https://everythingshul.com" target="_blank" style="text-decoration:none">
        <img src="https://drm.everythingshul.com/img/logo.png" alt="EverythingShul"
          style="height:28px;width:auto;display:block;margin:0 auto;opacity:0.75">
      </a>
    </div>`;

    const html = success
      ? `<p>A scheduled charge of <strong>${amount}</strong> was successfully processed for <strong>${donorName}</strong>.</p>
         <p>Date: ${tzUtil.fmtDateTimeInTz(new Date(), tzUtil.getOrgTimezone(org.id))}</p>
         <p>Transaction ID: ${donation.transaction_id || 'N/A'}</p>
         ${donor.email ? `<p>Donor email: ${donor.email}</p>` : ''}${poweredBy}`
      : `<p>A scheduled charge of <strong>${amount}</strong> <span style="color:red;font-weight:bold;">FAILED</span> for <strong>${donorName}</strong>.</p>
         <p>Date: ${tzUtil.fmtDateTimeInTz(new Date(), tzUtil.getOrgTimezone(org.id))}</p>
         <p>Reason: <strong>${failReason || 'Unknown'}</strong></p>
         <p>Please log in to DRM to review and retry this charge.</p>
         ${donor.email ? `<p>Donor email: ${donor.email}</p>` : ''}${poweredBy}`;

    for (const admin of admins) {
      await transporter.sendMail({
        from: `"${settings.from_name || org.name} DRM" <${settings.smtp_email}>`,
        to: admin.email,
        subject,
        html
      });
    }
  } catch (e) {
    console.error('Owner notification error:', e.message);
  }
}

async function processScheduledCharge(charge) {
  const donor = get('SELECT * FROM donors WHERE id = ?', [charge.donor_id]);
  const pm = get('SELECT * FROM payment_methods WHERE id = ?', [charge.payment_method_id]);
  const org = get('SELECT * FROM organizations WHERE id = ?', [charge.org_id]);
  if (!donor || !pm || !org) return;

  try {
    let txResult;

    if (pm.type === 'credit_card' && pm.sola_token) {
      // Charge via Sola using saved xToken
      txResult = await chargeToken(org.id, {
        token: pm.sola_token,
        amount: charge.amount,
        name: `${donor.first_name} ${donor.last_name}`,
        zip: donor.zip || '',
        email: donor.email || '',
        invoiceNum: charge.id.slice(0, 16),
        customNote: charge.notes || 'DRM Scheduled Charge'
      });

      const donId = uuidv4();
      run(`INSERT INTO donations (id, org_id, donor_id, amount, method, payment_method_id, transaction_id, donation_date, status, is_autopay)
           VALUES (?, ?, ?, ?, 'credit_card', ?, ?, CURRENT_TIMESTAMP, 'completed', ?)`,
        [donId, charge.org_id, charge.donor_id, charge.amount, pm.id,
         txResult.refNum, charge.is_autopay ? 1 : 0]);

      run('UPDATE scheduled_charges SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?', ['completed', charge.id]);

      const donation = get('SELECT * FROM donations WHERE id = ?', [donId]);
      await sendReceiptEmail(donor, donation, org);
      await sendChargeNotificationToOwner(org, donor, donation, true, null);

    } else {
      // DAF or other non-card method — log as pending for manual processing
      const donId = uuidv4();
      run(`INSERT INTO donations (id, org_id, donor_id, amount, method, payment_method_id, donation_date, status, is_autopay, notes)
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'pending', ?, 'Scheduled charge — manual processing required')`,
        [donId, charge.org_id, charge.donor_id, charge.amount, pm.type, pm.id, charge.is_autopay ? 1 : 0]);

      run('UPDATE scheduled_charges SET status = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?', ['completed', charge.id]);

      const donation = get('SELECT * FROM donations WHERE id = ?', [donId]);
      await sendChargeNotificationToOwner(org, donor, donation, true, null);
    }

  } catch (e) {
    const reason = e.message || 'Unknown error';
    run('UPDATE scheduled_charges SET status = ?, failure_reason = ?, processed_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['failed', reason, charge.id]);

    run(`INSERT INTO charge_failures (id, org_id, donor_id, scheduled_charge_id, amount, failure_reason, payment_method_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), charge.org_id, charge.donor_id, charge.id, charge.amount, reason, charge.payment_method_id]);

    await sendChargeNotificationToOwner(org, donor, { amount: charge.amount }, false, reason);
    console.error(`Charge failed for ${donor.first_name} ${donor.last_name}: ${reason}`);
  }
}

async function processAutopay() {
  // The server clock runs in UTC — "day 1 at 9am" configured by an org admin means
  // 9am in THEIR org's timezone, not 9am UTC. Pull every enabled-autopay donor along
  // with their org's timezone, then compare against that org-local day/hour/minute.
  const now = new Date();
  const donors = all(`
    SELECT d.*, o.settings as org_settings FROM donors d
    JOIN organizations o ON o.id = d.org_id
    WHERE d.autopay_enabled = 1 AND d.autopay_paused = 0
  `, []);

  const matching = donors.filter(donor => {
    let tz = 'America/New_York';
    try { tz = JSON.parse(donor.org_settings || '{}').timezone || tz; } catch {}
    let parts;
    try {
      parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, day: 'numeric', hour: 'numeric', minute: 'numeric', hour12: false
      }).formatToParts(now).reduce((acc, p) => { acc[p.type] = parseInt(p.value); return acc; }, {});
    } catch { return false; }
    const localDay = parts.day, localHour = parts.hour === 24 ? 0 : parts.hour, localMinute = parts.minute;
    return donor.autopay_day === localDay && donor.autopay_hour === localHour
      && (donor.autopay_minute === localMinute || donor.autopay_minute === 0);
  });

  for (const donor of matching) {
    const alreadyCharged = get(`
      SELECT id FROM donations
      WHERE donor_id = ? AND is_autopay = 1
        AND strftime('%Y-%m', donation_date) = strftime('%Y-%m', 'now')
        AND status IN ('completed', 'pending')
    `, [donor.id]);
    if (alreadyCharged) continue;

    const pm = get('SELECT * FROM payment_methods WHERE donor_id = ? AND is_default = 1', [donor.id])
      || get('SELECT * FROM payment_methods WHERE donor_id = ? LIMIT 1', [donor.id]);
    if (!pm) continue;

    const lastDon = get(`SELECT amount FROM donations WHERE donor_id = ? AND is_autopay = 1 ORDER BY donation_date DESC LIMIT 1`, [donor.id])
      || get(`SELECT amount FROM donations WHERE donor_id = ? ORDER BY donation_date DESC LIMIT 1`, [donor.id]);
    if (!lastDon) continue;

    const fakeCharge = {
      id: 'autopay-' + uuidv4(),
      org_id: donor.org_id,
      donor_id: donor.id,
      payment_method_id: pm.id,
      amount: lastDon.amount,
      is_autopay: 1,
      notes: 'Monthly AutoPay'
    };
    await processScheduledCharge(fakeCharge);
  }
}

async function processScheduledEmails() {
  const pending = all(`SELECT se.* FROM scheduled_emails se WHERE se.status='pending'`, []);
  const due = pending.filter(se => {
    try {
      const scheduledUtc = new Date(se.scheduled_for + (se.scheduled_for.includes('Z') || se.scheduled_for.includes('+') ? '' : 'Z'));
      return scheduledUtc <= new Date();
    } catch { return false; }
  });

  for (const email of due) {
    try {
      const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [email.org_id]);
      if (!settings?.brevo_api_key && (!settings?.smtp_email || !settings?.smtp_password)) {
        run('UPDATE scheduled_emails SET status=?, failure_reason=? WHERE id=?', ['failed', 'No email provider configured', email.id]);
        continue;
      }

      // Determine recipients based on recipient_group
      let recipients = [];
      const group = email.recipient_group || 'all_donors';

      if (group === 'all_donors') {
        const donors = all('SELECT email FROM donors WHERE org_id=? AND email IS NOT NULL AND email != "" AND donation_emails_paused=0', [email.org_id]);
        recipients = donors.map(d => d.email);
      } else if (group.startsWith('label:')) {
        const label = group.replace('label:', '');
        const donors = all('SELECT email, labels FROM donors WHERE org_id=? AND email IS NOT NULL AND email != "" AND donation_emails_paused=0', [email.org_id]);
        recipients = donors.filter(d => {
          try { return JSON.parse(d.labels||'[]').includes(label); } catch { return false; }
        }).map(d => d.email);
      } else if (email.donor_id) {
        const donor = get('SELECT email FROM donors WHERE id=?', [email.donor_id]);
        if (donor?.email) recipients = [donor.email];
      } else {
        // Fallback to org admin email
        if (settings.smtp_email) recipients = [settings.smtp_email];
      }

      if (!recipients.length) {
        run('UPDATE scheduled_emails SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?', ['sent', email.id]);
        continue;
      }

      const org = get('SELECT * FROM organizations WHERE id=?', [email.org_id]);
      const from = `"${settings.from_name || org?.name || 'DRM'}" <${settings.smtp_email || 'noreply@everythingshul.com'}>`;

      let sent = 0, failed = 0;
      for (const to of recipients) {
        try {
          await mailer.sendMail({
            settings, orgId: email.org_id,
            to, from,
            subject: email.subject,
            html: email.html_body,
            type: 'scheduled'
          });
          sent++;
        } catch(e) {
          failed++;
          console.error(`[scheduled] Failed to ${to}: ${e.message}`);
        }
      }

      run('UPDATE scheduled_emails SET status=?, sent_at=CURRENT_TIMESTAMP WHERE id=?', ['sent', email.id]);
      console.log(`[scheduled] Email "${email.subject}" sent to ${sent} recipients, ${failed} failed`);
    } catch(e) {
      run('UPDATE scheduled_emails SET status=?, failure_reason=? WHERE id=?', ['failed', e.message, email.id]);
    }
  }
}

async function processExpiryWarnings() {
  const { all, get, run } = require('../db/schema');
  const nodemailer = require('nodemailer');
  const now = new Date();

  // Find orgs with expiry dates that haven't been fully warned
  const orgs = all(`
    SELECT o.*, es.smtp_email, es.smtp_password, es.smtp_host, es.smtp_port,
           es.from_name, es.postmark_key, es.brevo_api_key
    FROM organizations o
    LEFT JOIN email_settings es ON es.org_id = o.id
    WHERE o.expires_at IS NOT NULL
  `, []);

  for (const org of orgs) {
    const expiry = new Date(org.expires_at);
    const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
    const warned = org.expiry_warned || 0;

    // Warning levels: 14 days = bit 1, 7 days = bit 2, 1 day = bit 4
    const warnings = [
      { days: 14, bit: 1 },
      { days: 7,  bit: 2 },
      { days: 1,  bit: 4 }
    ];

    for (const w of warnings) {
      if (daysLeft <= w.days && daysLeft > 0 && !(warned & w.bit)) {
        // Send warning email to all org admins
        const admins = all(`
          SELECT u.email, u.full_name FROM users u
          JOIN org_users ou ON ou.user_id = u.id
          WHERE ou.org_id = ? AND ou.role IN ('admin','org_admin')
        `, [org.id]);

        const expiryStr = tzUtil.fmtDateInTz(expiry, tzUtil.getOrgTimezone(org.id), { month:'long', day:'numeric', year:'numeric' });
        const html = `
          <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto">
            <h2 style="color:#d63031">Account Expiring in ${daysLeft} Day${daysLeft>1?'s':''}</h2>
            <p>Your <strong>${org.name}</strong> DRM account subscription expires on <strong>${expiryStr}</strong>.</p>
            <p>After expiration, your data will be preserved but:</p>
            <ul>
              <li>Recurring donations will stop processing</li>
              <li>Team members will not be able to log in</li>
            </ul>
            <p>Please contact <a href="mailto:support@everythingshul.com">support@everythingshul.com</a> to renew your subscription.</p>
            <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
            <p style="color:#9ca3af;font-size:12px">DRM – Powered by EverythingShul</p>
          </div>`;

        // Send via Postmark or SMTP
        let transporter;
        if (org.smtp_email && org.smtp_password) {
          transporter = nodemailer.createTransport({ host:org.smtp_host||'smtp.gmail.com', port:org.smtp_port||587, secure:false, auth:{user:org.smtp_email, pass:org.smtp_password} });
        }

        if (transporter) {
          for (const admin of admins) {
            try {
              await mailer.sendMail({
                transporter, orgId: org.id,
                to: admin.email,
                from: `"EverythingShul DRM" <${org.smtp_email || 'noreply@everythingshul.com'}>`,
                subject: `Action Required: DRM Account Expires in ${daysLeft} Day${daysLeft>1?'s':''}`,
                html, type: 'expiry_warning',
                headers: {}
              });
            } catch(e) { console.error(`[expiry] Warning email failed: ${e.message}`); }
          }
        }

        // Mark this warning level as sent (bitwise OR)
        run('UPDATE organizations SET expiry_warned = ? WHERE id = ?', [warned | w.bit, org.id]);
      }
    }
  }
}

async function processRecurringSchedules() {
  const due = all(`
    SELECT rs.*, d.first_name, d.last_name, d.email, d.zip
    FROM recurring_schedules rs
    JOIN donors d ON rs.donor_id = d.id
    WHERE rs.status = 'active'
      AND rs.next_run <= datetime('now')
      AND (rs.end_date IS NULL OR rs.next_run <= rs.end_date)
      AND (rs.occurrences_limit IS NULL OR rs.occurrences_count < rs.occurrences_limit)
  `, []);

  for (const sched of due) {
    const pm = get('SELECT * FROM payment_methods WHERE id = ?', [sched.payment_method_id]);
    const org = get('SELECT * FROM organizations WHERE id = ?', [sched.org_id]);
    const donor = get('SELECT * FROM donors WHERE id = ?', [sched.donor_id]);
    if (!pm || !org || !donor) continue;

    try {
      let txId = null;

      if (pm.type === 'credit_card' && pm.sola_token) {
        const result = await chargeToken(sched.org_id, {
          token: pm.sola_token,
          amount: sched.amount,
          name: `${donor.first_name} ${donor.last_name}`,
          zip: donor.zip || '',
          email: donor.email || '',
          invoiceNum: sched.id.slice(0, 16),
          customNote: `Recurring ${sched.frequency} charge`
        });
        txId = result.refNum;
      }

      // Fix #12: If this was a CC charge, txId MUST exist (Sola confirmed)
      // For other methods (check, cash, wire), donation is recorded without txId (manual collection needed)
      if (pm.type === 'credit_card' && !txId) {
        throw new Error('Sola did not confirm charge — no transaction ID returned');
      }

      const donId = uuidv4();
      run(`INSERT INTO donations (id, org_id, donor_id, amount, method, payment_method_id, transaction_id, donation_date, status, is_recurring, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'completed', 1, ?, 'system')`,
        [donId, sched.org_id, sched.donor_id, sched.amount, pm.type, pm.id, txId,
         `Recurring ${sched.frequency} — ${sched.notes || ''}`]);

      // Calculate next run
      const nextRun = calcNextRun(sched.next_run, sched.frequency);
      const newCount = (sched.occurrences_count || 0) + 1;
      const limitHit = sched.occurrences_limit && newCount >= sched.occurrences_limit;
      const endHit = sched.end_date && new Date(nextRun) > new Date(sched.end_date);

      run(`UPDATE recurring_schedules SET
           next_run = ?, occurrences_count = ?, last_run = CURRENT_TIMESTAMP, last_failure = NULL,
           status = ?
           WHERE id = ?`,
        [nextRun, newCount, (limitHit || endHit) ? 'completed' : 'active', sched.id]);

      const donation = get('SELECT * FROM donations WHERE id = ?', [donId]);
      await sendReceiptEmail(donor, donation, org);
      await sendChargeNotificationToOwner(org, donor, donation, true, null);

    } catch (e) {
      // Advance next_run to the NEXT occurrence date — this failed occurrence is skipped,
      // not retried. Status stays 'active' so future scheduled dates still run.
      // One failure email is sent now; the next occurrence will try again fresh.
      const nextRun = calcNextRun(sched.next_run, sched.frequency);
      const limitHit = sched.occurrences_limit && (sched.occurrences_count || 0) >= sched.occurrences_limit;
      const endHit   = sched.end_date && new Date(nextRun) > new Date(sched.end_date);

      run(`UPDATE recurring_schedules SET last_failure = ?, next_run = ?, status = ? WHERE id = ?`,
        [e.message, nextRun, (limitHit || endHit) ? 'completed' : 'active', sched.id]);

      run(`INSERT INTO charge_failures (id, org_id, donor_id, amount, failure_reason, payment_method_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), sched.org_id, sched.donor_id, sched.amount, e.message, sched.payment_method_id]);

      // Send exactly one notification for this failed occurrence
      await sendChargeNotificationToOwner(org, donor, { amount: sched.amount }, false, e.message).catch(()=>{});
    }
  }
}

function calcNextRun(fromDate, frequency) {
  const d = new Date(fromDate);
  switch (frequency) {
    case 'weekly':    d.setDate(d.getDate() + 7); break;
    case 'biweekly':  d.setDate(d.getDate() + 14); break;
    case 'monthly':   d.setMonth(d.getMonth() + 1); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3); break;
    case 'yearly':    d.setFullYear(d.getFullYear() + 1); break;
    case 'once':      return null;
    default:          d.setMonth(d.getMonth() + 1);
  }
  return d.toISOString();
}

async function processScheduledOneTimeCharges() {
  const allPending = all(`SELECT * FROM scheduled_charges WHERE status='pending'`, []);
  const due = allPending.filter(c => {
    try {
      const scheduledUtc = new Date(c.scheduled_for + (c.scheduled_for.includes('Z') || c.scheduled_for.includes('+') ? '' : 'Z'));
      return scheduledUtc <= new Date();
    } catch { return false; }
  });
  for (const charge of due) await processScheduledCharge(charge);
}

async function runDailyBackup() {
  const fs   = require('fs');
  const path = require('path');
  const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '../data');
  const DB_PATH    = path.join(DATA_DIR, 'drm.db');
  const BACKUP_DIR = path.join(DATA_DIR, 'backups');

  if (!fs.existsSync(DB_PATH)) {
    console.log('[backup] No DB file found, skipping backup');
    return;
  }

  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const date  = new Date().toISOString().slice(0, 10);
  const dest  = path.join(BACKUP_DIR, `drm-${date}.db`);

  // Copy the file
  fs.copyFileSync(DB_PATH, dest);
  const size = fs.statSync(dest).size;
  console.log(`[backup] ✓ Daily backup saved: ${dest} (${(size/1024).toFixed(1)} KB)`);

  // Keep only the last 30 backups
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('drm-') && f.endsWith('.db'))
    .sort(); // oldest first
  if (files.length > 30) {
    const toDelete = files.slice(0, files.length - 30);
    for (const f of toDelete) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      console.log(`[backup] Removed old backup: ${f}`);
    }
  }

  // Optional: upload to S3-compatible storage (Cloudflare R2, AWS S3, etc.)
  const S3_BUCKET   = process.env.BACKUP_S3_BUCKET;
  const S3_KEY      = process.env.BACKUP_S3_KEY;
  const S3_SECRET   = process.env.BACKUP_S3_SECRET;
  const S3_ENDPOINT = process.env.BACKUP_S3_ENDPOINT; // e.g. https://xxx.r2.cloudflarestorage.com
  if (S3_BUCKET && S3_KEY && S3_SECRET) {
    try {
      const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
      const fileBuffer = fs.readFileSync(dest);
      const s3 = new S3Client({
        region: process.env.BACKUP_S3_REGION || 'auto',
        endpoint: S3_ENDPOINT || undefined,
        credentials: { accessKeyId: S3_KEY, secretAccessKey: S3_SECRET },
        forcePathStyle: true  // required for R2
      });
      await s3.send(new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: `backups/drm-${date}.db`,
        Body: fileBuffer,
        ContentType: 'application/octet-stream'
      }));
      console.log(`[backup] ✓ Uploaded to R2: backups/drm-${date}.db`);
    } catch(e) { console.error(`[backup] R2 upload failed: ${e.message}`); }
  }

}

function _todayInTz(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());
  } catch { return new Date().toISOString().slice(0,10); }
}

async function processFollowupNotifications() {
  // Compute "today" separately per org, in that org's own configured timezone —
  // a follow-up scheduled for a given calendar date should only fire on that date
  // as experienced by the org, not by the server's UTC clock.
  const orgs = all('SELECT id, settings FROM organizations', []);
  for (const org of orgs) {
    let tz = 'UTC';
    try { tz = JSON.parse(org.settings||'{}').timezone || 'UTC'; } catch {}
    const today = _todayInTz(tz);

    const due = all(`
      SELECT lf.*, l.first_name, l.last_name, l.org_id, l.assigned_to
      FROM lead_followups lf
      JOIN leads l ON l.id = lf.lead_id
      WHERE l.org_id = ? AND lf.next_followup_date = ? AND lf.notified = 0 AND l.assigned_to IS NOT NULL
        AND l.next_followup_date = lf.next_followup_date
    `, [org.id, today]);

    for (const fu of due) {
      try {
        // Notify assigned fundraiser
        run(`INSERT INTO notifications (id, org_id, user_id, type, title, body, link)
             VALUES (?, ?, ?, 'followup_due', ?, ?, ?)`,
          [require('uuid').v4(), fu.org_id, fu.assigned_to,
           `Follow-up due: ${fu.first_name||''} ${fu.last_name||''}`,
           `Scheduled follow-up today. Notes: ${fu.notes?.slice(0,80)||'—'}`,
           `#leads/${fu.lead_id}`]);
        // Also notify org admins
        const admins = all(`SELECT u.id FROM users u JOIN org_users ou ON ou.user_id=u.id
          WHERE ou.org_id=? AND ou.role='admin' AND u.id!=?`, [fu.org_id, fu.assigned_to]);
        for (const admin of admins) {
          run(`INSERT INTO notifications (id, org_id, user_id, type, title, body, link) VALUES (?, ?, ?, 'followup_due', ?, ?, ?)`,
            [require('uuid').v4(), fu.org_id, admin.id,
             `Follow-up due: ${fu.first_name||''} ${fu.last_name||''}`,
             `Assigned to ${fu.done_by_name||'staff'}. Follow-up scheduled today.`,
             `#leads/${fu.lead_id}`]);
        }
        run('UPDATE lead_followups SET notified=1 WHERE id=?', [fu.id]);
        console.log(`[followup] Notified for lead ${fu.lead_id} (org tz: ${tz}, org-local date: ${today})`);
      } catch(e) {
        console.error(`[followup] Notification error: ${e.message}`);
      }
    }
  }
}

function startScheduler() {
  cron.schedule('* * * * *', async () => {
    try {
      await processScheduledOneTimeCharges();
      await processRecurringSchedules();
      await processScheduledEmails();
    } catch (e) { console.error('Scheduler error:', e.message); }
  });

  cron.schedule('0 * * * *', async () => {
    try { await processAutopay(); }
    catch (e) { console.error('Autopay error:', e.message); }
  });

  // Check expiry warnings once a day at 9am
  cron.schedule('0 9 * * *', async () => {
    try { await processExpiryWarnings(); }
    catch(e) { console.error('Expiry warning error:', e.message); }
  });

  // Check follow-up notifications every hour
  cron.schedule('0 * * * *', async () => {
    try { await processFollowupNotifications(); }
    catch(e) { console.error('Follow-up notification error:', e.message); }
  });

  // Daily backup at 2am
  cron.schedule('0 2 * * *', async () => {
    try { await runDailyBackup(); }
    catch(e) { console.error('Backup error:', e.message); }
  });

  // Run one backup on startup so there's always a fresh copy
  setTimeout(() => runDailyBackup().catch(e => console.error('Startup backup error:', e.message)), 10000);

  console.log('✅ Scheduler started');
}

module.exports = { startScheduler, sendReceiptEmail, sendChargeNotificationToOwner, runDailyBackup };
