// utils/daf.js — which processor handles a DAF card.
// Matbia and Pledger are charged directly through their own APIs; every other DAF
// provider (OJC, DonorsFund, iMasser, ...) still goes through Sola.
const matbia = require('./matbia');
const pledger = require('./pledger');

const GATEWAYS = { matbia, pledger };

// 'matbia' | 'pledger' | null (null = Sola). An explicit provider name wins over the card-number prefix.
function gatewayFor(name, cardNum) {
  if (/matbia/i.test(name || '')) return 'matbia';
  if (/pledger/i.test(name || '')) return 'pledger';
  if (matbia.isMatbiaProvider('', cardNum)) return 'matbia';
  if (pledger.isPledgerProvider('', cardNum)) return 'pledger';
  return null;
}
function gatewayForCard(pm) {
  if (pm?.type !== 'daf') return null;
  return gatewayFor(pm.daf_name, matbia.parseDafCard(pm).cardNum);
}

const label = gw => ({ matbia: 'Matbia', pledger: 'Pledger' }[gw] || gw);

// Direct charge from a typed-in card number.
function charge(gw, orgId, opts) { return GATEWAYS[gw].charge(orgId, opts); }
// Charge a stored payment method.
function chargePaymentMethod(gw, orgId, pm, opts) { return GATEWAYS[gw].chargePaymentMethod(orgId, pm, opts); }
// Reverse a donation made through that gateway. Both gateways reverse the full amount only.
function reverse(gw, orgId, don) {
  if (gw === 'matbia') return matbia.reverse(orgId, don.transaction_id);
  return pledger.reverse(orgId, { token: don.gateway_token, refNum: don.transaction_id, amount: don.amount });
}

module.exports = { gatewayFor, gatewayForCard, label, charge, chargePaymentMethod, reverse };
