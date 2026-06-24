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

    // Check if org is expired (non-super-admins only)
    if (activeOrg && !user.is_super_admin && activeOrg.expires_at) {
      const expiry = new Date(activeOrg.expires_at);
      if (expiry < new Date()) {
        return res.status(403).json({
          error: 'expired',
          message: 'Your account subscription has expired. Please contact EverythingShul to renew your subscription.',
          expired_at: activeOrg.expires_at
        });
      }
    }

    run('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    run(`INSERT INTO login_log (id, user_id, org_id, action, ip, user_agent)
         VALUES (?, ?, ?, 'login', ?, ?)`,
      [uuidv4(), user.id, activeOrg?.id, req.ip, req.headers['user-agent']]);

    res.cookie('drm_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
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

// Invite user by email — sends setup link, no password set by admin
router.post('/orgs/:orgId/users/invite', requireAuth, requireOrg, requireOrgAdmin, async (req, res) => {
  try {
    const { email, role = 'staff' } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Check if user already exists in org
    let user = get('SELECT * FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    let isNew = false;

    if (!user) {
      // Create a placeholder user with a random temp password they'll never use
      const crypto = require('crypto');
      const tempPass = crypto.randomBytes(32).toString('hex');
      const hash = await bcrypt.hash(tempPass, 12);
      const userId = uuidv4();
      const name = email.split('@')[0]; // placeholder name until they set up
      run('INSERT INTO users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)',
        [userId, email.toLowerCase().trim(), hash, name]);
      user = get('SELECT * FROM users WHERE id = ?', [userId]);
      isNew = true;
    }

    const existing = get('SELECT * FROM org_users WHERE org_id = ? AND user_id = ?', [req.orgId, user.id]);
    if (existing) return res.status(400).json({ error: 'User already in this organization' });

    run('INSERT INTO org_users (id, org_id, user_id, role, invited_by) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), req.orgId, user.id, role, req.user.id]);

    // Generate a setup token (same JWT mechanism, 48h)
    const { generateToken } = require('../middleware/auth');
    const setupToken = generateToken({ userId: user.id, setupMode: true, orgId: req.orgId });

    // Get email settings for this org's signup SMTP
    const emailSettings = get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]);
    // Use the org's configured SMTP (admin email + app password)
    // Falls back to SIGNUP_SMTP_EMAIL env var if org SMTP not configured
    const orgEmailCfg = get('SELECT * FROM email_settings WHERE org_id=?', [req.orgId]) || get('SELECT es.* FROM email_settings es JOIN org_users ou ON es.org_id=ou.org_id WHERE ou.user_id=? LIMIT 1', [req.user.id]);
    const signupEmail = orgEmailCfg?.smtp_email || process.env.SIGNUP_SMTP_EMAIL;
    const signupPass  = orgEmailCfg?.smtp_password || process.env.SIGNUP_SMTP_PASSWORD;
    const appUrl = process.env.APP_URL || 'https://drm.everythingshul.com';
    const setupUrl = `${appUrl}/complete-setup?token=${setupToken}`;

    // Try sending the invite email
    let emailSent = false;
    if (signupEmail && signupPass) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: orgEmailCfg?.smtp_host || 'smtp.gmail.com',
          port: orgEmailCfg?.smtp_port || 587,
          secure: false,
          auth: { user: signupEmail, pass: signupPass }
        });
        await transporter.sendMail({
          from: `"DRM – Everything Shul" <${signupEmail}>`,
          to: email,
          subject: 'You\'ve been invited to DRM',
          html: `
            <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto">
              <h2 style="color:#1a3a6b">Welcome to DRM</h2>
              <p>You've been invited to join <strong>${req.org.name}</strong> on DRM – Donor Relationship Manager, powered by Everything Shul.</p>
              <p>Click the button below to set up your account. This link expires in 48 hours.</p>
              <div style="margin:24px 0">
                <a href="${setupUrl}" style="background:#1a3a6b;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">
                  Set Up My Account →
                </a>
              </div>
              <p style="color:#6b7280;font-size:13px">If the button doesn't work, copy this link:<br>${setupUrl}</p>
              <hr style="border:none;border-top:1px solid #eee;margin:20px 0">
              <p style="color:#9ca3af;font-size:12px">DRM – Powered by Everything Shul &nbsp;·&nbsp; drm.everythingshul.com</p>
            </div>
          `
        });
        emailSent = true;
      } catch (e) {
        console.error('Invite email failed:', e.message);
      }
    }

    res.json({
      success: true,
      emailSent,
      setupUrl: emailSent ? null : setupUrl, // Return URL if email couldn't send so admin can share manually
      user: { id: user.id, email: user.email, role }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Complete account setup from invite link
router.get('/complete-setup', (req, res) => {
  // Serve the SPA — JS will handle the token
  res.sendFile(require('path').join(__dirname, '../public/index.html'));
});

router.post('/complete-setup', async (req, res) => {
  try {
    const { token, full_name, password } = req.body;
    if (!token || !full_name || !password) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'This setup link has expired or is invalid' });
    }
    if (!decoded.setupMode) return res.status(400).json({ error: 'Invalid setup token' });

    const hash = await bcrypt.hash(password, 12);
    run('UPDATE users SET full_name = ?, password_hash = ? WHERE id = ?', [full_name, hash, decoded.userId]);

    res.json({ success: true, message: 'Account set up! Please log in.' });
  } catch (e) {
    console.error(e);
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
    // Setup route: no expiry date for the initial super admin org
    const expiresAt = null;
    run('INSERT INTO organizations (id, name, slug, expires_at) VALUES (?, ?, ?, ?)', [orgId, org_name, slug, expiresAt]);
    run('INSERT INTO org_users (id, org_id, user_id, role) VALUES (?, ?, ?, ?)', [uuidv4(), orgId, userId, 'admin']);
    run('INSERT INTO email_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);
    run('INSERT INTO kvitel_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);

    res.json({ success: true, message: 'Setup complete. Please log in.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Super admin: invite a new organization account
// They get an email with a link to set up their own org + admin account
router.post('/invite-account', requireAuth, async (req, res) => {
  try {
    if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
    const { email, expiry_date } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Check not already a user
    const existing = get('SELECT id FROM users WHERE email = ?', [email.toLowerCase().trim()]);
    if (existing) return res.status(400).json({ error: 'An account with that email already exists' });

    // Generate a one-time invite token (JWT, 7 days)
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    const inviteToken = jwt.sign(
      { inviteEmail: email.toLowerCase().trim(), newAccount: true, expiryDate: expiry_date || null },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const appUrl = process.env.APP_URL || 'https://drm.everythingshul.com';
    const setupUrl = `${appUrl}/new-account?token=${inviteToken}`;

    // Use the org's configured SMTP (admin email + app password)
    // Falls back to SIGNUP_SMTP_EMAIL env var if org SMTP not configured
    const orgEmailCfg = get('SELECT * FROM email_settings WHERE org_id=?', [req.orgId]) || get('SELECT es.* FROM email_settings es JOIN org_users ou ON es.org_id=ou.org_id WHERE ou.user_id=? LIMIT 1', [req.user.id]);
    const signupEmail = orgEmailCfg?.smtp_email || process.env.SIGNUP_SMTP_EMAIL;
    const signupPass  = orgEmailCfg?.smtp_password || process.env.SIGNUP_SMTP_PASSWORD;
    let emailSent = false;

    if (signupEmail && signupPass) {
      try {
        const nodemailer = require('nodemailer');
        const transporter = nodemailer.createTransport({
          host: orgEmailCfg?.smtp_host || 'smtp.gmail.com',
          port: orgEmailCfg?.smtp_port || 587,
          secure: false,
          auth: { user: signupEmail, pass: signupPass }
        });
        await transporter.sendMail({
          from: `"DRM – Everything Shul" <${signupEmail}>`,
          to: email,
          subject: 'Your DRM Account Invitation',
          html: `
            <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;color:#1a1a2e">
              <img src="${appUrl}/img/logo.png" alt="Everything Shul" style="height:52px;margin-bottom:20px">
              <h2 style="color:#1a3a6b;margin-top:0">You're invited to DRM</h2>
              <p>You've been invited to create an account on <strong>DRM – Donor Relationship Manager</strong>, powered by Everything Shul.</p>
              <p>Click the button below to set up your organization and admin account. This link is valid for 7 days.</p>
              <div style="margin:28px 0">
                <a href="${setupUrl}" style="background:#1a3a6b;color:white;padding:13px 26px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;font-size:15px">
                  Set Up My Account →
                </a>
              </div>
              <p style="color:#6b7280;font-size:13px">If the button doesn't work, copy this link into your browser:<br>
              <a href="${setupUrl}" style="color:#2d8dc4;word-break:break-all">${setupUrl}</a></p>
              <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
              <p style="color:#9ca3af;font-size:12px">DRM – Powered by Everything Shul &nbsp;·&nbsp; drm.everythingshul.com</p>
            </div>
          `
        });
        emailSent = true;
      } catch (e) {
        console.error('Invite email failed:', e.message);
      }
    }

    res.json({ success: true, emailSent, setupUrl: emailSent ? null : setupUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Complete new account setup from invite link (creates user + org in one shot)
router.post('/new-account', async (req, res) => {
  try {
    const { token, full_name, password, org_name } = req.body;
    if (!token || !full_name || !password || !org_name) return res.status(400).json({ error: 'All fields required' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/auth');
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      return res.status(400).json({ error: 'This invite link has expired or is invalid. Ask for a new invite.' });
    }
    if (!decoded.newAccount || !decoded.inviteEmail) return res.status(400).json({ error: 'Invalid invite token' });

    // Make sure email not already taken (link reuse)
    const existing = get('SELECT id FROM users WHERE email = ?', [decoded.inviteEmail]);
    if (existing) return res.status(400).json({ error: 'An account with this email already exists. Please log in.' });

    const hash = await bcrypt.hash(password, 12);
    const userId = uuidv4();
    run('INSERT INTO users (id, email, password_hash, full_name, role) VALUES (?, ?, ?, ?, ?)',
      [userId, decoded.inviteEmail, hash, full_name, 'admin']);

    const slug = org_name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') + '-' + Date.now().toString(36);
    const orgId = uuidv4();
    const expiresAt = decoded.expiryDate ? new Date(decoded.expiryDate).toISOString() : null;
    run('INSERT INTO organizations (id, name, slug, expires_at) VALUES (?, ?, ?, ?)', [orgId, org_name, slug, expiresAt]);
    run('INSERT INTO org_users (id, org_id, user_id, role) VALUES (?, ?, ?, ?)', [uuidv4(), orgId, userId, 'admin']);
    run('INSERT INTO email_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);
    run('INSERT INTO kvitel_settings (id, org_id) VALUES (?, ?)', [uuidv4(), orgId]);

    res.json({ success: true, message: 'Account created! Please log in.' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;

// Super admin: list all orgs with expiry status
const authRouter = require('express').Router();
// (re-using existing router export, adding to it)

router.get('/orgs', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  const orgs = all(`
    SELECT o.id, o.name, o.slug, o.created_at, o.expires_at,
           COUNT(DISTINCT ou.user_id) as user_count
    FROM organizations o
    LEFT JOIN org_users ou ON ou.org_id = o.id
    GROUP BY o.id ORDER BY o.created_at DESC
  `, []);
  res.json(orgs);
});

// Super admin: set/update expiry date for an org
router.put('/orgs/:orgId/expiry', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  const { expires_at } = req.body;
  // Reset warning flags when expiry is updated
  run('UPDATE organizations SET expires_at=?, expiry_warned=0 WHERE id=?',
    [expires_at || null, req.params.orgId]);
  res.json({ success: true });
});
