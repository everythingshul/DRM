// routes/org.js - org settings, email, stats, reports, charge failures
const express = require('express');
const router = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');
const nodemailer = require('nodemailer');
const XLSX = require('xlsx');

router.use(requireAuth, requireOrg);

// --- ORG INFO ---
router.get('/info', (req, res) => res.json(req.org));

router.put('/info', requireOrgAdmin, (req, res) => {
  const { name, settings } = req.body;
  run('UPDATE organizations SET name = ?, settings = ? WHERE id = ?',
    [name || req.org.name, settings ? JSON.stringify(settings) : req.org.settings, req.orgId]);
  res.json({ success: true, org: get('SELECT * FROM organizations WHERE id = ?', [req.orgId]) });
});

// --- EMAIL SETTINGS ---
router.get('/email-settings', requireOrgAdmin, (req, res) => {
  const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]);
  if (settings) delete settings.smtp_password; // never expose password
  res.json(settings);
});

router.put('/email-settings', requireOrgAdmin, (req, res) => {
  const { smtp_email, smtp_password, smtp_host, smtp_port, from_name, receipt_template, marketing_template, donation_emails_paused } = req.body;
  const existing = get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]);

  if (!existing) {
    run(`INSERT INTO email_settings (id, org_id, smtp_email, smtp_password, smtp_host, smtp_port, from_name, receipt_template, marketing_template, donation_emails_paused)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [uuidv4(), req.orgId, smtp_email, smtp_password || '', smtp_host || 'smtp.gmail.com', smtp_port || 587, from_name || '', receipt_template || '', marketing_template || '', donation_emails_paused ? 1 : 0]);
  } else {
    const newPass = smtp_password ? smtp_password : existing.smtp_password;
    run(`UPDATE email_settings SET smtp_email = ?, smtp_password = ?, smtp_host = ?, smtp_port = ?, from_name = ?,
         receipt_template = ?, marketing_template = ?, donation_emails_paused = ?, updated_at = CURRENT_TIMESTAMP
         WHERE org_id = ?`,
      [smtp_email ?? existing.smtp_email, newPass, smtp_host ?? existing.smtp_host, smtp_port ?? existing.smtp_port,
       from_name ?? existing.from_name, receipt_template ?? existing.receipt_template,
       marketing_template ?? existing.marketing_template,
       donation_emails_paused !== undefined ? (donation_emails_paused ? 1 : 0) : existing.donation_emails_paused,
       req.orgId]);
  }
  res.json({ success: true });
});

// Send test email
router.post('/email-settings/test', requireOrgAdmin, async (req, res) => {
  try {
    const { to, subject, html } = req.body;
    const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]);
    if (!settings?.smtp_email) return res.status(400).json({ error: 'Email not configured' });

    const transporter = nodemailer.createTransport({
      host: settings.smtp_host || 'smtp.gmail.com',
      port: settings.smtp_port || 587,
      secure: false,
      auth: { user: settings.smtp_email, pass: settings.smtp_password }
    });

    await transporter.sendMail({
      from: `"${settings.from_name || 'DRM'}" <${settings.smtp_email}>`,
      to: to || settings.smtp_email,
      subject: subject || 'DRM Test Email',
      html: html || '<p>This is a test email from your DRM system.</p>'
    });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- SCHEDULED EMAILS ---
router.get('/scheduled-emails', (req, res) => {
  const emails = all('SELECT * FROM scheduled_emails WHERE org_id = ? ORDER BY scheduled_for DESC', [req.orgId]);
  res.json(emails);
});

router.post('/scheduled-emails', (req, res) => {
  const { donor_id, subject, html_body, scheduled_for } = req.body;
  if (!subject || !html_body || !scheduled_for) return res.status(400).json({ error: 'Subject, body and date required' });
  const id = uuidv4();
  run('INSERT INTO scheduled_emails (id, org_id, donor_id, subject, html_body, scheduled_for) VALUES (?, ?, ?, ?, ?, ?)',
    [id, req.orgId, donor_id || null, subject, html_body, scheduled_for]);
  res.json({ success: true, email: get('SELECT * FROM scheduled_emails WHERE id = ?', [id]) });
});

router.delete('/scheduled-emails/:id', (req, res) => {
  run('UPDATE scheduled_emails SET status = ? WHERE id = ? AND org_id = ?', ['cancelled', req.params.id, req.orgId]);
  res.json({ success: true });
});

// --- STATS ---
router.get('/stats', (req, res) => {
  const { from, to } = req.query;
  let dateFilter = '';
  const params = [req.orgId];

  if (from && to) {
    dateFilter = ' AND donation_date BETWEEN ? AND ?';
    params.push(from, to);
  }

  const totalDonors = get('SELECT COUNT(*) as n FROM donors WHERE org_id = ?', [req.orgId])?.n || 0;
  const activeDonors = get(`SELECT COUNT(DISTINCT donor_id) as n FROM donations WHERE org_id = ?${dateFilter} AND status = 'completed'`, params)?.n || 0;
  const totalAmount = get(`SELECT COALESCE(SUM(amount),0) as n FROM donations WHERE org_id = ?${dateFilter} AND status = 'completed'`, params)?.n || 0;
  const totalDonations = get(`SELECT COUNT(*) as n FROM donations WHERE org_id = ?${dateFilter} AND status = 'completed'`, params)?.n || 0;
  const avgDonation = totalDonations > 0 ? totalAmount / totalDonations : 0;

  const byMonth = all(`
    SELECT strftime('%Y-%m', donation_date) as month,
           COUNT(*) as count, COALESCE(SUM(amount),0) as total
    FROM donations WHERE org_id = ? AND status = 'completed'
    GROUP BY month ORDER BY month DESC LIMIT 24
  `, [req.orgId]);

  const byMethod = all(`
    SELECT method, COUNT(*) as count, COALESCE(SUM(amount),0) as total
    FROM donations WHERE org_id = ?${dateFilter} AND status = 'completed'
    GROUP BY method ORDER BY total DESC
  `, params);

  const byNeighborhood = all(`
    SELECT n.name_he, COUNT(DISTINCT d.id) as donors, COALESCE(SUM(don.amount),0) as total
    FROM donations don
    JOIN donors d ON don.donor_id = d.id
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE don.org_id = ?${dateFilter} AND don.status = 'completed'
    GROUP BY d.neighborhood_id ORDER BY total DESC
  `, params);

  const topDonors = all(`
    SELECT d.first_name, d.last_name, d.hebrew_full_name,
           COUNT(*) as count, COALESCE(SUM(don.amount),0) as total
    FROM donations don
    JOIN donors d ON don.donor_id = d.id
    WHERE don.org_id = ?${dateFilter} AND don.status = 'completed'
    GROUP BY don.donor_id ORDER BY total DESC LIMIT 10
  `, params);

  const autopayStats = get(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN autopay_enabled = 1 AND autopay_paused = 0 THEN 1 ELSE 0 END) as active,
           SUM(CASE WHEN autopay_enabled = 1 AND autopay_paused = 1 THEN 1 ELSE 0 END) as paused
    FROM donors WHERE org_id = ?
  `, [req.orgId]);

  const failedCharges = get(`SELECT COUNT(*) as n FROM charge_failures WHERE org_id = ? AND acknowledged = 0`, [req.orgId])?.n || 0;
  const needsVerification = get(`
    SELECT COUNT(*) as n FROM donors WHERE org_id = ?
    AND (info_verified_at IS NULL OR julianday('now') - julianday(info_verified_at) > 180)
  `, [req.orgId])?.n || 0;

  res.json({
    totalDonors, activeDonors, totalAmount, totalDonations, avgDonation,
    byMonth, byMethod, byNeighborhood, topDonors, autopayStats,
    failedCharges, needsVerification
  });
});

// --- CHARGE FAILURES ---
router.get('/charge-failures', (req, res) => {
  const failures = all(`
    SELECT cf.*, d.first_name, d.last_name, d.email,
           pm.label as method_label, pm.last_four, pm.type as method_type
    FROM charge_failures cf
    JOIN donors d ON cf.donor_id = d.id
    LEFT JOIN payment_methods pm ON cf.payment_method_id = pm.id
    WHERE cf.org_id = ?
    ORDER BY cf.occurred_at DESC
  `, [req.orgId]);
  res.json(failures);
});

router.post('/charge-failures/:id/acknowledge', (req, res) => {
  run('UPDATE charge_failures SET acknowledged = 1, acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = ? WHERE id = ? AND org_id = ?',
    [req.user.id, req.params.id, req.orgId]);
  res.json({ success: true });
});

router.post('/charge-failures/acknowledge-all', (req, res) => {
  run('UPDATE charge_failures SET acknowledged = 1, acknowledged_at = CURRENT_TIMESTAMP, acknowledged_by = ? WHERE org_id = ? AND acknowledged = 0',
    [req.user.id, req.orgId]);
  res.json({ success: true });
});

// --- REPORTS ---
router.get('/reports/donations', (req, res) => {
  const { from, to, method, donor_id, status, format = 'json' } = req.query;
  let sql = `
    SELECT don.id, don.donation_date, don.amount, don.method, don.status,
           don.transaction_id, don.notes, don.is_manual, don.is_autopay,
           d.first_name, d.last_name, d.email, d.cell,
           n.name_he as neighborhood,
           pm.label as payment_label, pm.last_four
    FROM donations don
    JOIN donors d ON don.donor_id = d.id
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    LEFT JOIN payment_methods pm ON don.payment_method_id = pm.id
    WHERE don.org_id = ?
  `;
  const params = [req.orgId];
  if (from) { sql += ' AND don.donation_date >= ?'; params.push(from); }
  if (to) { sql += ' AND don.donation_date <= ?'; params.push(to + ' 23:59:59'); }
  if (method) { sql += ' AND don.method = ?'; params.push(method); }
  if (donor_id) { sql += ' AND don.donor_id = ?'; params.push(donor_id); }
  if (status) { sql += ' AND don.status = ?'; params.push(status); }
  sql += ' ORDER BY don.donation_date DESC';

  const rows = all(sql, params);

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows.map(r => ({
      'Date': r.donation_date, 'Donor': `${r.first_name} ${r.last_name}`,
      'Amount': r.amount, 'Method': r.method, 'Status': r.status,
      'Transaction ID': r.transaction_id, 'Email': r.email,
      'Neighborhood': r.neighborhood, 'Notes': r.notes
    })));
    XLSX.utils.book_append_sheet(wb, ws, 'Donations');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=donations-report.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  res.json(rows);
});

// Export donors
router.get('/reports/donors', (req, res) => {
  const { format = 'json' } = req.query;
  const donors = all(`
    SELECT d.*, n.name_he as neighborhood_name,
           (SELECT COALESCE(SUM(amount),0) FROM donations WHERE donor_id = d.id AND status = 'completed') as total_donated
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.org_id = ?
    ORDER BY d.last_name, d.first_name
  `, [req.orgId]);

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(donors.map(d => ({
      'Title': d.title, 'First Name': d.first_name, 'Last Name': d.last_name,
      'Hebrew Title': d.hebrew_title, 'Hebrew Name': d.hebrew_full_name,
      'Cell': d.cell, 'Home': d.home_phone, 'Email': d.email,
      'Neighborhood': d.neighborhood_name,
      'Address': [d.street, d.apt, d.city, d.state, d.zip].filter(Boolean).join(', '),
      'Labels': d.labels, 'Total Donated': d.total_donated,
      'Auto Pay': d.autopay_enabled ? 'Yes' : 'No',
      'Created': d.created_at
    })));
    XLSX.utils.book_append_sheet(wb, ws, 'Donors');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=donors-export.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  res.json(donors);
});

// Import donors from xlsx
router.post('/import/donors', (req, res) => {
  // Handled via file upload in main server
  res.json({ error: 'Use multipart upload endpoint' });
});

// --- BANK CONNECTIONS ---
router.get('/bank', (req, res) => {
  const conns = all('SELECT id, bank_name, last_sync, is_active, created_at, account_ids FROM bank_connections WHERE org_id = ?', [req.orgId]);
  res.json(conns);
});

router.post('/bank', requireOrgAdmin, (req, res) => {
  const { bank_name, api_key, api_secret, account_ids } = req.body;
  const id = uuidv4();
  run('INSERT INTO bank_connections (id, org_id, bank_name, api_key, api_secret, account_ids) VALUES (?, ?, ?, ?, ?, ?)',
    [id, req.orgId, bank_name || 'Chase', api_key, api_secret, JSON.stringify(account_ids || [])]);
  res.json({ success: true });
});

router.get('/bank/transactions', (req, res) => {
  const { from, to, direction, labeled } = req.query;
  let sql = 'SELECT * FROM bank_transactions WHERE org_id = ?';
  const params = [req.orgId];
  if (from) { sql += ' AND transaction_date >= ?'; params.push(from); }
  if (to) { sql += ' AND transaction_date <= ?'; params.push(to); }
  if (direction) { sql += ' AND direction = ?'; params.push(direction); }
  if (labeled === 'false') { sql += ' AND (label IS NULL OR label = "")'; }
  sql += ' ORDER BY transaction_date DESC LIMIT 500';
  res.json(all(sql, params));
});

router.post('/bank/transactions/:id/label', (req, res) => {
  const { label, donor_id, donation_id } = req.body;
  run('UPDATE bank_transactions SET label = ?, linked_donor_id = ?, linked_donation_id = ? WHERE id = ? AND org_id = ?',
    [label, donor_id || null, donation_id || null, req.params.id, req.orgId]);
  res.json({ success: true });
});

// Mock bank sync (real Chase API requires OAuth)
router.post('/bank/sync', requireOrgAdmin, (req, res) => {
  run('UPDATE bank_connections SET last_sync = CURRENT_TIMESTAMP WHERE org_id = ?', [req.orgId]);
  res.json({ success: true, message: 'Chase API sync initiated. Configure OAuth credentials in settings.' });
});

// --- SOLA SETTINGS ---
router.get('/sola', requireOrgAdmin, (req, res) => {
  const s = get('SELECT id, merchant_id, is_active, created_at FROM sola_settings WHERE org_id = ?', [req.orgId]);
  res.json(s);
});

router.put('/sola', requireOrgAdmin, (req, res) => {
  const { api_key, merchant_id } = req.body;
  const existing = get('SELECT id FROM sola_settings WHERE org_id = ?', [req.orgId]);
  if (existing) {
    run('UPDATE sola_settings SET api_key = ?, merchant_id = ?, is_active = 1 WHERE org_id = ?', [api_key, merchant_id, req.orgId]);
  } else {
    run('INSERT INTO sola_settings (id, org_id, api_key, merchant_id, is_active) VALUES (?, ?, ?, ?, 1)', [uuidv4(), req.orgId, api_key, merchant_id]);
  }
  res.json({ success: true });
});

// --- DAF ACCOUNTS ---
router.get('/daf', (req, res) => {
  res.json(all('SELECT * FROM daf_accounts WHERE org_id = ? AND is_active = 1 ORDER BY name', [req.orgId]));
});

router.post('/daf', requireOrgAdmin, (req, res) => {
  const { name, account_number, contact_name, contact_email, contact_phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  run('INSERT INTO daf_accounts (id, org_id, name, account_number, contact_name, contact_email, contact_phone, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, req.orgId, name, account_number || null, contact_name || null, contact_email || null, contact_phone || null, notes || null]);
  res.json({ success: true, daf: get('SELECT * FROM daf_accounts WHERE id = ?', [id]) });
});

router.delete('/daf/:id', requireOrgAdmin, (req, res) => {
  run('UPDATE daf_accounts SET is_active = 0 WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

// --- KVITEL SETTINGS ---
router.get('/kvitel-settings', (req, res) => {
  res.json(get('SELECT * FROM kvitel_settings WHERE org_id = ?', [req.orgId]));
});

router.put('/kvitel-settings', (req, res) => {
  const fields = ['header_html','page_size','columns','column_gap','font_family','font_size','line_height',
    'margin_top','margin_bottom','margin_left','margin_right','group_by_neighborhood'];
  const existing = get('SELECT * FROM kvitel_settings WHERE org_id = ?', [req.orgId]);
  if (!existing) {
    run('INSERT INTO kvitel_settings (id, org_id) VALUES (?, ?)', [uuidv4(), req.orgId]);
  }
  const sets = fields.map(f => `${f} = ?`).join(', ');
  const vals = fields.map(f => req.body[f] !== undefined ? req.body[f] : (existing ? existing[f] : null));
  vals.push(req.orgId);
  run(`UPDATE kvitel_settings SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE org_id = ?`, vals);
  res.json({ success: true, settings: get('SELECT * FROM kvitel_settings WHERE org_id = ?', [req.orgId]) });
});

module.exports = router;
