// routes/leads.js — Leads management
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');

router.use(requireAuth, requireOrg);

// ══ IMPORT / EXPORT (mirrors the Donors import/export feature) ═══════════════
const multer = require('multer');
const XLSX   = require('xlsx');
const path   = require('path');
const fs     = require('fs');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const leadUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(DATA_DIR, 'uploads');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
  }),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ── Download blank template ────────────────────────────────────────────────────
router.get('/import/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet([{
    'ID #':'', 'Title':'', 'First Name':'', 'Last Name':'',
    'Hebrew Title':'', 'Hebrew Name':'', 'Email':'', 'Cell':'', 'Home Phone':'',
    'Street':'', 'Apt':'', 'City':'', 'State':'', 'Zip':'',
    'Category':'', 'Notes':''
  }]);
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=lead-import-template.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Import leads from Excel ─────────────────────────────────────────────────────
router.post('/import', requireOrgAdmin, leadUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const wb   = XLSX.readFile(req.file.path);
    const ws   = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    let imported = 0, errors = [], leadIds = [];
    const fieldMap = {
      'Title':'title', 'First Name':'first_name', 'Last Name':'last_name',
      'Hebrew Title':'hebrew_title', 'Hebrew Name':'hebrew_full_name',
      'Email':'email', 'Cell':'cell', 'Home Phone':'home_phone',
      'Street':'street', 'Apt':'apt', 'City':'city', 'State':'state', 'Zip':'zip',
      'Category':'category', 'Notes':'notes'
    };

    for (const row of rows) {
      const fn = (row['First Name']||'').toString().trim();
      const ln = (row['Last Name']||'').toString().trim();
      const email = (row['Email']||'').toString().trim().toLowerCase();
      const cell = (row['Cell']||'').toString().trim();
      if (!fn && !ln && !email && !cell) continue; // skip blank rows
      const displayName = [fn, ln].filter(Boolean).join(' ') || email || cell || 'Unknown';

      try {
        const importedNum = row['ID #'] || row['ID#'] || row['Lead ID'] || '';
        const existingById = importedNum ? get('SELECT * FROM leads WHERE donor_number=? AND org_id=?', [parseInt(importedNum), req.orgId]) : null;

        if (existingById) {
          const updates = [], vals = [];
          for (const [col, field] of Object.entries(fieldMap)) {
            const v = (row[col]||'').toString().trim();
            if (v) { updates.push(`${field}=?`); vals.push(v); }
          }
          if (updates.length) {
            vals.push(existingById.id, req.orgId);
            run(`UPDATE leads SET ${updates.join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=? AND org_id=?`, vals);
          }
          leadIds.push(existingById.id);
          imported++;
          continue;
        }

        // New lead — assign a fresh donor_number
        let donorNum;
        for (let attempts=0; attempts<20; attempts++) {
          const candidate = Math.floor(100000 + Math.random()*900000);
          const exists = get('SELECT id FROM donors WHERE donor_number=? UNION SELECT id FROM leads WHERE donor_number=?', [candidate, candidate]);
          if (!exists) { donorNum = candidate; break; }
        }
        const id = uuidv4();
        run(`INSERT INTO leads (id,org_id,donor_number,title,first_name,last_name,hebrew_title,hebrew_full_name,
             email,cell,home_phone,street,apt,city,state,zip,category,notes,status,created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [id, req.orgId, donorNum||null,
           (row['Title']||'').toString().trim()||null, fn||'', ln||'',
           (row['Hebrew Title']||'').toString().trim()||null,
           (row['Hebrew Name']||'').toString().trim()||null,
           email||null, cell||null,
           (row['Home Phone']||'').toString().trim()||null,
           (row['Street']||'').toString().trim()||null,
           (row['Apt']||'').toString().trim()||null,
           (row['City']||'').toString().trim()||null,
           (row['State']||'').toString().trim()||null,
           (row['Zip']||'').toString().trim()||null,
           (row['Category']||'').toString().trim()||null,
           (row['Notes']||'').toString().trim()||null,
           'new', req.user.id]);
        leadIds.push(id);
        imported++;
      } catch(e) { errors.push(`${displayName}: ${e.message}`); }
    }

    try { fs.unlinkSync(req.file.path); } catch {}
    res.json({ success: true, imported, errors: errors.slice(0,50) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Export leads to Excel ───────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const leads = all(`
    SELECT l.*, u.full_name as assigned_name
    FROM leads l LEFT JOIN users u ON u.id=l.assigned_to
    WHERE l.org_id=? ORDER BY l.last_name, l.first_name
  `, [req.orgId]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(leads.map(l => {
    let labels = '';
    try { labels = JSON.parse(l.labels||'[]').join(', '); } catch {}
    return {
      'ID #':            l.donor_number || '',
      'Title':           l.title || '',
      'First Name':      l.first_name || '',
      'Last Name':       l.last_name || '',
      'Hebrew Title':    l.hebrew_title || '',
      'Hebrew Name':     l.hebrew_full_name || '',
      'Email':           l.email || '',
      'Cell':            l.cell || '',
      'Home Phone':      l.home_phone || '',
      'Street':          l.street || '',
      'Apt':             l.apt || '',
      'City':            l.city || '',
      'State':           l.state || '',
      'Zip':             l.zip || '',
      'Category':        l.category || '',
      'Labels':          labels,
      'Status':          l.status || '',
      'Assigned To':     l.assigned_name || '',
      'Notes':           l.notes || '',
      'Created':         l.created_at ? l.created_at.slice(0,10) : ''
    };
  }));
  ws['!cols'] = [{wch:9},{wch:8},{wch:14},{wch:16},{wch:12},{wch:18},{wch:26},{wch:14},{wch:14},{wch:20},{wch:6},{wch:14},{wch:6},{wch:8},{wch:14},{wch:20},{wch:12},{wch:16},{wch:30},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws, 'Leads');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=leads-export.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});


// ── List leads ────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { status, assigned_to, category, q } = req.query;
  let where = 'l.org_id=? AND l.removed_at IS NULL', params = [req.orgId];
  if (status)      { where += ' AND l.status=?';      params.push(status); }
  if (assigned_to) { where += ' AND l.assigned_to=?'; params.push(assigned_to); }
  if (category)    { where += ' AND l.category=?';    params.push(category); }
  if (q) {
    where += ' AND (l.first_name LIKE ? OR l.last_name LIKE ? OR l.email LIKE ? OR l.cell LIKE ? OR l.hebrew_full_name LIKE ? OR CAST(l.donor_number AS TEXT) LIKE ?)';
    const s = `%${q.replace(/^#/, '')}%`;
    params.push(s,s,s,s,s,s);
  }
  const leads = all(`
    SELECT l.*,
      u.full_name as assigned_name,
      (SELECT COUNT(*) FROM lead_followups WHERE lead_id=l.id) as followup_count,
      l.next_followup_date as next_followup
    FROM leads l
    LEFT JOIN users u ON u.id = l.assigned_to
    WHERE ${where}
    ORDER BY l.created_at DESC
  `, params);
  res.json(leads);
});

// ── Recently removed leads (30-day restore window) — must be before /:id ───────
router.get('/removed', (req, res) => {
  const leads = all(`
    SELECT id, first_name, last_name, donor_number, email, cell, removed_at
    FROM leads WHERE org_id=? AND removed_at IS NOT NULL
      AND julianday('now') - julianday(removed_at) <= 30
    ORDER BY removed_at DESC
  `, [req.orgId]);
  res.json(leads);
});

// ── Get single lead ───────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const lead = get('SELECT l.*, u.full_name as assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=? AND l.org_id=?', [req.params.id, req.orgId]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const followups = all('SELECT lf.*, u.full_name as done_by_name FROM lead_followups lf LEFT JOIN users u ON u.id=lf.done_by WHERE lf.lead_id=? ORDER BY lf.created_at DESC', [req.params.id]);
  res.json({ ...lead, followups });
});

// ── Create lead ───────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { title,first_name,last_name,hebrew_title,hebrew_full_name,email,cell,home_phone,
          street,apt,city,state,zip,neighborhood_id,labels,category,notes,assigned_to,status } = req.body;
  const id = uuidv4();
  let donorNum;
  for (let attempts = 0; attempts < 20; attempts++) {
    const candidate = Math.floor(100000 + Math.random() * 900000);
    const { get: g } = require('../db/schema');
    const exists = g('SELECT id FROM donors WHERE donor_number=? UNION SELECT id FROM leads WHERE donor_number=?', [candidate, candidate]);
    if (!exists) { donorNum = candidate; break; }
  }
  run(`INSERT INTO leads (id,org_id,donor_number,title,first_name,last_name,hebrew_title,hebrew_full_name,
       email,cell,home_phone,street,apt,city,state,zip,neighborhood_id,labels,category,notes,
       assigned_to,status,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id,req.orgId,donorNum||null,title||null,first_name||null,last_name||null,hebrew_title||null,hebrew_full_name||null,
     email||null,cell||null,home_phone||null,street||null,apt||null,city||null,state||null,zip||null,
     neighborhood_id||null,JSON.stringify(labels||[]),category||null,notes||null,
     assigned_to||null,status||'new',req.user.id]);

  // Notify assigned user
  if (assigned_to && assigned_to !== req.user.id) {
    const lead = get('SELECT * FROM leads WHERE id=?', [id]);
    run(`INSERT INTO notifications (id,org_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(),req.orgId,assigned_to,'lead_assigned',
       `New lead assigned to you`,
       `${first_name||''} ${last_name||''} was assigned to you`,
       `#leads/${id}`]);
  }
  res.json({ success: true, lead: get('SELECT * FROM leads WHERE id=?', [id]) });
});

// ── Update lead ───────────────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const existing = get('SELECT * FROM leads WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!existing) return res.status(404).json({ error: 'Lead not found' });
  const { title,first_name,last_name,hebrew_title,hebrew_full_name,email,cell,home_phone,
          street,apt,city,state,zip,neighborhood_id,labels,category,notes,assigned_to,status } = req.body;

  run(`UPDATE leads SET title=?,first_name=?,last_name=?,hebrew_title=?,hebrew_full_name=?,
       email=?,cell=?,home_phone=?,street=?,apt=?,city=?,state=?,zip=?,neighborhood_id=?,
       labels=?,category=?,notes=?,assigned_to=?,status=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND org_id=?`,
    [title??existing.title,first_name??existing.first_name,last_name??existing.last_name,
     hebrew_title??existing.hebrew_title,hebrew_full_name??existing.hebrew_full_name,
     email??existing.email,cell??existing.cell,home_phone??existing.home_phone,
     street??existing.street,apt??existing.apt,city??existing.city,state??existing.state,zip??existing.zip,
     neighborhood_id??existing.neighborhood_id,
     labels!==undefined?JSON.stringify(labels):existing.labels,
     category??existing.category,notes??existing.notes,
     assigned_to!==undefined?assigned_to:existing.assigned_to,
     status??existing.status,
     req.params.id,req.orgId]);

  // Notify new assignee
  if (assigned_to && assigned_to !== existing.assigned_to && assigned_to !== req.user.id) {
    run(`INSERT INTO notifications (id,org_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)`,
      [uuidv4(),req.orgId,assigned_to,'lead_assigned',
       'Lead assigned to you',
       `${first_name||existing.first_name||''} ${last_name||existing.last_name||''} was assigned to you`,
       `#leads/${req.params.id}`]);
  }
  res.json({ success: true, lead: get('SELECT * FROM leads WHERE id=?', [req.params.id]) });
});

// ── Remove lead — soft delete, restorable for 30 days (mirrors Donors) ─────────
router.delete('/:id', requireOrgAdmin, (req, res) => {
  const existing = get('SELECT id FROM leads WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!existing) return res.status(404).json({ error: 'Lead not found' });
  run('UPDATE leads SET removed_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

router.post('/:id/restore', requireOrgAdmin, (req, res) => {
  const lead = get('SELECT * FROM leads WHERE id=? AND org_id=? AND removed_at IS NOT NULL', [req.params.id, req.orgId]);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  if ((Date.now() - new Date(lead.removed_at).getTime()) > 30*24*60*60*1000) {
    return res.status(400).json({ error: 'The 30-day restore window has passed' });
  }
  run('UPDATE leads SET removed_at = NULL WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ── Add follow-up ─────────────────────────────────────────────────────────────
router.post('/:id/followup', (req, res) => {
  const lead = get('SELECT * FROM leads WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const { notes, next_followup_date } = req.body;
  if (!notes) return res.status(400).json({ error: 'Notes required' });
  const id = uuidv4();
  // Record this follow-up permanently in history (never modify older rows)
  run(`INSERT INTO lead_followups (id,lead_id,org_id,notes,next_followup_date,done_by,done_by_name)
       VALUES (?,?,?,?,?,?,?)`,
    [id,req.params.id,req.orgId,notes,next_followup_date||null,req.user.id,req.user.full_name]);

  // The lead's single "active" scheduled date lives on the lead row itself —
  // this is what supersedes, not the history
  run('UPDATE leads SET next_followup_date=? WHERE id=?', [next_followup_date||null, req.params.id]);

  // Update lead status to 'in_progress'
  if (lead.status === 'new') run('UPDATE leads SET status=? WHERE id=?', ['in_progress', req.params.id]);

  // Notification is sent by the hourly scheduler exactly when the date arrives (see utils/scheduler.js)
  res.json({ success: true, followup: get('SELECT * FROM lead_followups WHERE id=?', [id]) });
});

// ── Edit a follow-up (all fields) ─────────────────────────────────────────────
router.put('/followups/:id', (req, res) => {
  const fu = get('SELECT * FROM lead_followups WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
  const { notes, next_followup_date } = req.body;
  run('UPDATE lead_followups SET notes=?,next_followup_date=? WHERE id=?',
    [notes!==undefined?notes:fu.notes, next_followup_date!==undefined?(next_followup_date||null):fu.next_followup_date, req.params.id]);

  // If this is the most recent follow-up for the lead, keep the lead's active date in sync
  const latest = get('SELECT id FROM lead_followups WHERE lead_id=? ORDER BY created_at DESC LIMIT 1', [fu.lead_id]);
  if (latest && latest.id === req.params.id) {
    run('UPDATE leads SET next_followup_date=? WHERE id=?',
      [next_followup_date!==undefined?(next_followup_date||null):fu.next_followup_date, fu.lead_id]);
  }
  res.json({ success: true });
});

// ── Convert lead to donor ─────────────────────────────────────────────────────
router.post('/:id/convert', requireOrgAdmin, (req, res) => {
  const lead = get('SELECT * FROM leads WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  if (lead.converted_donor_id) return res.status(400).json({ error: 'Already converted' });

  const donorId = uuidv4();
  run(`INSERT INTO donors (id,org_id,donor_number,title,first_name,last_name,hebrew_title,hebrew_full_name,
       email,cell,home_phone,street,apt,city,state,zip,neighborhood_id,labels,notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [donorId,req.orgId,lead.donor_number||null,lead.title,lead.first_name||'',lead.last_name||'',
     lead.hebrew_title,lead.hebrew_full_name,lead.email,lead.cell,lead.home_phone,
     lead.street,lead.apt,lead.city,lead.state,lead.zip,lead.neighborhood_id,
     lead.labels||'[]',lead.notes]);

  run('UPDATE leads SET status=?,converted_donor_id=? WHERE id=?', ['converted',donorId,req.params.id]);
  res.json({ success: true, donor_id: donorId });
});

// ── Lead categories ───────────────────────────────────────────────────────────
router.get('/categories/list', (req, res) => {
  res.json(all('SELECT * FROM lead_categories WHERE org_id=? ORDER BY sort_order,name', [req.orgId]));
});
router.post('/categories/list', requireOrgAdmin, (req, res) => {
  const { name, color } = req.body;
  const id = uuidv4();
  run('INSERT INTO lead_categories (id,org_id,name,color) VALUES (?,?,?,?)', [id,req.orgId,name,color||'#6366f1']);
  res.json({ success: true, category: get('SELECT * FROM lead_categories WHERE id=?', [id]) });
});
router.put('/categories/:id', requireOrgAdmin, (req, res) => {
  const { name, color } = req.body;
  run('UPDATE lead_categories SET name=?,color=? WHERE id=? AND org_id=?',
    [name, color||'#6366f1', req.params.id, req.orgId]);
  res.json({ success: true });
});
router.delete('/categories/:id', requireOrgAdmin, (req, res) => {
  run('DELETE FROM lead_categories WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

// ── Org users (for assignment) ────────────────────────────────────────────────
router.get('/staff/list', (req, res) => {
  const staff = all(`SELECT u.id, u.full_name, u.email, ou.role FROM users u
    JOIN org_users ou ON ou.user_id=u.id WHERE ou.org_id=? ORDER BY u.full_name`, [req.orgId]);
  res.json(staff);
});

// ── List all scheduled follow-ups for this org ────────────────────────────────
router.get('/followups/scheduled', (req, res) => {
  const followups = all(`
    SELECT l.id as lead_id, l.next_followup_date, l.assigned_to,
      l.first_name||' '||COALESCE(l.last_name,'') as lead_name,
      l.cell as lead_cell, la.full_name as lead_assigned_name,
      (SELECT lf.notes FROM lead_followups lf WHERE lf.lead_id=l.id ORDER BY lf.created_at DESC LIMIT 1) as notes,
      (SELECT lf.id FROM lead_followups lf WHERE lf.lead_id=l.id ORDER BY lf.created_at DESC LIMIT 1) as id,
      (SELECT lf.done_by_name FROM lead_followups lf WHERE lf.lead_id=l.id ORDER BY lf.created_at DESC LIMIT 1) as done_by_name
    FROM leads l
    LEFT JOIN users la ON la.id = l.assigned_to
    WHERE l.org_id=? AND l.next_followup_date IS NOT NULL
      AND l.status != 'converted' AND l.removed_at IS NULL
    ORDER BY l.next_followup_date ASC
  `, [req.orgId]);
  res.json(followups);
});

module.exports = router;
