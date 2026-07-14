// utils/solaRecurring.js — Sola Customer & Recurring API (api.cardknox.com/v2)
// This is a SEPARATE API from the gateway (x1.cardknox.com/gatewayjson)
// Used for: customer management, payment method vault, listing tokens
// NOT used for: scheduling recurring — DRM handles its own scheduling

'use strict';
const https = require('https');

const BASE_URL    = 'https://api.cardknox.com/v2';
const SW_NAME     = 'DRM-EverythingShul';
const SW_VER      = '1.0';
const API_VERSION = '2.1';

function getSolaKey(orgId) {
  // Same key as the gateway — stored in env or sola_settings table
  if (process.env.SOLA_API_KEY) return process.env.SOLA_API_KEY;
  const { get } = require('../db/schema');
  const s = get('SELECT api_key FROM sola_settings WHERE org_id=?', [orgId]);
  if (!s?.api_key) throw new Error('Sola API key not configured');
  return s.api_key;
}

function base() {
  return { SoftwareName: SW_NAME, SoftwareVersion: SW_VER };
}

async function solaPost(orgId, endpoint, payload) {
  const apiKey = getSolaKey(orgId);
  const body   = JSON.stringify({ ...base(), ...payload });
  const url    = new URL(`${BASE_URL}/${endpoint}`);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'POST',
      headers: {
        'Content-Type':              'application/json',
        'Content-Length':            Buffer.byteLength(body),
        'Authorization':             apiKey,
        'X-Recurring-Api-Version':   API_VERSION
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const r = JSON.parse(data);
          if (r.Result === 'E') throw new Error(`Sola: ${r.Error || 'Unknown error'}`);
          resolve(r);
        } catch(e) {
          if (e.message.startsWith('Sola:')) reject(e);
          else reject(new Error('Invalid Sola response: ' + data.slice(0, 100)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Customer Management ────────────────────────────────────────────────────────

async function createCustomer(orgId, donor) {
  const r = await solaPost(orgId, 'CreateCustomer', {
    CustomerNumber: donor.id,       // Use DRM donor ID as the internal reference
    Email:          donor.email || '',
    BillFirstName:  donor.first_name || '',
    BillLastName:   donor.last_name  || '',
    BillStreet:     donor.street     || '',
    BillStreet2:    donor.apt        || '',
    BillCity:       donor.city       || '',
    BillState:      donor.state      || '',
    BillZip:        donor.zip        || '',
    BillPhone:      donor.home_phone || '',
    BillMobile:     donor.cell       || '',
    CustomerNotes:  `DRM donor: ${donor.first_name} ${donor.last_name}`
  });
  return r.CustomerId; // e.g. "c1234567890"
}

async function updateCustomer(orgId, solaCustomerId, donor, revision) {
  await solaPost(orgId, 'UpdateCustomer', {
    CustomerId:            solaCustomerId,
    Revision:              revision,
    CustomerNumber:        donor.id,
    Email:                 donor.email || '',
    BillFirstName:         donor.first_name || '',
    BillLastName:          donor.last_name  || '',
    BillStreet:            donor.street     || '',
    BillStreet2:           donor.apt        || '',
    BillCity:              donor.city       || '',
    BillState:             donor.state      || '',
    BillZip:               donor.zip        || '',
    BillPhone:             donor.home_phone || '',
    BillMobile:            donor.cell       || '',
    DefaultPaymentMethodId: ''
  });
}

async function getCustomer(orgId, solaCustomerId) {
  return solaPost(orgId, 'GetCustomer', { CustomerId: solaCustomerId, ShowDeleted: false });
}

// ── Payment Method Management ──────────────────────────────────────────────────

// List all payment methods — used for "unassigned cards" detection
async function listPaymentMethods(orgId, filters = {}) {
  const results = [];
  let nextToken = '';
  do {
    const r = await solaPost(orgId, 'ListPaymentMethods', {
      PageSize: 500,
      NextToken: nextToken,
      Filters: { IsDeleted: false, ...filters }
    });
    results.push(...(r.PaymentMethods || []));
    nextToken = r.NextToken || '';
  } while (nextToken);
  return results;
}

// Create a payment method under a Sola customer (links a DRM token to their profile)
async function createPaymentMethod(orgId, solaCustomerId, token, tokenType = 'cc', options = {}) {
  const r = await solaPost(orgId, 'CreatePaymentMethod', {
    CustomerId:   solaCustomerId,
    Token:        token,
    TokenType:    tokenType,
    TokenAlias:   options.alias   || '',
    Exp:          options.exp     || '',
    SetAsDefault: options.setDefault !== false
  });
  return r.PaymentMethodId;
}

// ── Transaction (one-off charge via Sola customer, NOT Sola recurring) ──────────
// DRM manages its own scheduling — we just use this to charge when needed
async function processTransaction(orgId, solaCustomerId, paymentMethodId, amount, options = {}) {
  const r = await solaPost(orgId, 'ProcessTransaction', {
    CustomerId:      solaCustomerId,
    PaymentMethodId: paymentMethodId,
    Amount:          parseFloat(amount).toFixed(2),
    Description:     options.description || 'DRM Donation',
    Invoice:         options.invoice     || '',
    CustReceipt:     false // DRM sends its own receipts
  });
  return { refNum: r.RefNum, status: r.Result };
}

// Get full details of a single payment method (includes MaskedCardNumber, Issuer, Exp)
async function getPaymentMethodDetails(orgId, paymentMethodId) {
  return solaPost(orgId, 'GetPaymentMethod', {
    PaymentMethodId: paymentMethodId,
    ShowDeleted: false
  });
}

module.exports = {
  createCustomer,
  updateCustomer,
  getCustomer,
  listPaymentMethods,
  createPaymentMethod,
  processTransaction,
  getPaymentMethodDetails
};
