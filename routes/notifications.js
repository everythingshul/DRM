// routes/notifications.js
'use strict';
const express = require('express');
const router  = express.Router({ mergeParams: true });
const { v4: uuidv4 } = require('uuid');
const { get, run, all } = require('../db/schema');
const { requireAuth, requireOrg } = require('../middleware/auth');

router.use(requireAuth, requireOrg);

// Get notifications for current user
router.get('/', (req, res) => {
  const notifs = all(`
    SELECT * FROM notifications
    WHERE org_id=? AND user_id=?
    ORDER BY created_at DESC LIMIT 50
  `, [req.orgId, req.user.id]);
  res.json(notifs);
});

// Mark as read
router.put('/:id/read', (req, res) => {
  run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
  res.json({ success: true });
});

// Mark all as read
router.put('/read-all', (req, res) => {
  run('UPDATE notifications SET is_read=1 WHERE org_id=? AND user_id=?', [req.orgId, req.user.id]);
  res.json({ success: true });
});

// Get unread count
router.get('/unread-count', (req, res) => {
  const r = get('SELECT COUNT(*) as count FROM notifications WHERE org_id=? AND user_id=? AND is_read=0', [req.orgId, req.user.id]);
  res.json({ count: r?.count || 0 });
});

module.exports = router;
