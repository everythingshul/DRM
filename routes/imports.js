// routes/imports.js — Import history management (super admin only for delete)
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../db/schema');
const { requireAuth, requireOrg, requireOrgAdmin } = require('../middleware/auth');

router.use(requireAuth, requireOrg);

function requireSuperAdmin(req, res, next) {
  if (!req.user?.is_super_admin) return res.status(403).json({ error: 'Super admin only' });
  next();
}

// ── List imports ──────────────────────────────────────────────────────────────
router.get('/', requireOrgAdmin, (req, res) => {
  const imports = all(`
    SELECT ih.*, u.full_name as imported_by_name,
      (SELECT COUNT(*) FROM import_items WHERE import_id=ih.id) as donor_count
    FROM import_history ih
    LEFT JOIN users u ON u.id=ih.imported_by
    WHERE ih.org_id=?
    ORDER BY ih.created_at DESC
  `, [req.orgId]);
  res.json(imports);
});

// ── Get import details (list of donors created) ────────────────────────────────
router.get('/:id', requireOrgAdmin, (req, res) => {
  const imp = get('SELECT * FROM import_history WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!imp) return res.status(404).json({ error: 'Import not found' });
  const items = all(`
    SELECT ii.*, d.first_name, d.last_name, d.email, d.cell, d.created_at as donor_created
    FROM import_items ii
    LEFT JOIN donors d ON d.id=ii.donor_id
    WHERE ii.import_id=?
  `, [req.params.id]);
  res.json({ ...imp, items });
});

// ── Delete import (super admin only) — removes donors created by this import ──
router.delete('/:id', requireSuperAdmin, (req, res) => {
  const imp = get('SELECT * FROM import_history WHERE id=? AND org_id=?', [req.params.id, req.orgId]);
  if (!imp) return res.status(404).json({ error: 'Import not found' });

  const items = all('SELECT donor_id FROM import_items WHERE import_id=?', [req.params.id]);
  let deleted = 0;
  for (const item of items) {
    // Only delete if donor has no donations
    const hasDonations = get('SELECT id FROM donations WHERE donor_id=?', [item.donor_id]);
    if (!hasDonations) {
      run('DELETE FROM payment_methods WHERE donor_id=?', [item.donor_id]);
      run('DELETE FROM donors WHERE id=?', [item.donor_id]);
      deleted++;
    }
  }

  run('DELETE FROM import_items WHERE import_id=?', [req.params.id]);
  run('UPDATE import_history SET status=? WHERE id=?', ['deleted', req.params.id]);

  res.json({ success: true, deleted, skipped: items.length - deleted,
    message: `Deleted ${deleted} donors. Skipped ${items.length-deleted} with existing donations.` });
});

module.exports = router;
