// routes/donors.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const { requireAuth, requireOrg } = require('../middleware/auth');

// Apply auth + org middleware
router.use(requireAuth, requireOrg);

// List donors
router.get('/', (req, res) => {
  const { search, neighborhood, label, kvitel_enabled, autopay, page = 1, limit = 50 } = req.query;
  let sql = `
    SELECT d.*,
      n.name_he as neighborhood_name,
      CAST((julianday('now') - julianday(d.created_at)) / 30.44 AS INTEGER) as months_old,
      (SELECT COUNT(*) FROM donations WHERE donor_id = d.id AND status = 'completed') as total_donations,
      (SELECT COALESCE(SUM(amount),0) FROM donations WHERE donor_id = d.id AND status = 'completed') as total_amount,
      (SELECT MAX(donation_date) FROM donations WHERE donor_id = d.id AND status = 'completed') as last_donation_date,
      CASE WHEN d.info_verified_at IS NULL OR julianday('now') - julianday(d.info_verified_at) > 180
           THEN 1 ELSE 0 END as needs_verification
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.org_id = ?
  `;
  const params = [req.orgId];

  if (search) {
    sql += ` AND (d.first_name LIKE ? OR d.last_name LIKE ? OR d.email LIKE ? OR d.cell LIKE ? OR d.hebrew_full_name LIKE ?)`;
    const s = `%${search}%`;
    params.push(s, s, s, s, s);
  }
  if (neighborhood) { sql += ' AND d.neighborhood_id = ?'; params.push(neighborhood); }
  if (kvitel_enabled !== undefined) { sql += ' AND d.kvitel_enabled = ?'; params.push(kvitel_enabled); }
  if (autopay !== undefined) { sql += ' AND d.autopay_enabled = ?'; params.push(autopay); }

  sql += ' ORDER BY d.last_name, d.first_name';

  const offset = (parseInt(page) - 1) * parseInt(limit);
  const countSql = sql.replace(/SELECT d\.\*[\s\S]+?FROM donors/, 'SELECT COUNT(*) as total FROM donors');
  const total = get(countSql.split('ORDER BY')[0], params)?.total || 0;

  sql += ` LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), offset);

  const donors = all(sql, params);

  // Filter by label if needed
  let filtered = donors;
  if (label) {
    filtered = donors.filter(d => {
      try { const labels = JSON.parse(d.labels || '[]'); return labels.includes(label); } catch { return false; }
    });
  }

  res.json({ donors: filtered, total, page: parseInt(page), limit: parseInt(limit) });
});

// Get donors needing verification (>6 months)
router.get('/needs-verification', (req, res) => {
  const donors = all(`
    SELECT d.*, n.name_he as neighborhood_name,
      CAST((julianday('now') - julianday(d.created_at)) / 30.44 AS INTEGER) as months_old
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.org_id = ?
    AND (d.info_verified_at IS NULL OR julianday('now') - julianday(d.info_verified_at) > 180)
    ORDER BY d.info_verified_at ASC, d.created_at ASC
  `, [req.orgId]);
  res.json(donors);
});

// Get single donor
// ── Search donors — must be before /:id ──────────────────────────────────────
router.get('/search', (req, res) => {
  const q = '%' + (req.query.q || '') + '%';
  const donors = all(`
    SELECT id, first_name, last_name, hebrew_full_name, email, cell
    FROM donors WHERE org_id=?
      AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR cell LIKE ? OR hebrew_full_name LIKE ?)
    ORDER BY last_name, first_name LIMIT 20`,
    [req.orgId, q, q, q, q, q]);
  res.json(donors);
});

router.get('/:id', (req, res) => {
  const donor = get(`
    SELECT d.*,
      n.name_he as neighborhood_name,
      CAST((julianday('now') - julianday(d.created_at)) / 30.44 AS INTEGER) as months_old,
      (SELECT COUNT(*) FROM donations WHERE donor_id = d.id AND status = 'completed') as total_donations,
      (SELECT COALESCE(SUM(amount),0) FROM donations WHERE donor_id = d.id AND status = 'completed') as total_amount,
      (SELECT MAX(donation_date) FROM donations WHERE donor_id = d.id AND status = 'completed') as last_donation_date,
      CASE WHEN d.info_verified_at IS NULL OR julianday('now') - julianday(d.info_verified_at) > 180
           THEN 1 ELSE 0 END as needs_verification
    FROM donors d
    LEFT JOIN neighborhoods n ON d.neighborhood_id = n.id
    WHERE d.id = ? AND d.org_id = ?
  `, [req.params.id, req.orgId]);

  if (!donor) return res.status(404).json({ error: 'Donor not found' });

  const paymentMethods = all('SELECT * FROM payment_methods WHERE donor_id = ? ORDER BY is_default DESC, created_at DESC', [req.params.id]);
  const donations = all(`
    SELECT don.*, pm.label as method_label, pm.last_four, pm.type as pm_type
    FROM donations don
    LEFT JOIN payment_methods pm ON don.payment_method_id = pm.id
    WHERE don.donor_id = ?
    ORDER BY don.donation_date DESC
    LIMIT 100
  `, [req.params.id]);
  const scheduledCharges = all('SELECT * FROM scheduled_charges WHERE donor_id = ? AND status = ? ORDER BY scheduled_for', [req.params.id, 'pending']);

  res.json({ donor, paymentMethods, donations, scheduledCharges });
});

// Create donor
router.post('/', (req, res) => {
  try {
    const {
      title, first_name, last_name, hebrew_title, hebrew_full_name,
      cell, home_phone, email, neighborhood_id,
      street, apt, city, state, zip,
      labels = [], kvitel = '', kvitel_enabled = 1
    } = req.body;

    if (!first_name || !last_name) return res.status(400).json({ error: 'First and last name required' });

    const id = uuidv4();
    run(`
      INSERT INTO donors (
        id, org_id, title, first_name, last_name, hebrew_title, hebrew_full_name,
        cell, home_phone, email, neighborhood_id,
        street, apt, city, state, zip,
        labels, kvitel, kvitel_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, req.orgId, title || null, first_name, last_name, hebrew_title || null, hebrew_full_name || null,
      cell || null, home_phone || null, email || null, neighborhood_id || null,
      street || null, apt || null, city || null, state || null, zip || null,
      JSON.stringify(labels), kvitel, kvitel_enabled ? 1 : 0
    ]);

    const donor = get('SELECT * FROM donors WHERE id = ?', [id]);
    res.json({ success: true, donor });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update donor
router.put('/:id', (req, res) => {
  try {
    const existing = get('SELECT * FROM donors WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!existing) return res.status(404).json({ error: 'Donor not found' });

    const {
      title, first_name, last_name, hebrew_title, hebrew_full_name,
      cell, home_phone, email, neighborhood_id,
      street, apt, city, state, zip,
      labels, kvitel, kvitel_enabled,
      autopay_enabled, autopay_day, autopay_hour, autopay_minute, autopay_paused,
      donation_emails_paused, marketing_emails_paused, notes
    } = req.body;

    run(`
      UPDATE donors SET
        title = ?, first_name = ?, last_name = ?, hebrew_title = ?, hebrew_full_name = ?,
        cell = ?, home_phone = ?, email = ?, neighborhood_id = ?,
        street = ?, apt = ?, city = ?, state = ?, zip = ?,
        labels = ?, kvitel = ?, kvitel_enabled = ?,
        autopay_enabled = ?, autopay_day = ?, autopay_hour = ?, autopay_minute = ?, autopay_paused = ?,
        donation_emails_paused = ?, marketing_emails_paused = ?,
        notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND org_id = ?
    `, [
      title ?? existing.title, first_name ?? existing.first_name, last_name ?? existing.last_name,
      hebrew_title ?? existing.hebrew_title, hebrew_full_name ?? existing.hebrew_full_name,
      cell ?? existing.cell, home_phone ?? existing.home_phone, email ?? existing.email,
      neighborhood_id ?? existing.neighborhood_id,
      street ?? existing.street, apt ?? existing.apt, city ?? existing.city,
      state ?? existing.state, zip ?? existing.zip,
      labels !== undefined ? JSON.stringify(labels) : existing.labels,
      kvitel ?? existing.kvitel,
      kvitel_enabled !== undefined ? (kvitel_enabled ? 1 : 0) : existing.kvitel_enabled,
      autopay_enabled !== undefined ? (autopay_enabled ? 1 : 0) : existing.autopay_enabled,
      autopay_day ?? existing.autopay_day,
      autopay_hour ?? existing.autopay_hour,
      autopay_minute ?? existing.autopay_minute,
      autopay_paused !== undefined ? (autopay_paused ? 1 : 0) : existing.autopay_paused,
      donation_emails_paused !== undefined ? (donation_emails_paused ? 1 : 0) : existing.donation_emails_paused,
      marketing_emails_paused !== undefined ? (marketing_emails_paused ? 1 : 0) : existing.marketing_emails_paused,
      notes !== undefined ? JSON.stringify(notes) : existing.notes,
      req.params.id, req.orgId
    ]);

    const updated = get('SELECT * FROM donors WHERE id = ?', [req.params.id]);
    res.json({ success: true, donor: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark info verified
router.post('/:id/verify', (req, res) => {
  const existing = get('SELECT id FROM donors WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!existing) return res.status(404).json({ error: 'Donor not found' });
  run('UPDATE donors SET info_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// Delete donor
router.delete('/:id', (req, res) => {
  const existing = get('SELECT id FROM donors WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!existing) return res.status(404).json({ error: 'Donor not found' });
  run('DELETE FROM scheduled_charges WHERE donor_id = ?', [req.params.id]);
  run('DELETE FROM payment_methods WHERE donor_id = ?', [req.params.id]);
  run('DELETE FROM donations WHERE donor_id = ?', [req.params.id]);
  run('DELETE FROM donors WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// --- AUTOPAY CONTROLS ---
router.post('/autopay/pause-all', (req, res) => {
  run('UPDATE donors SET autopay_paused = 1 WHERE org_id = ?', [req.orgId]);
  res.json({ success: true });
});
router.post('/autopay/resume-all', (req, res) => {
  run('UPDATE donors SET autopay_paused = 0 WHERE org_id = ?', [req.orgId]);
  res.json({ success: true });
});

// --- PAYMENT METHODS ---
router.get('/:id/payment-methods', (req, res) => {
  const methods = all('SELECT * FROM payment_methods WHERE donor_id = ? AND org_id = ? ORDER BY is_default DESC', [req.params.id, req.orgId]);
  res.json(methods);
});

router.post('/:id/payment-methods', async (req, res) => {
  try {
    const { type, label, last_four, card_brand, daf_name, other_description, stripe_payment_method_id, is_default = 0 } = req.body;
    if (!type) return res.status(400).json({ error: 'Type required' });

    const donor = get('SELECT * FROM donors WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    if (is_default) {
      run('UPDATE payment_methods SET is_default = 0 WHERE donor_id = ?', [req.params.id]);
    }

    const pmId = uuidv4();
    run(`INSERT INTO payment_methods (id, donor_id, org_id, type, label, last_four, card_brand, daf_name, other_description, stripe_payment_method_id, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [pmId, req.params.id, req.orgId, type, label || null, last_four || null, card_brand || null, daf_name || null, other_description || null, stripe_payment_method_id || null, is_default ? 1 : 0]);

    res.json({ success: true, paymentMethod: get('SELECT * FROM payment_methods WHERE id = ?', [pmId]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id/payment-methods/:pmId', (req, res) => {
  run('DELETE FROM payment_methods WHERE id = ? AND donor_id = ? AND org_id = ?', [req.params.pmId, req.params.id, req.orgId]);
  res.json({ success: true });
});

// --- DONATIONS ---
router.get('/:id/donations', (req, res) => {
  const donations = all(`
    SELECT don.*, pm.label as method_label, pm.last_four, pm.type as pm_type
    FROM donations don
    LEFT JOIN payment_methods pm ON don.payment_method_id = pm.id
    WHERE don.donor_id = ? AND don.org_id = ?
    ORDER BY don.donation_date DESC
  `, [req.params.id, req.orgId]);
  res.json(donations);
});

router.post('/:id/donations', async (req, res) => {
  try {
    const { amount, method, payment_method_id, transaction_id, donation_date, notes, check_number, send_receipt } = req.body;
    if (!amount || !method) return res.status(400).json({ error: 'Amount and method required' });
    if (method === 'check' && !check_number) return res.status(400).json({ error: 'Check number required for check payments' });

    const donor = get('SELECT * FROM donors WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const id = uuidv4();
    const autoTxId = transaction_id || ('ES' + String(Math.floor(Math.random() * 1000000000)).padStart(9, '0'));
    const finalNotes = check_number ? `Check #${check_number}${notes ? ' — ' + notes : ''}` : (notes || null);

    run(`INSERT INTO donations (id, org_id, donor_id, amount, method, payment_method_id, transaction_id, donation_date, notes, status, is_manual, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 1, ?)`,
      [id, req.orgId, req.params.id, amount, method, payment_method_id || null, autoTxId,
       donation_date || new Date().toISOString(), finalNotes, req.user.id]);

    const donation = get('SELECT * FROM donations WHERE id = ?', [id]);
    const org = get('SELECT * FROM organizations WHERE id = ?', [req.orgId]);

    // Send receipt — default ON, only skip if explicitly set to false
    if (send_receipt !== false && send_receipt !== 'false') {
      const { sendReceiptEmail } = require('../utils/scheduler');
      await sendReceiptEmail(donor, donation, org).catch(e => console.error('[receipt] Failed:', e.message));
    } else {
      console.log(`[receipt] Skipped by user choice for donation ${id}`);
    }

    res.json({ success: true, donation });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// --- SCHEDULED CHARGES ---
router.get('/:id/scheduled-charges', (req, res) => {
  const charges = all('SELECT * FROM scheduled_charges WHERE donor_id = ? AND status = ? ORDER BY scheduled_for', [req.params.id, 'pending']);
  res.json(charges);
});

router.post('/:id/scheduled-charges', (req, res) => {
  try {
    const { payment_method_id, amount, scheduled_for, notes } = req.body;
    if (!payment_method_id || !amount || !scheduled_for) return res.status(400).json({ error: 'Payment method, amount and date required' });

    const id = uuidv4();
    run(`INSERT INTO scheduled_charges (id, org_id, donor_id, payment_method_id, amount, scheduled_for, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.orgId, req.params.id, payment_method_id, amount, scheduled_for, notes || null]);

    res.json({ success: true, charge: get('SELECT * FROM scheduled_charges WHERE id = ?', [id]) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/scheduled-charges/:chargeId', (req, res) => {
  const { scheduled_for, amount } = req.body;
  run('UPDATE scheduled_charges SET scheduled_for = ?, amount = ? WHERE id = ? AND donor_id = ?',
    [scheduled_for, amount, req.params.chargeId, req.params.id]);
  res.json({ success: true });
});

router.delete('/:id/scheduled-charges/:chargeId', (req, res) => {
  run('UPDATE scheduled_charges SET status = ? WHERE id = ? AND donor_id = ?', ['cancelled', req.params.chargeId, req.params.id]);
  res.json({ success: true });
});

// --- NEIGHBORHOODS ---
router.get('/meta/neighborhoods', (req, res) => {
  const hoods = all('SELECT * FROM neighborhoods WHERE org_id = ? ORDER BY sort_order, name_he', [req.orgId]);
  res.json(hoods);
});

router.post('/meta/neighborhoods', (req, res) => {
  const { name_he, name_en } = req.body;
  if (!name_he) return res.status(400).json({ error: 'Hebrew name required' });
  const id = uuidv4();
  run('INSERT INTO neighborhoods (id, org_id, name_he, name_en) VALUES (?, ?, ?, ?)', [id, req.orgId, name_he, name_en || null]);
  res.json({ success: true, neighborhood: get('SELECT * FROM neighborhoods WHERE id = ?', [id]) });
});

router.delete('/meta/neighborhoods/:id', (req, res) => {
  run('DELETE FROM neighborhoods WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

// --- RECURRING SCHEDULES ---
router.get('/:id/recurring', (req, res) => {
  const schedules = all(`
    SELECT rs.*, pm.label as pm_label, pm.last_four, pm.card_brand, pm.type as pm_type
    FROM recurring_schedules rs
    LEFT JOIN payment_methods pm ON rs.payment_method_id = pm.id
    WHERE rs.donor_id = ? AND rs.org_id = ? AND rs.status IN ('active','paused')
    ORDER BY rs.created_at DESC
  `, [req.params.id, req.orgId]);
  res.json(schedules);
});

router.post('/:id/recurring', (req, res) => {
  try {
    const { payment_method_id, amount, frequency, start_date, end_date, occurrences_limit, notes } = req.body;
    if (!payment_method_id || !amount || !frequency || !start_date) {
      return res.status(400).json({ error: 'payment_method_id, amount, frequency and start_date required' });
    }
    const id = uuidv4();
    run(`INSERT INTO recurring_schedules
         (id, org_id, donor_id, payment_method_id, amount, frequency, start_date, next_run, end_date, occurrences_limit, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.orgId, req.params.id, payment_method_id, amount, frequency,
       start_date, start_date, end_date || null, occurrences_limit || null, notes || null]);
    res.json({ success: true, schedule: get('SELECT * FROM recurring_schedules WHERE id = ?', [id]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/recurring/:sid', (req, res) => {
  const { amount, frequency, next_run, end_date, occurrences_limit, status, notes } = req.body;
  const existing = get('SELECT * FROM recurring_schedules WHERE id = ? AND donor_id = ?', [req.params.sid, req.params.id]);
  if (!existing) return res.status(404).json({ error: 'Schedule not found' });

  // When resuming, recalculate next_run from today's date using frequency
  let resolvedNextRun = next_run ?? existing.next_run;
  if (status === 'active' && existing.status === 'paused') {
    const freq = frequency ?? existing.frequency;
    const now = new Date();
    const next = new Date(now);
    switch(freq) {
      case 'weekly':     next.setDate(now.getDate() + 7); break;
      case 'biweekly':   next.setDate(now.getDate() + 14); break;
      case 'monthly':    next.setMonth(now.getMonth() + 1); break;
      case 'quarterly':  next.setMonth(now.getMonth() + 3); break;
      case 'yearly':     next.setFullYear(now.getFullYear() + 1); break;
      default:           next.setMonth(now.getMonth() + 1);
    }
    // If next_run is today or in the past, keep today so UI shows "Due today"
    const existingNext = existing.next_run ? new Date(existing.next_run) : null;
    const todayMidnight = new Date(); todayMidnight.setHours(0,0,0,0);
    if (existingNext && existingNext <= todayMidnight) {
      resolvedNextRun = now.toISOString().slice(0,10); // today
    } else {
      resolvedNextRun = next.toISOString().slice(0,10);
    }
  }

  run(`UPDATE recurring_schedules SET
       amount = ?, frequency = ?, next_run = ?, end_date = ?,
       occurrences_limit = ?, status = ?, notes = ?
       WHERE id = ?`,
    [amount ?? existing.amount, frequency ?? existing.frequency, resolvedNextRun,
     end_date ?? existing.end_date, occurrences_limit ?? existing.occurrences_limit,
     status ?? existing.status, notes ?? existing.notes, req.params.sid]);
  res.json({ success: true });
});

router.delete('/:id/recurring/:sid', (req, res) => {
  run(`UPDATE recurring_schedules SET status = 'cancelled' WHERE id = ? AND donor_id = ? AND org_id = ?`,
    [req.params.sid, req.params.id, req.orgId]);
  res.json({ success: true });
});

// --- DONATION NOTES ---
router.post('/:donorId/donations/:donId/notes', (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });
    const don = get('SELECT * FROM donations WHERE id = ? AND donor_id = ?', [req.params.donId, req.params.donorId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });
    const notes = (() => { try { return JSON.parse(don.donation_notes || '[]'); } catch { return []; } })();
    notes.push({ text, at: new Date().toISOString() });
    run('UPDATE donations SET donation_notes = ? WHERE id = ?', [JSON.stringify(notes), req.params.donId]);
    res.json({ success: true, notes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- REFUNDS ---
router.post('/:donorId/donations/:donId/refund', async (req, res) => {
  try {
    const { amount, notes, ref_num } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount required' });
    const don = get('SELECT * FROM donations WHERE id = ? AND donor_id = ? AND org_id = ?',
      [req.params.donId, req.params.donorId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });

    const refundAmt = parseFloat(amount);
    const totalRefunded = (don.refund_amount || 0) + refundAmt;
    if (totalRefunded > don.amount) return res.status(400).json({ error: 'Refund exceeds donation amount' });

    // If CC and we have a ref_num, hit Sola
    let solaRefNum = null;
    if (don.method === 'credit_card' && (ref_num || don.transaction_id)) {
      try {
        const { refundTransaction } = require('../utils/sola');
        const result = await refundTransaction(req.orgId, {
          refNum: ref_num || don.transaction_id,
          amount: refundAmt
        });
        solaRefNum = result.refNum;
      } catch (e) {
        return res.status(500).json({ error: 'Sola refund failed: ' + e.message });
      }
    }

    const newStatus = totalRefunded >= don.amount ? 'refunded' : 'partial_refund';
    const refundNote = `${notes || 'Refund'} — $${refundAmt.toFixed(2)}${solaRefNum ? ' (Sola ref: ' + solaRefNum + ')' : ''}`;
    run(`UPDATE donations SET refund_amount = ?, refund_notes = ?, status = ? WHERE id = ?`,
      [totalRefunded, refundNote, newStatus, req.params.donId]);

    res.json({ success: true, newStatus, solaRefNum });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- LABELS ---
router.get('/meta/labels', (req, res) => {
  const donors = all('SELECT labels FROM donors WHERE org_id = ?', [req.orgId]);
  const labelSet = new Set();
  donors.forEach(d => {
    try { JSON.parse(d.labels || '[]').forEach(l => labelSet.add(l)); } catch {}
  });
  res.json([...labelSet].sort());
});

module.exports = router;
