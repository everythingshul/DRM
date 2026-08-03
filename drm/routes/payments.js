// routes/payments.js - Sola CC processing routes
const express = require('express');
const router = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../db/schema');
const { requireAuth, requireOrg } = require('../middleware/auth');
const { chargeToken, chargeCard, saveCard, voidTransaction, refundTransaction, getTransactionReport } = require('../utils/sola');
const { sendReceiptEmail, sendChargeNotificationToOwner } = require('../utils/scheduler');

router.use(requireAuth, requireOrg);

// Save a card to Sola and store the xToken — no charge
// Expects: donorId, cardNum (SUT from iFields or raw), exp (MMYY), cvv, name, zip, email
router.post('/save-card', async (req, res) => {
  try {
    const { donor_id, card_num, exp, cvv, label } = req.body;
    if (!donor_id || !card_num || !exp) return res.status(400).json({ error: 'donor_id, card_num, and exp required' });

    const donor = get('SELECT * FROM donors WHERE id = ? AND org_id = ?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const result = await saveCard(req.orgId, {
      cardNum: card_num,
      exp,
      cvv: cvv || '',
      name: `${donor.first_name} ${donor.last_name}`,
      zip: donor.zip || '',
      email: donor.email || ''
    });

    // Determine last 4 from masked number
    const lastFour = result.maskedNum ? result.maskedNum.replace(/\D/g, '').slice(-4) : null;

    // Deactivate old defaults if this is being set as default
    run('UPDATE payment_methods SET is_default = 0 WHERE donor_id = ?', [donor_id]);

    const pmId = uuidv4();
    run(`INSERT INTO payment_methods (id, donor_id, org_id, type, label, last_four, card_brand, sola_token, is_default)
         VALUES (?, ?, ?, 'credit_card', ?, ?, ?, ?, 1)`,
      [pmId, donor_id, req.orgId, label || result.cardType || 'Card', lastFour, result.cardType || null, result.token]);

    res.json({ success: true, paymentMethod: get('SELECT * FROM payment_methods WHERE id = ?', [pmId]) });
  } catch (e) {
    console.error('Save card error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Charge a donor's saved card immediately
router.post('/charge', async (req, res) => {
  try {
    const { donor_id, payment_method_id, amount, notes } = req.body;
    if (!donor_id || !payment_method_id || !amount) return res.status(400).json({ error: 'donor_id, payment_method_id and amount required' });

    const donor = get('SELECT * FROM donors WHERE id = ? AND org_id = ?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const pm = get('SELECT * FROM payment_methods WHERE id = ? AND donor_id = ?', [payment_method_id, donor_id]);
    if (!pm) return res.status(404).json({ error: 'Payment method not found' });

    if (pm.type !== 'credit_card') return res.status(400).json({ error: 'Payment method is not a credit card' });
    if (!pm.sola_token) return res.status(400).json({ error: 'No Sola token on file for this card. Re-enter the card to generate one.' });

    const org = get('SELECT * FROM organizations WHERE id = ?', [req.orgId]);

    const result = await chargeToken(req.orgId, {
      token: pm.sola_token,
      amount,
      name: `${donor.first_name} ${donor.last_name}`,
      zip: donor.zip || '',
      email: donor.email || '',
      invoiceNum: uuidv4().slice(0, 16),
      customNote: notes || 'DRM Manual Charge'
    });

    const donId = uuidv4();
    run(`INSERT INTO donations (id, org_id, donor_id, amount, method, payment_method_id, transaction_id, donation_date, status, notes, created_by)
         VALUES (?, ?, ?, ?, 'credit_card', ?, ?, CURRENT_TIMESTAMP, 'completed', ?, ?)`,
      [donId, req.orgId, donor_id, amount, pm.id, result.refNum, notes || null, req.user.id]);

    const donation = get('SELECT * FROM donations WHERE id = ?', [donId]);
    await sendReceiptEmail(donor, donation, org);

    res.json({ success: true, donation, solaRefNum: result.refNum, authCode: result.authCode });
  } catch (e) {
    // Log the failure
    const { donor_id, payment_method_id, amount } = req.body;
    if (donor_id) {
      run(`INSERT INTO charge_failures (id, org_id, donor_id, amount, failure_reason, payment_method_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        [uuidv4(), req.orgId, donor_id, amount || 0, e.message, payment_method_id || null]);
    }
    console.error('Charge error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Void a transaction (same-day reversal)
router.post('/void', async (req, res) => {
  try {
    const { ref_num, donation_id } = req.body;
    if (!ref_num) return res.status(400).json({ error: 'ref_num required' });

    await voidTransaction(req.orgId, { refNum: ref_num });

    if (donation_id) {
      run(`UPDATE donations SET status = 'cancelled', notes = COALESCE(notes || ' | ', '') || 'Voided' WHERE id = ? AND org_id = ?`,
        [donation_id, req.orgId]);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Refund a transaction
router.post('/refund', async (req, res) => {
  try {
    const { ref_num, amount, donation_id } = req.body;
    if (!ref_num || !amount) return res.status(400).json({ error: 'ref_num and amount required' });

    const result = await refundTransaction(req.orgId, { refNum: ref_num, amount });

    if (donation_id) {
      run(`UPDATE donations SET notes = COALESCE(notes || ' | ', '') || 'Refunded $${parseFloat(amount).toFixed(2)}' WHERE id = ? AND org_id = ?`,
        [donation_id, req.orgId]);
    }

    res.json({ success: true, refundRefNum: result.refNum });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pull Sola transaction history (for reconciliation)
router.get('/sola-transactions', async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: 'from and to dates required (YYYY-MM-DD)' });

    // Convert to Sola date format MM/DD/YYYY HH:MM:SS
    const startDate = new Date(from).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' 00:00:00';
    const endDate = new Date(to).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) + ' 23:59:59';

    const report = await getTransactionReport(req.orgId, { startDate, endDate });
    res.json(report);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
