// utils/pledger.js — Pledger Charitable DAF API, called directly (no Sola).
// POST {base}/api/Funds/Capture with `Authorization: Bearer <token>`; the Command field
// picks the action: grant:donate (charge), grant:void (cancel), card:validate (check a card).
// Response: { Refnum, Status, ErrorMessage } — only Status "Approved" counts as success.

const http = require('http');
const https = require('https');
const { get } = require('../db/schema');
const { normalizeExp } = require('./matbia');

const BASE = process.env.PLEDGER_API_BASE || 'https://api.pledgercharitable.org';
const PATH = '/api/Funds/Capture';
const PLEDGER_BIN = '659997';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

// Per-org settings (Settings → Pledger) win; env vars are a fallback for a single-org deploy.
function getConfig(orgId) {
  const s = get('SELECT * FROM pledger_settings WHERE org_id=? AND is_active=1', [orgId]) || {};
  const pick = (a, b) => (a || b || '').trim();
  return {
    token: pick(s.api_token, process.env.PLEDGER_API_TOKEN),
    taxId: pick(s.tax_id, process.env.PLEDGER_TAX_ID),
    charityName: pick(s.charity_name, process.env.PLEDGER_CHARITY_NAME),
    charityId: pick(s.charity_id, process.env.PLEDGER_CHARITY_ID),
    campaignRef: (s.campaign_ref || '').trim(),
    source: s.api_token ? 'org' : (process.env.PLEDGER_API_TOKEN ? 'env' : 'none')
  };
}

function requireToken(orgId) {
  const c = getConfig(orgId);
  if (!c.token) throw fail('NOT_CONFIGURED', 'Pledger is not configured. Add your Pledger API token in Settings → Pledger.');
  return c;
}
function requireOrgIds(orgId) {
  const c = requireToken(orgId);
  if (!c.taxId || !c.charityName || !c.charityId) {
    throw fail('NOT_CONFIGURED', 'Pledger is not fully configured. Add your Tax ID, charity name and charity ID in Settings → Pledger.');
  }
  return c;
}

function post(cfg, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(PATH, BASE);
    const lib = u.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname, method: 'POST', timeout: 30000,
      headers: {
        Authorization: `Bearer ${cfg.token}`, accept: 'application/json',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        // Property names are matched case-insensitively (Refnum / RefNum / refnum).
        const r = {};
        if (parsed && typeof parsed === 'object') for (const k of Object.keys(parsed)) r[k.toLowerCase()] = parsed[k];
        else if (typeof parsed === 'string') r.errormessage = parsed;
        else r.errormessage = `Unexpected response from Pledger (HTTP ${res.statusCode})`;
        // One log line per call — no token, no card number/CVV — so Render's logs show what Pledger answered.
        const safe = { ...payload };
        if (safe.Cardnumber) safe.Cardnumber = '…' + String(safe.Cardnumber).slice(-4);
        delete safe.CVV;
        if (safe.CharityId) safe.CharityId = String(safe.CharityId).slice(0, 4) + '…' + String(safe.CharityId).slice(-4);
        console.log(`[pledger] ${payload.Command} http=${res.statusCode} status=${r.status || '-'} ref=${r.refnum || '-'} error=${r.errormessage || '-'} req=${JSON.stringify(safe)}`);
        resolve({ http: res.statusCode, status: r.status, refnum: r.refnum, error: r.errormessage, token: r.transtoken || null });
      });
    });
    req.on('timeout', () => req.destroy(new Error('Pledger did not respond in time')));
    req.on('error', e => reject(fail('NETWORK', 'Could not reach Pledger: ' + e.message)));
    req.write(body);
    req.end();
  });
}

const approved = r => String(r.status || '').toLowerCase() === 'approved';
function assertApproved(r) {
  if (!approved(r)) throw fail('PLEDGER', 'Pledger: ' + (r.error || r.status || 'request failed'));
  return r;
}

function isPledgerProvider(name, cardNum) {
  return /pledger/i.test(name || '') || String(cardNum || '').replace(/\D/g, '').startsWith(PLEDGER_BIN);
}

// Charges the card and credits the charity. CVV is optional and never stored.
async function charge(orgId, { cardNum, exp, cvv, amount, externalId, note }) {
  const cfg = requireOrgIds(orgId);
  const amt = Math.round(parseFloat(amount) * 100) / 100;
  if (!(amt > 0)) throw fail('PLEDGER', 'Pledger: amount must be greater than zero');
  const e = normalizeExp(exp);
  if (!e) throw fail('PLEDGER', 'Pledger: a valid card expiry (MMYY, as printed on the card) is required — if this is a saved card, edit the payment method and add it');
  const r = assertApproved(await post(cfg, {
    TaxID: cfg.taxId,
    CharityName: cfg.charityName,
    Command: 'grant:donate',
    Cardnumber: String(cardNum).replace(/\D/g, ''),
    ...(cvv ? { CVV: String(cvv).replace(/\D/g, '') } : {}),
    ExpDate: e,
    Amount: amt.toFixed(2),
    Invoice: String(externalId || Date.now()).replace(/-/g, '').slice(0, 20),
    Description: note || 'DRM Donation',
    ...(cfg.campaignRef ? { CampaignRef: cfg.campaignRef } : {}),
    CharityId: cfg.charityId
  }));
  if (!r.refnum) throw fail('PLEDGER', 'Pledger approved the charge but returned no reference — check your Pledger account before retrying');
  return { refNum: String(r.refnum), token: r.token ? String(r.token) : null, sandbox: false };
}

// Charges a stored DAF payment method (donor page, scheduled and recurring charges).
async function chargePaymentMethod(orgId, pm, { amount, externalId, note, cvv }) {
  const { parseDafCard } = require('./matbia');
  const { cardNum, exp } = parseDafCard(pm);
  if (!cardNum) throw fail('PLEDGER', 'DAF card number not stored. Please re-add this payment method.');
  return charge(orgId, { cardNum, exp, cvv, amount, externalId, note });
}

// card:validate — checks a card without charging it. Returns { ok, message } (never throws on a decline).
async function validate(orgId, { cardNum, exp, cvv }) {
  const cfg = requireToken(orgId);
  const e = normalizeExp(exp);
  const r = await post(cfg, {
    Command: 'card:validate',
    Cardnumber: String(cardNum).replace(/\D/g, ''),
    ...(e ? { ExpDate: e } : {}),
    ...(cvv ? { CVV: String(cvv).replace(/\D/g, '') } : {})
  });
  return { ok: approved(r), message: r.error || r.status || '' };
}

// grant:void — cancels a charge by its TransToken (falls back to the Refnum we stored).
async function reverse(orgId, { token, refNum, amount }) {
  const cfg = requireOrgIds(orgId);
  assertApproved(await post(cfg, {
    TaxID: cfg.taxId,
    CharityName: cfg.charityName,
    Command: 'grant:void',
    TransToken: token || refNum,
    Amount: (Math.round(parseFloat(amount) * 100) / 100).toFixed(2),
    CharityId: cfg.charityId
  }));
  return { method: 'void', refNum: refNum || token, sandbox: false };
}

module.exports = { GUID_RE, PLEDGER_BIN, getConfig, isPledgerProvider, charge, chargePaymentMethod, validate, reverse };
