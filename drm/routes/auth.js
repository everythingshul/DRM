// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { all, get, run } = require('../db/schema');
const { generateToken, requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');

// Login
router.post('/login', async (req, res) => {
  try {
    const { email, password, orgSlug } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Get user's orgs
    const orgs = all(`
      SELECT o.*, ou.role as user_role FROM organizations o
      JOIN org_users ou ON o.id = ou.org_id
      WHERE ou.user_id = ?
      ORDER BY o.name
    `, [user.id]);

    let activeOrg = null;
    if (orgSlug) {
      activeOrg = orgs.find(o => o.slug === orgSlug);
    }
    if (!activeOrg && orgs.length > 0) activeOrg = orgs[0];

    const token = generateToken({
      userId: user.id,
      email: user.email,
      orgId: activeOrg?.id
    });

    run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    run(`INSERT INTO login_log (id, user_id, org_id, action, ip, user_agent)
         VALUES (?, ?, ?, 'login', ?, ?)`,
      [uuidv4(), user.id, activeOrg?.id, req.ip, req.headers['user-agent']]);

    res.cookie('drm_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.json({
      success: true,
      user: { id: user.id, email: user.email, full_name: user.full_name, role: user.role, is_super_admin: user.is_super_admin },
      orgs,
      activeOrg,
      token
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout
router.post('/logout', requireAuth, (req, res) => {
  run(`INSERT INTO login_log (id, user_id, org_id, action, ip, user_agent)
       VALUES (?, ?, ?, 'logout', ?, ?)`,
    [uuidv4(), req.user.id, req.token.orgId, req.ip, req.headers['user-agent']]);
  res.clearCookie('drm_token');
  res.json({ success: true });
});

// Get current user
router.get('/me', requireAuth, (req, res) => {
  const orgs = all(`
    SELECT o.*, ou.role as user_role FROM organizations o
    JOIN org_users ou ON o.id = ou.org_id
    WHERE ou.user_id = ?
    ORDER BY o.name
  `, [req.user.id]);

  res.json({
    user: { id: req.user.id, email: req.user.email, full_name: req.user.full_name, role: req.user.role, is_super_admin: req.user.is_super_admin },
    orgs
  });
});

// Create organization
router.post('/orgs', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    const orgId = uuidv4();

    run('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)', [orgId, name, slug]);
    run('INSERT INTO org_users (id, org_id, user_id, role) VALUES (?, ?, ?, ?)',
      [uuidv4(), orgId, req.user.id, 'admin']);

    // Create default email settings
    run('INSERT INTO email_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);
    run('INSERT INTO kvitel_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);

    const org = get('SELECT * FROM organizations WHERE id = ?', [orgId]);
    res.json({ success: true, org });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// List orgs (super admin)
router.get('/orgs', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Forbidden' });
  const orgs = all('SELECT * FROM organizations ORDER BY name', []);
  res.json(orgs);
});

// Get org users (admin)
router.get('/orgs/:orgId/users', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const users = all(`
    SELECT u.id, u.email, u.full_name, u.last_login, u.created_at, ou.role
    FROM users u
    JOIN org_users ou ON u.id = ou.user_id
    WHERE ou.org_id = ?
    ORDER BY u.full_name
  `, [req.orgId]);
  res.json(users);
});

// Add user to org (admin)
router.post('/orgs/:orgId/users', requireAuth, requireOrg, requireOrgAdmin, async (req, res) => {
  try {
    const { email, full_name, password, role = 'staff' } = req.body;
    if (!email || !password || !full_name) return res.status(400).json({ error: 'Email, name and password required' });

    let user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (!user) {
      const hash = await bcrypt.hash(password, 12);
      const userId = uuidv4();
      run('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
        [userId, email.toLowerCase().trim(), hash, full_name]);
      user = get('SELECT * FROM users WHERE id = ?', [userId]);
    }

    const existing = get('SELECT * FROM org_users WHERE org_id = ? AND user_id = ?', [req.orgId, user.id]);
    if (existing) return res.status(400).json({ error: 'User already in org' });

    run('INSERT INTO org_users (id, org_id, user_id, role, invited_by) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), req.orgId, user.id, role, req.user.id]);

    res.json({ success: true, user: { id: user.id, email: user.email, full_name: user.full_name, role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove user from org
router.delete('/orgs/:orgId/users/:userId', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' });
  run('DELETE FROM org_users WHERE org_id = ? AND user_id = ?', [req.orgId, req.params.userId]);
  res.json({ success: true });
});

// Change user password (admin)
router.put('/orgs/:orgId/users/:userId/password', requireAuth, requireOrg, requireOrgAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const hash = await bcrypt.hash(password, 12);
    run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.params.userId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login log
router.get('/orgs/:orgId/login-log', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const log = all(`
    SELECT ll.*, u.email, u.full_name FROM login_log ll
    JOIN users u ON ll.user_id = u.id
    WHERE ll.org_id = ?
    ORDER BY ll.created_at DESC
    LIMIT 500
  `, [req.orgId]);
  res.json(log);
});

// Initial setup - create super admin if no users exist
router.post('/setup', async (req, res) => {
  try {
    const existing = all('SELECT id FROM users LIMIT 1', []);
    if (existing.length > 0) return res.status(400).json({ error: 'Already set up' });

    const { email, password, full_name, org_name } = req.body;
    if (!email || !password || !full_name || !org_name) return res.status(400).json({ error: 'All fields required' });

    const hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    run('INSERT INTO users (id, email, password_hash, full_name, role, is_super_admin) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, email.toLowerCase().trim(), hash, full_name, 'admin', 1]);

    const slug = org_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    const orgId = uuidv4();
    run('INSERT INTO organizations (id, name, slug) VALUES (?, ?, ?)', [orgId, org_name, slug]);
    run('INSERT INTO org_users (id, org_id, user_id, role) VALUES (?, ?, ?, ?)', [uuidv4(), orgId, userId, 'admin']);
    run('INSERT INTO email_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);
    run('INSERT INTO kvitel_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);

    res.json({ success: true, message: 'Setup complete. Please log in.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
