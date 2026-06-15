// db/schema.js - Full DRM database schema using sql.js with file persistence
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'drm.db');

let db = null;
let SQL = null;

function saveDb() {
  if (db && SQL) {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }
}

async function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');

  createTables();
  runMigrations();
  seedSolaKey();
  saveDb();

  // Auto-save every 30 seconds
  setInterval(saveDb, 30000);

  return db;
}

function getDb() {
  return db;
}

function createTables() {
  const statements = `

    -- Organizations (top-level accounts, like ticket system)
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      logo_url TEXT,
      plan TEXT DEFAULT 'starter',
      stripe_customer_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      settings TEXT DEFAULT '{}'
    );

    -- Users (can belong to multiple orgs)
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      is_super_admin INTEGER DEFAULT 0,
      last_login DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Org-User memberships
    CREATE TABLE IF NOT EXISTS org_users (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'staff',
      invited_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      UNIQUE(org_id, user_id)
    );

    -- Login audit log
    CREATE TABLE IF NOT EXISTS login_log (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      org_id TEXT,
      action TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Neighborhoods (per org, Hebrew names)
    CREATE TABLE IF NOT EXISTS neighborhoods (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name_he TEXT NOT NULL,
      name_en TEXT,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- Donors
    CREATE TABLE IF NOT EXISTS donors (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      title TEXT,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      hebrew_title TEXT,
      hebrew_full_name TEXT,
      cell TEXT,
      home_phone TEXT,
      email TEXT,
      neighborhood_id TEXT,
      street TEXT,
      apt TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      labels TEXT DEFAULT '[]',
      kvitel TEXT DEFAULT '',
      kvitel_enabled INTEGER DEFAULT 1,
      autopay_enabled INTEGER DEFAULT 0,
      autopay_day INTEGER DEFAULT 1,
      autopay_hour INTEGER DEFAULT 7,
      autopay_minute INTEGER DEFAULT 0,
      autopay_paused INTEGER DEFAULT 0,
      autopay_next_date DATETIME,
      donation_emails_paused INTEGER DEFAULT 0,
      marketing_emails_paused INTEGER DEFAULT 0,
      info_verified_at DATETIME,
      notes TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(neighborhood_id) REFERENCES neighborhoods(id)
    );

    -- Payment Methods per donor
    CREATE TABLE IF NOT EXISTS payment_methods (
      id TEXT PRIMARY KEY,
      donor_id TEXT NOT NULL,
      org_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('credit_card','daf','other')),
      label TEXT,
      last_four TEXT,
      card_brand TEXT,
      daf_name TEXT,
      other_description TEXT,
      sola_token TEXT,
      stripe_payment_method_id TEXT,
      is_default INTEGER DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(donor_id) REFERENCES donors(id)
    );

    -- Donations (manual + processed)
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      donor_id TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      method TEXT NOT NULL,
      payment_method_id TEXT,
      transaction_id TEXT,
      status TEXT DEFAULT 'completed' CHECK(status IN ('completed','pending','failed','scheduled','processing','refunded','partial_refund')),
      donation_date DATETIME NOT NULL,
      scheduled_date DATETIME,
      notes TEXT,
      donation_notes TEXT DEFAULT '[]',
      refund_amount REAL DEFAULT 0,
      refund_notes TEXT,
      is_manual INTEGER DEFAULT 0,
      is_autopay INTEGER DEFAULT 0,
      is_recurring INTEGER DEFAULT 0,
      receipt_sent INTEGER DEFAULT 0,
      failure_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_by TEXT,
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(donor_id) REFERENCES donors(id)
    );

    -- Recurring charge schedules (replaces one-time scheduled_charges for autopay)
    CREATE TABLE IF NOT EXISTS recurring_schedules (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      donor_id TEXT NOT NULL,
      payment_method_id TEXT NOT NULL,
      amount REAL NOT NULL,
      frequency TEXT NOT NULL CHECK(frequency IN ('weekly','biweekly','monthly','quarterly','yearly','once')),
      start_date DATETIME NOT NULL,
      next_run DATETIME,
      end_date DATETIME,
      occurrences_limit INTEGER,
      occurrences_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','completed','cancelled')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_run DATETIME,
      last_failure TEXT,
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(donor_id) REFERENCES donors(id)
    );

    -- Scheduled charges (one-time future charges)
    CREATE TABLE IF NOT EXISTS scheduled_charges (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      donor_id TEXT NOT NULL,
      payment_method_id TEXT NOT NULL,
      amount REAL NOT NULL,
      scheduled_for DATETIME NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','completed','failed','cancelled')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      failure_reason TEXT,
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(donor_id) REFERENCES donors(id)
    );

    -- Email settings per org
    CREATE TABLE IF NOT EXISTS email_settings (
      id TEXT PRIMARY KEY,
      org_id TEXT UNIQUE NOT NULL,
      smtp_email TEXT,
      smtp_password TEXT,
      smtp_host TEXT DEFAULT 'smtp.gmail.com',
      smtp_port INTEGER DEFAULT 587,
      from_name TEXT,
      receipt_template TEXT DEFAULT '',
      marketing_template TEXT DEFAULT '',
      donation_emails_paused INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- Scheduled emails
    CREATE TABLE IF NOT EXISTS scheduled_emails (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      donor_id TEXT,
      subject TEXT NOT NULL,
      html_body TEXT NOT NULL,
      scheduled_for DATETIME NOT NULL,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','sent','failed','cancelled')),
      sent_at DATETIME,
      failure_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- Chase bank connections per org
    CREATE TABLE IF NOT EXISTS bank_connections (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      bank_name TEXT DEFAULT 'Chase',
      api_key TEXT,
      api_secret TEXT,
      access_token TEXT,
      account_ids TEXT DEFAULT '[]',
      last_sync DATETIME,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- Bank transactions (imported)
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      bank_connection_id TEXT NOT NULL,
      external_id TEXT UNIQUE,
      amount REAL NOT NULL,
      direction TEXT CHECK(direction IN ('credit','debit')),
      description TEXT,
      merchant TEXT,
      category TEXT,
      transaction_date DATETIME NOT NULL,
      account_id TEXT,
      account_name TEXT,
      label TEXT,
      linked_donor_id TEXT,
      linked_donation_id TEXT,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- Sola payment processor settings per org
    CREATE TABLE IF NOT EXISTS sola_settings (
      id TEXT PRIMARY KEY,
      org_id TEXT UNIQUE NOT NULL,
      api_key TEXT,
      merchant_id TEXT,
      is_active INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- DAF accounts
    CREATE TABLE IF NOT EXISTS daf_accounts (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      name TEXT NOT NULL,
      account_number TEXT,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      notes TEXT,
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- Kvitel print settings per org
    CREATE TABLE IF NOT EXISTS kvitel_settings (
      id TEXT PRIMARY KEY,
      org_id TEXT UNIQUE NOT NULL,
      header_html TEXT DEFAULT '',
      header_font TEXT DEFAULT 'Frank Ruhl Libre',
      header_size REAL DEFAULT 18,
      header_bold INTEGER DEFAULT 1,
      header_align TEXT DEFAULT 'center',
      header_dir TEXT DEFAULT 'rtl',
      page_size TEXT DEFAULT 'letter',
      columns INTEGER DEFAULT 2,
      column_gap REAL DEFAULT 0.5,
      font_family TEXT DEFAULT 'Noto Sans Hebrew',
      font_size REAL DEFAULT 12,
      line_height REAL DEFAULT 1.6,
      margin_top REAL DEFAULT 1,
      margin_bottom REAL DEFAULT 1,
      margin_left REAL DEFAULT 1,
      margin_right REAL DEFAULT 1,
      group_by_neighborhood INTEGER DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(org_id) REFERENCES organizations(id)
    );

    -- Failed charge reports
    CREATE TABLE IF NOT EXISTS charge_failures (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL,
      donor_id TEXT NOT NULL,
      donation_id TEXT,
      scheduled_charge_id TEXT,
      amount REAL NOT NULL,
      failure_reason TEXT,
      payment_method_id TEXT,
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      acknowledged INTEGER DEFAULT 0,
      acknowledged_at DATETIME,
      acknowledged_by TEXT,
      FOREIGN KEY(org_id) REFERENCES organizations(id),
      FOREIGN KEY(donor_id) REFERENCES donors(id)
    );
  `;

  statements.split(';').forEach(stmt => {
    const s = stmt.trim();
    if (s) {
      try { db.run(s + ';'); } catch(e) { /* table exists */ }
    }
  });
}

function runMigrations() {
  const migrations = [
    `ALTER TABLE donations ADD COLUMN donation_notes TEXT DEFAULT '[]'`,
    `ALTER TABLE donations ADD COLUMN refund_amount REAL DEFAULT 0`,
    `ALTER TABLE donations ADD COLUMN refund_notes TEXT`,
    `ALTER TABLE donations ADD COLUMN is_recurring INTEGER DEFAULT 0`,
    `ALTER TABLE payment_methods ADD COLUMN sola_token TEXT`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_font TEXT DEFAULT 'Frank Ruhl Libre'`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_size REAL DEFAULT 18`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_bold INTEGER DEFAULT 1`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_align TEXT DEFAULT 'center'`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_dir TEXT DEFAULT 'rtl'`,
  ];
  for (const m of migrations) {
    try { db.run(m); } catch(e) { /* column already exists */ }
  }
}

// Query helpers
function seedSolaKey() {
  // If SOLA_API_KEY env var is set, ensure it's stored in every org's sola_settings
  const key = process.env.SOLA_API_KEY;
  if (!key) return;
  const orgs = all('SELECT id FROM organizations', []);
  for (const org of orgs) {
    const existing = get('SELECT id FROM sola_settings WHERE org_id = ?', [org.id]);
    if (!existing) {
      db.run('INSERT INTO sola_settings (id, org_id, api_key, is_active) VALUES (?, ?, ?, 1)',
        [require('crypto').randomUUID(), org.id, key]);
    } else {
      db.run('UPDATE sola_settings SET api_key = ?, is_active = 1 WHERE org_id = ?', [key, org.id]);
    }
  }
}

// Query helpers
function all(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  } catch (e) {
    console.error('DB all error:', e.message, sql);
    return [];
  }
}

function get(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    stmt.bind(params);
    let row = null;
    if (stmt.step()) row = stmt.getAsObject();
    stmt.free();
    return row;
  } catch (e) {
    console.error('DB get error:', e.message, sql);
    return null;
  }
}

function run(sql, params = []) {
  try {
    db.run(sql, params);
    saveDb();
    return { changes: db.getRowsModified() };
  } catch (e) {
    console.error('DB run error:', e.message, sql);
    throw e;
  }
}

module.exports = { initDb, getDb, all, get, run, saveDb };
