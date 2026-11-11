// routes/activity.js — admin-only activity log (30 days), undo/redo, processor call logs,
// and recovery of records deleted before the log existed (from the daily database backups).
'use strict';
const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router({ mergeParams: true });
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');
const { all, get, run, transaction, AUDITED_TABLES } = require('../db/schema');
const { current: auditCtx } = require('../db/ctx');

router.use(requireAuth, requireOrg, requireOrgAdmin);

const DAYS = 30;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// ── Labels ─────────────────────────────────────────────────────────────────────
const TYPE = {
  donors: ['donor', 'donors'], leads: ['lead', 'leads'], donations: ['donation', 'donations'],
  payment_methods: ['payment method', 'payment methods'], recurring_schedules: ['recurring schedule', 'recurring schedules'],
  scheduled_charges: ['scheduled charge', 'scheduled charges'], donor_duplicates: ['duplicate flag', 'duplicate flags'],
  charge_failures: ['failed-charge record', 'failed-charge records'], expenses: ['expense', 'expenses'],
  neighborhoods: ['neighborhood', 'neighborhoods'], lead_followups: ['follow-up', 'follow-ups'],
  lead_categories: ['lead category', 'lead categories'], org_label_lists: ['label list', 'label lists'],
  email_templates: ['email template', 'email templates'], whatsapp_groups: ['WhatsApp group', 'WhatsApp groups'],
  whatsapp_contacts: ['WhatsApp contact', 'WhatsApp contacts'], whatsapp_broadcasts: ['WhatsApp broadcast', 'WhatsApp broadcasts'],
  import_history: ['import', 'imports'], import_items: ['imported record', 'imported records']
};
const PRIORITY = ['donors', 'leads', 'donations', 'recurring_schedules', 'scheduled_charges', 'expenses', 'payment_methods',
  'neighborhoods', 'email_templates', 'lead_followups', 'lead_categories', 'whatsapp_groups', 'whatsapp_contacts',
  'whatsapp_broadcasts', 'import_history', 'charge_failures', 'donor_duplicates', 'org_label_lists', 'import_items'];

const money = n => '$' + (Number(n) || 0).toFixed(2);
const personName = r => [r.title, r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.hebrew_full_name || '';

function parse(j) { try { return j ? JSON.parse(j) : null; } catch { return null; } }

// Finds a donor's name even if the donor row was since deleted (falls back to the change log).
const donorCache = new Map();
function donorName(id) {
  if (!id) return '';
  if (donorCache.has(id)) return donorCache.get(id);
  let n = '';
  const d = get('SELECT title,first_name,last_name,hebrew_full_name FROM donors WHERE id=?', [id]);
  if (d) n = personName(d);
  else {
    const c = get(`SELECT old_json, new_json FROM change_log WHERE tbl='donors' AND row_id=? ORDER BY id DESC LIMIT 1`, [id]);
    const j = c && (parse(c.new_json) || parse(c.old_json));
    if (j) n = personName(j);
  }
  donorCache.set(id, n);
  return n;
}

function labelRow(tbl, r) {
  if (!r) return '';
  switch (tbl) {
    case 'donors': case 'leads': return personName(r) || 'Unnamed';
    case 'donations': { const n = donorName(r.donor_id); return money(r.amount) + (n ? ' — ' + n : '') + (r.donation_date ? ' (' + String(r.donation_date).slice(0, 10) + ')' : ''); }
    case 'payment_methods': {
      const base = r.type === 'daf' ? (r.daf_name || 'DAF') + ' card' : [r.card_brand || r.type || 'Payment method', r.last_four ? '•••• ' + r.last_four : ''].filter(Boolean).join(' ');
      const n = donorName(r.donor_id); return base + (n ? ' — ' + n : '');
    }
    case 'recurring_schedules': { const n = donorName(r.donor_id); return `${money(r.amount)} ${r.frequency || ''}`.trim() + (n ? ' — ' + n : ''); }
    case 'scheduled_charges': { const n = donorName(r.donor_id); return `${money(r.amount)} on ${String(r.scheduled_for || '').slice(0, 10)}` + (n ? ' — ' + n : ''); }
    case 'charge_failures': { const n = donorName(r.donor_id); return money(r.amount) + (n ? ' — ' + n : ''); }
    case 'expenses': return `${money(r.amount)} — ${r.description || r.category || 'expense'}`;
    case 'neighborhoods': return r.name || r.name_en || r.name_he || 'Neighborhood';
    case 'lead_followups': return String(r.notes || 'Follow-up').slice(0, 60);
    case 'donor_duplicates': return `${donorName(r.donor_id_a)} / ${donorName(r.donor_id_b)}`;
    case 'import_history': return r.filename || 'Import';
    case 'whatsapp_contacts': return r.name || r.phone || 'Contact';
    default: return r.name || r.title || r.subject || r.description || TYPE[tbl]?.[0] || tbl;
  }
}

const SKIP_FIELDS = new Set(['updated_at']);
function fieldDiff(o, n) {
  const out = [];
  if (!o || !n) return out;
  for (const k of Object.keys(n)) if (!SKIP_FIELDS.has(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k])) out.push({ k, from: o[k], to: n[k] });
  return out;
}

// Plain-English title for one action, built from the rows it changed.
function describe(actionId, counts, depth = 0) {
  const total = counts.reduce((s, c) => s + c.n, 0);
  const byTbl = {};
  for (const c of counts) { byTbl[c.tbl] = byTbl[c.tbl] || { I: 0, U: 0, D: 0 }; byTbl[c.tbl][c.op] = c.n; }
  const tbls = Object.keys(byTbl).sort((a, b) => (PRIORITY.indexOf(a) + 1 || 99) - (PRIORITY.indexOf(b) + 1 || 99));
  if (!tbls.length) return { title: 'No changes', detail: '', total: 0 };
  const main = tbls[0], m = byTbl[main];
  const nMain = m.I + m.U + m.D;
  let verb = m.D ? 'Deleted' : m.I ? 'Added' : 'Edited';
  const [one, many] = TYPE[main] || [main, main];
  let label = '', fields = '';
  const sample = all('SELECT op, old_json, new_json FROM change_log WHERE action_id=? AND tbl=? ORDER BY id LIMIT 5', [actionId, main]);
  if (nMain === 1 || sample.length === 1) {
    const s = sample[0], o = parse(s.old_json), n = parse(s.new_json);
    label = labelRow(main, n || o);
    if (s.op === 'U') {
      const diff = fieldDiff(o, n);
      if ((main === 'donors' || main === 'leads') && diff.some(d => d.k === 'removed_at')) {
        verb = diff.find(d => d.k === 'removed_at').to ? 'Removed' : 'Restored';
      } else if (diff.length) fields = ' (' + diff.slice(0, 4).map(d => d.k.replace(/_/g, ' ')).join(', ') + (diff.length > 4 ? '…' : '') + ')';
    }
  }
  let title;
  if (nMain === 1) title = `${verb} ${one}${label ? ': ' + label : ''}${fields}`;
  else {
    // several rows: if every one is a soft-remove/restore keep that verb
    title = `${verb} ${nMain} ${many}`;
  }
  const others = tbls.slice(1).map(t => {
    const x = byTbl[t], n = x.I + x.U + x.D, nm = TYPE[t] || [t, t];
    return `${n} ${n === 1 ? nm[0] : nm[1]}`;
  });
  return { title, detail: others.length ? 'Also changed: ' + others.join(', ') : '', total, main };
}

function actionView(a) {
  const counts = all('SELECT tbl, op, COUNT(*) n FROM change_log WHERE action_id=? GROUP BY tbl, op', [a.id]);
  let d = describe(a.id, counts);
  if (a.undo_of) {
    const orig = get('SELECT id, undo_of FROM audit_actions WHERE id=?', [a.undo_of]);
    let root = orig;
    const isRedo = !!(orig && orig.undo_of);
    if (isRedo) root = get('SELECT id FROM audit_actions WHERE id=?', [orig.undo_of]);
    const od = root ? describe(root.id, all('SELECT tbl, op, COUNT(*) n FROM change_log WHERE action_id=? GROUP BY tbl, op', [root.id])) : null;
    d = { ...d, title: (isRedo ? 'Redid: ' : 'Undid: ') + (od ? od.title : 'an earlier action') };
  }
  const reversed = !!a.undone_at;
  return {
    id: a.id, created_at: a.created_at, user: a.user_name || 'System', ip: a.ip,
    title: d.title, detail: d.detail, total: d.total, main: d.main || null,
    is_undo: !!a.undo_of, undone_at: a.undone_at, undone_by: a.undone_by || null,
    irreversible_note: a.irreversible_note || null,
    undoable: !reversed && !a.irreversible_note && d.total > 0,
    redo_id: reversed ? a.undone_by : null
  };
}

// ── Recent actions ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  donorCache.clear();
  const days = Math.min(DAYS, Math.max(1, +req.query.days || DAYS));
  const q = String(req.query.q || '').trim().toLowerCase();
  const kind = String(req.query.kind || '');   // table name, or '' for all
  const rows = all(`SELECT * FROM audit_actions WHERE org_id=? AND created_at >= datetime('now', ?)
                    ORDER BY created_at DESC, rowid DESC LIMIT 1500`, [req.orgId, `-${days} days`]);
  let out = rows.map(actionView);
  if (kind) out = out.filter(a => a.main === kind);
  if (q) out = out.filter(a => (a.title + ' ' + a.detail + ' ' + a.user).toLowerCase().includes(q));
  const limit = Math.min(300, +req.query.limit || 100), offset = +req.query.offset || 0;
  res.json({ total: out.length, days, actions: out.slice(offset, offset + limit) });
});

// What one action changed, row by row.
router.get('/:id', (req, res) => {
  donorCache.clear();
  const a = get('SELECT * FROM audit_actions WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!a) return res.status(404).json({ error: 'Not found' });
  const rows = all('SELECT id, tbl, row_id, op, old_json, new_json FROM change_log WHERE action_id=? ORDER BY id LIMIT 500', [a.id]);
  const total = get('SELECT COUNT(*) n FROM change_log WHERE action_id=?', [a.id]).n;
  res.json({
    action: actionView(a), total, shown: rows.length, path: a.method ? `${a.method} ${a.path}` : null,
    changes: rows.map(r => {
      const o = parse(r.old_json), n = parse(r.new_json);
      return { op: r.op, type: (TYPE[r.tbl] || [r.tbl])[0], label: labelRow(r.tbl, n || o), fields: r.op === 'U' ? fieldDiff(o, n) : [] };
    })
  });
});

// ── Undo / redo ────────────────────────────────────────────────────────────────
// Undoing replays the action's recorded row changes in reverse. Because the undo is itself
// a request, its changes are logged as a new action — undoing THAT is "redo".
router.post('/:id/undo', (req, res) => {
  const st = auditCtx();
  try {
    const target = get('SELECT * FROM audit_actions WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
    if (!target) return res.status(404).json({ error: 'That action is no longer in the log (it is kept for 30 days).' });
    if (target.undone_at) return res.status(400).json({ error: 'That action was already undone.' });
    if (target.irreversible_note) return res.status(400).json({ error: `This action ${target.irreversible_note.charAt(0).toLowerCase() + target.irreversible_note.slice(1)}, which can't be undone here. Use Refund on the donation instead.` });
    const rows = all('SELECT * FROM change_log WHERE action_id=? ORDER BY id DESC', [target.id]);
    if (!rows.length) return res.status(400).json({ error: 'Nothing to undo — this action changed no records.' });

    // Newer changes to the same records would be overwritten by an undo — say so first.
    if (!req.body?.force) {
      const seen = new Map();
      for (const r of rows) {
        const later = all(`SELECT DISTINCT a.id, a.user_name, a.created_at, a.undone_at FROM change_log c
            JOIN audit_actions a ON a.id = c.action_id
          WHERE c.tbl=? AND c.row_id=? AND c.id>? AND c.action_id NOT IN (?, ?)
            AND a.undone_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM audit_actions b WHERE b.id = a.undo_of AND b.undone_by = a.id)`,
          [r.tbl, r.row_id, r.id, target.id, st?.id || '']);
        for (const l of later) seen.set(l.id, l);
      }
      if (seen.size) {
        donorCache.clear();
        const list = [...seen.values()].slice(0, 5).map(l => ({ id: l.id, user: l.user_name || 'System', created_at: l.created_at, title: actionView(get('SELECT * FROM audit_actions WHERE id=?', [l.id])).title }));
        return res.status(409).json({ error: 'Newer changes were made to these records.', conflicts: list, conflict_count: seen.size });
      }
    }

    const cols = {};
    const colsOf = t => cols[t] || (cols[t] = new Set(all(`PRAGMA table_info("${t}")`).map(c => c.name)));
    const result = { restored: 0, removed: 0, reverted: 0, skipped: 0 };
    transaction(() => {
      for (const r of rows) {
        if (!AUDITED_TABLES[r.tbl]) { result.skipped++; continue; }
        const o = parse(r.old_json), n = parse(r.new_json), c = colsOf(r.tbl);
        if (r.op === 'I') {
          if (get(`SELECT 1 FROM "${r.tbl}" WHERE id=?`, [r.row_id])) { run(`DELETE FROM "${r.tbl}" WHERE id=?`, [r.row_id]); result.removed++; }
        } else if (r.op === 'D' && o) {
          const keys = Object.keys(o).filter(k => c.has(k));
          if (get(`SELECT 1 FROM "${r.tbl}" WHERE id=?`, [r.row_id])) { result.skipped++; continue; }
          run(`INSERT INTO "${r.tbl}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map(k => o[k]));
          result.restored++;
        } else if (r.op === 'U' && o && n) {
          const keys = Object.keys(o).filter(k => c.has(k) && k !== 'id' && JSON.stringify(o[k]) !== JSON.stringify(n[k]));
          if (!keys.length) continue;
          if (!get(`SELECT 1 FROM "${r.tbl}" WHERE id=?`, [r.row_id])) { result.skipped++; continue; }
          run(`UPDATE "${r.tbl}" SET ${keys.map(k => `"${k}"=?`).join(', ')} WHERE id=?`, [...keys.map(k => o[k]), r.row_id]);
          result.reverted++;
        }
      }
      run(`UPDATE audit_actions SET undone_at=datetime('now'), undone_by=? WHERE id=?`, [st?.id || null, target.id]);
      if (st) run('UPDATE audit_actions SET undo_of=? WHERE id=?', [target.id, st.id]);
      // undoing an undo is a redo: the original action is live again
      if (target.undo_of) run('UPDATE audit_actions SET undone_at=NULL, undone_by=NULL WHERE id=?', [target.undo_of]);
    }, { foreignKeysOff: true });
    res.json({ success: true, ...result, undo_id: st?.id || null });
  } catch (e) {
    console.error('[activity] undo error:', e.message);
    res.status(500).json({ error: 'Undo failed — nothing was changed. ' + e.message });
  }
});

// ── Logs: payment processor calls + emails ─────────────────────────────────────
router.get('/logs/calls', (req, res) => {
  const days = Math.min(DAYS, Math.max(1, +req.query.days || DAYS));
  const provider = String(req.query.provider || '');
  const q = String(req.query.q || '').trim().toLowerCase();
  let rows = all(`SELECT l.*, u.full_name AS user_name FROM api_call_log l LEFT JOIN users u ON u.id = l.user_id
                  WHERE l.org_id=? AND l.created_at >= datetime('now', ?) ORDER BY l.id DESC LIMIT 1500`, [req.orgId, `-${days} days`]);
  if (provider) rows = rows.filter(r => r.provider === provider);
  if (q) rows = rows.filter(r => [r.endpoint, r.reference, r.error, r.detail, r.status, r.user_name].join(' ').toLowerCase().includes(q));
  res.json({ total: rows.length, calls: rows.slice(0, 300) });
});

// ── Recover records deleted BEFORE the activity log existed ────────────────────
// The server saves a copy of the database every night (kept 30 days). Anything that is in
// one of those copies but missing now was deleted since — list it and let an admin put it back.
const RESTORE_ORDER = ['neighborhoods', 'lead_categories', 'donors', 'leads', 'payment_methods', 'recurring_schedules',
  'scheduled_charges', 'donations', 'expenses', 'lead_followups', 'email_templates', 'whatsapp_groups', 'whatsapp_contacts'];
let sqlPromise = null;
const getSql = () => sqlPromise || (sqlPromise = require('sql.js')());

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR).filter(f => /^drm-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    .map(f => { const st = fs.statSync(path.join(BACKUP_DIR, f)); return { file: f, date: f.slice(4, 14), size: st.size }; })
    .sort((a, b) => b.date.localeCompare(a.date));
}

function rowsOf(bdb, sql, params) {
  const stmt = bdb.prepare(sql); stmt.bind(params);
  const out = []; while (stmt.step()) out.push(stmt.getAsObject());
  stmt.free(); return out;
}

const scanCache = new Map();   // orgId -> { sig, at, found }
async function scan(orgId, fresh) {
  const backups = listBackups();
  const sig = backups.map(b => b.file + ':' + b.size).join('|');
  const hit = scanCache.get(orgId);
  if (!fresh && hit && hit.sig === sig && Date.now() - hit.at < 5 * 60 * 1000) return { backups, found: hit.found };
  const SQL = await getSql();
  const live = {};
  for (const t of RESTORE_ORDER) live[t] = new Set(all(`SELECT id FROM "${t}" WHERE org_id=?`, [orgId]).map(r => r.id));
  const found = new Map();   // "table:id" -> { t, id, row, backup }
  for (const b of backups) {   // newest first: the first copy that still has a row is the freshest version
    let bdb;
    try { bdb = new SQL.Database(fs.readFileSync(path.join(BACKUP_DIR, b.file))); } catch { continue; }
    try {
      for (const t of RESTORE_ORDER) {
        let rows;
        try { rows = rowsOf(bdb, `SELECT * FROM "${t}" WHERE org_id=?`, [orgId]); } catch { continue; }
        for (const r of rows) {
          const key = t + ':' + r.id;
          if (!live[t].has(r.id) && !found.has(key)) found.set(key, { t, id: r.id, row: r, backup: b.date });
        }
      }
    } finally { bdb.close(); }
  }
  scanCache.set(orgId, { sig, at: Date.now(), found });
  return { backups, found };
}

router.get('/recover/scan', async (req, res) => {
  try {
    donorCache.clear();
    const { backups, found } = await scan(req.orgId, req.query.fresh === '1');
    const liveDonor = id => !!get('SELECT 1 FROM donors WHERE id=?', [id]);
    const donors = [], other = [];
    const kids = {};   // donorId -> { table: n }
    for (const f of found.values()) {
      const did = f.row.donor_id;
      if (f.t !== 'donors' && did && found.has('donors:' + did)) {
        kids[did] = kids[did] || {}; kids[did][f.t] = (kids[did][f.t] || 0) + 1;
      }
    }
    for (const f of found.values()) {
      const r = f.row;
      if (f.t === 'donors') donors.push({ key: 'donors:' + f.id, label: labelRow('donors', r), backup: f.backup, children: kids[f.id] || {}, email: r.email || '', created_at: r.created_at });
      else if (r.donor_id && found.has('donors:' + r.donor_id)) continue;   // comes back with its donor
      else {
        const orphan = !!r.donor_id && !liveDonor(r.donor_id);
        other.push({ key: f.t + ':' + f.id, table: f.t, type: (TYPE[f.t] || [f.t])[0], label: labelRow(f.t, r), backup: f.backup,
          date: r.donation_date || r.expense_date || r.scheduled_for || r.created_at || null, orphan });
      }
    }
    const byDate = (a, b) => String(b.date || b.created_at || '').localeCompare(String(a.date || a.created_at || ''));
    donors.sort(byDate); other.sort(byDate);
    res.json({ backups: backups.map(b => ({ date: b.date, size: b.size })), donors, other });
  } catch (e) { console.error('[activity] scan error:', e.message); res.status(500).json({ error: e.message }); }
});

router.post('/recover/restore', async (req, res) => {
  try {
    const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : [];
    if (!keys.length) return res.status(400).json({ error: 'Nothing selected' });
    const { found } = await scan(req.orgId, false);
    const pick = new Map();
    for (const k of keys) {
      const f = found.get(k); if (!f) continue;
      pick.set(k, f);
      // a donor comes back with everything that was deleted along with it
      if (f.t === 'donors') for (const [k2, f2] of found) if (f2.row.donor_id === f.id && f2.t !== 'donors') pick.set(k2, f2);
    }
    if (!pick.size) return res.status(404).json({ error: 'Those records are no longer in the backups — refresh the list.' });
    const result = { restored: {}, skipped: 0, failed: [] };
    transaction(() => {
      for (const t of RESTORE_ORDER) {
        const live = new Set(all(`PRAGMA table_info("${t}")`).map(c => c.name));
        for (const f of pick.values()) {
          if (f.t !== t) continue;
          if (get(`SELECT 1 FROM "${t}" WHERE id=?`, [f.id])) { result.skipped++; continue; }
          const ks = Object.keys(f.row).filter(k => live.has(k));
          try {
            run(`INSERT INTO "${t}" (${ks.map(k => `"${k}"`).join(',')}) VALUES (${ks.map(() => '?').join(',')})`, ks.map(k => f.row[k]));
            result.restored[t] = (result.restored[t] || 0) + 1;
          } catch (e) { result.failed.push({ key: f.t + ':' + f.id, error: e.message }); }
        }
      }
    }, { foreignKeysOff: true });
    scanCache.delete(req.orgId);
    res.json({ success: true, ...result });
  } catch (e) { console.error('[activity] restore error:', e.message); res.status(500).json({ error: 'Restore failed — ' + e.message }); }
});

module.exports = router;
