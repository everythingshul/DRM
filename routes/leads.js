// routes/leads.js — Leads management
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');

router.use(requireAuth, requireOrg);

// ── List leads ────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { status, assigned_to, category, q } = req.query;
  let where = 'l.org_id=?', params = [req.orgId];
  if (status)      { where += ' AND l.status=?';      params.push(status); }
  if (assigned_to) { where += ' AND l.assigned_to=?'; params.push(assigned_to); }
  if (category)    { where += ' AND l.category=?';    params.push(category); }
  if (q) {
    where += ' AND (l.first_name LIKE ? OR l.last_name LIKE ? OR l.email LIKE ? OR l.cell LIKE ? OR l.hebrew_full_name LIKE ?)';
    const s = `%${q}%`;
    params.push(s,s,s,s,s);
  }
  const leads = all(`
    SELECT l.*,
      u.full_name as assigned_name,
      (SELECT COUNT(*) FROM lead_followups WHERE lead_id=l.id) as followup_count,
      (SELECT next_followup_date FROM lead_followups WHERE lead_id=l.id ORDER BY created_at DESC LIMIT 1) as next_followup
    FROM leads l
    LEFT JOIN users u ON u.id = l.assigned_to
    WHERE ${where}
    ORDER BY l.created_at DESC
  `, params);
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
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

// ── Delete lead ───────────────────────────────────────────────────────────────
router.delete('/:id', requireOrgAdmin, (req, res) => {
  run('DELETE FROM lead_followups WHERE lead_id=?', [req.params.id]);
  run('DELETE FROM leads WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

// ── Add follow-up ─────────────────────────────────────────────────────────────
router.post('/:id/followup', (req, res) => {
  const lead = get('SELECT * FROM leads WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const { notes, next_followup_date } = req.body;
  if (!notes) return res.status(400).json({ error: 'Notes required' });
  const id = uuidv4();
  // Supersede previous scheduled follow-ups for this lead
  run('UPDATE lead_followups SET next_followup_date=NULL WHERE lead_id=?', [req.params.id]);
  run(`INSERT INTO lead_followups (id,lead_id,org_id,notes,next_followup_date,done_by,done_by_name)
       VALUES (?,?,?,?,?,?,?)`,
    [id,req.params.id,req.orgId,notes,next_followup_date||null,req.user.id,req.user.full_name]);

  // Update lead status to 'in_progress'
  if (lead.status === 'new') run('UPDATE leads SET status=? WHERE id=?', ['in_progress', req.params.id]);

  // Schedule notification for assigned user on follow-up date
  if (next_followup_date && lead.assigned_to) {
    run(`INSERT INTO notifications (id,org_id,user_id,type,title,body,link,created_at) VALUES (?,?,?,?,?,?,?,?)`,
      [uuidv4(),req.orgId,lead.assigned_to,'followup_due',
       `Follow-up due: ${lead.first_name||''} ${lead.last_name||''}`,
       `Scheduled follow-up for ${next_followup_date}`,
       `#leads/${req.params.id}`, next_followup_date]);
  }
  res.json({ success: true, followup: get('SELECT * FROM lead_followups WHERE id=?', [id]) });
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

// ── Edit follow-up ────────────────────────────────────────────────────────────
router.put('/followups/:id', (req, res) => {
  const { next_followup_date, notes } = req.body;
  const fu = get('SELECT * FROM lead_followups WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!fu) return res.status(404).json({ error: 'Follow-up not found' });
  run('UPDATE lead_followups SET next_followup_date=?,notes=? WHERE id=?',
    [next_followup_date||null, notes||fu.notes, req.params.id]);
  res.json({ success: true });
});

// ── List all scheduled follow-ups for this org ────────────────────────────────
router.get('/followups/scheduled', (req, res) => {
  const followups = all(`
    SELECT lf.*,
      l.first_name||' '||COALESCE(l.last_name,'') as lead_name,
      l.cell as lead_cell, l.id as lead_id,
      l.assigned_to, la.full_name as lead_assigned_name
    FROM lead_followups lf
    JOIN leads l ON l.id = lf.lead_id
    LEFT JOIN users la ON la.id = l.assigned_to
    WHERE lf.org_id=? AND lf.next_followup_date IS NOT NULL
      AND l.status != 'converted'
    ORDER BY lf.next_followup_date ASC
  `, [req.orgId]);
  res.json(followups);
});

module.exports = router;
