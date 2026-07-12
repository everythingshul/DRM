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
const recoveryRouter = require('./routes/recovery');
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
      const headers = [['Title','First Name','Last Name','Hebrew Title','Hebrew Name',
        'Email','Cell','Home Phone','Street','Apt','City','State','Zip','Neighborhood','Labels','Notes']];
      const sample = [['R\'','Moshe','Cohen','הרב','משה כהן',
        'moshe@example.com','9175551234','7185551234',
        '123 Main St','Apt 2','Brooklyn','NY','11201','Boro Park','Major Donor','Sample donor']];
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

      let imported = 0, duplicates = 0, errors = [];
      for (const row of rows) {
        const fn = (row['First Name'] || row['first_name'] || '').toString().trim();
        const ln = (row['Last Name']  || row['last_name']  || '').toString().trim();
        if (!fn || !ln) { errors.push(`Row skipped: missing First Name or Last Name`); continue; }

        const email = (row['Email'] || row['email'] || '').toString().trim().toLowerCase() || null;
        const cell  = (row['Cell']  || row['cell']  || row['Phone'] || '').toString().replace(/\D/g,'') || null;

        // Duplicate check: match on name OR email OR cell
        const nameKey = `${fn.toLowerCase()}|${ln.toLowerCase()}`;
        const isDup = nameSet.has(nameKey)
          || (email && emailSet.has(email))
          || (cell && cellSet.has(cell));

        if (isDup) { duplicates++; continue; }

        try {
          run(`INSERT INTO donors
            (id,org_id,title,first_name,last_name,hebrew_title,hebrew_full_name,
             email,cell,home_phone,street,apt,city,state,zip,notes,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
            [uuidv4(), req.params.orgId,
             (row['Title']||row['title']||'').toString().trim()||null, fn, ln,
             (row['Hebrew Title']||'').toString().trim()||null,
             (row['Hebrew Name']||row['hebrew_name']||'').toString().trim()||null,
             email,
             cell ? (cell.length===10?'+1'+cell:'+'+cell) : null,
             (row['Home Phone']||'').toString().replace(/\D/g,'')||null,
             (row['Street']||row['street']||'').toString().trim()||null,
             (row['Apt']||row['apt']||'').toString().trim()||null,
             (row['City']||row['city']||'').toString().trim()||null,
             (row['State']||row['state']||'').toString().trim()||null,
             (row['Zip']||row['zip']||'').toString().trim()||null,
             (row['Notes']||row['notes']||'').toString().trim()||null
            ]);
          // Track for within-batch duplicate detection
          nameSet.add(nameKey);
          if (email) emailSet.add(email);
          if (cell) cellSet.add(cell);
          imported++;
        } catch(e) { errors.push(`${fn} ${ln}: ${e.message}`); }
      }

      try { fs.unlinkSync(req.file.path); } catch {}
      res.json({ success: true, imported, duplicates, skipped: errors.length, errors: errors.slice(0,20) });
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
