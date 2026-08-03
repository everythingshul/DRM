// utils/sola.js - Sola (Cardknox) payment processing integration
// API docs: https://docs.solapayments.com/api/transaction
// Endpoint: https://x1.cardknox.com/gatewayjson
// Sola is the Cardknox gateway rebranded. All fields use xKey, xCommand, xToken, etc.

const https = require('https');
const { get } = require('../db/schema');

const SOLA_ENDPOINT = 'https://x1.cardknox.com/gatewayjson';
const SOLA_VERSION = '5.0.0';
const SOLA_SOFTWARE_NAME = 'DRM-EverythingShul';
const SOLA_SOFTWARE_VERSION = '1.0.0';

async function solaRequest(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(SOLA_ENDPOINT);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error('Invalid response from Sola: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function basePayload(apiKey, command) {
  return {
    xKey: apiKey,
    xVersion: SOLA_VERSION,
    xSoftwareName: SOLA_SOFTWARE_NAME,
    xSoftwareVersion: SOLA_SOFTWARE_VERSION,
    xCommand: command
  };
}

function getSolaKey(orgId) {
  const sola = get('SELECT api_key FROM sola_settings WHERE org_id = ? AND is_active = 1', [orgId]);
  if (!sola?.api_key) throw new Error('Sola payment processor not configured for this organization');
  return sola.api_key;
}

/**
 * Save a card and get a reusable xToken
 * Used when adding a new credit card payment method without charging it
 */
async function saveCard(orgId, { cardNum, exp, cvv, name, zip, email }) {
  const apiKey = getSolaKey(orgId);
  const payload = {
    ...basePayload(apiKey, 'cc:save'),
    xCardNum: cardNum,   // Full card number OR SUT from iFields
    xExp: exp,           // MMYY format
    xCVV: cvv || '',
    xName: name || '',
    xBillZip: zip || '',
    xEmail: email || ''
  };

  const result = await solaRequest(payload);
  if (result.xResult !== 'A') {
    throw new Error(result.xError || result.xErrorCode || 'Card save failed');
  }
  return {
    token: result.xToken,
    maskedNum: result.xMaskedCardNumber,
    cardType: result.xCardType,
    exp: result.xExp
  };
}

/**
 * Charge a saved card by xToken
 * Used for autopay and scheduled charges
 */
async function chargeToken(orgId, { token, amount, name, zip, email, invoiceNum, customNote }) {
  const apiKey = getSolaKey(orgId);
  const payload = {
    ...basePayload(apiKey, 'cc:sale'),
    xToken: token,
    xAmount: parseFloat(amount).toFixed(2),
    xName: name || '',
    xBillZip: zip || '',
    xEmail: email || '',
    xInvoice: invoiceNum || '',
    xDescription: customNote || 'DRM Donation',
    xCustReceipt: email ? '1' : '0'   // Sola sends receipt to cardholder if email provided
  };

  const result = await solaRequest(payload);
  if (result.xResult !== 'A') {
    throw new Error(result.xError || result.xErrorCode || 'Charge declined');
  }
  return {
    refNum: result.xRefNum,
    authCode: result.xAuthCode,
    maskedNum: result.xMaskedCardNumber,
    amount: result.xAmount,
    status: result.xStatus
  };
}

/**
 * One-time charge with raw card data (use iFields SUT for PCI compliance)
 * cardNum should be a SUT (single-use token) from iFields when used from browser
 */
async function chargeCard(orgId, { cardNum, exp, cvv, amount, name, zip, email, saveForLater = false }) {
  const apiKey = getSolaKey(orgId);
  const command = saveForLater ? 'cc:sale' : 'cc:sale';
  const payload = {
    ...basePayload(apiKey, command),
    xCardNum: cardNum,
    xExp: exp,
    xCVV: cvv || '',
    xAmount: parseFloat(amount).toFixed(2),
    xName: name || '',
    xBillZip: zip || '',
    xEmail: email || ''
  };

  const result = await solaRequest(payload);
  if (result.xResult !== 'A') {
    throw new Error(result.xError || result.xErrorCode || 'Charge declined');
  }
  return {
    refNum: result.xRefNum,
    authCode: result.xAuthCode,
    token: result.xToken,   // Always returned — save this for future charges
    maskedNum: result.xMaskedCardNumber,
    cardType: result.xCardType,
    amount: result.xAmount
  };
}

/**
 * Void a transaction (same day)
 */
async function voidTransaction(orgId, { refNum }) {
  const apiKey = getSolaKey(orgId);
  const result = await solaRequest({
    ...basePayload(apiKey, 'cc:void'),
    xRefNum: refNum
  });
  if (result.xResult !== 'A') throw new Error(result.xError || 'Void failed');
  return { refNum: result.xRefNum };
}

/**
 * Refund a previous transaction
 */
async function refundTransaction(orgId, { refNum, amount }) {
  const apiKey = getSolaKey(orgId);
  const result = await solaRequest({
    ...basePayload(apiKey, 'cc:refund'),
    xRefNum: refNum,
    xAmount: parseFloat(amount).toFixed(2)
  });
  if (result.xResult !== 'A') throw new Error(result.xError || 'Refund failed');
  return { refNum: result.xRefNum };
}

/**
 * Pull transaction report from Sola Reporting API
 */
async function getTransactionReport(orgId, { startDate, endDate, pageNum = 1 }) {
  const sola = get('SELECT api_key FROM sola_settings WHERE org_id = ? AND is_active = 1', [orgId]);
  if (!sola?.api_key) throw new Error('Sola not configured');

  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      xKey: sola.api_key,
      xVersion: SOLA_VERSION,
      xSoftwareName: SOLA_SOFTWARE_NAME,
      xBeginDate: startDate,   // MM/DD/YYYY HH:MM:SS
      xEndDate: endDate,
      xPageNum: pageNum,
      xCommand: 'report:transactions'
    });

    const url = new URL('https://x1.cardknox.com/reportingjson');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid reporting response')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { saveCard, chargeToken, chargeCard, voidTransaction, refundTransaction, getTransactionReport, getSolaKey };
