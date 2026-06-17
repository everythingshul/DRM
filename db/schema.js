const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'drm.db');
let db = null;

function saveDb() {
  if (db) fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

async function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();
  db.run('PRAGMA foreign_keys=ON');
  createTables();
  runMigrations();
  saveDb();
  setInterval(saveDb, 30000);
  return db;
}

function createTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
      plan TEXT DEFAULT 'starter', settings TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL, role TEXT DEFAULT 'admin', is_super_admin INTEGER DEFAULT 0,
      last_login DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS org_users (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, user_id TEXT NOT NULL,
      role TEXT DEFAULT 'staff', invited_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(org_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS login_log (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT, action TEXT NOT NULL,
      ip TEXT, user_agent TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS neighborhoods (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name_he TEXT NOT NULL,
      name_en TEXT, sort_order INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS donors (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      title TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      hebrew_title TEXT, hebrew_full_name TEXT,
      cell TEXT, home_phone TEXT, email TEXT,
      neighborhood_id TEXT, street TEXT, apt TEXT, city TEXT, state TEXT, zip TEXT,
      labels TEXT DEFAULT '[]', kvitel TEXT DEFAULT '', kvitel_enabled INTEGER DEFAULT 1,
      autopay_enabled INTEGER DEFAULT 0, autopay_paused INTEGER DEFAULT 0,
      autopay_day INTEGER DEFAULT 1, autopay_hour INTEGER DEFAULT 7, autopay_minute INTEGER DEFAULT 0,
      donation_emails_paused INTEGER DEFAULT 0, marketing_emails_paused INTEGER DEFAULT 0,
      info_verified_at DATETIME, notes TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS payment_methods (
      id TEXT PRIMARY KEY, donor_id TEXT NOT NULL, org_id TEXT NOT NULL,
      type TEXT NOT NULL, label TEXT, last_four TEXT, card_brand TEXT,
      daf_name TEXT, other_description TEXT, sola_token TEXT,
      is_default INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS donations (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, donor_id TEXT,
      amount REAL NOT NULL, method TEXT NOT NULL, payment_method_id TEXT,
      transaction_id TEXT, status TEXT DEFAULT 'completed',
      donation_date DATETIME NOT NULL, notes TEXT,
      donation_notes TEXT DEFAULT '[]', refund_amount REAL DEFAULT 0, refund_notes TEXT,
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
      scheduled_for DATETIME NOT NULL, status TEXT DEFAULT 'pending',
      notes TEXT, processed_at DATETIME, failure_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_settings (
      id TEXT PRIMARY KEY, org_id TEXT UNIQUE NOT NULL,
      smtp_email TEXT, smtp_password TEXT, smtp_host TEXT DEFAULT 'smtp.gmail.com',
      smtp_port INTEGER DEFAULT 587, from_name TEXT,
      receipt_template TEXT DEFAULT '', marketing_template TEXT DEFAULT '',
      donation_emails_paused INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS scheduled_emails (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, donor_id TEXT,
      subject TEXT NOT NULL, html_body TEXT NOT NULL,
      scheduled_for DATETIME NOT NULL, status TEXT DEFAULT 'pending',
      sent_at DATETIME, failure_reason TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sola_settings (
      id TEXT PRIMARY KEY, org_id TEXT UNIQUE NOT NULL,
      api_key TEXT, merchant_id TEXT, is_active INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS daf_accounts (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL,
      account_number TEXT, contact_name TEXT, contact_email TEXT,
      notes TEXT, is_active INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    CREATE TABLE IF NOT EXISTS charge_failures (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, donor_id TEXT NOT NULL,
      donation_id TEXT, scheduled_charge_id TEXT, amount REAL NOT NULL,
      failure_reason TEXT, payment_method_id TEXT,
      occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      acknowledged INTEGER DEFAULT 0, acknowledged_at DATETIME, acknowledged_by TEXT
    );
    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      amount REAL NOT NULL, category TEXT, description TEXT,
      expense_date DATE NOT NULL, created_by TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS email_templates (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL,
      name TEXT NOT NULL, description TEXT,
      subject TEXT NOT NULL, blocks TEXT DEFAULT '[]',
      is_default_receipt INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bank_connections (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, bank_name TEXT DEFAULT 'Chase',
      api_key TEXT, api_secret TEXT, last_sync DATETIME, is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS bank_transactions (
      id TEXT PRIMARY KEY, org_id TEXT NOT NULL, bank_connection_id TEXT,
      external_id TEXT UNIQUE, amount REAL NOT NULL, direction TEXT,
      description TEXT, merchant TEXT, transaction_date DATETIME NOT NULL,
      label TEXT, linked_donor_id TEXT, linked_donation_id TEXT,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;
  sql.split(';').forEach(s => { const t = s.trim(); if (t) try { db.run(t+';'); } catch(e){} });
}

function runMigrations() {
  const migrations = [
    `ALTER TABLE donations ADD COLUMN donation_notes TEXT DEFAULT '[]'`,
    `ALTER TABLE donations ADD COLUMN refund_amount REAL DEFAULT 0`,
    `ALTER TABLE donations ADD COLUMN refund_notes TEXT`,
    `ALTER TABLE donations ADD COLUMN is_recurring INTEGER DEFAULT 0`,
    `ALTER TABLE payment_methods ADD COLUMN sola_token TEXT`,
    `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'admin'`,
    `ALTER TABLE email_settings ADD COLUMN marketing_template TEXT DEFAULT ''`,
    `ALTER TABLE organizations ADD COLUMN settings TEXT DEFAULT '{}'`,
    `ALTER TABLE donors ADD COLUMN autopay_minute INTEGER DEFAULT 0`,
    `ALTER TABLE kvitel_settings ADD COLUMN neighborhood_font TEXT DEFAULT 'Frank Ruhl Libre'`,
    `ALTER TABLE donations ADD COLUMN label TEXT`,
    `ALTER TABLE kvitel_settings ADD COLUMN neighborhood_size REAL DEFAULT 14`,
    `ALTER TABLE kvitel_settings ADD COLUMN neighborhood_bold INTEGER DEFAULT 1`,
    `CREATE TABLE IF NOT EXISTS email_templates (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, subject TEXT NOT NULL, blocks TEXT DEFAULT '[]', is_default_receipt INTEGER DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_text TEXT DEFAULT ''`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_font TEXT DEFAULT 'Frank Ruhl Libre'`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_size REAL DEFAULT 18`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_bold INTEGER DEFAULT 1`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_align TEXT DEFAULT 'center'`,
    `ALTER TABLE kvitel_settings ADD COLUMN header_dir TEXT DEFAULT 'rtl'`,
  ];
  migrations.forEach(m => { try { db.run(m); } catch(e){} });

  // Seed Sola key from env into all orgs
  const key = process.env.SOLA_API_KEY;
  if (key) {
    all('SELECT id FROM organizations', []).forEach(org => {
      const ex = get('SELECT id FROM sola_settings WHERE org_id=?', [org.id]);
      if (!ex) run('INSERT INTO sola_settings (id,org_id,api_key,is_active) VALUES (?,?,?,1)',
        [require('crypto').randomUUID(), org.id, key]);
      else run('UPDATE sola_settings SET api_key=?,is_active=1 WHERE org_id=?', [key, org.id]);
    });
  }
}

function all(sql, params=[]) {
  try {
    const st = db.prepare(sql); st.bind(params);
    const rows = []; while(st.step()) rows.push(st.getAsObject()); st.free(); return rows;
  } catch(e) { console.error('DB all:', e.message); return []; }
}
function get(sql, params=[]) {
  try {
    const st = db.prepare(sql); st.bind(params);
    let r = null; if(st.step()) r = st.getAsObject(); st.free(); return r;
  } catch(e) { console.error('DB get:', e.message); return null; }
}
function run(sql, params=[]) {
  try { db.run(sql, params); saveDb(); return { changes: db.getRowsModified() }; }
  catch(e) { console.error('DB run:', e.message); throw e; }
}

module.exports = { initDb, all, get, run, saveDb };
