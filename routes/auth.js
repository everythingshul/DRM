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

    // Get user's own orgs — including super admins, who must go through the
    // request/approve access flow (Accounts page) to view any other org rather
    // than having every organisation available in their own sidebar switcher.
    const orgs = all(`
      SELECT o.*, ou.role as user_role FROM organizations o
      JOIN org_users ou ON o.id = ou.org_id
      WHERE ou.user_id = ? AND ou.removed_at IS NULL
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
  // Own orgs only — including super admins, who must request/be-approved access
  // (see /super-admin/request-access below) to view any other organisation, rather
  // than having every account available directly in their sidebar switcher.
  const orgs = all(`
    SELECT o.*, ou.role as user_role FROM organizations o
    JOIN org_users ou ON o.id = ou.org_id
    WHERE ou.user_id = ? AND ou.removed_at IS NULL
    ORDER BY o.name
  `, [req.user.id]);

  // If this request is for a specific approved cross-org access session (the
  // super-admin "view another org" new tab), include that one extra org so the
  // frontend can resolve it — without exposing every org in the normal list.
  const embeddedOrgId = req.query.embedded_org;
  if (embeddedOrgId && req.user.is_super_admin && !orgs.find(o => o.id === embeddedOrgId)) {
    const approved = get(`SELECT * FROM access_requests WHERE super_admin_id=? AND org_id=? AND status='approved'`, [req.user.id, embeddedOrgId]);
    if (approved) {
      const org = get('SELECT * FROM organizations WHERE id=?', [embeddedOrgId]);
      if (org) orgs.push({ ...org, user_role: 'admin' });
    }
  }

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
  const orgs = all(`
    SELECT o.*,
      (SELECT COUNT(*) FROM donors WHERE org_id=o.id) as donor_count,
      (SELECT COUNT(*) FROM donations WHERE org_id=o.id) as donation_count
    FROM organizations o ORDER BY name
  `, []);
  res.json(orgs);
});

// Get org users (admin)
router.get('/orgs/:orgId/users', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  const users = all(`
    SELECT u.id, u.email, u.full_name, u.last_login, u.created_at, ou.role,
           u.hebrew_name, u.hebrew_title, u.english_title, u.cell, u.home_phone, u.address, u.notes
    FROM users u
    JOIN org_users ou ON u.id = ou.user_id
    WHERE ou.org_id = ? AND ou.removed_at IS NULL
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
    if (existing && !existing.removed_at) return res.status(400).json({ error: 'User already in org' });
    if (existing && existing.removed_at) {
      // Previously removed — restore their membership instead of erroring
      run('UPDATE org_users SET role=?, removed_at=NULL, invited_by=? WHERE id=?', [role, req.user.id, existing.id]);
    } else {
      run('INSERT INTO org_users (id, org_id, user_id, role, invited_by) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), req.orgId, user.id, role, req.user.id]);
    }
    // Save page permissions
    if (Array.isArray(permissions) && permissions.length) {
      for (const p of permissions) {
        run(`INSERT INTO user_permissions (id,org_id,user_id,page,can_view,can_edit) VALUES (?,?,?,?,?,?)
             ON CONFLICT(org_id,user_id,page) DO UPDATE SET can_view=excluded.can_view,can_edit=excluded.can_edit`,
          [uuidv4(), req.orgId, user.id, p.page, p.can_view?1:0, p.can_edit?1:0]);
      }
    }

    res.json({ success: true, user: { id: user.id, email: user.email, full_name: user.full_name, role } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove user from org
router.delete('/orgs/:orgId/users/:userId', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  if (req.params.userId === req.user.id) return res.status(400).json({ error: 'Cannot remove yourself' });
  run('UPDATE org_users SET removed_at=CURRENT_TIMESTAMP WHERE org_id = ? AND user_id = ?', [req.orgId, req.params.userId]);
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
    const { email, role = 'staff', permissions = [] } = req.body;
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
    if (existing && !existing.removed_at) return res.status(400).json({ error: 'User already in this organization' });
    if (existing && existing.removed_at) {
      run('UPDATE org_users SET role=?, removed_at=NULL, invited_by=? WHERE id=?', [role, req.user.id, existing.id]);
    } else {
      run('INSERT INTO org_users (id, org_id, user_id, role, invited_by) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), req.orgId, user.id, role, req.user.id]);
    }
    // Save page permissions
    if (Array.isArray(permissions) && permissions.length) {
      for (const p of permissions) {
        run(`INSERT INTO user_permissions (id,org_id,user_id,page,can_view,can_edit) VALUES (?,?,?,?,?,?)
             ON CONFLICT(org_id,user_id,page) DO UPDATE SET can_view=excluded.can_view,can_edit=excluded.can_edit`,
          [uuidv4(), req.orgId, user.id, p.page, p.can_view?1:0, p.can_edit?1:0]);
      }
    }

    // Generate a setup token (same JWT mechanism, 48h)
    const { generateToken } = require('../middleware/auth');
    const setupToken = generateToken({ userId: user.id, setupMode: true, orgId: req.orgId });

    // Get email settings for this org's signup SMTP
    const emailSettings = req.orgId ? get('SELECT * FROM email_settings WHERE org_id = ?', [req.orgId]) : null;
    // Use the org's configured SMTP (admin email + app password)
    // Falls back to SIGNUP_SMTP_EMAIL env var if org SMTP not configured
    const orgEmailCfg = req.orgId
      ? (get('SELECT * FROM email_settings WHERE org_id=?', [req.orgId]) ||
         get('SELECT es.* FROM email_settings es JOIN org_users ou ON es.org_id=ou.org_id WHERE ou.user_id=? LIMIT 1', [req.user.id]))
      : get('SELECT es.* FROM email_settings es JOIN org_users ou ON es.org_id=ou.org_id WHERE ou.user_id=? LIMIT 1', [req.user.id]);
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
    const orgEmailCfg = get('SELECT es.* FROM email_settings es JOIN org_users ou ON es.org_id=ou.org_id WHERE ou.user_id=? LIMIT 1', [req.user.id]);
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

// ── Update user profile ───────────────────────────────────────────────────────
router.put('/orgs/:orgId/users/:userId/profile', requireAuth, requireOrg, async (req, res) => {
  try {
    const { full_name, email, role, hebrew_name, hebrew_title, english_title, cell, home_phone, address, notes } = req.body;
    const isOwnProfile = req.params.userId === req.user.id;
    const isAdmin = req.orgRole === 'admin' || req.user.is_super_admin;
    if (!isOwnProfile && !isAdmin) return res.status(403).json({ error: 'Not authorized' });
    if (full_name) run('UPDATE users SET full_name=? WHERE id=?', [full_name, req.params.userId]);
    if (email) run('UPDATE users SET email=? WHERE id=?', [email.toLowerCase().trim(), req.params.userId]);
    if (role && isAdmin && !isOwnProfile) run('UPDATE org_users SET role=? WHERE user_id=? AND org_id=?', [role, req.params.userId, req.params.orgId]);
    if (hebrew_name    !== undefined) run('UPDATE users SET hebrew_name=? WHERE id=?', [hebrew_name||null, req.params.userId]);
    if (hebrew_title   !== undefined) run('UPDATE users SET hebrew_title=? WHERE id=?', [hebrew_title||null, req.params.userId]);
    if (english_title  !== undefined) run('UPDATE users SET english_title=? WHERE id=?', [english_title||null, req.params.userId]);
    if (cell           !== undefined) run('UPDATE users SET cell=? WHERE id=?', [cell||null, req.params.userId]);
    if (home_phone     !== undefined) run('UPDATE users SET home_phone=? WHERE id=?', [home_phone||null, req.params.userId]);
    if (address        !== undefined) run('UPDATE users SET address=? WHERE id=?', [address||null, req.params.userId]);
    if (notes          !== undefined) run('UPDATE users SET notes=? WHERE id=?', [notes||null, req.params.userId]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Change own password ────────────────────────────────────────────────────────
router.post('/orgs/:orgId/users/change-password', requireAuth, requireOrg, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Both passwords required' });
    if (new_password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const user = get('SELECT * FROM users WHERE id=?', [req.user.id]);
    const bcrypt = require('bcryptjs');
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(400).json({ error: 'Current password is incorrect' });
    const hash = await bcrypt.hash(new_password, 10);
    run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id]);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Update org settings (name etc) ────────────────────────────────────────────
// Already handled in org router — this is just a convenience alias

// ── Super admin: request access to an org (org admin must approve) ───────────
router.post('/super-admin/request-access', requireAuth, async (req, res) => {
  try {
    if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
    const { org_id, purpose } = req.body;
    if (!org_id || !purpose) return res.status(400).json({ error: 'org_id and purpose required' });
    const org = get('SELECT * FROM organizations WHERE id=?', [org_id]);
    if (!org) return res.status(404).json({ error: 'Org not found' });

    // Create pending access request — no time-based expiry; access lasts only
    // as long as the super admin keeps the access overlay open, and is revoked
    // the moment they close it.
    const requestId = uuidv4();
    run(`INSERT INTO access_requests (id,super_admin_id,super_admin_name,org_id,purpose,status)
         VALUES (?,?,?,?,?,?)`,
      [requestId, req.user.id, req.user.full_name||req.user.email, org_id, purpose, 'pending']);

    // Notify org admins
    const admins = all(`SELECT u.id FROM users u JOIN org_users ou ON ou.user_id=u.id WHERE ou.org_id=? AND ou.role='admin'`, [org_id]);
    for (const admin of admins) {
      run(`INSERT INTO notifications (id,org_id,user_id,type,title,body,link) VALUES (?,?,?,?,?,?,?)`,
        [uuidv4(), org_id, admin.id, 'access_request',
         `Access request from ${req.user.full_name||'Super Admin'}`,
         `Reason: ${purpose}. Please approve or deny in Settings.`,
         `#settings`]);
    }
    res.json({ success: true, request_id: requestId, message: 'Access request sent to org admin' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Org admin: list pending access requests ────────────────────────────────────
router.get('/access-requests', requireAuth, requireOrg, (req, res) => {
  const requests = all(`SELECT * FROM access_requests WHERE org_id=? AND status='pending' ORDER BY created_at DESC`, [req.orgId]);
  res.json(requests);
});

// ── Super admin: see their own access requests ────────────────────────────────
router.get('/access-requests/mine', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  const requests = all(`SELECT * FROM access_requests WHERE super_admin_id=? ORDER BY created_at DESC`, [req.user.id]);
  res.json(requests);
});

// ── Org admin: approve or deny an access request ──────────────────────────────
router.post('/access-requests/:id/respond', requireAuth, requireOrg, requireOrgAdmin, (req, res) => {
  try {
    const { action } = req.body; // 'approve' or 'deny'
    const request = get('SELECT * FROM access_requests WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Already responded' });

    if (action === 'approve') {
      const token = generateToken({ userId: request.super_admin_id, orgId: req.orgId, superAdminAccess: true });
      run(`UPDATE access_requests SET status='approved',token=?,granted_by=? WHERE id=?`, [token, req.user.id, req.params.id]);
      run(`INSERT INTO super_admin_access (id,super_admin_id,org_id,granted_by,purpose) VALUES (?,?,?,?,?)`,
        [uuidv4(), request.super_admin_id, req.orgId, req.user.id, request.purpose]);
      // Notify super admin
      run(`INSERT INTO notifications (id,org_id,user_id,type,title,body) VALUES (?,?,?,?,?,?)`,
        [uuidv4(), req.orgId, request.super_admin_id, 'access_approved',
         `Access approved for ${get('SELECT name FROM organizations WHERE id=?',[req.orgId])?.name}`,
         `Your access request was approved. Go to All Orgs → Access to use it.`]);
      res.json({ success: true, token });
    } else {
      run(`UPDATE access_requests SET status='denied' WHERE id=?`, [req.params.id]);
      res.json({ success: true });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Super admin: use approved token to switch into org ────────────────────────
router.get('/access-requests/:id/token', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  const request = get('SELECT * FROM access_requests WHERE id=? AND super_admin_id=? AND status=?', [req.params.id, req.user.id, 'approved']);
  if (!request) return res.status(404).json({ error: 'No approved request found' });
  const org = get('SELECT * FROM organizations WHERE id=?', [request.org_id]);
  res.json({ token: request.token, org });
});

// ── Revoke access — called when the super admin closes the access overlay ─────
router.post('/access-requests/:id/revoke', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  const request = get('SELECT * FROM access_requests WHERE id=? AND super_admin_id=?', [req.params.id, req.user.id]);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  run(`UPDATE access_requests SET status='revoked' WHERE id=?`, [req.params.id]);
  res.json({ success: true });
});

// ── User permissions (page-level) ─────────────────────────────────────────────
router.get('/orgs/:orgId/user-permissions/:userId', requireAuth, (req, res) => {
  const perms = all('SELECT * FROM user_permissions WHERE org_id=? AND user_id=?', [req.params.orgId, req.params.userId]);
  res.json(perms);
});

router.put('/orgs/:orgId/user-permissions/:userId', requireAuth, (req, res) => {
  const { permissions } = req.body; // array of {page, can_view, can_edit}
  if (!Array.isArray(permissions)) return res.status(400).json({ error: 'permissions must be array' });
  for (const p of permissions) {
    run(`INSERT INTO user_permissions (id,org_id,user_id,page,can_view,can_edit) VALUES (?,?,?,?,?,?)
         ON CONFLICT(org_id,user_id,page) DO UPDATE SET can_view=excluded.can_view,can_edit=excluded.can_edit`,
      [uuidv4(), req.params.orgId, req.params.userId, p.page, p.can_view?1:0, p.can_edit?1:0]);
  }
  res.json({ success: true });
});

// Super admin: set/update expiry date (and optionally name) for an org
router.put('/orgs/:orgId/expiry', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  const { expires_at, expiry_date, name } = req.body;
  const expiryVal = expiry_date || expires_at || null;
  if (name) run('UPDATE organizations SET name=? WHERE id=?', [name, req.params.orgId]);
  run('UPDATE organizations SET expires_at=?, expiry_warned=0 WHERE id=?', [expiryVal, req.params.orgId]);
  res.json({ success: true });
});

module.exports = router;
