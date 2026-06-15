// routes/payments.js — Sola CC + DAF processing
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../db/schema');
const { requireAuth, requireOrg } = require('../middleware/auth');
const { ccSave, ccSale, ccRefund, ccVoid, dafGrant, dafVoid } = require('../utils/sola');
const { sendReceiptEmail, sendChargeNotificationToOwner } = require('../utils/scheduler');

router.use(requireAuth, requireOrg);

// ── Save card → get xToken (no charge) ────────────────────────────────────────
router.post('/save-card', async (req, res) => {
  try {
    const { donor_id, card_num, exp, cvv, label, card_brand } = req.body;
    if (!donor_id || !card_num || !exp) return res.status(400).json({ error: 'donor_id, card_num and exp required' });

    const donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const result = await ccSave(req.orgId, {
      cardNum: card_num.replace(/\s/g, ''),
      exp, cvv: cvv || '',
      name:  `${donor.first_name} ${donor.last_name}`,
      zip:   donor.zip || ''
    });

    // Deactivate old defaults if setting this as default
    run('UPDATE payment_methods SET is_default=0 WHERE donor_id=?', [donor_id]);

    const pmId = uuidv4();
    run(`INSERT INTO payment_methods (id, donor_id, org_id, type, label, last_four, card_brand, sola_token, is_default)
         VALUES (?,?,?,'credit_card',?,?,?,?,1)`,
      [pmId, donor_id, req.orgId,
       label || result.cardType || 'Card',
       result.last4,
       card_brand || result.cardType || null,
       result.token]);

    res.json({ success: true, paymentMethod: get('SELECT * FROM payment_methods WHERE id=?', [pmId]) });
  } catch(e) {
    console.error('save-card:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Update card brand after save ───────────────────────────────────────────────
router.put('/payment-methods/:pmId', (req, res) => {
  const { card_brand } = req.body;
  run('UPDATE payment_methods SET card_brand=? WHERE id=? AND org_id=?', [card_brand, req.params.pmId, req.orgId]);
  res.json({ success: true });
});

// ── Charge saved CC token instantly ───────────────────────────────────────────
router.post('/charge', async (req, res) => {
  try {
    const { donor_id, payment_method_id, amount, notes } = req.body;
    if (!donor_id || !payment_method_id || !amount) return res.status(400).json({ error: 'donor_id, payment_method_id and amount required' });

    const donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const pm = get('SELECT * FROM payment_methods WHERE id=? AND donor_id=?', [payment_method_id, donor_id]);
    if (!pm) return res.status(404).json({ error: 'Payment method not found' });
    if (pm.type !== 'credit_card') return res.status(400).json({ error: 'Not a credit card. Use manual donation for check/cash/other.' });
    if (!pm.sola_token) return res.status(400).json({ error: 'Card not tokenized. Re-enter the card.' });

    const org = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    const invoice = uuidv4().replace(/-/g,'').slice(0,16);

    const result = await ccSale(req.orgId, {
      token:   pm.sola_token,
      amount,
      name:    `${donor.first_name} ${donor.last_name}`,
      zip:     donor.zip || '',
      email:   donor.email || '',
      invoice,
      note:    notes || 'DRM Donation'
    });

    const donId = uuidv4();
    run(`INSERT INTO donations (id,org_id,donor_id,amount,method,payment_method_id,transaction_id,donation_date,status,notes,is_manual,created_by)
         VALUES (?,?,?,?,'credit_card',?,?,CURRENT_TIMESTAMP,'completed',?,1,?)`,
      [donId, req.orgId, donor_id, amount, pm.id, result.refNum, notes||null, req.user.id]);

    const donation = get('SELECT * FROM donations WHERE id=?', [donId]);
    await sendReceiptEmail(donor, donation, org).catch(()=>{});

    res.json({ success: true, donation, transaction_id: result.refNum, auth_code: result.authCode, masked_card: result.maskedCard });
  } catch(e) {
    const { donor_id, payment_method_id, amount } = req.body;
    if (donor_id) {
      run(`INSERT INTO charge_failures (id,org_id,donor_id,amount,failure_reason,payment_method_id) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), req.orgId, donor_id, amount||0, e.message, payment_method_id||null]);
    }
    console.error('charge:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DAF Grant Recommendation ───────────────────────────────────────────────────
router.post('/daf-grant', async (req, res) => {
  try {
    const { donor_id, daf_card_num, daf_provider, amount, notes } = req.body;
    if (!donor_id || !daf_card_num || !amount) return res.status(400).json({ error: 'donor_id, daf_card_num and amount required' });

    const donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const org = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);

    const result = await dafGrant(req.orgId, {
      cardNum: daf_card_num.replace(/\s/g,''),
      amount,
      name:    `${donor.first_name} ${donor.last_name}`,
      note:    notes || `DRM DAF Donation – ${daf_provider||'DAF'}`
    });

    const donId = uuidv4();
    const txId  = result.refNum || ('ES' + String(Math.floor(Math.random()*1000000000)).padStart(9,'0'));
    run(`INSERT INTO donations (id,org_id,donor_id,amount,method,transaction_id,donation_date,status,notes,is_manual,created_by)
         VALUES (?,?,?,?,'daf',?,CURRENT_TIMESTAMP,'completed',?,1,?)`,
      [donId, req.orgId, donor_id, amount, txId, `${daf_provider||'DAF'} grant${notes?' — '+notes:''}`, req.user.id]);

    const donation = get('SELECT * FROM donations WHERE id=?', [donId]);
    await sendReceiptEmail(donor, donation, org).catch(()=>{});

    res.json({ success: true, donation, transaction_id: txId });
  } catch(e) {
    console.error('daf-grant:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Refund ─────────────────────────────────────────────────────────────────────
router.post('/refund', async (req, res) => {
  try {
    const { donation_id, donor_id, amount, notes } = req.body;
    if (!donation_id || !donor_id || !amount) return res.status(400).json({ error: 'donation_id, donor_id and amount required' });

    const don = get('SELECT * FROM donations WHERE id=? AND org_id=?', [donation_id, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });

    const refAmt = parseFloat(amount);
    const prevRefunded = don.refund_amount || 0;
    if (prevRefunded + refAmt > don.amount) return res.status(400).json({ error: `Cannot refund more than the original amount ($${don.amount})` });

    let solaRefNum = null;
    if (don.method === 'credit_card' && don.transaction_id && !don.transaction_id.startsWith('ES')) {
      // Real Sola transaction — refund through gateway
      const result = await ccRefund(req.orgId, { refNum: don.transaction_id, amount: refAmt });
      solaRefNum = result.refNum;
    }
    // For manual / check / cash / DAF — just mark in DB

    const newRefunded = prevRefunded + refAmt;
    const newStatus   = newRefunded >= don.amount ? 'refunded' : 'partial_refund';
    const refNote     = `Refund $${refAmt.toFixed(2)}${solaRefNum?' (Sola:'+solaRefNum+')':''}${notes?' — '+notes:''}`;

    run('UPDATE donations SET refund_amount=?, refund_notes=?, status=? WHERE id=?',
      [newRefunded, refNote, newStatus, donation_id]);

    res.json({ success: true, newStatus, solaRefNum, refunded: newRefunded });
  } catch(e) {
    console.error('refund:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Void (same-day) ────────────────────────────────────────────────────────────
router.post('/void', async (req, res) => {
  try {
    const { donation_id, ref_num } = req.body;
    await ccVoid(req.orgId, { refNum: ref_num });
    if (donation_id) run("UPDATE donations SET status='cancelled' WHERE id=? AND org_id=?", [donation_id, req.orgId]);
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Generate PDF receipt for a donation ────────────────────────────────────────
router.get('/receipt/:donationId', async (req, res) => {
  try {
    const don = get(`
      SELECT d.*, dn.first_name, dn.last_name, dn.email, dn.title,
             dn.hebrew_full_name, dn.street, dn.city, dn.state, dn.zip,
             o.name as org_name
      FROM donations d
      JOIN donors dn ON d.donor_id = dn.id
      JOIN organizations o ON d.org_id = o.id
      WHERE d.id=? AND d.org_id=?
    `, [req.params.donationId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });

    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const doc  = await PDFDocument.create();
    const page = doc.addPage([612, 396]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);

    const navy = rgb(0.10, 0.23, 0.42);
    const gray = rgb(0.42, 0.42, 0.42);
    const blk  = rgb(0,0,0);

    // Header bar
    page.drawRectangle({ x:0, y:340, width:612, height:56, color: navy });
    page.drawText(don.org_name, { x:24, y:364, size:18, font:bold, color:rgb(1,1,1) });
    page.drawText('DONATION RECEIPT', { x:24, y:348, size:10, font, color:rgb(0.7,0.8,0.95) });

    // Body
    const row = (label, value, y) => {
      page.drawText(label+':', { x:24, y, size:9, font, color:gray });
      page.drawText(String(value||'—'), { x:170, y, size:9, font:bold, color:blk });
    };

    const name = `${don.title?don.title+' ':''}${don.first_name} ${don.last_name}`;
    const addr = [don.street, don.city, don.state, don.zip].filter(Boolean).join(', ');

    row('Donor', name, 308);
    row('Address', addr||'—', 292);
    row('Date', new Date(don.donation_date).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}), 276);
    row('Amount', `$${parseFloat(don.amount).toFixed(2)}`, 260);
    row('Method', don.method.replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase()), 244);
    row('Transaction ID', don.transaction_id||'N/A', 228);
    row('Status', don.status.charAt(0).toUpperCase()+don.status.slice(1), 212);

    // Tax line
    page.drawLine({ start:{x:24,y:196}, end:{x:588,y:196}, thickness:0.5, color:rgb(0.85,0.85,0.85) });
    page.drawText('Tax ID: 11-6076986', { x:24, y:180, size:9, font:bold, color:navy });
    page.drawText('No goods or services were provided in exchange for this contribution.', { x:24, y:166, size:8, font, color:gray });
    page.drawText('This letter serves as your official tax receipt. Please retain for your records.', { x:24, y:154, size:8, font, color:gray });

    // Footer
    page.drawRectangle({ x:0, y:0, width:612, height:40, color:rgb(0.96,0.97,0.99) });
    page.drawText(don.org_name + ' · Tax ID 11-6076986 · drm.everythingshul.com', { x:24, y:16, size:8, font, color:gray });
    page.drawText(`Receipt generated ${new Date().toLocaleDateString()}`, { x:430, y:16, size:8, font, color:gray });

    const bytes = await doc.save();
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename=receipt-${don.transaction_id||don.id}.pdf`);
    res.send(Buffer.from(bytes));
  } catch(e) {
    console.error('receipt PDF:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
