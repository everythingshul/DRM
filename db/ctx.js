// db/ctx.js — which request (if any) is currently writing to the database.
// The audit triggers in schema.js stamp every row change with this request's action id,
// so "everything this click changed" can be listed and undone together.
'use strict';
const { AsyncLocalStorage } = require('async_hooks');
const als = new AsyncLocalStorage();

const current = () => als.getStore() || null;

// Called by the payment gateways when a request moved real money (charge, void, refund...).
// Such an action stays in the log but can't be undone from there — database rows can be put
// back, money can't — so the Undo button is replaced by a pointer to Refund.
function flagMoney(note) {
  const s = als.getStore();
  if (s) s.moneyNote = note || 'Moved money through a payment processor';
}

module.exports = { als, current, flagMoney };
