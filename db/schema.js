// db/schema.js — sql.js with synchronous disk write on every transaction
'use strict';
const initSqlJs = require('sql.js');
const path      = require('path');
const fs        = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH  = path.join(DATA_DIR, 'drm.db');

let db;

function saveDb() {
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch(e) {
    console.error('[db] saveDb error:', e.message);
  }
}

async function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    try {
      const data = fs.readFileSync(DB_PATH);
      db = new SQL.Database(data);
      db.run('PRAGMA foreign_keys=ON');
      // Quick integrity check
      const result = db.exec("PRAGMA integrity_check");
      const ok = result[0]?.values[0]?.[0] === 'ok';
      if (!ok) throw new Error('integrity check failed');
      console.log(`[db] Loaded DB from ${DB_PATH} (${data.length} bytes)`);
    } catch(e) {
      // Corrupted — move aside and start fresh
      const backup = `${DB_PATH}.corrupted.${Date.now()}`;
      console.error(`[db] Corrupted DB (${e.message}) — saving to ${backup} and starting fresh`);
      try { fs.renameSync(DB_PATH, backup); } catch {}
      const SQL2 = await initSqlJs();
      db = new SQL2.Database();
      db.run('PRAGMA foreign_keys=ON');
      console.log(`[db] Created fresh DB at ${DB_PATH}`);
    }
  } else {
    db = new SQL.Database();
    db.run('PRAGMA foreign_keys=ON');
    console.log(`[db] Created new DB at ${DB_PATH}`);
  }

  createTables();
  runMigrations();
  saveDb(); // initial save
  return db;
}

function run(sql, params = []) {
  try {
    db.run(sql, params);
    saveDb(); // write to disk immediately after every change
    return { changes: db.getRowsModified() };
  } catch(e) {
    console.error('DB run error:', e.message, '| SQL:', sql.slice(0,80));
    throw e;
  }
}

function get(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) {
      const row = stmt.getAsObject();
      stmt.free();
      return row;
    }
    stmt.free();
    return null;
  } catch(e) {
    console.error('DB get error:', e.message, '| SQL:', sql.slice(0,80));
    throw e;
  }
}

function all(sql, params = []) {
  try {
    const stmt  = db.prepare(sql);
    const rows  = [];
    stmt.bind(params);
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  } catch(e) {
    console.error('DB all error:', e.message, '| SQL:', sql.slice(0,80));
    throw e;
  }
}

function createTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      settings TEXT DEFAULT '{}', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME DEFAULT NULL, expiry_warned INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      full_name TEXT, role TEXT DEFAULT 'admin', is_super_admin INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_login DATETIME
    );
    CREATE TABLE IF NOT EXISTS org_users (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT DEFAULT 'admin', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS invite_tokens (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, token TEXT UNIQUE NOT NULL,
      org_id TEXT, expiry_date TEXT, used INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS login_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT,
      action TEXT, ip TEXT, user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS neighborhoods (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name_he TEXT, name TEXT,
      sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS donors (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      donor_number INTEGER,
      title TEXT, first_name TEXT, last_name TEXT,
      hebrew_title TEXT, hebrew_full_name TEXT, neighborhood_id TEXT,
      cell TEXT, home_phone TEXT, email TEXT,
      street TEXT, apt TEXT, city TEXT, state TEXT, zip TEXT,
      labels TEXT DEFAULT '[]',
      notes TEXT, kvitel TEXT, kvitel_enabled INTEGER DEFAULT 0, sola_customer_id TEXT,
      autopay_enabled INTEGER DEFAULT 0, autopay_paused INTEGER DEFAULT 0,
      autopay_day INTEGER DEFAULT 1, autopay_hour INTEGER DEFAULT 9, autopay_minute INTEGER DEFAULT 0,
      donation_emails_paused INTEGER DEFAULT 0, marketing_emails_paused INTEGER DEFAULT 0,
      info_verified_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS payment_methods (
      id TEXT PRIMARY KEY, donor_id TEXT NOT NULL, org_id TEXT NOT NULL,
      type TEXT NOT NULL, label TEXT, sola_token TEXT, last_four TEXT,
      card_brand TEXT, daf_name TEXT, other_description TEXT,
      is_default INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, donor_id TEXT,
      amount REAL NOT NULL, method TEXT NOT NULL, payment_method_id TEXT,
      transaction_id TEXT, status TEXT DEFAULT 'completed', label TEXT,
      donation_date DATETIME NOT NULL, notes TEXT,
      donation_notes TEXT DEFAULT '[]', labels TEXT DEFAULT '[]', refund_amount REAL DEFAULT 0, refund_notes TEXT,
      is_manual INTEGER DEFAULT 0, is_autopay INTEGER DEFAULT 0, is_recurring INTEGER DEFAULT 0,
      receipt_sent INTEGER DEFAULT 0, failure_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, created_by TEXT
    );
    CREATE TABLE IF NOT EXISTS recurring_schedules (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, donor_id TEXT NOT NULL,
      payment_method_id TEXT NOT NULL, amount REAL NOT NULL,
      frequency TEXT NOT NULL, start_date DATETIME NOT NULL,
      next_run DATETIME, end_date DATETIME,
      occurrences_limit INTEGER, occurrences_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active', notes TEXT,
      last_run DATETIME, last_failure TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS scheduled_charges (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, donor_id TEXT NOT NULL,
      payment_method_id TEXT NOT NULL, amount REAL NOT NULL,
      charge_date DATETIME NOT NULL, status TEXT DEFAULT 'pending',
      notes TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS charge_failures (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, donor_id TEXT NOT NULL,
      amount REAL, failure_reason TEXT, payment_method_id TEXT,
      acknowledged INTEGER DEFAULT 0, acknowledged_at DATETIME,
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_settings (
      id TEXT PRIMARY KEY, org_id TEXT UNIQUE NOT NULL,
      smtp_email TEXT, smtp_password TEXT, smtp_host TEXT DEFAULT 'smtp.gmail.com',
      smtp_port INTEGER DEFAULT 587, from_name TEXT,
      receipt_template TEXT DEFAULT '', marketing_template TEXT DEFAULT '',
      donation_emails_paused INTEGER DEFAULT 0, postmark_key TEXT DEFAULT '', brevo_api_key TEXT DEFAULT '',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS scheduled_emails (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      subject TEXT NOT NULL, html_body TEXT, template_id TEXT,
      scheduled_for DATETIME NOT NULL, status TEXT DEFAULT 'pending',
      sent_at DATETIME, recipient_group TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sola_settings (
      id TEXT PRIMARY KEY, org_id TEXT UNIQUE NOT NULL,
      api_key TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS kvitel_settings (
      id TEXT PRIMARY KEY, org_id TEXT UNIQUE NOT NULL,
      header_text TEXT DEFAULT '[]',
      page_size TEXT DEFAULT 'letter', columns INTEGER DEFAULT 1,
      column_gap REAL DEFAULT 0.5, font_family TEXT DEFAULT 'Noto Sans Hebrew',
      font_size REAL DEFAULT 12, line_height REAL DEFAULT 1.6,
      margin_top REAL DEFAULT 1, margin_bottom REAL DEFAULT 1,
      margin_left REAL DEFAULT 1, margin_right REAL DEFAULT 1,
      group_by_neighborhood INTEGER DEFAULT 1,
      neighborhood_font TEXT DEFAULT 'Frank Ruhl Libre',
      neighborhood_size REAL DEFAULT 14, neighborhood_bold INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_templates (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT,
      subject TEXT NOT NULL, blocks TEXT DEFAULT '[]',
      is_default_receipt INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      to_email TEXT NOT NULL, subject TEXT NOT NULL,
      html_body TEXT, type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent',
      error TEXT, donor_id TEXT, donation_id TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      amount REAL NOT NULL, category TEXT DEFAULT 'Other',
      description TEXT, expense_date DATE NOT NULL,
      created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bank_connections (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      provider TEXT, api_key TEXT, api_secret TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, connection_id TEXT,
      amount REAL, description TEXT, transaction_date DATE,
      label TEXT, linked_donor_id TEXT, linked_donation_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS org_label_lists (
      id TEXT PRIMARY KEY, org_id TEXT UNIQUE NOT NULL,
      donor_labels TEXT DEFAULT '[]',
      donation_labels TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id TEXT PRIMARY KEY, org_id TEXT UNIQUE NOT NULL,
      account_sid TEXT, auth_token TEXT, from_number TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_groups (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_contacts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      group_id TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
      donor_id TEXT, opted_in INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_broadcasts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      name TEXT, message TEXT NOT NULL, group_id TEXT,
      status TEXT DEFAULT 'draft', total INTEGER DEFAULT 0,
      sent INTEGER DEFAULT 0, failed INTEGER DEFAULT 0,
      scheduled_at DATETIME, sent_at DATETIME,
      created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      broadcast_id TEXT NOT NULL, contact_id TEXT,
      to_number TEXT NOT NULL, to_name TEXT, body TEXT NOT NULL,
      status TEXT DEFAULT 'pending', twilio_sid TEXT, error TEXT,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Import history
    CREATE TABLE IF NOT EXISTS import_history (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      imported_by TEXT NOT NULL, type TEXT DEFAULT 'donors',
      total_rows INTEGER DEFAULT 0, imported INTEGER DEFAULT 0,
      flagged INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
      filename TEXT, status TEXT DEFAULT 'completed',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Import items (donors created by an import)
    CREATE TABLE IF NOT EXISTS import_items (
      id TEXT PRIMARY KEY, import_id TEXT NOT NULL,
      donor_id TEXT NOT NULL, was_flagged INTEGER DEFAULT 0,
      flag_reasons TEXT
    );

    -- Donor duplicates
    CREATE TABLE IF NOT EXISTS donor_duplicates (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      donor_id_a TEXT NOT NULL, donor_id_b TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      resolved_by TEXT, resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(donor_id_a, donor_id_b)
    );

    -- Leads
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      donor_number INTEGER,
      title TEXT, first_name TEXT, last_name TEXT,
      hebrew_title TEXT, hebrew_full_name TEXT,
      email TEXT, cell TEXT, home_phone TEXT,
      street TEXT, apt TEXT, city TEXT, state TEXT, zip TEXT,
      neighborhood_id TEXT, labels TEXT DEFAULT '[]',
      category TEXT, notes TEXT,
      assigned_to TEXT,
      status TEXT DEFAULT 'new',
      converted_donor_id TEXT,
      created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Lead follow-ups
    CREATE TABLE IF NOT EXISTS lead_followups (
      id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, org_id TEXT NOT NULL,
      notes TEXT NOT NULL,
      next_followup_date DATE,
      done_by TEXT NOT NULL,
      done_by_name TEXT,
      notified INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Lead categories (per org)
    CREATE TABLE IF NOT EXISTS lead_categories (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      name TEXT NOT NULL, color TEXT DEFAULT '#6366f1',
      sort_order INTEGER DEFAULT 0
    );

    -- User page permissions
    CREATE TABLE IF NOT EXISTS user_permissions (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      page TEXT NOT NULL, can_view INTEGER DEFAULT 1, can_edit INTEGER DEFAULT 1,
      UNIQUE(org_id, user_id, page)
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      user_id TEXT NOT NULL, type TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT,
      link TEXT, is_read INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Super admin org access log
    CREATE TABLE IF NOT EXISTS super_admin_access (
      id TEXT PRIMARY KEY, super_admin_id TEXT NOT NULL,
      org_id TEXT NOT NULL, granted_by TEXT,
      purpose TEXT, accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function runMigrations() {
  const safe = (sql) => { try { db.run(sql); saveDb(); } catch(e) { /* already exists */ } };

  // Remove NOT NULL from first_name/last_name to allow partial imports
  // SQLite requires table recreation to drop NOT NULL constraints
  try {
    const col = db.exec("PRAGMA table_info(donors)");
    const cols = col[0]?.values || [];
    const fnCol = cols.find(c => c[1] === 'first_name');
    // If first_name is NOT NULL (notnull=1), recreate the table without that constraint
    if (fnCol && fnCol[3] === 1) {
      db.run(`CREATE TABLE IF NOT EXISTS donors_new (
        id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
        title TEXT, first_name TEXT, last_name TEXT,
        hebrew_title TEXT, hebrew_full_name TEXT, neighborhood_id TEXT,
        cell TEXT, home_phone TEXT, email TEXT,
        street TEXT, apt TEXT, city TEXT, state TEXT, zip TEXT,
        labels TEXT DEFAULT '[]',
        notes TEXT, kvitel TEXT, kvitel_enabled INTEGER DEFAULT 0,
        autopay_enabled INTEGER DEFAULT 0, autopay_paused INTEGER DEFAULT 0,
        autopay_day INTEGER DEFAULT 1, autopay_hour INTEGER DEFAULT 9, autopay_minute INTEGER DEFAULT 0,
        donation_emails_paused INTEGER DEFAULT 0, marketing_emails_paused INTEGER DEFAULT 0,
        info_verified_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
      db.run(`INSERT INTO donors_new SELECT * FROM donors`);
      db.run(`DROP TABLE donors`);
      db.run(`ALTER TABLE donors_new RENAME TO donors`);
      saveDb();
      console.log('[db] Migration: removed NOT NULL from donors.first_name and donors.last_name');
    }
  } catch(e) { console.error('[db] Migration error (donors NOT NULL):', e.message); }
  safe("ALTER TABLE donors ADD COLUMN autopay_minute INTEGER DEFAULT 0");
  safe("ALTER TABLE donors ADD COLUMN hebrew_title TEXT");
  safe("ALTER TABLE donations ADD COLUMN label TEXT");
  safe("ALTER TABLE email_settings ADD COLUMN postmark_key TEXT DEFAULT ''");
  safe("ALTER TABLE organizations ADD COLUMN expires_at DATETIME DEFAULT NULL");
  safe("ALTER TABLE organizations ADD COLUMN expiry_warned INTEGER DEFAULT 0");
  safe("ALTER TABLE kvitel_settings ADD COLUMN neighborhood_font TEXT DEFAULT 'Frank Ruhl Libre'");
  safe("ALTER TABLE kvitel_settings ADD COLUMN neighborhood_size REAL DEFAULT 14");
  safe("ALTER TABLE kvitel_settings ADD COLUMN neighborhood_bold INTEGER DEFAULT 1");
  safe("ALTER TABLE donors ADD COLUMN sola_customer_id TEXT");
  safe("ALTER TABLE donors ADD COLUMN donor_number INTEGER");
  safe("ALTER TABLE leads ADD COLUMN donor_number INTEGER");
  safe("ALTER TABLE donations ADD COLUMN labels TEXT DEFAULT '[]'");
  safe("ALTER TABLE email_settings ADD COLUMN brevo_api_key TEXT DEFAULT ''");
  // Invite permissions column
  safe("ALTER TABLE org_users ADD COLUMN permissions TEXT DEFAULT '{}'");
  safe("ALTER TABLE org_users ADD COLUMN invited_by TEXT");
  // New tables — add as migrations since DB already exists
  try { db.run(`CREATE TABLE IF NOT EXISTS import_history (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
    imported_by TEXT NOT NULL, type TEXT DEFAULT 'donors',
    total_rows INTEGER DEFAULT 0, imported INTEGER DEFAULT 0,
    flagged INTEGER DEFAULT 0, errors INTEGER DEFAULT 0,
    filename TEXT, status TEXT DEFAULT 'completed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS import_items (
    id TEXT PRIMARY KEY, import_id TEXT NOT NULL,
    donor_id TEXT NOT NULL, was_flagged INTEGER DEFAULT 0,
    flag_reasons TEXT
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS donor_duplicates (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
    donor_id_a TEXT NOT NULL, donor_id_b TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    resolved_by TEXT, resolved_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(donor_id_a, donor_id_b)
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
    title TEXT, first_name TEXT, last_name TEXT,
    hebrew_title TEXT, hebrew_full_name TEXT,
    email TEXT, cell TEXT, home_phone TEXT,
    street TEXT, apt TEXT, city TEXT, state TEXT, zip TEXT,
    neighborhood_id TEXT, labels TEXT DEFAULT '[]',
    category TEXT, notes TEXT, assigned_to TEXT,
    status TEXT DEFAULT 'new', converted_donor_id TEXT,
    created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS lead_followups (
    id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, org_id TEXT NOT NULL,
    notes TEXT NOT NULL, next_followup_date DATE,
    done_by TEXT NOT NULL, done_by_name TEXT,
    notified INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS lead_categories (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
    name TEXT NOT NULL, color TEXT DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS user_permissions (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
    page TEXT NOT NULL, can_view INTEGER DEFAULT 1, can_edit INTEGER DEFAULT 1,
    UNIQUE(org_id, user_id, page)
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
    user_id TEXT NOT NULL, type TEXT NOT NULL,
    title TEXT NOT NULL, body TEXT, link TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS super_admin_access (
    id TEXT PRIMARY KEY, super_admin_id TEXT NOT NULL,
    org_id TEXT NOT NULL, granted_by TEXT,
    purpose TEXT, status TEXT DEFAULT 'pending',
    accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); saveDb(); } catch(e) {}
  try { db.run(`CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY, super_admin_id TEXT NOT NULL,
    super_admin_name TEXT, org_id TEXT NOT NULL,
    purpose TEXT, status TEXT DEFAULT 'pending',
    token TEXT, granted_by TEXT, expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`); saveDb(); } catch(e) {}
  try { db.run(`ALTER TABLE access_requests ADD COLUMN granted_by TEXT`); saveDb(); } catch(e) {}
  // Verify column exists
  try {
    const cols = db.exec("PRAGMA table_info(email_settings)");
    const hasBrevo = cols[0]?.values?.some(c => c[1] === 'brevo_api_key');
    console.log('[db] email_settings.brevo_api_key column:', hasBrevo ? 'EXISTS' : 'MISSING');
  } catch(e) {}
}

module.exports = { initDb, all, get, run, saveDb };
