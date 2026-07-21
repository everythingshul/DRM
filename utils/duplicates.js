// utils/duplicates.js — real-time duplicate detection across donors AND leads.
//
// Detection runs at query time (not at creation/import time) so a duplicate flag
// never goes stale — e.g. deleting one side of a pair makes the flag disappear on
// the very next check, with nothing left over to clean up.
//
// Strong signals only: exact full name, Hebrew name, email, or full address match.
// Phone number is deliberately NOT used — shared household phones (spouses, siblings,
// parent/child living together) are extremely common and legitimate, and flagging on
// phone produced false positives between real, distinct people sharing a landline.
'use strict';
const { all } = require('../db/schema');

function _norm(s) { return (s || '').toString().toLowerCase().trim(); }

function _loadEntities(orgId) {
  const donors = all(`
    SELECT id, first_name, last_name, hebrew_full_name, email, cell, street, apt, zip, donor_number
    FROM donors WHERE org_id=? AND removed_at IS NULL
  `, [orgId]).map(d => ({ ...d, type: 'donor' }));

  // A converted lead has already become its matching donor — it's not a separate duplicate.
  const leads = all(`
    SELECT id, first_name, last_name, hebrew_full_name, email, cell, street, apt, zip, donor_number
    FROM leads WHERE org_id=? AND removed_at IS NULL AND status != 'converted'
  `, [orgId]).map(l => ({ ...l, type: 'lead' }));

  return [...donors, ...leads];
}

function _bucket(map, key, entity) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(entity);
}

function _entityKey(e) { return `${e.type}:${e.id}`; }

// Finds every duplicate pair for an org, tagged with which signal(s) matched.
// Returns [{ a, b, reasons: string[] }, ...] with a/b each { type, id, first_name, ... }.
function findDuplicateClusters(orgId) {
  const entities = _loadEntities(orgId);
  const nameMap = new Map(), hebrewMap = new Map(), emailMap = new Map(), addrMap = new Map();

  for (const e of entities) {
    const fn = _norm(e.first_name), ln = _norm(e.last_name);
    if (fn && ln) _bucket(nameMap, `${fn}|${ln}`, e);
    const heb = _norm(e.hebrew_full_name);
    if (heb) _bucket(hebrewMap, heb, e);
    const email = _norm(e.email);
    if (email) _bucket(emailMap, email, e);
    if (e.street && e.zip) _bucket(addrMap, `${_norm(e.street)}|${_norm(e.apt)}|${(e.zip||'').trim()}`, e);
  }

  const pairs = new Map(); // "typeA:idA|typeB:idB" (sorted) -> { a, b, reasons: Set }
  const addPairs = (bucket, reason) => {
    for (const group of bucket.values()) {
      if (group.length < 2) continue;
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const e1 = group[i], e2 = group[j];
          const k1 = _entityKey(e1), k2 = _entityKey(e2);
          const [a, b] = k1 < k2 ? [e1, e2] : [e2, e1];
          const pairKey = `${_entityKey(a)}|${_entityKey(b)}`;
          if (!pairs.has(pairKey)) pairs.set(pairKey, { a, b, reasons: new Set() });
          pairs.get(pairKey).reasons.add(reason);
        }
      }
    }
  };
  addPairs(nameMap, 'Full name match');
  addPairs(hebrewMap, 'Hebrew name match');
  addPairs(emailMap, 'Same email');
  addPairs(addrMap, 'Same address');

  return [...pairs.values()].map(p => ({ a: p.a, b: p.b, reasons: [...p.reasons] }));
}

module.exports = { findDuplicateClusters };
