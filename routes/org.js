// routes/org.js - org settings, email, stats, reports, charge failures
const express = require('express');
const router = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');
const nodemailer = require('nodemailer');
const mailer    = require('../utils/mailer');
const XLSX = require('xlsx');
const tzUtil = require('../utils/tz');

router.use(requireAuth, requireOrg);

// --- ORG INFO ---
router.get('/info', (req, res) => res.json(req.org));

router.put('/info', requireOrgAdmin, (req, res) => {
  const { name, settings } = req.body;
  run('UPDATE organizations SET name = ?, settings = ? WHERE id = ?',
    [name || req.org.name, settings ? JSON.stringify(settings) : req.org.settings, req.orgId]);
  res.json({ success: true, org: get('SELECT * FROM organizations WHERE id = ?', [req.orgId]) });
});

// ── Update org name/settings ──────────────────────────────────────────────────
router.put('/settings', requireOrgAdmin, (req, res) => {
  try {
    const { name, company_name, hebrew_name, cell, phone, address, contact_email, notes } = req.body;
    if (name) run('UPDATE organizations SET name=? WHERE id=?', [name.trim(), req.orgId]);
    if (company_name  !== undefined) run('UPDATE organizations SET company_name=? WHERE id=?', [company_name||null, req.orgId]);
    if (hebrew_name   !== undefined) run('UPDATE organizations SET hebrew_name=? WHERE id=?', [hebrew_name||null, req.orgId]);
    if (cell          !== undefined) run('UPDATE organizations SET cell=? WHERE id=?', [cell||null, req.orgId]);
    if (phone         !== undefined) run('UPDATE organizations SET phone=? WHERE id=?', [phone||null, req.orgId]);
    if (address       !== undefined) run('UPDATE organizations SET address=? WHERE id=?', [address||null, req.orgId]);
    if (contact_email !== undefined) run('UPDATE organizations SET contact_email=? WHERE id=?', [contact_email||null, req.orgId]);
    if (notes         !== undefined) run('UPDATE organizations SET notes=? WHERE id=?', [notes||null, req.orgId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// --- EMAIL SETTINGS ---
router.get('/email-settings', requireOrgAdmin, (req, res) => {
  const s = get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]);
  if (s) { delete s.smtp_password; delete s.brevo_api_key; }
  res.json(s || {});
});

router.put('/email-settings', requireOrgAdmin, (req, res) => {
  try {
    const body = req.body;
    const ex = get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]);

    // Fields that keep existing value when blank/undefined
    const email      = body.smtp_email      !== undefined ? body.smtp_email      : (ex?.smtp_email || '');
    const pass       = body.smtp_password                ? body.smtp_password    : (ex?.smtp_password || '');
    const host       = body.smtp_host       !== undefined ? body.smtp_host       : (ex?.smtp_host || 'smtp.gmail.com');
    const port       = body.smtp_port       !== undefined ? body.smtp_port       : (ex?.smtp_port || 587);
    const fromName   = body.from_name       !== undefined ? body.from_name       : (ex?.from_name || '');
    const recTpl     = body.receipt_template!== undefined ? body.receipt_template: (ex?.receipt_template || '');
    const mktTpl     = body.marketing_template!==undefined? body.marketing_template:(ex?.marketing_template||'');
    const paused     = body.donation_emails_paused !== undefined ? (body.donation_emails_paused ? 1 : 0) : (ex?.donation_emails_paused || 0);
    const brevoKey   = body.brevo_api_key               ? body.brevo_api_key    : (ex?.brevo_api_key || '');
    console.log('[email-settings] save: brevo_key_in_body=', !!body.brevo_api_key, 'ex_brevo=', !!(ex?.brevo_api_key), 'final=', !!brevoKey);

    if (!ex) {
      run(`INSERT INTO email_settings
           (id, org_id, smtp_email, smtp_password, smtp_host, smtp_port,
            from_name, receipt_template, marketing_template,
            donation_emails_paused, postmark_key, brevo_api_key)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuidv4(), req.orgId, email, pass, host, port,
         fromName, recTpl, mktTpl, paused, '', brevoKey]);
    } else {
      run(`UPDATE email_settings
           SET smtp_email=?, smtp_password=?, smtp_host=?, smtp_port=?,
               from_name=?, receipt_template=?, marketing_template=?,
               donation_emails_paused=?, postmark_key=?, brevo_api_key=?,
               updated_at=CURRENT_TIMESTAMP
           WHERE org_id=?`,
        [email, pass, host, port,
         fromName, recTpl, mktTpl, paused, '', brevoKey,
         req.orgId]);
    }
    res.json({ success: true });
  } catch(e) {
    console.error('email-settings save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Send test email
router.post('/email-settings/test', requireOrgAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    const settings = get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]);
    const org      = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    if (!settings?.brevo_api_key && (!settings?.smtp_email || !settings?.smtp_password)) {
      return res.status(400).json({ error: 'Email not configured. Enter your Brevo API key and save first.' });
    }
    const fromName  = settings?.from_name || org?.name || 'DRM';
    const fromEmail = settings?.smtp_email || 'noreply@everythingshul.com';
    const toAddr    = to || settings?.smtp_email;
    const html      = '<p>This is a test email from your DRM system. If you received this, email is working correctly.</p>';
    await mailer.sendMail({
      settings, orgId: req.orgId,
      to: toAddr, from: `"${fromName}" <${fromEmail}>`,
      subject: 'DRM Test Email', html, type: 'test'
    });
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Email status — quick check whether email is fully configured ──────────────
router.get('/email-settings/status', (req, res) => {
  const settings = get('SELECT smtp_email, smtp_password, donation_emails_paused, postmark_key, brevo_api_key FROM email_settings WHERE org_id = ?', [req.orgId]);
  const hasBrevo = !!(settings?.brevo_api_key);
  const hasGmail = !!(settings?.smtp_email && settings?.smtp_password);
  res.json({
    configured: hasBrevo || hasGmail,
    brevo:      hasBrevo,
    has_email:  !!settings?.smtp_email,
    has_password: !!settings?.smtp_password,
    paused: !!settings?.donation_emails_paused
  });
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

  const totalDonors = get('SELECT COUNT(*) as n FROM donors WHERE org_id = ? AND removed_at IS NULL', [req.orgId])?.n || 0;
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
    FROM donors WHERE org_id = ? AND removed_at IS NULL
  `, [req.orgId]);

  const failedCharges = get(`SELECT COUNT(*) as n FROM charge_failures WHERE org_id = ? AND acknowledged = 0`, [req.orgId])?.n || 0;
  const needsVerification = get(`
    SELECT COUNT(*) as n FROM donors WHERE org_id = ? AND removed_at IS NULL
    AND (info_verified_at IS NULL OR julianday('now') - julianday(info_verified_at) > 180)
  `, [req.orgId])?.n || 0;
  const totalExpenses = get(`SELECT COALESCE(SUM(amount),0) as n FROM expenses WHERE org_id=?`, [req.orgId])?.n || 0;

  res.json({
    totalDonors, activeDonors, totalAmount, totalDonations, avgDonation,
    byMonth, byMethod, byNeighborhood, topDonors, autopayStats,
    failedCharges, needsVerification, totalExpenses
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

router.post('/charge-failures/:id/unacknowledge', (req, res) => {
  run('UPDATE charge_failures SET acknowledged = 0, acknowledged_at = NULL, acknowledged_by = NULL WHERE id = ? AND org_id = ?',
    [req.params.id, req.orgId]);
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
           don.transaction_id, don.notes, don.label, don.labels, don.donation_notes,
           don.is_manual, don.is_autopay, don.donor_id,
           d.first_name, d.last_name, d.email, d.cell,
           n.name_he as neighborhood,
           pm.label as payment_label, pm.last_four,
           don.refund_amount, don.refund_notes
    FROM donations don
    LEFT JOIN donors d ON don.donor_id = d.id
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
  const { format = 'json', include_removed } = req.query;
  const donors = all(`
    SELECT d.*, n.name_he as neighborhood_name,
           (SELECT COALESCE(SUM(amount),0) FROM donations WHERE donor_id=d.id AND status='completed') as total_donated,
           (SELECT COUNT(*) FROM donations WHERE donor_id=d.id AND status='completed') as donation_count,
           (SELECT MAX(donation_date) FROM donations WHERE donor_id=d.id AND status='completed') as last_donation_date,
           (SELECT COUNT(*) FROM recurring_schedules WHERE donor_id=d.id AND status='active') as active_recurring
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.org_id = ? ${include_removed === '1' ? '' : 'AND d.removed_at IS NULL'}
    ORDER BY d.last_name, d.first_name
  `, [req.orgId]);

  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();

    // ── Sheet 1: Donors ──────────────────────────────────────────────────────
    const ws1 = XLSX.utils.json_to_sheet(donors.map(d => {
      // Parse labels JSON
      let labels = '';
      try { labels = JSON.parse(d.labels||'[]').join(', '); } catch {}

      // Get payment methods for this donor
      const cards = all(
        'SELECT type, label, last_four, card_brand, daf_name, other_description, is_default FROM payment_methods WHERE donor_id=? ORDER BY is_default DESC',
        [d.id]
      );
      const cardsStr = cards.map(c => {
        if (c.type === 'credit_card') return `${c.card_brand||'Card'} ••${c.last_four||''}${c.label?' ('+c.label+')':''}${c.is_default?' [default]':''}`;
        if (c.type === 'daf') return `DAF: ${c.daf_name||''}${c.is_default?' [default]':''}`;
        return `${c.type}${c.label?' ('+c.label+')':''}`;
      }).join(' | ');

      return {
        'ID #':               d.donor_number || '',
        'Title':              d.title || '',
        'First Name':         d.first_name || '',
        'Last Name':          d.last_name || '',
        'Hebrew Title':       d.hebrew_title || '',
        'Hebrew Name':        d.hebrew_full_name || '',
        'Email':              d.email || '',
        'Cell':               d.cell || '',
        'Home Phone':         d.home_phone || '',
        'Street':             d.street || '',
        'Apt':                d.apt || '',
        'City':               d.city || '',
        'State':              d.state || '',
        'Zip':                d.zip || '',
        'Neighborhood':       d.neighborhood_name || '',
        'Labels':             labels,
        'Notes':              d.notes || '',
        'Total Donated':      parseFloat(d.total_donated||0).toFixed(2),
        'Donation Count':     d.donation_count || 0,
        'Last Donation':      d.last_donation_date ? d.last_donation_date.slice(0,10) : '',
        'Active Recurring':   d.active_recurring ? 'Yes' : 'No',
        'Auto Pay':           d.autopay_enabled ? 'Yes' : 'No',
        'Cards on File':      cardsStr,
        'Kvitel Names':       d.kvitel || '',
        'Kvitel Enabled':     d.kvitel_enabled ? 'Yes' : 'No',
        'Emails Paused':      d.donation_emails_paused ? 'Yes' : 'No',
        'Sola Customer ID':   d.sola_customer_id || '',
        'Created':            d.created_at ? d.created_at.slice(0,10) : '',
        'Last Verified':      d.info_verified_at ? d.info_verified_at.slice(0,10) : ''
      };
    }));
    ws1['!cols'] = [
      {wch:9},{wch:8},{wch:14},{wch:16},{wch:12},{wch:18},{wch:28},{wch:14},{wch:14},
      {wch:22},{wch:6},{wch:14},{wch:6},{wch:8},{wch:16},{wch:20},{wch:30},
      {wch:12},{wch:10},{wch:14},{wch:10},{wch:10},{wch:40},{wch:10},{wch:10},{wch:18},{wch:12},{wch:14}
    ];
    XLSX.utils.book_append_sheet(wb, ws1, 'Donors');

    // ── Sheet 2: Payment Methods ──────────────────────────────────────────────
    const allCards = all(`
      SELECT pm.*, d.first_name, d.last_name, d.email, d.donor_number
      FROM payment_methods pm
      JOIN donors d ON pm.donor_id = d.id
      WHERE pm.org_id = ?
      ORDER BY d.last_name, d.first_name
    `, [req.orgId]);
    if (allCards.length) {
      const ws2 = XLSX.utils.json_to_sheet(allCards.map(c => ({
        'ID #':              c.donor_number || '',
        'Donor First Name':  c.first_name,
        'Donor Last Name':   c.last_name,
        'Donor Email':       c.email || '',
        'Type':              c.type,
        'Label':             c.label || '',
        'Card Brand':        c.card_brand || '',
        'Last Four':         c.last_four || '',
        'DAF Name':          c.daf_name || '',
        'Description':       c.other_description || '',
        'Is Default':        c.is_default ? 'Yes' : 'No',
        'Sola Token':        c.sola_token || '',
        'Added':             c.created_at ? c.created_at.slice(0,10) : ''
      })));
      XLSX.utils.book_append_sheet(wb, ws2, 'Payment Methods');
    }

    // ── Sheet 3: Donation History ─────────────────────────────────────────────
    const donations = all(`
      SELECT don.*, d.first_name, d.last_name, d.email, d.donor_number,
             pm.label as card_label, pm.last_four, pm.card_brand, pm.type as card_type
      FROM donations don
      JOIN donors d ON don.donor_id = d.id
      LEFT JOIN payment_methods pm ON don.payment_method_id = pm.id
      WHERE don.org_id = ?
      ORDER BY don.donation_date DESC
    `, [req.orgId]);
    if (donations.length) {
      const ws3 = XLSX.utils.json_to_sheet(donations.map(d => ({
        'Date':              d.donation_date ? d.donation_date.slice(0,10) : '',
        'ID #':              d.donor_number || '',
        'First Name':        d.first_name,
        'Last Name':         d.last_name,
        'Email':             d.email || '',
        'Amount':            parseFloat(d.amount||0).toFixed(2),
        'Method':            d.method,
        'Card':              d.card_brand ? `${d.card_brand} ••${d.last_four||''}` : '',
        'Label':             d.label || '',
        'Status':            d.status,
        'Transaction ID':    d.transaction_id || '',
        'Notes':             d.notes || '',
        'Is Autopay':        d.is_autopay ? 'Yes' : 'No',
        'Is Recurring':      d.is_recurring ? 'Yes' : 'No',
        'Receipt Sent':      d.receipt_sent ? 'Yes' : 'No',
        'Refund Amount':     d.refund_amount ? parseFloat(d.refund_amount).toFixed(2) : ''
      })));
      XLSX.utils.book_append_sheet(wb, ws3, 'Donations');
    }

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=donors-export.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    return res.send(buf);
  }

  res.json(donors);
});

// Import donors from xlsx


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

// ── Full dashboard export — all data in one XLSX, multiple tabs ───────────────
router.get('/reports/full-export', (req, res) => {
  try {
    const org = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    const orgName = (org?.name || 'DRM').replace(/[^a-zA-Z0-9 ]/g, '').trim();
    const now = new Date();
    const orgTz = tzUtil.getOrgTimezone(req.orgId);
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: orgTz, year:'numeric', month:'2-digit', day:'2-digit' }).format(now);

    const wb = XLSX.utils.book_new();

    // ── Tab 1: Summary ────────────────────────────────────────────────────────
    const totalDonations  = get(`SELECT COALESCE(SUM(amount),0) as n FROM donations WHERE org_id=? AND status='completed'`, [req.orgId])?.n || 0;
    const totalDonors     = get(`SELECT COUNT(*) as n FROM donors WHERE org_id=?`, [req.orgId])?.n || 0;
    const totalExpenses   = get(`SELECT COALESCE(SUM(amount),0) as n FROM expenses WHERE org_id=?`, [req.orgId])?.n || 0;
    const totalRecurring  = get(`SELECT COUNT(*) as n FROM recurring_schedules WHERE org_id=? AND status='active'`, [req.orgId])?.n || 0;
    const totalFailed     = get(`SELECT COUNT(*) as n FROM charge_failures WHERE org_id=? AND acknowledged=0`, [req.orgId])?.n || 0;
    const byMethod = all(`SELECT method, COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM donations WHERE org_id=? AND status='completed' GROUP BY method`, [req.orgId]);

    const summaryRows = [
      { Metric: 'Organization',           Value: org?.name || '' },
      { Metric: 'Export Date',            Value: dateStr },
      { Metric: '',                        Value: '' },
      { Metric: 'Total Donors',           Value: totalDonors },
      { Metric: 'Total Donations Raised', Value: `$${parseFloat(totalDonations).toFixed(2)}` },
      { Metric: 'Total Expenses',         Value: `$${parseFloat(totalExpenses).toFixed(2)}` },
      { Metric: 'Net (Donations – Expenses)', Value: `$${(parseFloat(totalDonations) - parseFloat(totalExpenses)).toFixed(2)}` },
      { Metric: 'Active Recurring Schedules', Value: totalRecurring },
      { Metric: 'Unacknowledged Charge Failures', Value: totalFailed },
      { Metric: '',                        Value: '' },
      { Metric: 'Donations by Method',    Value: '' },
      ...byMethod.map(r => ({ Metric: `  ${r.method.replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase())}`, Value: `$${parseFloat(r.total).toFixed(2)} (${r.count} gifts)` })),
    ];
    const wsSummary = XLSX.utils.json_to_sheet(summaryRows, { skipHeader: false });
    wsSummary['!cols'] = [{ wch: 32 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // ── Tab 2: Donors ─────────────────────────────────────────────────────────
    const donors = all(`
      SELECT d.donor_number, d.title, d.first_name, d.last_name, d.hebrew_title, d.hebrew_full_name,
             d.cell, d.home_phone, d.email,
             n.name_he as neighborhood,
             d.street, d.apt, d.city, d.state, d.zip,
             d.labels, d.autopay_enabled, d.autopay_paused, d.kvitel,
             COALESCE(SUM(don.amount),0) as total_donated,
             COUNT(don.id) as donation_count,
             MAX(don.donation_date) as last_donation,
             d.created_at
      FROM donors d
      LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
      LEFT JOIN donations don ON don.donor_id = d.id AND don.status='completed'
      WHERE d.org_id=?
      GROUP BY d.id
      ORDER BY d.last_name, d.first_name
    `, [req.orgId]);
    const wsDonors = XLSX.utils.json_to_sheet(donors.map(d => ({
      'ID #':            d.donor_number || '',
      'Title':           d.title || '',
      'First Name':      d.first_name,
      'Last Name':       d.last_name,
      'Hebrew Title':    d.hebrew_title || '',
      'Hebrew Name':     d.hebrew_full_name || '',
      'Cell':            d.cell || '',
      'Home Phone':      d.home_phone || '',
      'Email':           d.email || '',
      'Neighborhood':    d.neighborhood || '',
      'Street':          d.street || '',
      'Apt':             d.apt || '',
      'City':            d.city || '',
      'State':           d.state || '',
      'ZIP':             d.zip || '',
      'Labels':          (() => { try { return JSON.parse(d.labels||'[]').join(', '); } catch { return ''; } })(),
      'AutoPay':         d.autopay_enabled ? (d.autopay_paused ? 'Paused' : 'Active') : 'Off',
      'Total Donated':   parseFloat(d.total_donated || 0).toFixed(2),
      'Gifts':           d.donation_count || 0,
      'Last Donation':   d.last_donation ? d.last_donation.slice(0,10) : '',
      'Donor Since':     d.created_at ? d.created_at.slice(0,10) : '',
      'Kvitel Names':    d.kvitel || '',
    })));
    wsDonors['!cols'] = [9,6,10,10,10,16,12,12,22,14,18,5,12,5,8,14,8,12,6,12,12,30].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsDonors, 'Donors');

    // ── Tab 3: Donations ──────────────────────────────────────────────────────
    const donations = all(`
      SELECT don.donation_date, d.first_name, d.last_name, d.donor_number,
             don.amount, don.method, don.transaction_id, don.status,
             don.refund_amount, don.refund_notes, don.notes,
             pm.card_brand, pm.last_four
      FROM donations don
      LEFT JOIN donors d ON don.donor_id = d.id
      LEFT JOIN payment_methods pm ON don.payment_method_id = pm.id
      WHERE don.org_id=?
      ORDER BY don.donation_date DESC
    `, [req.orgId]);
    const wsDonations = XLSX.utils.json_to_sheet(donations.map(d => ({
      'Date':            d.donation_date ? d.donation_date.slice(0,10) : '',
      'ID #':            d.donor_number || '',
      'Donor':           d.first_name ? `${d.first_name} ${d.last_name}` : '(Unlinked)',
      'Amount':          parseFloat(d.amount || 0).toFixed(2),
      'Method':          (d.method||'').replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase()),
      'Card':            d.card_brand ? `${d.card_brand} ••${d.last_four||''}` : '',
      'Transaction ID':  d.transaction_id || '',
      'Status':          d.status || '',
      'Refunded':        d.refund_amount > 0 ? parseFloat(d.refund_amount).toFixed(2) : '',
      'Refund Notes':    d.refund_notes || '',
      'Notes':           d.notes || '',
    })));
    wsDonations['!cols'] = [12,9,20,10,12,14,18,12,10,20,24].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsDonations, 'Donations');

    // ── Tab: Leads ────────────────────────────────────────────────────────────
    const leadsForExport = all(`
      SELECT l.donor_number, l.title, l.first_name, l.last_name, l.hebrew_title, l.hebrew_full_name,
             l.email, l.cell, l.home_phone, l.category, l.status,
             l.labels, l.notes, u.full_name as assigned_name, l.created_at
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.org_id=?
      ORDER BY l.created_at DESC
    `, [req.orgId]);
    const wsLeads = XLSX.utils.json_to_sheet(leadsForExport.map(l => ({
      'ID #':          l.donor_number || '',
      'Title':         l.title || '',
      'First Name':    l.first_name || '',
      'Last Name':     l.last_name || '',
      'Hebrew Title':  l.hebrew_title || '',
      'Hebrew Name':   l.hebrew_full_name || '',
      'Email':         l.email || '',
      'Cell':          l.cell || '',
      'Home Phone':    l.home_phone || '',
      'Category':      l.category || '',
      'Status':        l.status || '',
      'Labels':        (() => { try { return JSON.parse(l.labels||'[]').join(', '); } catch { return ''; } })(),
      'Assigned To':   l.assigned_name || '',
      'Notes':         l.notes || '',
      'Created':       l.created_at ? l.created_at.slice(0,10) : ''
    })));
    wsLeads['!cols'] = [9,6,10,10,10,16,22,14,14,14,12,20,16,30,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsLeads, 'Leads');

    // ── Tab 4: Expenses ───────────────────────────────────────────────────────
    const expenses = all(`
      SELECT e.expense_date, e.category, e.description, e.amount, e.created_at
      FROM expenses e
      WHERE e.org_id=?
      ORDER BY e.expense_date DESC
    `, [req.orgId]);
    const wsExpenses = XLSX.utils.json_to_sheet(expenses.length ? expenses.map(e => ({
      'Date':        e.expense_date || '',
      'Category':    e.category || '',
      'Description': e.description || '',
      'Amount':      parseFloat(e.amount || 0).toFixed(2),
      'Recorded':    e.created_at ? e.created_at.slice(0,10) : '',
    })) : [{ 'Date':'', 'Category':'', 'Description':'No expenses recorded', 'Amount':'', 'Recorded':'' }]);
    wsExpenses['!cols'] = [12,14,28,10,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsExpenses, 'Expenses');

    // ── Tab 5: Recurring Schedules ────────────────────────────────────────────
    const recurring = all(`
      SELECT rs.*, d.first_name, d.last_name,
             pm.type as pm_type, pm.card_brand, pm.last_four, pm.daf_name
      FROM recurring_schedules rs
      JOIN donors d ON rs.donor_id = d.id
      LEFT JOIN payment_methods pm ON rs.payment_method_id = pm.id
      WHERE rs.org_id=?
      ORDER BY d.last_name, d.first_name
    `, [req.orgId]);
    const wsRecurring = XLSX.utils.json_to_sheet(recurring.length ? recurring.map(r => ({
      'Donor':         `${r.first_name} ${r.last_name}`,
      'Amount':        parseFloat(r.amount || 0).toFixed(2),
      'Frequency':     r.frequency ? r.frequency.charAt(0).toUpperCase()+r.frequency.slice(1) : '',
      'Status':        r.status ? r.status.charAt(0).toUpperCase()+r.status.slice(1) : '',
      'Next Run':      r.next_run ? r.next_run.slice(0,10) : '',
      'Payment':       r.pm_type === 'credit_card' ? `${r.card_brand||'Card'} ••${r.last_four||''}` : (r.daf_name || r.pm_type || ''),
      'Charges Made':  r.occurrences_count || 0,
      'Charge Limit':  r.occurrences_limit || 'Unlimited',
      'Last Run':      r.last_run ? r.last_run.slice(0,10) : 'Never',
      'Last Failure':  r.last_failure || '',
      'Notes':         r.notes || '',
    })) : [{ 'Donor':'', 'Amount':'', 'Frequency':'No recurring schedules', 'Status':'', 'Next Run':'', 'Payment':'', 'Charges Made':'', 'Charge Limit':'', 'Last Run':'', 'Last Failure':'', 'Notes':'' }]);
    wsRecurring['!cols'] = [20,10,12,10,12,16,12,12,12,28,20].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsRecurring, 'Recurring Schedules');

    // ── Tab 6: Failed Charges ─────────────────────────────────────────────────
    const failures = all(`
      SELECT cf.occurred_at, d.first_name, d.last_name, d.email,
             cf.amount, cf.failure_reason,
             cf.acknowledged, cf.acknowledged_at,
             pm.type as pm_type, pm.card_brand, pm.last_four
      FROM charge_failures cf
      JOIN donors d ON cf.donor_id = d.id
      LEFT JOIN payment_methods pm ON cf.payment_method_id = pm.id
      WHERE cf.org_id=?
      ORDER BY cf.occurred_at DESC
    `, [req.orgId]);
    const wsFailures = XLSX.utils.json_to_sheet(failures.length ? failures.map(f => ({
      'Date':          f.occurred_at ? f.occurred_at.slice(0,10) : '',
      'Donor':         `${f.first_name} ${f.last_name}`,
      'Email':         f.email || '',
      'Amount':        parseFloat(f.amount || 0).toFixed(2),
      'Payment':       f.pm_type === 'credit_card' ? `${f.card_brand||'Card'} ••${f.last_four||''}` : (f.pm_type || ''),
      'Failure Reason': f.failure_reason || '',
      'Acknowledged':  f.acknowledged ? 'Yes' : 'No',
      'Acked At':      f.acknowledged_at ? f.acknowledged_at.slice(0,10) : '',
    })) : [{ 'Date':'', 'Donor':'', 'Email':'', 'Amount':'', 'Payment':'', 'Failure Reason':'No charge failures', 'Acknowledged':'', 'Acked At':'' }]);
    wsFailures['!cols'] = [12,20,24,10,16,32,12,12].map(w=>({wch:w}));
    XLSX.utils.book_append_sheet(wb, wsFailures, 'Failed Charges');

    // ── Write and send ─────────────────────────────────────────────────────────
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `${orgName} - Full Report ${dateStr}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch(e) {
    console.error('full-export:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── Scheduled emails: edit ─────────────────────────────────────────────────────
router.put('/scheduled-emails/:id', (req, res) => {
  const { subject, html_body, scheduled_for } = req.body;
  const ex = get('SELECT id FROM scheduled_emails WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!ex) return res.status(404).json({ error: 'Email not found' });
  run('UPDATE scheduled_emails SET subject=?, html_body=?, scheduled_for=? WHERE id=? AND org_id=?',
    [subject, html_body, scheduled_for, req.params.id, req.orgId]);
  res.json({ success: true });
});

// ── Scheduled emails: send test immediately ────────────────────────────────────
router.post('/scheduled-emails/:id/test', requireOrgAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    const email = get('SELECT * FROM scheduled_emails WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
    if (!email) return res.status(404).json({ error: 'Email not found' });

    const settings = get('SELECT * FROM email_settings WHERE org_id=?', [req.orgId]);
    if (!settings?.smtp_email) return res.status(400).json({ error: 'Email not configured' });

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host: settings.smtp_host || 'smtp.gmail.com',
      port: settings.smtp_port || 587,
      secure: false,
      auth: { user: settings.smtp_email, pass: settings.smtp_password }
    });

    await transporter.sendMail({
      from: `"${settings.from_name || 'DRM'}" <${settings.smtp_email}>`,
      to: to || settings.smtp_email,
      subject: '[TEST] ' + email.subject,
      html: email.html_body
    });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Org timezone setting ───────────────────────────────────────────────────────
router.get('/timezone', (req, res) => {
  const s = get('SELECT settings FROM organizations WHERE id=?', [req.orgId]);
  const parsed = (() => { try { return JSON.parse(s?.settings || '{}'); } catch { return {}; } })();
  res.json({ timezone: parsed.timezone || 'America/New_York' });
});

router.put('/timezone', requireOrgAdmin, (req, res) => {
  const { timezone } = req.body;
  const org = get('SELECT settings FROM organizations WHERE id=?', [req.orgId]);
  const current = (() => { try { return JSON.parse(org?.settings || '{}'); } catch { return {}; } })();
  current.timezone = timezone;
  run('UPDATE organizations SET settings=? WHERE id=?', [JSON.stringify(current), req.orgId]);
  res.json({ success: true });
});

// ── Outstanding manual charges (non-CC/DAF that need manual collection) ────────
router.get('/outstanding-charges', (req, res) => {
  const charges = all(`
    SELECT sc.*, d.first_name, d.last_name, d.email, d.cell,
           pm.type as pm_type, pm.label as pm_label, pm.other_description
    FROM scheduled_charges sc
    JOIN donors d ON sc.donor_id = d.id
    LEFT JOIN payment_methods pm ON sc.payment_method_id = pm.id
    WHERE sc.org_id=? AND sc.status='pending'
      AND (pm.type IS NULL OR pm.type NOT IN ('credit_card','daf'))
    ORDER BY sc.scheduled_for ASC
  `, [req.orgId]);
  res.json(charges);
});

// Mark outstanding charge as collected (enter transaction details)
router.post('/outstanding-charges/:id/collect', (req, res) => {
  try {
    const { transaction_id, notes, amount } = req.body;
    const charge = get('SELECT * FROM scheduled_charges WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
    if (!charge) return res.status(404).json({ error: 'Charge not found' });

    const txId = transaction_id || ('ES' + String(Math.floor(Math.random()*1000000000)).padStart(9,'0'));

    // Record the donation
    const donId = require('uuid').v4();
    run(`INSERT INTO donations (id,org_id,donor_id,amount,method,payment_method_id,transaction_id,donation_date,status,notes,is_manual,created_by)
         VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,'completed',?,1,'manual-collection')`,
      [donId, req.orgId, charge.donor_id, amount || charge.amount,
       'check', charge.payment_method_id, txId, notes || charge.notes || null]);

    // Mark charge as completed
    run('UPDATE scheduled_charges SET status=?,processed_at=CURRENT_TIMESTAMP,failure_reason=? WHERE id=?',
      ['completed', `Manually collected: ${txId}`, req.params.id]);

    res.json({ success: true, donation: get('SELECT * FROM donations WHERE id=?', [donId]) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Logo upload for receipts ────────────────────────────────────────────────────
router.post('/upload-logo', requireOrgAdmin, (req, res) => {
  // Logo is uploaded as base64 in body
  const { logo_base64, mime_type } = req.body;
  if (!logo_base64) return res.status(400).json({ error: 'No logo data' });
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
  const dir = path.join(DATA_DIR, 'logos');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = (mime_type || 'image/png').includes('jpeg') ? 'jpg' : 'png';
  const filename = `org-${req.orgId}-logo.${ext}`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, Buffer.from(logo_base64, 'base64'));
  const logoUrl = `/org-logos/${filename}`;
  run("UPDATE organizations SET settings=json_set(COALESCE(settings,'{}'),'$.logo_url',?) WHERE id=?", [logoUrl, req.orgId]);
  res.json({ success: true, logo_url: logoUrl });
});

// ── Expenses (Issue 23) ───────────────────────────────────────────────────────
router.get('/expenses', (req, res) => {
  const expenses = all('SELECT * FROM expenses WHERE org_id=? ORDER BY expense_date DESC', [req.orgId]);
  res.json(expenses);
});

router.post('/expenses', (req, res) => {
  try {
    const { amount, category, description, expense_date } = req.body;
    if (!amount || !expense_date) return res.status(400).json({ error: 'amount and expense_date required' });
    const id = require('uuid').v4();
    run('INSERT INTO expenses (id,org_id,amount,category,description,expense_date,created_by) VALUES (?,?,?,?,?,?,?)',
      [id, req.orgId, parseFloat(amount), category||'Other', description||'', expense_date, req.user.id]);
    res.json({ success: true, expense: get('SELECT * FROM expenses WHERE id=?', [id]) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/expenses/:id', (req, res) => {
  run('DELETE FROM expenses WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

// ── Unlinked donations (Issue 24) ─────────────────────────────────────────────
router.post('/donations/unlinked', (req, res) => {
  try {
    const { amount, method, donor_name, donation_date, transaction_id, notes } = req.body;
    if (!amount || !method) return res.status(400).json({ error: 'amount and method required' });
    const id = require('uuid').v4();
    const txId = transaction_id || ('ES' + String(Math.floor(Math.random()*1000000000)).padStart(9,'0'));
    run(`INSERT INTO donations (id,org_id,donor_id,amount,method,transaction_id,donation_date,status,notes,is_manual,created_by)
         VALUES (?,?,NULL,?,?,?,?,?,?,1,?)`,
      [id, req.orgId, parseFloat(amount), method, txId,
       donation_date || new Date().toISOString(),
       'completed',
       donor_name ? `Unlinked: ${donor_name}${notes?' — '+notes:''}` : (notes||null),
       req.user.id]);
    res.json({ success: true, donation: get('SELECT * FROM donations WHERE id=?', [id]) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Link a donation to a donor ────────────────────────────────────────────────
router.put('/donations/:donationId/link', (req, res) => {
  const { donor_id } = req.body;
  const don = get('SELECT id FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
  if (!don) return res.status(404).json({ error: 'Donation not found' });
  if (donor_id) {
    const donor = get('SELECT id FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });
  }
  run('UPDATE donations SET donor_id=? WHERE id=? AND org_id=?',
    [donor_id || null, req.params.donationId, req.orgId]);
  res.json({ success: true });
});

// ── Label a donation transaction ──────────────────────────────────────────────
router.put('/donations/:donationId/label', (req, res) => {
  try {
    const { label, labels, action } = req.body;
    const don = get('SELECT labels FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });

    if (labels !== undefined) {
      // Replace the full label set at once (used by the label editor modal)
      run('UPDATE donations SET labels=?,label=? WHERE id=? AND org_id=?',
        [JSON.stringify(labels), labels[0]||null, req.params.donationId, req.orgId]);
    } else if (label) {
      // Add or remove a single label (used by quick-add/remove actions)
      const current = (() => { try { return JSON.parse(don.labels||'[]'); } catch { return []; } })();
      let updated;
      if (action === 'remove') updated = current.filter(l => l !== label);
      else updated = current.includes(label) ? current : [...current, label];
      run('UPDATE donations SET labels=?,label=? WHERE id=? AND org_id=?',
        [JSON.stringify(updated), updated[0]||null, req.params.donationId, req.orgId]);
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// donor search moved to donors.js

// ── Label lists (donor labels + donation labels) ───────────────────────────────
router.get('/label-lists', (req, res) => {
  const r = get('SELECT * FROM org_label_lists WHERE org_id=?', [req.orgId]);
  res.json({
    donor_labels:    (() => { try { return JSON.parse(r?.donor_labels||'[]'); } catch { return []; } })(),
    donation_labels: (() => { try { return JSON.parse(r?.donation_labels||'[]'); } catch { return []; } })(),
    lead_labels:     (() => { try { return JSON.parse(r?.lead_labels||'[]'); } catch { return []; } })()
  });
});

router.put('/label-lists', requireOrgAdmin, (req, res) => {
  const { donor_labels, donation_labels, lead_labels } = req.body;
  const ex = get('SELECT * FROM org_label_lists WHERE org_id=?', [req.orgId]);
  if (ex) {
    run('UPDATE org_label_lists SET donor_labels=?,donation_labels=?,lead_labels=?,updated_at=CURRENT_TIMESTAMP WHERE org_id=?',
      [JSON.stringify(donor_labels||[]), JSON.stringify(donation_labels||[]), JSON.stringify(lead_labels!==undefined?lead_labels:JSON.parse(ex.lead_labels||'[]')), req.orgId]);
  } else {
    run('INSERT INTO org_label_lists (id,org_id,donor_labels,donation_labels,lead_labels) VALUES (?,?,?,?,?)',
      [require('uuid').v4(), req.orgId, JSON.stringify(donor_labels||[]), JSON.stringify(donation_labels||[]), JSON.stringify(lead_labels||[])]);
  }
  res.json({ success: true });
});

// ── Add note to any donation (linked or unlinked) ─────────────────────────────
router.post('/donations/:donationId/notes', (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    const don = get('SELECT * FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });
    const notes = (() => { try { return JSON.parse(don.donation_notes || '[]'); } catch { return []; } })();
    notes.push({ text, at: new Date().toISOString(), by: req.user?.full_name || '' });
    run('UPDATE donations SET donation_notes=? WHERE id=? AND org_id=?',
      [JSON.stringify(notes), req.params.donationId, req.orgId]);
    res.json({ success: true, notes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Edit donation (method, date, notes, check_number — NOT amount) ────────────
router.put('/donations/:donationId/edit', (req, res) => {
  try {
    const { method, donation_date, notes, check_number, transaction_id } = req.body;
    const don = get('SELECT * FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });
    const finalNotes = check_number ? `Check #${check_number}${notes ? ' — ' + notes : ''}` : (notes ?? don.notes);
    run(`UPDATE donations SET method=?, donation_date=?, notes=?, transaction_id=? WHERE id=? AND org_id=?`,
      [method ?? don.method, donation_date ?? don.donation_date, finalNotes, transaction_id ?? don.transaction_id, req.params.donationId, req.orgId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete donation ────────────────────────────────────────────────────────────
router.delete('/donations/:donationId', (req, res) => {
  const don = get('SELECT id FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
  if (!don) return res.status(404).json({ error: 'Donation not found' });
  run('DELETE FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
  res.json({ success: true });
});

// ── Edit a donation note ───────────────────────────────────────────────────────
router.put('/donations/:donationId/notes/:noteIdx', (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    const don = get('SELECT * FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });
    const notes = (() => { try { return JSON.parse(don.donation_notes || '[]'); } catch { return []; } })();
    const idx = parseInt(req.params.noteIdx);
    if (idx < 0 || idx >= notes.length) return res.status(404).json({ error: 'Note not found' });
    notes[idx].text = text;
    notes[idx].edited_at = new Date().toISOString();
    run('UPDATE donations SET donation_notes=? WHERE id=? AND org_id=?', [JSON.stringify(notes), req.params.donationId, req.orgId]);
    res.json({ success: true, notes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Delete a donation note ─────────────────────────────────────────────────────
router.delete('/donations/:donationId/notes/:noteIdx', (req, res) => {
  try {
    const don = get('SELECT * FROM donations WHERE id=? AND org_id=?', [req.params.donationId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });
    const notes = (() => { try { return JSON.parse(don.donation_notes || '[]'); } catch { return []; } })();
    const idx = parseInt(req.params.noteIdx);
    if (idx < 0 || idx >= notes.length) return res.status(404).json({ error: 'Note not found' });
    notes.splice(idx, 1);
    run('UPDATE donations SET donation_notes=? WHERE id=? AND org_id=?', [JSON.stringify(notes), req.params.donationId, req.orgId]);
    res.json({ success: true, notes });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Debug: test the exact same receipt email path as a real donation ──────────
// This lets us compare test vs donation trigger precisely
router.post('/email-settings/test-receipt', requireOrgAdmin, async (req, res) => {
  try {
    const { donor_id } = req.body;
    const { sendReceiptEmail } = require('../utils/scheduler');
    const { get } = require('../db/schema');

    const org = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    const settings = get('SELECT * FROM email_settings WHERE org_id=?', [req.orgId]);

    // Log exactly what sendReceiptEmail will see
    console.log('[test-receipt] org.id:', org?.id);
    console.log('[test-receipt] settings found:', !!settings);
    console.log('[test-receipt] smtp_email:', settings?.smtp_email);
    console.log('[test-receipt] smtp_password set:', !!settings?.smtp_password);
    console.log('[test-receipt] donation_emails_paused:', settings?.donation_emails_paused);

    let donor;
    if (donor_id) {
      donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    } else {
      // Use the current user's email as a fake donor for testing
      donor = { id: 'test', first_name: 'Test', last_name: 'Recipient',
        email: req.user?.email || settings?.smtp_email,
        donation_emails_paused: 0, hebrew_full_name: '', title: '' };
    }
    console.log('[test-receipt] donor.email:', donor?.email);

    const fakeDonation = { id: 'test-don-' + Date.now(), amount: 100,
      donation_date: new Date().toISOString(), transaction_id: 'ES-TEST-001',
      method: 'check', payment_method_id: null };

    await sendReceiptEmail(donor, fakeDonation, org);
    res.json({ success: true, message: 'Check Render logs for [receipt] entries' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Email log ──────────────────────────────────────────────────────────────────
router.get('/email-log', (req, res) => {
  const { type, status, q, limit = 100 } = req.query;
  let sql = `
    SELECT el.*, d.first_name, d.last_name
    FROM email_log el
    LEFT JOIN donors d ON el.donor_id = d.id
    WHERE el.org_id = ?`;
  const params = [req.orgId];
  if (type)   { sql += ' AND el.type = ?';          params.push(type); }
  if (status) { sql += ' AND el.status = ?';        params.push(status); }
  if (q)      { sql += ' AND (el.to_email LIKE ? OR el.subject LIKE ?)';
                params.push('%'+q+'%', '%'+q+'%'); }
  sql += ' ORDER BY el.sent_at DESC LIMIT ?';
  params.push(parseInt(limit) || 100);
  res.json(all(sql, params));
});

// ── Email log: get full HTML body of a logged email ────────────────────────────
router.get('/email-log/:id/body', (req, res) => {
  const row = get('SELECT html_body, subject FROM email_log WHERE id=? AND org_id=?',
    [req.params.id, req.orgId]);
  if (!row) return res.status(404).json({ error: 'Email not found' });
  if (!row.html_body) return res.status(404).json({ error: 'No body stored for this email' });
  // Return as HTML so it can be rendered in an iframe
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.send(row.html_body);
});

// ── Email log: forward a logged email to a new address ────────────────────────
router.post('/email-log/:id/forward', requireOrgAdmin, async (req, res) => {
  try {
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient address required' });

    const row = get('SELECT * FROM email_log WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
    if (!row) return res.status(404).json({ error: 'Email not found' });
    if (!row.html_body) return res.status(400).json({ error: 'No body stored — cannot forward' });

    const settings = get('SELECT * FROM email_settings WHERE org_id=?', [req.orgId]);
    const org      = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    const { fromAddr, sendMail } = require('../utils/mailer');

    await sendMail({
      settings, orgId: req.orgId,
      to, from: fromAddr(settings, org?.name),
      subject: `Fwd: ${row.subject}`,
      html: row.html_body,
      type: row.type,
      donorId: row.donor_id, donationId: row.donation_id
    });

    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Database backup status + manual trigger ────────────────────────────────────
router.get('/backup/status', requireOrgAdmin, (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '../data');
  const BACKUP_DIR = path.join(DATA_DIR, 'backups');
  const DB_PATH    = path.join(DATA_DIR, 'drm.db');

  const dbSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  let backups = [];
  if (fs.existsSync(BACKUP_DIR)) {
    backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('drm-') && f.endsWith('.db'))
      .map(f => {
        const s = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size: s.size, date: f.replace('drm-','').replace('.db',''), mtime: s.mtime };
      })
      .sort((a,b) => b.date.localeCompare(a.date));
  }

  res.json({
    db_size: dbSize,
    db_path: DB_PATH,
    backup_count: backups.length,
    latest_backup: backups[0] || null,
    backups: backups.slice(0, 10) // last 10
  });
});

router.post('/backup/run', requireOrgAdmin, async (req, res) => {
  try {
    const { runDailyBackup } = require('../utils/scheduler');
    if (typeof runDailyBackup !== 'function') {
      // Call it directly if not exported
      const fs   = require('fs');
      const path = require('path');
      const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '../data');
      const DB_PATH    = path.join(DATA_DIR, 'drm.db');
      const BACKUP_DIR = path.join(DATA_DIR, 'backups');
      if (!fs.existsSync(DB_PATH)) return res.status(400).json({ error: 'No DB file found' });
      if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const date = new Date().toISOString().slice(0,10)+'-'+Date.now().toString(36);
      const dest = path.join(BACKUP_DIR, `drm-${date}.db`);
      fs.copyFileSync(DB_PATH, dest);
      return res.json({ success: true, file: dest, size: fs.statSync(dest).size });
    }
    await runDailyBackup();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Download a backup file ────────────────────────────────────────────────────
router.get('/backup/download/:filename', requireOrgAdmin, (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '../data');
  const BACKUP_DIR = path.join(DATA_DIR, 'backups');
  const filename   = req.params.filename.replace(/[^a-zA-Z0-9\-_.]/g, ''); // sanitize
  const filepath   = path.join(BACKUP_DIR, filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'Backup not found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(fs.readFileSync(filepath));
});
