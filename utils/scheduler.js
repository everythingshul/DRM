// utils/scheduler.js - Autopay, scheduled charges, emails
// Uses Sola (Cardknox) for CC processing — no Stripe
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const nodemailer = require('nodemailer');
const { chargeToken } = require('./sola');

function getTransporter(settings) {
  if (!settings?.smtp_email || !settings?.smtp_password) return null;
  return nodemailer.createTransport({
    host: settings.smtp_host || 'smtp.gmail.com',
    port: settings.smtp_port || 587,
    secure: false,
    auth: { user: settings.smtp_email, pass: settings.smtp_password }
  });
}

function interpolateTemplate(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
}

async function sendReceiptEmail(donor, donation, org) {
  try {
    if (donor.donation_emails_paused) return;
    const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [org.id]);
    if (!settings?.smtp_email || settings.donation_emails_paused) return;

    const transporter = getTransporter(settings);
    if (!transporter) return;

    const template = settings.receipt_template || `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto">
        <p>Dear {title} {first_name} {last_name},</p>
        <p>Thank you for your generous donation of <strong>{amount}</strong> on {date}.</p>
        <table style="width:100%;border-collapse:collapse;margin:12px 0">
          <tr><td style="padding:6px 0;color:#666">Amount:</td><td style="padding:6px 0;font-weight:bold">{amount}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Date:</td><td style="padding:6px 0">{date}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Method:</td><td style="padding:6px 0">{method}</td></tr>
          <tr><td style="padding:6px 0;color:#666">Transaction ID:</td><td style="padding:6px 0">{transaction_id}</td></tr>
        </table>
        <p style="font-size:12px;color:#888;border-top:1px solid #eee;padding-top:10px">
          Tax ID: 11-6076986 &nbsp;|&nbsp; {org_name}<br>
          No goods or services were provided in exchange for this donation.
        </p>
      </div>
    `;

    const pm = donation.payment_method_id ? get('SELECT * FROM payment_methods WHERE id = ?', [donation.payment_method_id]) : null;
    const html = interpolateTemplate(template, {
      title: donor.title || '',
      first_name: donor.first_name,
      last_name: donor.last_name,
      hebrew_name: donor.hebrew_full_name || '',
      amount: `$${parseFloat(donation.amount).toFixed(2)}`,
      date: new Date(donation.donation_date).toLocaleDateString(),
      transaction_id: donation.transaction_id || 'N/A',
      method: donation.method,
      last_four: pm?.last_four || '',
      org_name: org.name
    });

    if (donor.email) {
      await transporter.sendMail({
        from: `"${settings.from_name || org.name}" <${settings.smtp_email}>`,
        to: donor.email,
        subject: `Donation Receipt - ${org.name}`,
        html
      });
      run('UPDATE donations SET receipt_sent = 1 WHERE id = ?', [donation.id]);
    }
  } catch (e) {
    console.error('Receipt email error:', e.message);
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

    const html = success
      ? `<p>A scheduled charge of <strong>${amount}</strong> was successfully processed for <strong>${donorName}</strong>.</p>
         <p>Date: ${new Date().toLocaleString()}</p>
         <p>Transaction ID: ${donation.transaction_id || 'N/A'}</p>
         ${donor.email ? `<p>Donor email: ${donor.email}</p>` : ''}`
      : `<p>A scheduled charge of <strong>${amount}</strong> <span style="color:red;font-weight:bold;">FAILED</span> for <strong>${donorName}</strong>.</p>
         <p>Date: ${new Date().toLocaleString()}</p>
         <p>Reason: <strong>${failReason || 'Unknown'}</strong></p>
         <p>Please log in to DRM to review and retry this charge.</p>
         ${donor.email ? `<p>Donor email: ${donor.email}</p>` : ''}`;

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
  const now = new Date();
  const day = now.getDate();
  const hour = now.getHours();
  const minute = now.getMinutes();

  const donors = all(`
    SELECT d.* FROM donors d
    WHERE d.autopay_enabled = 1 AND d.autopay_paused = 0
      AND d.autopay_day = ? AND d.autopay_hour = ?
      AND (d.autopay_minute = ? OR d.autopay_minute = 0)
  `, [day, hour, minute]);

  for (const donor of donors) {
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
  const due = all(`
    SELECT se.* FROM scheduled_emails se
    WHERE se.status = 'pending' AND se.scheduled_for <= datetime('now')
  `, []);

  for (const email of due) {
    try {
      const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [email.org_id]);
      if (!settings?.smtp_email) { run('UPDATE scheduled_emails SET status = ? WHERE id = ?', ['failed', email.id]); continue; }
      const transporter = getTransporter(settings);
      if (!transporter) { run('UPDATE scheduled_emails SET status = ? WHERE id = ?', ['failed', email.id]); continue; }

      let to = settings.smtp_email;
      if (email.donor_id) {
        const donor = get('SELECT email FROM donors WHERE id = ?', [email.donor_id]);
        if (donor?.email) to = donor.email;
      }

      await transporter.sendMail({
        from: `"${settings.from_name}" <${settings.smtp_email}>`,
        to,
        subject: email.subject,
        html: email.html_body
      });
      run('UPDATE scheduled_emails SET status = ?, sent_at = CURRENT_TIMESTAMP WHERE id = ?', ['sent', email.id]);
    } catch (e) {
      run('UPDATE scheduled_emails SET status = ?, failure_reason = ? WHERE id = ?', ['failed', e.message, email.id]);
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
      run(`UPDATE recurring_schedules SET last_failure = ?, status = 'active' WHERE id = ?`,
        [e.message, sched.id]);

      run(`INSERT INTO charge_failures (id, org_id, donor_id, amount, failure_reason, payment_method_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), sched.org_id, sched.donor_id, sched.amount, e.message, sched.payment_method_id]);

      await sendChargeNotificationToOwner(org, donor, { amount: sched.amount }, false, e.message);
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
  const due = all(`
    SELECT * FROM scheduled_charges
    WHERE status = 'pending' AND scheduled_for <= datetime('now')
  `, []);
  for (const charge of due) await processScheduledCharge(charge);
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

  console.log('✅ Scheduler started');
}

module.exports = { startScheduler, sendReceiptEmail, sendChargeNotificationToOwner };
