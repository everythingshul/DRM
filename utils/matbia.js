// utils/matbia.js — Matbia payment API, called directly (docs: developers.matbia.org)
// Charges a donor's Matbia card and credits the organization; no Sola in the path.
// Auth: the raw token in an `Authorization` header (no "Bearer").

const https = require('https');
const { get } = require('../db/schema');

const HOSTS = { production: 'api.matbia.org', sandbox: 'sandbox.api.matbia.org' };
const MATBIA_BIN = '862824';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

// Per-org settings (Settings → Matbia) win; env vars are a fallback for a single-org deploy.
function getConfig(orgId) {
  const s = get('SELECT api_token, org_user_handle, environment FROM matbia_settings WHERE org_id=? AND is_active=1', [orgId]);
  const token = (s?.api_token || process.env.MATBIA_API_TOKEN || '').trim();
  const handle = (s?.org_user_handle || process.env.MATBIA_ORG_HANDLE || '').trim();
  const env = (s?.environment || process.env.MATBIA_ENV || 'production') === 'sandbox' ? 'sandbox' : 'production';
  return { token, handle, env, host: HOSTS[env], source: s?.api_token ? 'org' : (token ? 'env' : 'none') };
}

function requireToken(orgId) {
  const c = getConfig(orgId);
  if (!c.token) throw fail('NOT_CONFIGURED', 'Matbia is not configured. Add your Matbia API token in Settings → Matbia.');
  return c;
}

function post(cfg, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: cfg.host, path, method: 'POST', timeout: 30000,
      headers: {
        Authorization: cfg.token, accept: 'application/json',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        // Declines and card errors arrive as HTTP 406 *with* a JSON body, and some failures
        // (e.g. a malformed token) arrive as a bare JSON string — so always read the body.
        if (parsed && typeof parsed === 'object') return resolve({ http: res.statusCode, ...parsed });
        if (typeof parsed === 'string') return resolve({ http: res.statusCode, status: 'Error', error: parsed });
        resolve({ http: res.statusCode, status: 'Error', error: `Unexpected response from Matbia (HTTP ${res.statusCode})` });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Matbia did not respond in time')));
    req.on('error', e => reject(fail('NETWORK', 'Could not reach Matbia: ' + e.message)));
    req.write(body);
    req.end();
  });
}

function assertSuccess(r) {
  if (r.status !== 'Success') {
    // A "Declined" result still carries a referenceId — never treat the id alone as success.
    throw fail('MATBIA', 'Matbia: ' + (r.error || r.status || 'request failed'));
  }
  return r;
}

// Matbia wants MMYY. Accepts "12/28", "1228", "12-28".
function normalizeExp(exp) {
  const d = String(exp || '').replace(/\D/g, '');
  if (d.length !== 4 || +d.slice(0, 2) < 1 || +d.slice(0, 2) > 12) return null;
  return d;
}

// Payment methods store DAF cards as "cardNum|exp" in other_description (older /save-daf
// rows hold JSON). Returns { cardNum, exp } with exp possibly empty.
function parseDafCard(pm) {
  const raw = pm?.other_description || '';
  if (raw.trim().startsWith('{')) {
    try { const j = JSON.parse(raw); return { cardNum: String(j.card_num || '').replace(/\D/g, ''), exp: j.exp || '' }; } catch {}
  }
  const [num, exp] = raw.split('|');
  return { cardNum: (num || '').replace(/\D/g, ''), exp: exp || '' };
}

function isMatbiaProvider(name, cardNum) {
  return /matbia/i.test(name || '') || String(cardNum || '').replace(/\D/g, '').startsWith(MATBIA_BIN);
}
function isMatbiaCard(pm) {
  return pm?.type === 'daf' && isMatbiaProvider(pm.daf_name, parseDafCard(pm).cardNum);
}

// Verifies a card number + expiry (no funds are moved, no balance check).
async function preauthorize(orgId, { cardNum, exp }) {
  const cfg = requireToken(orgId);
  const e = normalizeExp(exp);
  if (!e) throw fail('MATBIA', 'Matbia: card expiry must be MMYY (the real expiry on the card)');
  assertSuccess(await post(cfg, '/v1/Matbia/Preauthorization', { cardNum: String(cardNum).replace(/\D/g, ''), exp: e }));
  return { ok: true };
}

// Charges the card and credits the org. externalId must be unique per attempt (Matbia
// rejects a reused one) — pass the donation id. Returns the referenceId to void/refund with.
async function charge(orgId, { cardNum, exp, amount, externalId, note }) {
  const cfg = requireToken(orgId);
  if (!cfg.handle) throw fail('NOT_CONFIGURED', 'Matbia is not configured. Add your organization handle in Settings → Matbia.');
  const amt = Math.round(parseFloat(amount) * 100) / 100;
  if (!(amt > 0)) throw fail('MATBIA', 'Matbia: amount must be greater than zero');
  const e = normalizeExp(exp);
  if (!e) throw fail('MATBIA', 'Matbia: a valid card expiry (MMYY, as printed on the card) is required — if this is a saved card, edit the payment method and add it');
  const r = assertSuccess(await post(cfg, '/v1/Matbia/Charge', {
    orgUserHandle: cfg.handle,
    cardNum: String(cardNum).replace(/\D/g, ''),
    exp: e,
    amount: amt,
    transDate: new Date().toISOString(),
    note: note || 'DRM Donation',
    externalTransactionId: externalId || undefined,
    allowDuplicates: false
  }));
  if (!r.referenceId) throw fail('MATBIA', 'Matbia did not return a transaction reference — check the Matbia dashboard before retrying');
  return { refNum: r.referenceId, cardHolderName: r.cardHolderName || null, sandbox: cfg.env === 'sandbox' };
}

// Charges a stored DAF payment method (shared by the donor page, scheduled and recurring charges).
async function chargePaymentMethod(orgId, pm, { amount, externalId, note }) {
  const { cardNum, exp } = parseDafCard(pm);
  if (!cardNum) throw fail('MATBIA', 'DAF card number not stored. Please re-add this payment method.');
  return charge(orgId, { cardNum, exp, amount, externalId, note });
}

async function voidPayment(orgId, referenceId) {
  const cfg = requireToken(orgId);
  assertSuccess(await post(cfg, '/v1/Matbia/VoidPayment', { referenceId }));
  return { refNum: referenceId, sandbox: cfg.env === 'sandbox' };
}

async function refundPayment(orgId, referenceId) {
  const cfg = requireToken(orgId);
  assertSuccess(await post(cfg, '/v1/Matbia/RefundPayment', { referenceId }));
  return { refNum: referenceId, sandbox: cfg.env === 'sandbox' };
}

// Void while the transaction is still pending (~24h), refund once it has batched.
async function reverse(orgId, referenceId) {
  try {
    const v = await voidPayment(orgId, referenceId);
    return { method: 'void', refNum: referenceId, sandbox: v.sandbox };
  } catch (err) {
    if (err.code === 'MATBIA' && /batched/i.test(err.message) && /refund/i.test(err.message)) {
      const r = await refundPayment(orgId, referenceId);
      return { method: 'refund', refNum: referenceId, sandbox: r.sandbox };
    }
    throw err;
  }
}

const SANDBOX_NOTE = '[SANDBOX TEST — no real money moved] ';

module.exports = {
  SANDBOX_NOTE, GUID_RE, MATBIA_BIN, getConfig, normalizeExp, parseDafCard, isMatbiaProvider, isMatbiaCard,
  preauthorize, charge, chargePaymentMethod, voidPayment, refundPayment, reverse
};
