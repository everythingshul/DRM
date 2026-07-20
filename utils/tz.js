// utils/tz.js — shared server-side timezone helpers.
// The Node process itself runs in UTC (Render's default system clock), so any
// date formatted with plain toLocaleDateString()/toLocaleString() with no
// explicit timeZone bakes in UTC as a plain string — the browser has no way
// to fix that after the fact. Every place that turns a Date into text for a
// receipt, PDF, or email must go through these helpers instead.
'use strict';

function _dbGet() {
  // Lazy require to dodge circular-require issues between schema.js and this file
  return require('../db/schema').get;
}

function getOrgTimezone(orgId) {
  try {
    const org = _dbGet()('SELECT settings FROM organizations WHERE id=?', [orgId]);
    const tz = JSON.parse(org?.settings || '{}').timezone;
    return tz || 'America/New_York';
  } catch { return 'America/New_York'; }
}

function fmtDateInTz(date, tz, opts) {
  try {
    return new Date(date).toLocaleDateString('en-US', { timeZone: tz || 'America/New_York', ...(opts || { year:'numeric', month:'long', day:'numeric' }) });
  } catch { return new Date(date).toISOString().slice(0,10); }
}

function fmtDateTimeInTz(date, tz, opts) {
  try {
    return new Date(date).toLocaleString('en-US', { timeZone: tz || 'America/New_York', ...(opts || { year:'numeric', month:'long', day:'numeric', hour:'numeric', minute:'2-digit' }) });
  } catch { return new Date(date).toISOString(); }
}

module.exports = { getOrgTimezone, fmtDateInTz, fmtDateTimeInTz };
