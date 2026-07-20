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

      // Load existing donors for duplicate detection
      const existing = all('SELECT first_name, last_name, email, cell FROM donors WHERE org_id=?', [req.params.orgId]);
      const nameSet  = new Set(existing.map(d => `${d.first_name?.toLowerCase()}|${d.last_name?.toLowerCase()}`));
      const emailSet = new Set(existing.filter(d=>d.email).map(d => d.email.toLowerCase()));
      const cellSet  = new Set(existing.filter(d=>d.cell).map(d => d.cell.replace(/\D/g,'')));

      let imported = 0, flagged = [], errors = [], donorIds = [];

      // Build lookup sets from existing donors for duplicate detection
      const hebrewSet  = new Set(existing.filter(d=>d.hebrew_full_name).map(d=>d.hebrew_full_name.trim().toLowerCase()));
      const emailSet2  = new Set(existing.filter(d=>d.email).map(d=>d.email.toLowerCase()));
      const cellSet2   = new Set(existing.filter(d=>d.cell).map(d=>d.cell.replace(/\D/g,'')));
      const homeSet    = new Set(existing.filter(d=>d.home_phone).map(d=>d.home_phone.replace(/\D/g,'')));
      const addrSet    = new Set(existing.filter(d=>d.street&&d.zip).map(d=>`${d.street.toLowerCase().trim()}|${d.zip.trim()}`));

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

        // Duplicate detection — flag on any field match, still import
        const dupReasons = [];
        if (hebrew && hebrewSet.has(hebrew.toLowerCase()))        dupReasons.push('Hebrew name');
        if (email  && emailSet2.has(email))                       dupReasons.push('Email');
        if (cell   && cellSet2.has(cell))                         dupReasons.push('Cell phone');
        if (home   && homeSet.has(home))                          dupReasons.push('Home phone');
        if (street && zip && addrSet.has(`${street.toLowerCase()}|${zip}`)) dupReasons.push('Address');

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

          // If flagged as duplicate, create duplicate record
          if (dupReasons.length) {
            // Find the matching existing donor
            let matchId = null;
            if (dupReasons.includes('Email') && email) {
              const m = get('SELECT id FROM donors WHERE email=? AND org_id=? AND id!=?', [email, req.params.orgId, newId]);
              matchId = m?.id;
            } else if (dupReasons.includes('Cell phone') && cell) {
              const m = get('SELECT id FROM donors WHERE cell=? AND org_id=? AND id!=?', [cell, req.params.orgId, newId]);
              matchId = m?.id;
            }
            if (matchId) {
              try {
                run(`INSERT OR IGNORE INTO donor_duplicates (id,org_id,donor_id_a,donor_id_b) VALUES (?,?,?,?)`,
                  [uuidv4(), req.params.orgId, matchId, newId]);
              } catch {}
            }
          }

          donorIds.push({ id: newId, flagged: dupReasons.length > 0, reasons: dupReasons.join(', ') });

          // Add to sets so within-batch duplicates are also caught
          if (hebrew) hebrewSet.add(hebrew.toLowerCase());
          if (email)  emailSet2.add(email);
          if (cell)   cellSet2.add(cell);
          if (home)   homeSet.add(home);
          if (street && zip) addrSet.add(`${street.toLowerCase()}|${zip}`);

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
