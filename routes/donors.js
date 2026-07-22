// routes/donors.js
const express = require('express');
const router = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');
const { findDuplicateClusters } = require('../utils/duplicates');

// Apply auth + org middleware
router.use(requireAuth, requireOrg);

// Build a donor.id -> { other, reason } map from the live duplicate clusters, for
// annotating list/detail rows with the "⚠ DUPLICATE" badge. Only non-dismissed pairs.
function _donorDupMap(orgId) {
  const clusters = findDuplicateClusters(orgId);
  const dismissals = all('SELECT * FROM duplicate_dismissals WHERE org_id=?', [orgId]);
  const dismissedKeys = new Set(dismissals.map(d => `${d.entity_a_type}:${d.entity_a_id}|${d.entity_b_type}:${d.entity_b_id}`));
  const map = new Map();
  for (const c of clusters) {
    const key = `${c.a.type}:${c.a.id}|${c.b.type}:${c.b.id}`;
    if (dismissedKeys.has(key)) continue;
    if (c.a.type === 'donor' && !map.has(c.a.id)) map.set(c.a.id, { other_id: c.b.id, other_type: c.b.type, reason: c.reasons.join(', ') });
    if (c.b.type === 'donor' && !map.has(c.b.id)) map.set(c.b.id, { other_id: c.a.id, other_type: c.a.type, reason: c.reasons.join(', ') });
  }
  return map;
}

// List donors
router.get('/', (req, res) => {
  const { search, neighborhood, label, kvitel_enabled, autopay, duplicates_only, page = 1, limit = 50 } = req.query;
  const dupMap = (duplicates_only === '1' || duplicates_only === 'true') ? _donorDupMap(req.orgId) : null;

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
    WHERE d.org_id = ? AND d.removed_at IS NULL
  `;
  const params = [req.orgId];

  if (search) {
    sql += ` AND (d.first_name LIKE ? OR d.last_name LIKE ? OR d.email LIKE ? OR d.cell LIKE ? OR d.hebrew_full_name LIKE ? OR CAST(d.donor_number AS TEXT) LIKE ?)`;
    const s = `%${search.replace(/^#/, '')}%`;
    params.push(s, s, s, s, s, s);
  }
  if (neighborhood) { sql += ' AND d.neighborhood_id = ?'; params.push(neighborhood); }
  if (kvitel_enabled !== undefined) { sql += ' AND d.kvitel_enabled = ?'; params.push(kvitel_enabled); }
  if (autopay !== undefined) { sql += ' AND d.autopay_enabled = ?'; params.push(autopay); }
  if (dupMap) {
    const ids = [...dupMap.keys()];
    sql += ids.length ? ` AND d.id IN (${ids.map(()=>'?').join(',')})` : ' AND 1=0';
    params.push(...ids);
  }

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

  // Annotate with live duplicate badges (compute once if not already, e.g. when duplicates_only wasn't set)
  const badgeMap = dupMap || _donorDupMap(req.orgId);
  for (const d of filtered) {
    const dup = badgeMap.get(d.id);
    d.dup_id = dup ? d.id : null;
    d.dup_other_id = dup ? dup.other_id : null;
    d.dup_other_type = dup ? dup.other_type : null;
    d.dup_reason = dup ? dup.reason : null;
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
    WHERE d.org_id = ? AND d.removed_at IS NULL
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
    FROM donors WHERE org_id=? AND removed_at IS NULL
      AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ? OR cell LIKE ? OR hebrew_full_name LIKE ?)
    ORDER BY last_name, first_name LIMIT 20`,
    [req.orgId, q, q, q, q, q]);
  res.json(donors);
});

// ── Recently removed donors (30-day restore window) — must be before /:id ──────
router.get('/removed', (req, res) => {
  const donors = all(`
    SELECT id, first_name, last_name, donor_number, email, cell, removed_at
    FROM donors WHERE org_id=? AND removed_at IS NOT NULL
      AND julianday('now') - julianday(removed_at) <= 30
    ORDER BY removed_at DESC
  `, [req.orgId]);
  res.json(donors);
});

// ── Duplicate flags (computed live, across donors + leads) — must be before /:id ────
// See utils/duplicates.js. Status here means: 'pending' (default) = not dismissed,
// 'dismissed' = explicitly marked "not a duplicate", 'all' = both.
router.get('/duplicates', (req, res) => {
  const { status } = req.query;
  const clusters = findDuplicateClusters(req.orgId);
  const dismissals = all('SELECT * FROM duplicate_dismissals WHERE org_id=?', [req.orgId]);
  const dismissedKeys = new Set(dismissals.map(d => `${d.entity_a_type}:${d.entity_a_id}|${d.entity_b_type}:${d.entity_b_id}`));

  const entityInfo = e => ({
    type: e.type, id: e.id,
    name: `${e.first_name||''} ${e.last_name||''}`.trim() || '(no name)',
    email: e.email||null, cell: e.cell||null, number: e.donor_number||null
  });

  let result = clusters.map(c => {
    const key = `${c.a.type}:${c.a.id}|${c.b.type}:${c.b.id}`;
    return { key, reason: c.reasons.join(', '), dismissed: dismissedKeys.has(key), entity_a: entityInfo(c.a), entity_b: entityInfo(c.b) };
  });

  if (status === 'dismissed')      result = result.filter(c => c.dismissed);
  else if (status !== 'all')       result = result.filter(c => !c.dismissed); // default: pending

  res.json(result);
});

// "Keep both" — remembers this pair is not actually a duplicate so it stops resurfacing.
router.post('/duplicates/dismiss', requireOrgAdmin, (req, res) => {
  const { entity_a_type, entity_a_id, entity_b_type, entity_b_id } = req.body;
  if (!entity_a_type || !entity_a_id || !entity_b_type || !entity_b_id) return res.status(400).json({ error: 'Missing entity info' });
  const ka = `${entity_a_type}:${entity_a_id}`, kb = `${entity_b_type}:${entity_b_id}`;
  const [aType, aId, bType, bId] = ka < kb
    ? [entity_a_type, entity_a_id, entity_b_type, entity_b_id]
    : [entity_b_type, entity_b_id, entity_a_type, entity_a_id];
  run(`INSERT OR IGNORE INTO duplicate_dismissals (id,org_id,entity_a_type,entity_a_id,entity_b_type,entity_b_id,dismissed_by) VALUES (?,?,?,?,?,?,?)`,
    [uuidv4(), req.orgId, aType, aId, bType, bId, req.user.id]);
  res.json({ success: true });
});

router.post('/duplicates/undismiss', requireOrgAdmin, (req, res) => {
  const { entity_a_type, entity_a_id, entity_b_type, entity_b_id } = req.body;
  if (!entity_a_type || !entity_a_id || !entity_b_type || !entity_b_id) return res.status(400).json({ error: 'Missing entity info' });
  const ka = `${entity_a_type}:${entity_a_id}`, kb = `${entity_b_type}:${entity_b_id}`;
  const [aType, aId, bType, bId] = ka < kb
    ? [entity_a_type, entity_a_id, entity_b_type, entity_b_id]
    : [entity_b_type, entity_b_id, entity_a_type, entity_a_id];
  run(`DELETE FROM duplicate_dismissals WHERE org_id=? AND entity_a_type=? AND entity_a_id=? AND entity_b_type=? AND entity_b_id=?`,
    [req.orgId, aType, aId, bType, bId]);
  res.json({ success: true });
});

// Merge is only meaningful between two donors — moves donations/payment methods onto the
// kept donor and deletes the other. For a donor/lead pair, resolve manually (e.g. convert
// or delete the lead) and dismiss the pair instead.
router.post('/duplicates/merge', requireOrgAdmin, (req, res) => {
  const { keep_id, drop_id } = req.body;
  if (!keep_id || !drop_id || keep_id === drop_id) return res.status(400).json({ error: 'Invalid merge request' });
  const keep = get('SELECT id FROM donors WHERE id=? AND org_id=?', [keep_id, req.orgId]);
  const drop = get('SELECT id FROM donors WHERE id=? AND org_id=?', [drop_id, req.orgId]);
  if (!keep || !drop) return res.status(404).json({ error: 'Donor not found' });
  run('UPDATE donations SET donor_id=? WHERE donor_id=?', [keep_id, drop_id]);
  run('UPDATE payment_methods SET donor_id=? WHERE donor_id=?', [keep_id, drop_id]);
  run('DELETE FROM donors WHERE id=?', [drop_id]);
  res.json({ success: true });
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

  const dup = _donorDupMap(req.orgId).get(donor.id);
  donor.dup_id = dup ? donor.id : null;
  donor.dup_other_id = dup ? dup.other_id : null;
  donor.dup_other_type = dup ? dup.other_type : null;
  donor.dup_reason = dup ? dup.reason : null;

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
    // Generate unique 6-digit donor number
    let donorNum;
    for (let attempts = 0; attempts < 20; attempts++) {
      const candidate = Math.floor(100000 + Math.random() * 900000);
      const exists = get('SELECT id FROM donors WHERE donor_number=? UNION SELECT id FROM leads WHERE donor_number=?', [candidate, candidate]);
      if (!exists) { donorNum = candidate; break; }
    }
    run(`
      INSERT INTO donors (
        id, org_id, donor_number, title, first_name, last_name, hebrew_title, hebrew_full_name,
        cell, home_phone, email, neighborhood_id,
        street, apt, city, state, zip,
        labels, kvitel, kvitel_enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      id, req.orgId, donorNum||null, title || null, first_name, last_name, hebrew_title || null, hebrew_full_name || null,
      cell || null, home_phone || null, email || null, neighborhood_id || null,
      street || null, apt || null, city || null, state || null, zip || null,
      JSON.stringify(labels), kvitel, kvitel_enabled ? 1 : 0
    ]);

    const donor = get('SELECT * FROM donors WHERE id = ?', [id]);

    // Duplicate detection now runs in real time across donors + leads (see
    // utils/duplicates.js) instead of being computed and stored here at creation time.

    // Sync to Sola customer portal (async, don't block response)
    setImmediate(async () => {
      try {
        const { createCustomer } = require('../utils/solaRecurring');
        const solaId = await createCustomer(req.orgId, donor);
        run('UPDATE donors SET sola_customer_id=? WHERE id=?', [solaId, id]);
        console.log(`[sola] Created customer ${solaId} for donor ${id}`);
      } catch(e) {
        console.error(`[sola] Failed to create customer for donor ${id}: ${e.message}`);
      }
    });

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

    // Sync updates to Sola customer portal (async)
    setImmediate(async () => {
      try {
        const { createCustomer, updateCustomer, getCustomer } = require('../utils/solaRecurring');
        if (updated.sola_customer_id) {
          // Get current revision before updating (required by Sola)
          const current = await getCustomer(req.orgId, updated.sola_customer_id);
          await updateCustomer(req.orgId, updated.sola_customer_id, updated, current.Revision);
          console.log(`[sola] Updated customer ${updated.sola_customer_id} for donor ${updated.id}`);
        } else {
          // Donor exists in DRM but not yet in Sola — create now
          const solaId = await createCustomer(req.orgId, updated);
          run('UPDATE donors SET sola_customer_id=? WHERE id=?', [solaId, updated.id]);
          console.log(`[sola] Created customer ${solaId} for existing donor ${updated.id}`);
        }
      } catch(e) {
        console.error(`[sola] Failed to sync donor ${req.params.id}: ${e.message}`);
      }
    });

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

// Remove donor — soft delete, restorable for 30 days (Settings > Users mirrors this for staff)
router.delete('/:id', (req, res) => {
  const existing = get('SELECT id FROM donors WHERE id = ? AND org_id = ?', [req.params.id, req.orgId]);
  if (!existing) return res.status(404).json({ error: 'Donor not found' });
  // Stop any billing while removed. Left cancelled/paused on restore — an admin must
  // manually re-enable autopay/recurring rather than have it silently resume.
  run(`UPDATE scheduled_charges SET status='cancelled' WHERE donor_id=? AND status='pending'`, [req.params.id]);
  run(`UPDATE recurring_schedules SET status='cancelled' WHERE donor_id=? AND status='active'`, [req.params.id]);
  run('UPDATE donors SET removed_at = CURRENT_TIMESTAMP, autopay_paused = 1 WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

router.post('/:id/restore', requireOrgAdmin, (req, res) => {
  const donor = get('SELECT * FROM donors WHERE id=? AND org_id=? AND removed_at IS NOT NULL', [req.params.id, req.orgId]);
  if (!donor) return res.status(404).json({ error: 'Not found' });
  if ((Date.now() - new Date(donor.removed_at).getTime()) > 30*24*60*60*1000) {
    return res.status(400).json({ error: 'The 30-day restore window has passed' });
  }
  run('UPDATE donors SET removed_at = NULL WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ── Move a donor back to Leads ─────────────────────────────────────────────────
router.post('/:id/move-to-lead', requireOrgAdmin, (req, res) => {
  const donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!donor) return res.status(404).json({ error: 'Donor not found' });
  const hasDonations = get('SELECT id FROM donations WHERE donor_id=? LIMIT 1', [req.params.id]);
  if (hasDonations) return res.status(400).json({ error: 'This donor has donation history and cannot be moved back to Leads. Delete the donations first if this was a mistake.' });

  const leadId = uuidv4();
  run(`INSERT INTO leads (id,org_id,donor_number,title,first_name,last_name,hebrew_title,hebrew_full_name,
       email,cell,home_phone,street,apt,city,state,zip,neighborhood_id,labels,notes,status,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [leadId, req.orgId, donor.donor_number||null, donor.title, donor.first_name||'', donor.last_name||'',
     donor.hebrew_title, donor.hebrew_full_name, donor.email, donor.cell, donor.home_phone,
     donor.street, donor.apt, donor.city, donor.state, donor.zip, donor.neighborhood_id,
     donor.labels||'[]', donor.notes, 'in_progress', req.user.id]);

  run('DELETE FROM scheduled_charges WHERE donor_id=?', [req.params.id]);
  run('DELETE FROM recurring_schedules WHERE donor_id=?', [req.params.id]);
  run('DELETE FROM payment_methods WHERE donor_id=?', [req.params.id]);
  run('DELETE FROM donors WHERE id=?', [req.params.id]);

  res.json({ success: true, lead_id: leadId });
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
    if (_donorDupMap(req.orgId).has(req.params.id)) {
      return res.status(400).json({ error: 'Unresolved duplicate flag on this donor. Resolve in Info Check first.' });
    }

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
    let receiptSent = false;
    if (send_receipt !== false && send_receipt !== 'false') {
      const { sendReceiptEmail } = require('../utils/scheduler');
      try {
        await sendReceiptEmail(donor, donation, org);
        receiptSent = true;
      } catch(e) {
        console.error('[receipt] Failed:', e.message);
      }
    } else {
      console.log(`[receipt] Skipped by user choice for donation ${id}`);
    }

    res.json({ success: true, donation, receipt_sent: receiptSent });
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
