// routes/whatsapp.js — WhatsApp Business broadcasting via Twilio
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');

router.use(requireAuth, requireOrg);

// ── Helper: get Twilio client for this org ─────────────────────────────────────
function getTwilio(orgId) {
  const s = get('SELECT * FROM whatsapp_settings WHERE org_id=?', [orgId]);
  if (!s?.account_sid || !s?.auth_token) return null;
  const twilio = require('twilio');
  return { client: twilio(s.account_sid, s.auth_token), from: s.from_number, settings: s };
}

// Normalize phone: strip non-digits, add + prefix
function normalizePhone(raw) {
  const digits = String(raw||'').replace(/\D/g,'');
  if (!digits) return null;
  return digits.startsWith('1') && digits.length===11 ? `+${digits}` :
         digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

// ── Settings ───────────────────────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  const s = get('SELECT account_sid, from_number, updated_at FROM whatsapp_settings WHERE org_id=?', [req.orgId]);
  res.json(s || {});
});

router.put('/settings', requireOrgAdmin, (req, res) => {
  const { account_sid, auth_token, from_number } = req.body;
  const ex = get('SELECT id FROM whatsapp_settings WHERE org_id=?', [req.orgId]);
  if (ex) {
    const newToken = auth_token || get('SELECT auth_token FROM whatsapp_settings WHERE org_id=?', [req.orgId])?.auth_token;
    run('UPDATE whatsapp_settings SET account_sid=?,auth_token=?,from_number=?,updated_at=CURRENT_TIMESTAMP WHERE org_id=?',
      [account_sid, newToken, from_number, req.orgId]);
  } else {
    run('INSERT INTO whatsapp_settings (id,org_id,account_sid,auth_token,from_number) VALUES (?,?,?,?,?)',
      [uuidv4(), req.orgId, account_sid, auth_token||'', from_number||'']);
  }
  res.json({ success: true });
});

// Test connection
router.post('/settings/test', requireOrgAdmin, async (req, res) => {
  const tw = getTwilio(req.orgId);
  if (!tw) return res.status(400).json({ error: 'Twilio not configured. Enter Account SID, Auth Token and WhatsApp number first.' });
  try {
    const account = await tw.client.api.accounts(tw.settings.account_sid).fetch();
    res.json({ success: true, account_name: account.friendlyName, status: account.status });
  } catch(e) {
    res.status(400).json({ error: `Twilio error: ${e.message}` });
  }
});

// ── Groups ─────────────────────────────────────────────────────────────────────
router.get('/groups', (req, res) => {
  const groups = all(`
    SELECT g.*, COUNT(c.id) as contact_count
    FROM whatsapp_groups g
    LEFT JOIN whatsapp_contacts c ON c.group_id=g.id AND c.opted_in=1
    WHERE g.org_id=?
    GROUP BY g.id ORDER BY g.name`, [req.orgId]);
  res.json(groups);
});

router.post('/groups', requireOrgAdmin, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uuidv4();
  run('INSERT INTO whatsapp_groups (id,org_id,name,description) VALUES (?,?,?,?)',
    [id, req.orgId, name, description||'']);
  res.json({ success: true, group: get('SELECT * FROM whatsapp_groups WHERE id=?', [id]) });
});

router.put('/groups/:id', requireOrgAdmin, (req, res) => {
  const { name, description } = req.body;
  run('UPDATE whatsapp_groups SET name=?,description=? WHERE id=? AND org_id=?',
    [name, description||'', req.params.id, req.orgId]);
  res.json({ success: true });
});

router.delete('/groups/:id', requireOrgAdmin, (req, res) => {
  run('DELETE FROM whatsapp_contacts WHERE group_id=? AND org_id=?', [req.params.id, req.orgId]);
  run('DELETE FROM whatsapp_groups WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

// ── Contacts ───────────────────────────────────────────────────────────────────
router.get('/groups/:gid/contacts', (req, res) => {
  res.json(all('SELECT * FROM whatsapp_contacts WHERE group_id=? AND org_id=? ORDER BY name',
    [req.params.gid, req.orgId]));
});

router.post('/groups/:gid/contacts', requireOrgAdmin, (req, res) => {
  const { name, phone, donor_id } = req.body;
  const normalized = normalizePhone(phone);
  if (!name || !normalized) return res.status(400).json({ error: 'Name and valid phone required' });
  const id = uuidv4();
  try {
    run('INSERT INTO whatsapp_contacts (id,org_id,group_id,name,phone,donor_id) VALUES (?,?,?,?,?,?)',
      [id, req.orgId, req.params.gid, name, normalized, donor_id||null]);
    res.json({ success: true, contact: get('SELECT * FROM whatsapp_contacts WHERE id=?', [id]) });
  } catch(e) {
    if (e.message?.includes('UNIQUE')) return res.status(400).json({ error: 'This number is already in this group' });
    throw e;
  }
});

router.delete('/groups/:gid/contacts/:cid', requireOrgAdmin, (req, res) => {
  run('DELETE FROM whatsapp_contacts WHERE id=? AND group_id=? AND org_id=?',
    [req.params.cid, req.params.gid, req.orgId]);
  res.json({ success: true });
});

// Import donors into a group
router.post('/groups/:gid/import-donors', requireOrgAdmin, (req, res) => {
  const { neighborhood_id, label, all_donors } = req.body;
  let donors;
  if (all_donors) {
    donors = all(`SELECT id, first_name, last_name, cell, home_phone FROM donors WHERE org_id=? AND (cell IS NOT NULL OR home_phone IS NOT NULL)`, [req.orgId]);
  } else if (neighborhood_id) {
    donors = all(`SELECT id, first_name, last_name, cell, home_phone FROM donors WHERE org_id=? AND neighborhood_id=? AND (cell IS NOT NULL OR home_phone IS NOT NULL)`, [req.orgId, neighborhood_id]);
  } else if (label) {
    donors = all(`SELECT id, first_name, last_name, cell, home_phone FROM donors WHERE org_id=? AND labels LIKE ? AND (cell IS NOT NULL OR home_phone IS NOT NULL)`, [req.orgId, `%${label}%`]);
  } else {
    return res.status(400).json({ error: 'Specify all_donors, neighborhood_id, or label' });
  }

  let added = 0, skipped = 0;
  for (const d of donors) {
    const phone = normalizePhone(d.cell || d.home_phone);
    if (!phone) { skipped++; continue; }
    const name = `${d.first_name} ${d.last_name}`;
    try {
      run('INSERT OR IGNORE INTO whatsapp_contacts (id,org_id,group_id,name,phone,donor_id) VALUES (?,?,?,?,?,?)',
        [uuidv4(), req.orgId, req.params.gid, name, phone, d.id]);
      added++;
    } catch { skipped++; }
  }
  res.json({ success: true, added, skipped });
});

// Import from uploaded CSV/list
router.post('/groups/:gid/import-list', requireOrgAdmin, (req, res) => {
  const { contacts } = req.body; // [{name, phone}]
  if (!Array.isArray(contacts)) return res.status(400).json({ error: 'contacts array required' });
  let added = 0, skipped = 0, errors = [];
  for (const c of contacts) {
    const phone = normalizePhone(c.phone);
    if (!phone || !c.name?.trim()) { skipped++; continue; }
    try {
      run('INSERT OR IGNORE INTO whatsapp_contacts (id,org_id,group_id,name,phone) VALUES (?,?,?,?,?)',
        [uuidv4(), req.orgId, req.params.gid, c.name.trim(), phone]);
      added++;
    } catch(e) { errors.push(c.name); skipped++; }
  }
  res.json({ success: true, added, skipped, errors });
});

// ── Broadcasts ─────────────────────────────────────────────────────────────────
router.get('/broadcasts', (req, res) => {
  res.json(all(`
    SELECT b.*, g.name as group_name
    FROM whatsapp_broadcasts b
    LEFT JOIN whatsapp_groups g ON b.group_id=g.id
    WHERE b.org_id=? ORDER BY b.created_at DESC`, [req.orgId]));
});

router.post('/broadcasts', requireOrgAdmin, (req, res) => {
  const { name, message, group_id, scheduled_at } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });
  const id = uuidv4();
  // Count recipients
  let total = 0;
  if (group_id) {
    total = get('SELECT COUNT(*) as n FROM whatsapp_contacts WHERE group_id=? AND org_id=? AND opted_in=1',
      [group_id, req.orgId])?.n || 0;
  }
  run(`INSERT INTO whatsapp_broadcasts (id,org_id,name,message,group_id,status,total,scheduled_at,created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, req.orgId, name||'Broadcast '+new Date().toLocaleDateString(), message, group_id||null,
     scheduled_at ? 'scheduled' : 'draft', total, scheduled_at||null, req.user.id]);
  res.json({ success: true, broadcast: get('SELECT * FROM whatsapp_broadcasts WHERE id=?', [id]) });
});

// Send a broadcast now
router.post('/broadcasts/:id/send', requireOrgAdmin, async (req, res) => {
  const b = get('SELECT * FROM whatsapp_broadcasts WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!b) return res.status(404).json({ error: 'Broadcast not found' });
  if (b.status === 'sent') return res.status(400).json({ error: 'Already sent' });

  const tw = getTwilio(req.orgId);
  if (!tw) return res.status(400).json({ error: 'Twilio not configured. Go to WhatsApp Settings.' });

  // Get contacts
  let contacts;
  if (b.group_id) {
    contacts = all('SELECT * FROM whatsapp_contacts WHERE group_id=? AND org_id=? AND opted_in=1',
      [b.group_id, req.orgId]);
  } else {
    return res.status(400).json({ error: 'No group selected for this broadcast' });
  }

  if (!contacts.length) return res.status(400).json({ error: 'No contacts in this group' });

  // Mark as sending
  run('UPDATE whatsapp_broadcasts SET status=?,total=?,sent_at=CURRENT_TIMESTAMP WHERE id=?',
    ['sending', contacts.length, b.id]);

  // Respond immediately, send in background
  res.json({ success: true, total: contacts.length, broadcast_id: b.id });

  // Send messages (background, don't await from handler)
  setImmediate(async () => {
    let sent = 0, failed = 0;
    for (const contact of contacts) {
      const msgId = uuidv4();
      const toWa = `whatsapp:${contact.phone}`;
      try {
        const msg = await tw.client.messages.create({
          from: tw.from.startsWith('whatsapp:') ? tw.from : `whatsapp:${tw.from}`,
          to: toWa,
          body: b.message
        });
        run(`INSERT INTO whatsapp_messages (id,org_id,broadcast_id,contact_id,to_number,to_name,body,status,twilio_sid,sent_at)
             VALUES (?,?,?,?,?,?,?,'sent',?,CURRENT_TIMESTAMP)`,
          [msgId, req.orgId, b.id, contact.id, contact.phone, contact.name, b.message, msg.sid]);
        sent++;
      } catch(e) {
        run(`INSERT INTO whatsapp_messages (id,org_id,broadcast_id,contact_id,to_number,to_name,body,status,error,sent_at)
             VALUES (?,?,?,?,?,?,?,'failed',?,CURRENT_TIMESTAMP)`,
          [msgId, req.orgId, b.id, contact.id, contact.phone, contact.name, b.message, e.message]);
        failed++;
        console.error(`[whatsapp] Failed to ${contact.phone}: ${e.message}`);
      }
      // Small delay to avoid Twilio rate limits
      await new Promise(r => setTimeout(r, 50));
    }
    run('UPDATE whatsapp_broadcasts SET status=?,sent=?,failed=? WHERE id=?',
      ['sent', sent, failed, b.id]);
    console.log(`[whatsapp] Broadcast ${b.id} done: ${sent} sent, ${failed} failed`);
  });
});

// Get broadcast message log
router.get('/broadcasts/:id/messages', (req, res) => {
  res.json(all(`
    SELECT * FROM whatsapp_messages WHERE broadcast_id=? AND org_id=?
    ORDER BY sent_at DESC`, [req.params.id, req.orgId]));
});

// Delete broadcast (draft only)
router.delete('/broadcasts/:id', requireOrgAdmin, (req, res) => {
  const b = get('SELECT status FROM whatsapp_broadcasts WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!b) return res.status(404).json({ error: 'Not found' });
  if (b.status === 'sent' || b.status === 'sending') return res.status(400).json({ error: 'Cannot delete a sent broadcast' });
  run('DELETE FROM whatsapp_broadcasts WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  res.json({ success: true });
});

module.exports = router;
