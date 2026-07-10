// routes/recovery.js — reads corrupted DB and imports data into live DB
// Only accessible by super admin
'use strict';
const express   = require('express');
const router    = express.Router();
const path      = require('path');
const fs        = require('fs');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { all, get, run } = require('../db/schema');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');

function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  next();
}

// Find corrupted DB files on disk
router.get('/files', requireAuth, requireSuperAdmin, (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter(f => f.includes('.corrupted') || (f.endsWith('.db') && f !== 'drm.db'))
      .map(f => {
        const fp = path.join(DATA_DIR, f);
        const stat = fs.statSync(fp);
        return { name: f, size: stat.size, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ files, data_dir: DATA_DIR });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Preview what's in a corrupted DB file
router.get('/preview/:filename', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const data = fs.readFileSync(filepath);
    const corruptDb = new SQL.Database(data);

    const counts = {};
    const tables = ['users','organizations','donors','donations','payment_methods',
      'recurring_schedules','email_settings','neighborhoods','expenses',
      'email_templates','org_label_lists','whatsapp_settings','charge_failures',
      'kvitel_settings','sola_settings'];

    for (const t of tables) {
      try {
        const r = corruptDb.exec(`SELECT COUNT(*) as n FROM ${t}`);
        counts[t] = r[0]?.values[0]?.[0] || 0;
      } catch { counts[t] = 'error'; }
    }

    corruptDb.close();
    res.json({ counts, filename });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Import everything from corrupted DB into live DB
router.post('/import/:filename', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, '');
    const filepath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found' });

    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const data = fs.readFileSync(filepath);
    const old = new SQL.Database(data);
    const results = {};

    function oldAll(sql) {
      try {
        const stmt = old.prepare(sql);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      } catch { return []; }
    }

    // Helper: insert ignoring duplicates
    function safeRun(sql, params) {
      try { run(sql, params); return true; }
      catch { return false; }
    }

    // 1. Organizations
    const orgs = oldAll('SELECT * FROM organizations');
    results.organizations = 0;
    for (const o of orgs) {
      if (safeRun('INSERT OR IGNORE INTO organizations (id,name,slug,settings,created_at,expires_at,expiry_warned) VALUES (?,?,?,?,?,?,?)',
        [o.id, o.name, o.slug, o.settings||'{}', o.created_at, o.expires_at||null, o.expiry_warned||0]))
        results.organizations++;
    }

    // 2. Users
    const users = oldAll('SELECT * FROM users');
    results.users = 0;
    for (const u of users) {
      if (safeRun('INSERT OR IGNORE INTO users (id,email,password_hash,full_name,role,is_super_admin,created_at,last_login) VALUES (?,?,?,?,?,?,?,?)',
        [u.id, u.email, u.password_hash, u.full_name, u.role||'admin', u.is_super_admin||0, u.created_at, u.last_login||null]))
        results.users++;
    }

    // 3. Org users
    const orgUsers = oldAll('SELECT * FROM org_users');
    results.org_users = 0;
    for (const ou of orgUsers) {
      if (safeRun('INSERT OR IGNORE INTO org_users (id,org_id,user_id,role,created_at) VALUES (?,?,?,?,?)',
        [ou.id, ou.org_id, ou.user_id, ou.role||'admin', ou.created_at]))
        results.org_users++;
    }

    // 4. Neighborhoods
    const nhs = oldAll('SELECT * FROM neighborhoods');
    results.neighborhoods = 0;
    for (const n of nhs) {
      if (safeRun('INSERT OR IGNORE INTO neighborhoods (id,org_id,name_he,name,sort_order,created_at) VALUES (?,?,?,?,?,?)',
        [n.id, n.org_id, n.name_he||'', n.name||'', n.sort_order||0, n.created_at]))
        results.neighborhoods++;
    }

    // 5. Donors
    const donors = oldAll('SELECT * FROM donors');
    results.donors = 0;
    for (const d of donors) {
      if (safeRun(`INSERT OR IGNORE INTO donors
        (id,org_id,title,first_name,last_name,hebrew_title,hebrew_full_name,neighborhood_id,
         cell,home_phone,email,street,apt,city,state,zip,labels,notes,kvitel,kvitel_enabled,
         autopay_enabled,autopay_paused,autopay_day,autopay_hour,autopay_minute,
         donation_emails_paused,marketing_emails_paused,info_verified_at,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d.id,d.org_id,d.title||null,d.first_name,d.last_name,d.hebrew_title||null,
         d.hebrew_full_name||null,d.neighborhood_id||null,d.cell||null,d.home_phone||null,
         d.email||null,d.street||null,d.apt||null,d.city||null,d.state||null,d.zip||null,
         d.labels||'[]',d.notes||null,d.kvitel||null,d.kvitel_enabled||0,
         d.autopay_enabled||0,d.autopay_paused||0,d.autopay_day||1,d.autopay_hour||9,
         d.autopay_minute||0,d.donation_emails_paused||0,d.marketing_emails_paused||0,
         d.info_verified_at||null,d.created_at]))
        results.donors++;
    }

    // 6. Payment methods
    const pms = oldAll('SELECT * FROM payment_methods');
    results.payment_methods = 0;
    for (const p of pms) {
      if (safeRun(`INSERT OR IGNORE INTO payment_methods
        (id,donor_id,org_id,type,label,sola_token,last_four,card_brand,daf_name,other_description,is_default,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [p.id,p.donor_id,p.org_id,p.type,p.label||null,p.sola_token||null,p.last_four||null,
         p.card_brand||null,p.daf_name||null,p.other_description||null,p.is_default||0,p.created_at]))
        results.payment_methods++;
    }

    // 7. Donations
    const donations = oldAll('SELECT * FROM donations');
    results.donations = 0;
    for (const d of donations) {
      if (safeRun(`INSERT OR IGNORE INTO donations
        (id,org_id,donor_id,amount,method,payment_method_id,transaction_id,status,label,
         donation_date,notes,donation_notes,refund_amount,refund_notes,
         is_manual,is_autopay,is_recurring,receipt_sent,failure_reason,created_at,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d.id,d.org_id,d.donor_id||null,d.amount,d.method,d.payment_method_id||null,
         d.transaction_id||null,d.status||'completed',d.label||null,d.donation_date,
         d.notes||null,d.donation_notes||'[]',d.refund_amount||0,d.refund_notes||null,
         d.is_manual||0,d.is_autopay||0,d.is_recurring||0,d.receipt_sent||0,
         d.failure_reason||null,d.created_at,d.created_by||null]))
        results.donations++;
    }

    // 8. Recurring schedules
    const recs = oldAll('SELECT * FROM recurring_schedules');
    results.recurring_schedules = 0;
    for (const r of recs) {
      if (safeRun(`INSERT OR IGNORE INTO recurring_schedules
        (id,org_id,donor_id,payment_method_id,amount,frequency,start_date,next_run,end_date,
         occurrences_limit,occurrences_count,status,notes,last_run,last_failure,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.id,r.org_id,r.donor_id,r.payment_method_id,r.amount,r.frequency,r.start_date,
         r.next_run||null,r.end_date||null,r.occurrences_limit||null,r.occurrences_count||0,
         r.status||'active',r.notes||null,r.last_run||null,r.last_failure||null,r.created_at]))
        results.recurring_schedules++;
    }

    // 9. Email settings
    const emailSettings = oldAll('SELECT * FROM email_settings');
    results.email_settings = 0;
    for (const e of emailSettings) {
      if (safeRun(`INSERT OR IGNORE INTO email_settings
        (id,org_id,smtp_email,smtp_password,smtp_host,smtp_port,from_name,
         receipt_template,marketing_template,donation_emails_paused,postmark_key,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [e.id,e.org_id,e.smtp_email||null,e.smtp_password||null,e.smtp_host||'smtp.gmail.com',
         e.smtp_port||587,e.from_name||null,e.receipt_template||'',e.marketing_template||'',
         e.donation_emails_paused||0,e.postmark_key||'',e.updated_at]))
        results.email_settings++;
    }

    // 10. Sola settings
    const solaSettings = oldAll('SELECT * FROM sola_settings');
    results.sola_settings = 0;
    for (const s of solaSettings) {
      if (safeRun('INSERT OR IGNORE INTO sola_settings (id,org_id,api_key,created_at) VALUES (?,?,?,?)',
        [s.id,s.org_id,s.api_key||null,s.created_at]))
        results.sola_settings++;
    }

    // 11. Expenses
    const expenses = oldAll('SELECT * FROM expenses');
    results.expenses = 0;
    for (const e of expenses) {
      if (safeRun('INSERT OR IGNORE INTO expenses (id,org_id,amount,category,description,expense_date,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',
        [e.id,e.org_id,e.amount,e.category||'Other',e.description||null,e.expense_date,e.created_by||null,e.created_at]))
        results.expenses++;
    }

    // 12. Kvitel settings
    const kvitel = oldAll('SELECT * FROM kvitel_settings');
    results.kvitel_settings = 0;
    for (const k of kvitel) {
      if (safeRun(`INSERT OR IGNORE INTO kvitel_settings
        (id,org_id,header_text,page_size,columns,column_gap,font_family,font_size,line_height,
         margin_top,margin_bottom,margin_left,margin_right,group_by_neighborhood,
         neighborhood_font,neighborhood_size,neighborhood_bold,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [k.id,k.org_id,k.header_text||'[]',k.page_size||'letter',k.columns||1,k.column_gap||0.5,
         k.font_family||'Noto Sans Hebrew',k.font_size||12,k.line_height||1.6,
         k.margin_top||1,k.margin_bottom||1,k.margin_left||1,k.margin_right||1,
         k.group_by_neighborhood!==undefined?k.group_by_neighborhood:1,
         k.neighborhood_font||'Frank Ruhl Libre',k.neighborhood_size||14,k.neighborhood_bold!==undefined?k.neighborhood_bold:1,
         k.updated_at]))
        results.kvitel_settings++;
    }

    // 13. Email templates
    const templates = oldAll('SELECT * FROM email_templates');
    results.email_templates = 0;
    for (const t of templates) {
      if (safeRun(`INSERT OR IGNORE INTO email_templates
        (id,org_id,name,description,subject,blocks,is_default_receipt,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [t.id,t.org_id,t.name,t.description||null,t.subject,t.blocks||'[]',
         t.is_default_receipt||0,t.created_at,t.updated_at]))
        results.email_templates++;
    }

    // 14. Label lists
    const labelLists = oldAll('SELECT * FROM org_label_lists');
    results.org_label_lists = 0;
    for (const l of labelLists) {
      if (safeRun('INSERT OR IGNORE INTO org_label_lists (id,org_id,donor_labels,donation_labels,updated_at) VALUES (?,?,?,?,?)',
        [l.id,l.org_id,l.donor_labels||'[]',l.donation_labels||'[]',l.updated_at]))
        results.org_label_lists++;
    }

    // 15. Charge failures
    const failures = oldAll('SELECT * FROM charge_failures');
    results.charge_failures = 0;
    for (const f of failures) {
      if (safeRun(`INSERT OR IGNORE INTO charge_failures
        (id,org_id,donor_id,amount,failure_reason,payment_method_id,acknowledged,acknowledged_at,occurred_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        [f.id,f.org_id,f.donor_id,f.amount||null,f.failure_reason||null,f.payment_method_id||null,
         f.acknowledged||0,f.acknowledged_at||null,f.occurred_at]))
        results.charge_failures++;
    }

    old.close();
    res.json({ success: true, results });
  } catch(e) {
    console.error('Recovery error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
