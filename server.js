require('dotenv').config();
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const XLSX = require('xlsx');
const fs = require('fs');

const { initDb, all, get, run } = require('./db/schema');
const authRouter     = require('./routes/auth');
const donorsRouter   = require('./routes/donors');
const orgRouter      = require('./routes/org');
const kvitelRouter   = require('./routes/kvitel');
const paymentsRouter  = require('./routes/payments');
const { router: emailTplRouter } = require('./routes/email-templates');
const whatsappRouter = require('./routes/whatsapp');
const recoveryRouter       = require('./routes/recovery');
const leadsRouter          = require('./routes/leads');
const importsRouter        = require('./routes/imports');
const notificationsRouter  = require('./routes/notifications');
const { startScheduler } = require('./utils/scheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// Trust Render's proxy so req.secure works and cookies set correctly
app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Static files
app.use(express.static(path.join(__dirname, 'public')));
// Serve org-uploaded logos
app.use('/org-logos', express.static(path.join(DATA_DIR, 'logos')));
// Serve email-designer uploaded images
app.use('/email-images', express.static(path.join(DATA_DIR, 'email-images')));

// File upload
const upload = multer({
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

// API
app.use('/api/auth', authRouter);
app.use('/api', authRouter);  // also mount here for /api/orgs/:orgId/users etc.
app.use('/api/orgs/:orgId/donors', donorsRouter);
// ── Download import template ──────────────────────────────────────────────────
app.get('/api/orgs/:orgId/import/donors/template',
  (req, res, next) => {
    const { requireAuth, requireOrg } = require('./middleware/auth');
    requireAuth(req, res, () => requireOrg(req, res, next));
  },
  (req, res) => {
    try {
      const wb = XLSX.utils.book_new();
      const headers = [['ID #','Title','First Name','Last Name','Hebrew Title','Hebrew Name',
        'Email','Cell','Home Phone','Street','Apt','City','State','Zip','Neighborhood','Labels','Notes','Kvitel Names']];
      const sample = [['','R\'','Moshe','Cohen','הרב','משה כהן',
        'moshe@example.com','9175551234','7185551234',
        '123 Main St','Apt 2','Brooklyn','NY','11201','Boro Park','Major Donor','Sample donor','משה כהן\nשרה כהן']];
      const ws = XLSX.utils.aoa_to_sheet([...headers, ...sample]);
      ws['!cols'] = headers[0].map(h => ({ wch: Math.max(h.length + 4, 14) }));
      XLSX.utils.book_append_sheet(wb, ws, 'Donors');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', 'attachment; filename="donor-import-template.xlsx"');
      res.send(buf);
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

// ── Import donors from Excel ───────────────────────────────────────────────────
app.post('/api/orgs/:orgId/import/donors',
  (req, res, next) => {
    const { requireAuth, requireOrg, requireOrgAdmin } = require('./middleware/auth');
    requireAuth(req, res, () => requireOrg(req, res, () => requireOrgAdmin(req, res, next)));
  },
  upload.single('file'),
  (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
      const wb   = XLSX.readFile(req.file.path);
      const ws   = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      if (!rows.length) return res.status(400).json({ error: 'File is empty' });

      // Load existing donors for duplicate detection (select every field actually used below)
      const existing = all('SELECT id, first_name, last_name, email, cell, home_phone, hebrew_full_name, street, apt, zip FROM donors WHERE org_id=?', [req.params.orgId]);
      const norm10 = p => (p||'').replace(/\D/g,'').slice(-10); // compare by last 10 digits regardless of +1/formatting

      // Map each normalized key -> existing donor id, so we can link the duplicate record for ANY trigger reason
      const nameMap   = new Map(existing.filter(d=>d.first_name&&d.last_name).map(d=>[`${d.first_name.toLowerCase().trim()}|${d.last_name.toLowerCase().trim()}`, d.id]));
      const hebrewMap = new Map(existing.filter(d=>d.hebrew_full_name).map(d=>[d.hebrew_full_name.trim().toLowerCase(), d.id]));
      const emailMap  = new Map(existing.filter(d=>d.email).map(d=>[d.email.toLowerCase().trim(), d.id]));
      const cellMap   = new Map(existing.filter(d=>d.cell).map(d=>[norm10(d.cell), d.id]));
      const homeMap   = new Map(existing.filter(d=>d.home_phone).map(d=>[norm10(d.home_phone), d.id]));
      const addrMap   = new Map(existing.filter(d=>d.street&&d.zip).map(d=>[`${d.street.toLowerCase().trim()}|${(d.apt||'').toLowerCase().trim()}|${d.zip.trim()}`, d.id]));
      const lastNameByCell = new Map(existing.filter(d=>d.cell&&d.last_name).map(d=>[norm10(d.cell), d.last_name.toLowerCase().trim()]));
      const lastNameByHome = new Map(existing.filter(d=>d.home_phone&&d.last_name).map(d=>[norm10(d.home_phone), d.last_name.toLowerCase().trim()]));

      let imported = 0, flagged = [], errors = [], donorIds = [];

      for (const row of rows) {
        const fn      = (row['First Name']  || row['first_name']  || '').toString().trim();
        const ln      = (row['Last Name']   || row['last_name']   || '').toString().trim();
        const hebrew  = (row['Hebrew Name'] || row['hebrew_name'] || '').toString().trim();
        const email   = (row['Email']       || row['email']       || '').toString().trim().toLowerCase() || null;
        const cellRaw = (row['Cell']        || row['cell']        || row['Phone'] || '').toString().replace(/\D/g,'');
        const cell    = cellRaw || null;
        const homeRaw = (row['Home Phone']  || row['home_phone']  || '').toString().replace(/\D/g,'');
        const home    = homeRaw || null;
        const street  = (row['Street']      || row['street']      || '').toString().trim();
        const apt     = (row['Apt']         || row['apt']         || '').toString().trim();
        const zip     = (row['Zip']         || row['zip']         || '').toString().trim();

        // Skip only completely empty rows
        const allEmpty = !fn && !ln && !email && !cell && !hebrew && !street;
        if (allEmpty) continue;
        const displayName = [fn, ln].filter(Boolean).join(' ') || email || cell || 'Unknown';

        // Check for existing donor by ID number
        const importedNum = row['ID #'] || row['ID#'] || row['Donor ID'] || row['donor_number'] || '';
        const existingById = importedNum ? get('SELECT * FROM donors WHERE donor_number=? AND org_id=?', [parseInt(importedNum), req.params.orgId]) : null;
        if (existingById) {
          // Update only non-empty fields
          const updates = [];
          const vals = [];
          const fieldMap = {
            'First Name': 'first_name', 'Last Name': 'last_name',
            'Hebrew Title': 'hebrew_title', 'Hebrew Name': 'hebrew_full_name',
            'Email': 'email', 'Cell': 'cell', 'Home Phone': 'home_phone',
            'Street': 'street', 'Apt': 'apt', 'City': 'city',
            'State': 'state', 'Zip': 'zip', 'Title': 'title', 'Notes': 'notes',
            'Kvitel Names': 'kvitel'
          };
          for (const [col, field] of Object.entries(fieldMap)) {
            const v = (row[col]||'').toString().trim();
            if (v) { updates.push(`${field}=?`); vals.push(v); }
          }
          if (updates.length) {
            vals.push(existingById.id, req.params.orgId);
            run(`UPDATE donors SET ${updates.join(',')} WHERE id=? AND org_id=?`, vals);
          }
          donorIds.push({ id: existingById.id, flagged: false, reasons: '' });
          imported++;
          continue;
        }

        // ── Duplicate detection ────────────────────────────────────────────────
        // Strong signals (flag on their own): exact full name, Hebrew name, email, address (incl. apt)
        // Weak signals (phone alone): only flag if the last name ALSO matches that same
        // existing donor — shared household phones (e.g. spouses) are common and legitimate,
        // so a phone match with a clearly different last name is not auto-flagged.
        const nameKey = fn && ln ? `${fn.toLowerCase()}|${ln.toLowerCase()}` : null;
        const addrKey = street && zip ? `${street.toLowerCase()}|${apt.toLowerCase()}|${zip}` : null;
        const dupReasons = [];
        let matchId = null;

        if (nameKey && nameMap.has(nameKey))                   { dupReasons.push('Full name match'); matchId = matchId || nameMap.get(nameKey); }
        if (hebrew && hebrewMap.has(hebrew.toLowerCase()))      { dupReasons.push('Hebrew name match'); matchId = matchId || hebrewMap.get(hebrew.toLowerCase()); }
        if (email && emailMap.has(email))                       { dupReasons.push('Same email'); matchId = matchId || emailMap.get(email); }
        if (addrKey && addrMap.has(addrKey))                    { dupReasons.push('Same address'); matchId = matchId || addrMap.get(addrKey); }
        if (cell) {
          const key10 = norm10(cell);
          if (cellMap.has(key10)) {
            const otherLast = lastNameByCell.get(key10);
            if (!ln || !otherLast || otherLast === ln.toLowerCase()) { dupReasons.push('Same cell phone'); matchId = matchId || cellMap.get(key10); }
          }
        }
        if (home) {
          const key10 = norm10(home);
          if (homeMap.has(key10)) {
            const otherLast = lastNameByHome.get(key10);
            if (!ln || !otherLast || otherLast === ln.toLowerCase()) { dupReasons.push('Same home phone'); matchId = matchId || homeMap.get(key10); }
          }
        }

        try {
          const newId = uuidv4();
          // Generate unique 6-digit donor number for new import rows too
          let importDonorNum;
          for (let attempts = 0; attempts < 20; attempts++) {
            const candidate = Math.floor(100000 + Math.random() * 900000);
            const exists = get('SELECT id FROM donors WHERE donor_number=? UNION SELECT id FROM leads WHERE donor_number=?', [candidate, candidate]);
            if (!exists) { importDonorNum = candidate; break; }
          }
          run(`INSERT INTO donors
            (id,org_id,donor_number,title,first_name,last_name,hebrew_title,hebrew_full_name,
             email,cell,home_phone,street,apt,city,state,zip,notes,kvitel,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
            [newId, req.params.orgId, importDonorNum||null,
             (row['Title']||row['title']||'').toString().trim()||null,
             fn||'', ln||'',
             (row['Hebrew Title']||'').toString().trim()||null,
             hebrew||null, email,
             cell ? (cell.length===10?'+1'+cell:cell.length===11&&cell[0]==='1'?'+'+cell:'+'+cell) : null,
             home ? (home.length===10?'+1'+home:home.length===11&&home[0]==='1'?'+'+home:'+'+home) : null,
             street||null,
             (row['Apt']||row['apt']||'').toString().trim()||null,
             (row['City']||row['city']||'').toString().trim()||null,
             (row['State']||row['state']||'').toString().trim()||null,
             zip||null,
             (row['Notes']||row['notes']||'').toString().trim()||null,
             (row['Kvitel Names']||row['kvitel']||'').toString().trim()||null
            ]);

          // If flagged as duplicate, create the persistent duplicate-link record
          if (dupReasons.length && matchId && matchId !== newId) {
            try {
              run(`INSERT OR IGNORE INTO donor_duplicates (id,org_id,donor_id_a,donor_id_b,reason) VALUES (?,?,?,?,?)`,
                [uuidv4(), req.params.orgId, matchId, newId, dupReasons.join(', ')]);
            } catch {}
          }

          donorIds.push({ id: newId, flagged: dupReasons.length > 0, reasons: dupReasons.join(', ') });

          // Add this row into the lookup maps so later rows in the SAME batch also catch duplicates
          if (nameKey)              nameMap.set(nameKey, newId);
          if (hebrew)                hebrewMap.set(hebrew.toLowerCase(), newId);
          if (email)                 emailMap.set(email, newId);
          if (cell)                { cellMap.set(norm10(cell), newId); if (ln) lastNameByCell.set(norm10(cell), ln.toLowerCase()); }
          if (home)                { homeMap.set(norm10(home), newId); if (ln) lastNameByHome.set(norm10(home), ln.toLowerCase()); }
          if (addrKey)               addrMap.set(addrKey, newId);

          imported++;
          if (dupReasons.length) {
            flagged.push({ name: displayName, reasons: dupReasons });
          }
        } catch(e) { errors.push(`${displayName}: ${e.message}`); }
      }

      // Save import history
      const importId = uuidv4();
      run(`INSERT INTO import_history (id,org_id,imported_by,type,total_rows,imported,flagged,errors,filename)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        [importId, req.params.orgId, req.user?.id||'unknown', 'donors',
         rows.length, imported, flagged.length, errors.length, req.file.originalname||'upload.xlsx']);
      for (const d of donorIds) {
        run('INSERT INTO import_items (id,import_id,donor_id,was_flagged,flag_reasons) VALUES (?,?,?,?,?)',
          [uuidv4(), importId, d.id, d.flagged?1:0, d.reasons||null]);
      }

      try { fs.unlinkSync(req.file.path); } catch {}
      res.json({ success: true, imported, flagged, errors: errors.slice(0,50), import_id: importId });
    } catch(e) {
      try { if(req.file) fs.unlinkSync(req.file.path); } catch {}
      res.status(500).json({ error: e.message });
    }
  }
);

app.use('/api/orgs/:orgId', orgRouter);
app.use('/api/orgs/:orgId/kvitel', kvitelRouter);
app.use('/api/orgs/:orgId/payments', paymentsRouter);
app.use('/api/orgs/:orgId/email-templates', emailTplRouter);
app.use('/api/orgs/:orgId/whatsapp', whatsappRouter);
app.use('/api/recovery', recoveryRouter);
app.use('/api/orgs/:orgId/leads', leadsRouter);
app.use('/api/orgs/:orgId/imports', importsRouter);
app.use('/api/orgs/:orgId/notifications', notificationsRouter);

app.get('/api/setup-status', (req, res) => {
  res.json({ needsSetup: all('SELECT id FROM users LIMIT 1', []).length === 0 });
});


// SPA — all non-API, non-file routes serve index.html
app.get('*', (req, res, next) => {
  // Let express.static handle real files (.js, .css, .png etc.)
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await initDb();
  startScheduler();
  app.listen(PORT, () => {
    console.log(`\nDRM running on port ${PORT}\n`);
    // Log email config status on startup so it's visible in Render logs
    try {
      const { all } = require('./db/schema');
      const orgs = all('SELECT id, name FROM organizations', []);
      for (const org of orgs) {
        const settings = require('./db/schema').get('SELECT smtp_email, smtp_password FROM email_settings WHERE org_id=?', [org.id]);
        if (settings?.smtp_email && settings?.smtp_password) {
          console.log(`[email] ✓ SMTP configured for "${org.name}" — ${settings.smtp_email}`);
        } else {
          console.log(`[email] ⚠ No SMTP configured for "${org.name}" — receipts will NOT send`);
        }
      }
    } catch(e) { /* DB may not be ready yet on first boot */ }
  });
}
start().catch(console.error);
