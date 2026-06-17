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
app.use('/api/orgs/:orgId', orgRouter);
app.use('/api/orgs/:orgId/kvitel', kvitelRouter);
app.use('/api/orgs/:orgId/payments', paymentsRouter);
app.use('/api/orgs/:orgId/email-templates', emailTplRouter);

app.get('/api/setup-status', (req, res) => {
  res.json({ needsSetup: all('SELECT id FROM users LIMIT 1', []).length === 0 });
});

app.post('/api/orgs/:orgId/import/donors',
  (req, res, next) => {
    const { requireAuth, requireOrg, requireOrgAdmin } = require('./middleware/auth');
    requireAuth(req, res, () => requireOrg(req, res, () => requireOrgAdmin(req, res, next)));
  },
  upload.single('file'),
  (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file' });
      const rows = XLSX.utils.sheet_to_json(
        XLSX.readFile(req.file.path).Sheets[XLSX.readFile(req.file.path).SheetNames[0]]
      );
      let imported = 0, errors = [];
      for (const row of rows) {
        const fn = row['First Name'] || row['first_name'] || '';
        const ln = row['Last Name'] || row['last_name'] || '';
        if (!fn || !ln) { errors.push('Row skipped: no name'); continue; }
        try {
          run(`INSERT INTO donors (id,org_id,first_name,last_name,hebrew_full_name,email,cell,street,city,state,zip)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [uuidv4(), req.params.orgId, fn, ln,
             row['Hebrew Name']||null, row['Email']||null, row['Cell']||null,
             row['Street']||null, row['City']||null, row['State']||null, row['Zip']||null]);
          imported++;
        } catch(e) { errors.push(e.message); }
      }
      fs.unlinkSync(req.file.path);
      res.json({ success: true, imported, errors });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

// SPA — all non-API, non-file routes serve index.html
app.get('*', (req, res, next) => {
  // Let express.static handle real files (.js, .css, .png etc.)
  if (path.extname(req.path)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await initDb();
  startScheduler();
  app.listen(PORT, () => console.log(`\nDRM running on port ${PORT}\n`));
}
start().catch(console.error);
