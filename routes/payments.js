// routes/payments.js — Sola CC + DAF processing
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');
const { ccSave, ccSale, ccRefund, ccVoid, dafGrant } = require('../utils/sola');
const { sendReceiptEmail } = require('../utils/scheduler');

router.use(requireAuth, requireOrg);

// ── Save CC card → get xToken ─────────────────────────────────────────────────
router.post('/save-card', async (req, res) => {
  try {
    const { donor_id, card_num, exp, cvv, label, card_brand } = req.body;
    if (!donor_id || !card_num || !exp) return res.status(400).json({ error: 'donor_id, card_num and exp required' });

    const donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const result = await ccSave(req.orgId, {
      cardNum: card_num.replace(/\s/g, ''), exp, cvv: cvv || '',
      name: `${donor.first_name} ${donor.last_name}`, zip: donor.zip || ''
    });

    run('UPDATE payment_methods SET is_default=0 WHERE donor_id=?', [donor_id]);
    const pmId = uuidv4();
    run(`INSERT INTO payment_methods (id,donor_id,org_id,type,label,last_four,card_brand,sola_token,is_default)
         VALUES (?,?,?,'credit_card',?,?,?,?,1)`,
      [pmId, donor_id, req.orgId, label || result.cardType || 'Card',
       result.last4, card_brand || result.cardType || null, result.token]);

    res.json({ success: true, paymentMethod: get('SELECT * FROM payment_methods WHERE id=?', [pmId]) });
  } catch(e) {
    console.error('save-card:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Save DAF card (stored for later charges) ──────────────────────────────────
router.post('/save-daf', async (req, res) => {
  try {
    const { donor_id, card_num, exp, daf_provider, label } = req.body;
    if (!donor_id || !card_num || !exp) return res.status(400).json({ error: 'donor_id, card_num and exp required' });

    run('UPDATE payment_methods SET is_default=0 WHERE donor_id=?', [donor_id]);
    const pmId = uuidv4();
    // Store DAF card: card_num in other_description, exp in metadata, provider in daf_name
    run(`INSERT INTO payment_methods (id,donor_id,org_id,type,label,daf_name,other_description,last_four,is_default)
         VALUES (?,?,?,'daf',?,?,?,?,1)`,
      [pmId, donor_id, req.orgId, label || daf_provider || 'DAF',
       daf_provider || 'DAF',
       JSON.stringify({ card_num: card_num.replace(/\s/g,''), exp }),
       card_num.replace(/\s/g,'').slice(-4)]);

    res.json({ success: true, paymentMethod: get('SELECT * FROM payment_methods WHERE id=?', [pmId]) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Charge CC via Sola ────────────────────────────────────────────────────────
router.post('/charge', async (req, res) => {
  try {
    const { donor_id, payment_method_id, amount, notes } = req.body;
    if (!donor_id || !payment_method_id || !amount) return res.status(400).json({ error: 'donor_id, payment_method_id and amount required' });

    const donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const pm = get('SELECT * FROM payment_methods WHERE id=? AND donor_id=?', [payment_method_id, donor_id]);
    if (!pm) return res.status(404).json({ error: 'Payment method not found' });
    if (pm.type === 'daf') return res.status(400).json({ error: 'DAF cannot be charged as a one-time card. Use "Process DAF" button instead.' });
    if (pm.type !== 'credit_card') return res.status(400).json({ error: 'This payment method cannot be charged directly. Use manual donation for check/cash.' });
    if (!pm.sola_token) return res.status(400).json({ error: 'Card not tokenized. Please re-enter the card.' });

    const org = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    const result = await ccSale(req.orgId, {
      token: pm.sola_token, amount,
      name: `${donor.first_name} ${donor.last_name}`,
      zip: donor.zip || '', email: donor.email || '',
      invoice: uuidv4().replace(/-/g,'').slice(0,16),
      note: notes || 'DRM Donation'
    });

    // Only mark completed if Sola confirmed it
    const donId = uuidv4();
    run(`INSERT INTO donations (id,org_id,donor_id,amount,method,payment_method_id,transaction_id,donation_date,status,notes,is_manual,created_by)
         VALUES (?,?,?,?,'credit_card',?,?,CURRENT_TIMESTAMP,'completed',?,1,?)`,
      [donId, req.orgId, donor_id, amount, pm.id, result.refNum, notes||null, req.user.id]);

    const donation = get('SELECT * FROM donations WHERE id=?', [donId]);
    await sendReceiptEmail(donor, donation, org).catch(e => console.error('[receipt] Failed:', e.message));
    res.json({ success: true, donation, transaction_id: result.refNum, auth_code: result.authCode });
  } catch(e) {
    const { donor_id, payment_method_id, amount } = req.body;
    if (donor_id) run(`INSERT INTO charge_failures (id,org_id,donor_id,amount,failure_reason,payment_method_id) VALUES (?,?,?,?,?,?)`,
      [uuidv4(), req.orgId, donor_id, amount||0, e.message, payment_method_id||null]);
    console.error('charge:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Charge DAF card via Sola grant:Recommendation ────────────────────────────
router.post('/charge-daf', async (req, res) => {
  try {
    const { donor_id, payment_method_id, amount, notes } = req.body;
    if (!donor_id || !payment_method_id || !amount) return res.status(400).json({ error: 'Required: donor_id, payment_method_id, amount' });

    const donor = get('SELECT * FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    const pm = get('SELECT * FROM payment_methods WHERE id=? AND donor_id=?', [payment_method_id, donor_id]);
    if (!pm || pm.type !== 'daf') return res.status(400).json({ error: 'Not a DAF payment method' });

    // Stored as "cardNum|exp" in other_description, or via /daf-grant with explicit fields
    const parts = (pm.other_description || '').split('|');
    const storedCardNum = parts[0] || '';
    const storedExp = parts[1] || '1299';
    if (!storedCardNum) return res.status(400).json({ error: 'DAF card number not stored. Please re-add this payment method.' });

    const org = get('SELECT * FROM organizations WHERE id=?', [req.orgId]);
    const result = await dafGrant(req.orgId, {
      cardNum: storedCardNum,
      exp: storedExp,
      amount,
      name: `${donor.first_name} ${donor.last_name}`,
      note: notes || `DAF Grant – ${pm.daf_name || 'DAF'}`
    });

    const donId = uuidv4();
    run(`INSERT INTO donations (id,org_id,donor_id,amount,method,payment_method_id,transaction_id,donation_date,status,notes,is_manual,created_by)
         VALUES (?,?,?,?,'daf',?,?,CURRENT_TIMESTAMP,'completed',?,1,?)`,
      [donId, req.orgId, donor_id, amount, pm.id, result.refNum,
       `${pm.daf_name||'DAF'} grant${notes?' — '+notes:''}`, req.user.id]);

    const donation = get('SELECT * FROM donations WHERE id=?', [donId]);
    await sendReceiptEmail(donor, donation, org).catch(e => console.error('[receipt] Failed:', e.message));
    res.json({ success: true, donation, transaction_id: result.refNum });
  } catch(e) {
    console.error('charge-daf:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Refund or Void (Fix 3/11) ─────────────────────────────────────────────────
// Sola prefers void on same-day, refund on settled transactions.
// We try refund first; if it fails we try void. Only for real Sola txns.
router.post('/refund', async (req, res) => {
  try {
    const { donation_id, donor_id, amount, notes } = req.body;
    if (!donation_id || !donor_id || !amount) return res.status(400).json({ error: 'donation_id, donor_id and amount required' });

    const don = get('SELECT * FROM donations WHERE id=? AND org_id=?', [donation_id, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });

    const refAmt = parseFloat(amount);
    const prevRefunded = parseFloat(don.refund_amount) || 0;
    if (prevRefunded + refAmt > parseFloat(don.amount) + 0.001) {
      return res.status(400).json({ error: `Cannot refund more than the original $${parseFloat(don.amount).toFixed(2)}` });
    }

    let solaRefNum = null;
    let method = 'manual';

    const isRealSolaTx = (don.method === 'credit_card' || don.method === 'daf')
      && don.transaction_id
      && !don.transaction_id.startsWith('ES');

    if (isRealSolaTx) {
      try {
        console.log(`[refund] Attempting void txId=${don.transaction_id}`);
        const v = await ccVoid(req.orgId, { refNum: don.transaction_id });
        solaRefNum = v.refNum;
        method = 'void';
        console.log(`[refund] Void SUCCESS refNum=${solaRefNum}`);
      } catch(voidErr) {
        const voidMsg = voidErr.message || '';
        const alreadyVoided = voidMsg.toLowerCase().includes('previously voided') ||
                              voidMsg.toLowerCase().includes('already voided');
        console.log(`[refund] Void failed: ${voidMsg} alreadyVoided=${alreadyVoided}`);

        if (alreadyVoided) {
          // Sola says it was already voided — mark it in our DB without another Sola call
          method = 'void';
          solaRefNum = don.transaction_id;
          console.log('[refund] Treating as already voided — marking in DB');
        } else {
          // Try refund as fallback (settled transactions)
          try {
            const r = await ccRefund(req.orgId, { refNum: don.transaction_id, amount: refAmt });
            solaRefNum = r.refNum;
            method = 'refund';
            console.log(`[refund] Refund SUCCESS refNum=${solaRefNum}`);
          } catch(refundErr) {
            const refundMsg = refundErr.message || '';
            const alreadyRefunded = refundMsg.toLowerCase().includes('previously voided') ||
                                    refundMsg.toLowerCase().includes('already');
            if (alreadyRefunded) {
              method = 'refund';
              solaRefNum = don.transaction_id;
              console.log('[refund] Treating as already refunded — marking in DB');
            } else {
              return res.status(400).json({
                error: `Void failed: ${voidMsg}. Refund also failed: ${refundMsg}`
              });
            }
          }
        }
      }
    }
    // For manual/check/cash/wire — just mark in DB, no Sola call

    const newRefunded = prevRefunded + refAmt;
    const newStatus = newRefunded >= parseFloat(don.amount) - 0.001 ? 'refunded' : 'partial_refund';
    const refNote = `${method==='void'?'Voided':'Refund'} $${refAmt.toFixed(2)}${solaRefNum?' (ref:'+solaRefNum+')':''}${notes?' — '+notes:''}`;

    console.log(`[refund] Writing DB: status=${newStatus} refunded=${newRefunded} method=${method}`);
    run('UPDATE donations SET refund_amount=?, refund_notes=?, status=? WHERE id=?',
      [newRefunded, refNote, newStatus, donation_id]);
    console.log(`[refund] DB write done for donation ${donation_id}`);

    res.json({ success: true, newStatus, solaRefNum, method, refunded: newRefunded });
  } catch(e) {
    console.error('refund:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PDF Receipt ───────────────────────────────────────────────────────────────
router.get('/receipt/:donationId', async (req, res) => {
  try {
    const don = get(`
      SELECT d.*, COALESCE(dn.first_name||' '||dn.last_name, d.notes) as donor_display,
             dn.email, dn.title, dn.street, dn.city, dn.state, dn.zip,
             o.name as org_name
      FROM donations d
      LEFT JOIN donors dn ON d.donor_id = dn.id
      JOIN organizations o ON d.org_id = o.id
      WHERE d.id=? AND d.org_id=?
    `, [req.params.donationId, req.orgId]);
    if (!don) return res.status(404).json({ error: 'Donation not found' });

    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const doc  = await PDFDocument.create();
    const page = doc.addPage([612, 396]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const navy = rgb(0.10, 0.23, 0.42), gray = rgb(0.42,0.42,0.42), blk = rgb(0,0,0);

    page.drawRectangle({ x:0, y:340, width:612, height:56, color: navy });

    let logoX = 24;
    try {
      const orgRow = get('SELECT settings FROM organizations WHERE id=?', [req.orgId]);
      const orgSettings = JSON.parse(orgRow?.settings||'{}');
      if (orgSettings.logo_url) {
        const fs=require('fs'),path=require('path');
        const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'../data');
        const logoFile=path.join(DATA_DIR,'logos',path.basename(orgSettings.logo_url));
        if (fs.existsSync(logoFile)) {
          const lb=fs.readFileSync(logoFile);
          const img=orgSettings.logo_url.match(/\.(jpg|jpeg)$/i)?await doc.embedJpg(lb):await doc.embedPng(lb);
          const sc=img.scaleToFit(120,44);
          page.drawImage(img,{x:24,y:352-sc.height/2+22,width:sc.width,height:sc.height});
          logoX=24+sc.width+12;
        }
      }
    } catch{}

    page.drawText(don.org_name, {x:logoX,y:364,size:16,font:bold,color:rgb(1,1,1)});
    page.drawText('DONATION RECEIPT', {x:logoX,y:348,size:10,font,color:rgb(0.7,0.8,0.95)});

    const row=(label,value,y)=>{page.drawText(label+':',{x:24,y,size:9,font,color:gray});page.drawText(String(value||'—'),{x:170,y,size:9,font:bold,color:blk});};

    row('Donor', don.donor_display||'—', 308);
    row('Date', new Date(don.donation_date).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}), 292);
    row('Amount', `$${parseFloat(don.amount).toFixed(2)}`, 276);
    row('Method', (don.method||'').replace('_',' ').replace(/\b\w/g,c=>c.toUpperCase()), 260);
    row('Transaction ID', don.transaction_id||'N/A', 244);
    row('Status', (don.status||'').charAt(0).toUpperCase()+(don.status||'').slice(1), 228);

    page.drawLine({start:{x:24,y:212},end:{x:588,y:212},thickness:0.5,color:rgb(0.85,0.85,0.85)});
    page.drawText('Tax ID: 11-6076986',{x:24,y:196,size:9,font:bold,color:navy});
    page.drawText('No goods or services were provided in exchange for this contribution.',{x:24,y:182,size:8,font,color:gray});
    page.drawText('This letter serves as your official tax receipt. Please retain for your records.',{x:24,y:170,size:8,font,color:gray});

    page.drawRectangle({x:0,y:0,width:612,height:40,color:rgb(0.96,0.97,0.99)});
    page.drawText(don.org_name+' · Tax ID 11-6076986 · drm.everythingshul.com',{x:24,y:16,size:8,font,color:gray});
    page.drawText(`Generated ${new Date().toLocaleDateString()}`,{x:460,y:16,size:8,font,color:gray});

    const bytes=await doc.save();
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename=receipt-${don.transaction_id||don.id}.pdf`);
    res.send(Buffer.from(bytes));
  } catch(e) {
    console.error('receipt PDF:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── List Sola vault tokens not yet assigned to any donor in this org ───────────
router.get('/vault/unassigned', requireOrgAdmin, async (req, res) => {
  try {
    const { listPaymentMethods } = require('../utils/solaRecurring');
    const vaultMethods = await listPaymentMethods(req.orgId);

    // Get all tokens already stored in DRM for this org
    const assigned = all('SELECT sola_token FROM payment_methods WHERE org_id=? AND sola_token IS NOT NULL', [req.orgId]);
    const assignedSet = new Set(assigned.map(p => p.sola_token));

    const unassigned = vaultMethods
      .filter(pm => pm.Token && !assignedSet.has(pm.Token))
      .map(pm => ({
        token:     pm.Token,
        last_four: (pm.MaskedCardNumber || '').replace(/\D/g,'').slice(-4),
        card_type: pm.Issuer || pm.TokenType || '',
        name:      pm.Name   || '',
        exp:       pm.Exp    || '',
        created:   pm.CreatedDate || '',
        pm_id:     pm.PaymentMethodId || ''
      }));

    res.json({ unassigned, total_in_vault: vaultMethods.length, total_assigned: assignedSet.size });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Assign a vault token to a donor as a payment method ───────────────────────
router.post('/vault/assign', requireOrgAdmin, async (req, res) => {
  try {
    const { token, donor_id, label, card_type, last_four } = req.body;
    if (!token || !donor_id) return res.status(400).json({ error: 'token and donor_id required' });

    const donor = get('SELECT id FROM donors WHERE id=? AND org_id=?', [donor_id, req.orgId]);
    if (!donor) return res.status(404).json({ error: 'Donor not found' });

    // Check not already assigned
    const exists = get('SELECT id FROM payment_methods WHERE sola_token=? AND org_id=?', [token, req.orgId]);
    if (exists) return res.status(400).json({ error: 'This card is already assigned to a donor in this org' });

    const id = require('uuid').v4();
    run(`INSERT INTO payment_methods (id, donor_id, org_id, type, label, sola_token, last_four, card_brand, is_default)
         VALUES (?, ?, ?, 'credit_card', ?, ?, ?, ?, 0)`,
      [id, donor_id, req.orgId, label || `Card ••${last_four||''}`, token, last_four||null, card_type||null]);

    res.json({ success: true, payment_method: get('SELECT * FROM payment_methods WHERE id=?', [id]) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
