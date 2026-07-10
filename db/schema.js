// db/schema.js — better-sqlite3 (writes directly to disk, no corruption risk)
'use strict';
const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../data');
const DB_PATH  = path.join(DATA_DIR, 'drm.db');

let db;

async function initDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const existed = fs.existsSync(DB_PATH);

  if (existed) {
    try {
      db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      console.log(`[db] Loaded DB at ${DB_PATH} (${fs.statSync(DB_PATH).size} bytes)`);
    } catch(e) {
      // Corrupted — move aside and start fresh rather than crashing
      const backup = `${DB_PATH}.corrupted.${Date.now()}`;
      console.error(`[db] Corrupted DB (${e.message}) — moving to ${backup} and starting fresh`);
      fs.renameSync(DB_PATH, backup);
      db = new Database(DB_PATH);
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      console.log(`[db] Created fresh DB at ${DB_PATH}`);
    }
  } else {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    console.log(`[db] Created new DB at ${DB_PATH}`);
  }

  createTables();
  runMigrations();
  return db;
}

// better-sqlite3 is synchronous — no saveDb() needed, writes happen on every run()
function saveDb() { /* no-op — better-sqlite3 writes directly to disk */ }

function run(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const info = stmt.run(params);
    return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
  } catch(e) {
    console.error('DB run error:', e.message, '| SQL:', sql.slice(0,80));
    throw e;
  }
}

function get(sql, params = []) {
  try {
    return db.prepare(sql).get(params);
  } catch(e) {
    console.error('DB get error:', e.message, '| SQL:', sql.slice(0,80));
    throw e;
  }
}

function all(sql, params = []) {
  try {
    return db.prepare(sql).all(params);
  } catch(e) {
    console.error('DB all error:', e.message, '| SQL:', sql.slice(0,80));
    throw e;
  }
}

function createTables() {
  db.exec(`
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
      title TEXT, first_name TEXT NOT NULL, last_name TEXT NOT NULL,
      hebrew_title TEXT, hebrew_full_name TEXT, neighborhood_id TEXT,
      cell TEXT, home_phone TEXT, email TEXT,
      street TEXT, apt TEXT, city TEXT, state TEXT, zip TEXT,
      labels TEXT DEFAULT '[]',
      notes TEXT, kvitel TEXT, kvitel_enabled INTEGER DEFAULT 0,
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
      donation_emails_paused INTEGER DEFAULT 0, postmark_key TEXT DEFAULT '',
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(group_id, phone)
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
  `);
}

function runMigrations() {
  // All migrations are now handled by CREATE TABLE IF NOT EXISTS above.
  // Add any ALTER TABLE statements here for columns added after initial deploy.
  const safeAlter = (sql) => { try { db.exec(sql); } catch(e) { /* column exists */ } };
  safeAlter("ALTER TABLE donors ADD COLUMN autopay_minute INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE donors ADD COLUMN hebrew_title TEXT");
  safeAlter("ALTER TABLE donations ADD COLUMN label TEXT");
  safeAlter("ALTER TABLE email_settings ADD COLUMN postmark_key TEXT DEFAULT ''");
  safeAlter("ALTER TABLE organizations ADD COLUMN expires_at DATETIME DEFAULT NULL");
  safeAlter("ALTER TABLE organizations ADD COLUMN expiry_warned INTEGER DEFAULT 0");
  safeAlter("ALTER TABLE kvitel_settings ADD COLUMN neighborhood_font TEXT DEFAULT 'Frank Ruhl Libre'");
  safeAlter("ALTER TABLE kvitel_settings ADD COLUMN neighborhood_size REAL DEFAULT 14");
  safeAlter("ALTER TABLE kvitel_settings ADD COLUMN neighborhood_bold INTEGER DEFAULT 1");
}

module.exports = { initDb, all, get, run, saveDb };
