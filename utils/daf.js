// utils/daf.js — which processor handles a DAF card.
// Matbia, Pledger and OJC are charged directly through their own APIs; every other DAF
// provider (DonorsFund, iMasser, ...) still goes through Sola. OJC only goes direct once the org
// has entered its OJC login in Settings → OJC — until then OJC cards keep working through Sola.
const matbia = require('./matbia');
const pledger = require('./pledger');
const ojc = require('./ojc');

const GATEWAYS = { matbia, pledger, ojc };

// 'matbia' | 'pledger' | 'ojc' | null (null = Sola). An explicit provider name wins over the card-number prefix.
function gatewayFor(name, cardNum, orgId) {
  if (/matbia/i.test(name || '')) return 'matbia';
  if (/pledger/i.test(name || '')) return 'pledger';
  if (/ojc/i.test(name || '') || ojc.isOjcProvider('', cardNum)) return orgId && ojc.isConfigured(orgId) ? 'ojc' : null;
  if (matbia.isMatbiaProvider('', cardNum)) return 'matbia';
  if (pledger.isPledgerProvider('', cardNum)) return 'pledger';
  return null;
}
function gatewayForCard(pm, orgId) {
  if (pm?.type !== 'daf') return null;
  return gatewayFor(pm.daf_name, matbia.parseDafCard(pm).cardNum, orgId || pm.org_id);
}

const label = gw => ({ matbia: 'Matbia', pledger: 'Pledger', ojc: 'OJC' }[gw] || gw);
const isDirect = gw => !!GATEWAYS[gw];

// Direct charge from a typed-in card number.
function charge(gw, orgId, opts) { return GATEWAYS[gw].charge(orgId, opts); }
// Charge a stored payment method.
function chargePaymentMethod(gw, orgId, pm, opts) { return GATEWAYS[gw].chargePaymentMethod(orgId, pm, opts); }
// Reverse a donation made through that gateway. All direct gateways reverse the full amount only.
function reverse(gw, orgId, don) {
  if (gw === 'matbia') return matbia.reverse(orgId, don.transaction_id);
  if (gw === 'ojc') return ojc.reverse(orgId, { refNum: don.transaction_id, amount: don.amount });
  return pledger.reverse(orgId, { token: don.gateway_token, refNum: don.transaction_id, amount: don.amount });
}

module.exports = { gatewayFor, gatewayForCard, label, isDirect, charge, chargePaymentMethod, reverse };
