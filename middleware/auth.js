// middleware/auth.js
const jwt = require('jsonwebtoken');
const { get } = require('../db/schema');

const JWT_SECRET = process.env.JWT_SECRET || 'drm-secret-change-in-production';
const SESSION_HOURS = 24;

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
}

function requireAuth(req, res, next) {
  const token = req.cookies?.drm_token || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = get('SELECT * FROM users WHERE id = ?', [decoded.userId]);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    req.token = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Session expired' });
  }
}

function requireOrg(req, res, next) {
  const orgId = req.params.orgId || req.body.orgId || req.query.orgId || req.headers['x-org-id'];
  if (!orgId) return res.status(400).json({ error: 'Org ID required' });

  const org = get('SELECT * FROM organizations WHERE id = ?', [orgId]);
  if (!org) return res.status(404).json({ error: 'Organization not found' });

  // Check membership unless super admin
  if (!req.user.is_super_admin) {
    const membership = get('SELECT * FROM org_users WHERE org_id = ? AND user_id = ? AND removed_at IS NULL', [orgId, req.user.id]);
    if (!membership) return res.status(403).json({ error: 'Access denied' });
    req.orgRole = membership.role;
  } else {
    req.orgRole = 'admin';
  }

  req.org = org;
  req.orgId = orgId;
  next();
}

function requireOrgAdmin(req, res, next) {
  if (req.orgRole !== 'admin' && !req.user.is_super_admin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { generateToken, requireAuth, requireOrg, requireOrgAdmin, JWT_SECRET };
