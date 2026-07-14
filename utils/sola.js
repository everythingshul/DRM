// utils/sola.js — Sola (Cardknox) Payment Gateway
// Endpoint: https://x1.cardknox.com/gatewayjson
// All requests are server-side POST (CORS disallows browser calls)

const https = require('https');
const { get } = require('../db/schema');

const ENDPOINT = 'https://x1.cardknox.com/gatewayjson';
const VERSION  = '5.0.0';
const SW_NAME  = 'DRM-EverythingShul';
const SW_VER   = '1.0.0';

function getSolaKey(orgId) {
  // Check env first (global key), then per-org setting
  if (process.env.SOLA_API_KEY) return process.env.SOLA_API_KEY;
  const s = get('SELECT api_key FROM sola_settings WHERE org_id=? AND is_active=1', [orgId]);
  if (!s?.api_key) throw new Error('Sola API key not configured. Add SOLA_API_KEY to environment variables.');
  return s.api_key;
}

function base(orgId, command) {
  return {
    xKey:             getSolaKey(orgId),
    xVersion:         VERSION,
    xSoftwareName:    SW_NAME,
    xSoftwareVersion: SW_VER,
    xCommand:         command
  };
}

function solaPost(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const u = new URL(ENDPOINT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid Sola response: ' + data.slice(0,100))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function assertApproved(result) {
  // Cardknox xResult: 'A' = Approved, 'V' = Voided — both are success
  if (result.xResult !== 'A' && result.xResult !== 'V') {
    const msg = result.xError || result.xErrorCode || `Declined (${result.xResult})`;
    throw new Error('Sola: ' + msg);
  }
  return result;
}

// ── CC: Save card, get reusable xToken ────────────────────────────────────────
async function ccSave(orgId, { cardNum, exp, cvv, name, zip }) {
  const r = assertApproved(await solaPost({
    ...base(orgId, 'cc:save'),
    xCardNum: cardNum,
    xExp:     exp,
    xCVV:     cvv || '',
    xName:    name || '',
    xBillZip: zip || ''
  }));
  return {
    token:    r.xToken,
    last4:    (r.xMaskedCardNumber || '').replace(/\D/g, '').slice(-4),
    cardType: r.xCardType || ''
  };
}

// ── CC: Charge saved token ─────────────────────────────────────────────────────
async function ccSale(orgId, { token, amount, name, zip, email, invoice, note }) {
  const r = assertApproved(await solaPost({
    ...base(orgId, 'cc:sale'),
    xToken:    token,
    xAmount:   parseFloat(amount).toFixed(2),
    xName:     name  || '',
    xBillZip:  zip   || '',
    xEmail:    email || '',
    xInvoice:  invoice || '',
    xComments: note    || 'DRM Donation'
  }));
  return { refNum: r.xRefNum, authCode: r.xAuthCode, maskedCard: r.xMaskedCardNumber, token: r.xToken };
}

// ── CC: Refund by refNum ───────────────────────────────────────────────────────
async function ccRefund(orgId, { refNum, amount }) {
  const raw = await solaPost({
    ...base(orgId, 'cc:refund'),
    xRefNum: refNum,
    xAmount: parseFloat(amount).toFixed(2)
  });
  console.log('Sola ccRefund response:', JSON.stringify(raw));
  const r = assertApproved(raw);
  // xRefNum on refund is the new refund transaction number
  return { refNum: r.xRefNum || refNum };
}

// ── CC: Void ───────────────────────────────────────────────────────────────────
async function ccVoid(orgId, { refNum }) {
  const raw = await solaPost({
    ...base(orgId, 'cc:void'),
    xRefNum: refNum
  });
  console.log('Sola ccVoid response:', JSON.stringify(raw));
  const r = assertApproved(raw);
  // Void returns the original xRefNum — keep it
  return { refNum: r.xRefNum || refNum };
}

// ── DAF: Grant Recommendation ─────────────────────────────────────────────────
// DAF providers supported by Sola: Matbia, OJC, Pledger, DonorsFund, iMasser
// The card number IS the DAF card number; Sola auto-routes to the right provider.
async function dafGrant(orgId, { cardNum, exp, amount, name, note }) {
  const r = assertApproved(await solaPost({
    ...base(orgId, 'grant:Recommendation'),
    xCardNum:  cardNum,
    xExp:      exp || '1299',  // DAF cards often don't expire; use far future
    xAmount:   parseFloat(amount).toFixed(2),
    xName:     name || '',
    xComments: note || 'DRM Donation'
  }));
  return { refNum: r.xRefNum, authCode: r.xAuthCode || '' };
}

// ── DAF: Void Grant ───────────────────────────────────────────────────────────
async function dafVoid(orgId, { refNum }) {
  const r = assertApproved(await solaPost({
    ...base(orgId, 'grant:Void'),
    xRefNum: refNum
  }));
  return { refNum: r.xRefNum };
}

// ── List all tokens in the Sola vault ─────────────────────────────────────────
// Uses Cardknox cc:reporttokens — returns all stored cards
async function listVaultTokens(orgId) {
  const raw = await solaPost({
    ...base(orgId, 'cc:reporttokens'),
  });
  // Response contains xRecords array or xError
  if (raw.xError) throw new Error('Sola: ' + raw.xError);
  // Parse the token list — Cardknox returns xRecords as a delimited string or array
  let records = [];
  if (Array.isArray(raw.xRecords)) {
    records = raw.xRecords;
  } else if (raw.xRecords) {
    // Sometimes returned as newline-delimited JSON objects
    records = String(raw.xRecords).split('\n')
      .filter(Boolean)
      .map(r => { try { return JSON.parse(r); } catch { return null; } })
      .filter(Boolean);
  }
  return records.map(r => ({
    token:     r.xToken      || r.token      || '',
    last_four: (r.xMaskedCardNumber || r.maskedCardNumber || '').replace(/\D/g,'').slice(-4),
    card_type: r.xCardType   || r.cardType   || '',
    name:      r.xName       || r.name       || '',
    exp:       r.xExp        || r.exp        || '',
    created:   r.xEnteredDate || r.enteredDate || ''
  })).filter(r => r.token);
}

module.exports = { ccSave, ccSale, ccRefund, ccVoid, dafGrant, dafVoid, getSolaKey, listVaultTokens };
