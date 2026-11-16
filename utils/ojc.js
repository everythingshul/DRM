// utils/ojc.js — OJC Fund Charity Card API, called directly (no Sola).
// Docs: "OJC Charity Card API" PDF from OJC. Basic Auth; one host for everything:
//   POST {base}/api/vouchers/processcharitycardtransaction     charge
//   PUT  {base}/api/vouchers/VoidCharityCardTransaction/{ref}/{orgApiKey}/{amount}
//   GET  {base}/api/vouchers/ValidateCard?cardno=&expdate=      check a card (no charge)
//   GET  {base}/api/organizations/orgapikey/{taxId}             find an org's API key + name
// OJC's test login is "developers_test" — anything charged with it is flagged as a sandbox
// test in DRM (no receipt emailed), because nothing tells a test result from a real one otherwise.

const http = require('http');
const https = require('https');
const { get, logApiCall } = require('../db/schema');
const { flagMoney } = require('../db/ctx');
const { normalizeExp } = require('./matbia');

const BASE = process.env.OJC_API_BASE || 'https://api.ojcfund.org:3391';
const OJC_BIN = '690066';        // OJC charity cards in OJC's own examples all start 690066
const TEST_USER = 'developers_test';

function fail(code, message, extra) { const e = new Error(message); e.code = code; return Object.assign(e, extra || {}); }

// Per-org settings (Settings → OJC) win; env vars are a fallback for a single-org deploy.
function getConfig(orgId) {
  const s = get('SELECT * FROM ojc_settings WHERE org_id=? AND is_active=1', [orgId]) || {};
  const pick = (a, b) => (a || b || '').trim();
  const user = pick(s.username, process.env.OJC_API_USER);
  return {
    orgId, user,
    pass: pick(s.password, process.env.OJC_API_PASS),
    orgKey: pick(s.org_api_key, process.env.OJC_ORG_KEY),
    orgName: (s.org_name || '').trim(),
    base: BASE,
    sandbox: user.toLowerCase() === TEST_USER,
    source: s.username ? 'org' : (process.env.OJC_API_USER ? 'env' : 'none')
  };
}
const isConfigured = orgId => { const c = getConfig(orgId); return !!(c.user && c.pass && c.orgKey); };

function requireConfig(orgId, needKey = true) {
  const c = getConfig(orgId);
  if (!c.user || !c.pass) throw fail('NOT_CONFIGURED', 'OJC is not configured. Add your OJC username and password in Settings → OJC.');
  if (needKey && !c.orgKey) throw fail('NOT_CONFIGURED', 'OJC is not fully configured. Add your organization API key in Settings → OJC (use "Find by Tax ID" if you don\'t have it).');
  return c;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
// Resolves { http, text, json } for ANY status — OJC reports declines as 4xx codes with a body.
function request(cfg, method, pathAndQuery, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(pathAndQuery, cfg.base);
    const lib = u.protocol === 'http:' ? http : https;
    const payload = body ? JSON.stringify(body) : null;
    const req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, timeout: 30000,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64'),
        accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
        'Content-Length': payload ? Buffer.byteLength(payload) : 0
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let json = null; try { json = JSON.parse(data); } catch {}
        resolve({ http: res.statusCode, text: data, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('OJC did not respond in time')));
    req.on('error', e => reject(fail('NETWORK', 'Could not reach OJC: ' + e.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

// Whatever message OJC sent with a failure (plain text, a JSON string, or an object).
function bodyMessage(r) {
  const j = r.json;
  if (typeof j === 'string') return j;
  if (j && typeof j === 'object') {
    const k = Object.keys(j).find(x => /^(message|error|errormessage|title|detail|description)$/i.test(x) && typeof j[x] === 'string');
    if (k) return j[k];
  }
  const t = String(r.text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 200 ? t.slice(0, 200) + '…' : t;
}

// Reference number from a 200 response: a bare number/string, or a field in an object.
function extractRef(r) {
  const j = r.json;
  if (typeof j === 'number') return String(j);
  if (typeof j === 'string' && j.trim()) return j.trim().replace(/^"|"$/g, '');
  if (j && typeof j === 'object') {
    const want = /^(referencenumber|referenceno|referencenum|reference|referenceid|refnum|transactionid|transactionnumber|confirmationnumber|id)$/i;
    const k = Object.keys(j).find(x => want.test(x) && j[x] !== null && j[x] !== '' && typeof j[x] !== 'object');
    if (k) return String(j[k]);
  }
  const t = String(r.text || '').trim().replace(/^"|"$/g, '');
  return /^[A-Za-z0-9._-]{3,40}$/.test(t) ? t : null;
}

const CODES = {
  461: 'Organization was not found in the OJC Fund system — check the organization API key in Settings → OJC',
  462: 'The card is not valid or not activated',
  451: 'The amount is more than the maximum this donor allows',
  452: 'The donor reached their limit (OJC "days limit")',
  453: 'OJC needs an organization ID — check the organization API key in Settings → OJC',
  454: 'OJC could not find that transaction',
  406: 'The card is not valid'
};
function describe(r) {
  if (r.http === 401 || r.http === 403) return `OJC rejected the username or password (HTTP ${r.http}) — check Settings → OJC`;
  const m = bodyMessage(r);
  const known = CODES[r.http];
  if (known) return known + (m && !known.toLowerCase().includes(m.toLowerCase().slice(0, 25)) ? ` (${m})` : '');
  return m || `HTTP ${r.http}`;
}

// One call + one log row (no card number, no password); the response body is kept briefly
// because OJC's docs don't show what a success looks like — this is how we find out.
async function call(cfg, label, method, pathAndQuery, body, logDetail) {
  const r = await request(cfg, method, pathAndQuery, body);
  const ok = r.http >= 200 && r.http < 300;
  console.log(`[ojc] ${label} http=${r.http} ${ok ? 'ok' : 'FAILED'} body=${String(r.text || '').slice(0, 120).replace(/\s+/g, ' ')}`);
  logApiCall({ orgId: cfg.orgId, provider: 'ojc', endpoint: label + (cfg.sandbox ? ' (test login)' : ''), httpStatus: r.http,
    status: ok ? 'Success' : 'Error', reference: ok ? extractRef(r) : null, error: ok ? null : describe(r),
    detail: [logDetail, ok ? 'response: ' + String(r.text || '').slice(0, 100).replace(/\s+/g, ' ') : null].filter(Boolean).join(' · ') });
  return { ...r, ok };
}

function isOjcProvider(name, cardNum) {
  return /ojc/i.test(name || '') || String(cardNum || '').replace(/\D/g, '').startsWith(OJC_BIN);
}

// ── Operations ────────────────────────────────────────────────────────────────
async function charge(orgId, { cardNum, exp, amount, externalId }) {
  const cfg = requireConfig(orgId);
  const amt = Math.round(parseFloat(amount) * 100) / 100;
  if (!(amt > 0)) throw fail('OJC', 'OJC: amount must be greater than zero');
  const e = normalizeExp(exp);
  if (!e) throw fail('OJC', 'OJC: a valid card expiry (MMYY, as printed on the card) is required — if this is a saved card, edit the payment method and add it');
  const card = String(cardNum).replace(/\D/g, '');
  const r = await call(cfg, 'Charge', 'POST', '/api/vouchers/processcharitycardtransaction', {
    CardNo: card, ExpDate: e, OrgId: cfg.orgKey, Amount: amt,
    ExternalreferenceId: String(externalId || Date.now()).replace(/-/g, '').slice(0, 20),   // (sic) — OJC's spelling
    SplitByMonths: 0
  }, `$${amt.toFixed(2)} card …${card.slice(-4)}`);
  if (!r.ok) {
    // Older saved cards carry the placeholder expiry 1299 (Sola didn't need a real one) — say so if OJC rejects the card.
    const hint = e === '1299' && (r.http === 462 || r.http === 406) ? ' — this card is saved with a placeholder expiry (12/99); edit the payment method and enter the real expiry' : '';
    throw fail('OJC', 'OJC: ' + describe(r) + hint, { http: r.http });
  }
  const ref = extractRef(r);
  if (!ref) throw fail('OJC', 'OJC approved the charge but returned no reference number — check your OJC portal before retrying');
  if (!cfg.sandbox) flagMoney('Moved money through OJC');
  return { refNum: ref, token: null, sandbox: cfg.sandbox };
}

async function chargePaymentMethod(orgId, pm, { amount, externalId }) {
  const { parseDafCard } = require('./matbia');
  const { cardNum, exp } = parseDafCard(pm);
  if (!cardNum) throw fail('OJC', 'DAF card number not stored. Please re-add this payment method.');
  return charge(orgId, { cardNum, exp, amount, externalId });
}

// Checks a card without charging it. Never throws on a rejection: { ok, definite, message }.
// definite = OJC positively said the card is bad (406 / 462), as opposed to an auth or network problem.
async function validate(orgId, { cardNum, exp }) {
  const cfg = requireConfig(orgId, false);
  const q = `cardno=${encodeURIComponent(String(cardNum).replace(/\D/g, ''))}&expdate=${encodeURIComponent(normalizeExp(exp) || '')}`;
  const r = await call(cfg, 'ValidateCard', 'GET', `/api/vouchers/ValidateCard?${q}`, null, `card …${String(cardNum).slice(-4)}`);
  return { ok: r.ok, definite: r.http === 406 || r.http === 462, message: r.ok ? '' : describe(r) };
}

// Looks up an organization's OJC API key and name by Tax ID. Returns [{ name, apiKey }].
async function lookupByTaxId(orgId, taxId, creds) {
  // creds = a username/password typed into Settings but not saved yet (lets you find the key first)
  const base = getConfig(orgId);
  const cfg = creds?.user && creds?.pass
    ? { ...base, user: creds.user.trim(), pass: creds.pass, sandbox: creds.user.trim().toLowerCase() === TEST_USER }
    : requireConfig(orgId, false);
  const digits = String(taxId || '').replace(/\D/g, '');
  if (!digits) throw fail('OJC', 'Enter the Tax ID (EIN) first');
  const r = await call(cfg, 'OrgLookup', 'GET', `/api/organizations/orgapikey/${digits}`, null, `tax id …${digits.slice(-4)}`);
  if (!r.ok) throw fail('OJC', 'OJC: ' + describe(r), { http: r.http });
  let list = r.json;
  if (list && !Array.isArray(list)) list = Array.isArray(list.data) ? list.data : Array.isArray(list.organizations) ? list.organizations : [list];
  if (!Array.isArray(list)) list = [];
  const pickKey = (o, re) => { const k = Object.keys(o || {}).find(x => re.test(x) && typeof o[x] !== 'object'); return k ? String(o[k]) : ''; };
  return list.map(o => ({
    name: pickKey(o, /^(name|orgname|organizationname|organization|legalname)$/i),
    apiKey: pickKey(o, /(apikey|orgid|orgapikey|key)$/i),
    raw: o
  })).filter(o => o.apiKey || o.name);
}

// Cancels a charge. OJC only voids while the transaction hasn't been processed yet.
async function reverse(orgId, { refNum, amount }) {
  const cfg = requireConfig(orgId);
  const amt = Math.round(parseFloat(amount) * 100) / 100;
  const key = encodeURIComponent(cfg.orgKey).replace(/%3D/gi, '=');   // keys end in "==" — OJC's own example sends it raw
  const r = await call(cfg, 'Void', 'PUT', `/api/vouchers/VoidCharityCardTransaction/${encodeURIComponent(refNum)}/${key}/${amt}`, null, `ref ${refNum} $${amt.toFixed(2)}`);
  if (!r.ok) {
    if (r.http === 400 && /already processed/i.test(bodyMessage(r))) {
      throw fail('OJC', 'OJC: this transaction was already processed, so it can no longer be voided — contact OJC to have it returned', { http: r.http });
    }
    throw fail('OJC', 'OJC: ' + describe(r), { http: r.http });
  }
  if (!cfg.sandbox) flagMoney('Moved money through OJC');
  return { method: 'void', refNum, sandbox: cfg.sandbox };
}

module.exports = { OJC_BIN, TEST_USER, getConfig, isConfigured, isOjcProvider, charge, chargePaymentMethod, validate, lookupByTaxId, reverse };
