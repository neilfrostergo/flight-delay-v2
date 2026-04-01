'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { query } = require('../../db/connection');
const config    = require('../../config');
const { requireAdmin } = require('../../middleware/requireAdmin');

const router = express.Router();
const SALT_ROUNDS = 12;

// POST /api/admin/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }

  const result = await query(
    `SELECT id, tenant_id, username, email, role, password_hash, is_active
     FROM admin_users WHERE username = $1`,
    [String(username).trim()]
  );
  const user = result.rows[0];

  // Constant-time comparison to prevent timing oracle attacks
  const dummyHash = '$2b$12$invalidhashusedtoblindtimingattacks000000000000000000000';
  const hashToCompare = user ? user.password_hash : dummyHash;
  const passwordMatch = await bcrypt.compare(password, hashToCompare);

  if (!user || !passwordMatch || !user.is_active) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  await query('UPDATE admin_users SET last_login_at = NOW() WHERE id = $1', [user.id]);

  const token = jwt.sign(
    { sub: user.id, username: user.username, role: user.role, tenant_id: user.tenant_id },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );

  return res.json({
    token,
    user: { id: user.id, username: user.username, email: user.email, role: user.role, tenantId: user.tenant_id },
  });
});

// GET /api/admin/auth/me
router.get('/me', requireAdmin, async (req, res) => {
  const result = await query(
    `SELECT u.id, u.tenant_id, u.username, u.email, u.role, u.last_login_at,
            t.name AS tenant_name, t.primary_colour
     FROM admin_users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE u.id = $1 AND u.is_active = TRUE`,
    [req.admin.sub]
  );
  if (result.rows.length === 0) {
    return res.status(401).json({ error: 'User not found or inactive' });
  }
  const u = result.rows[0];
  return res.json({
    id: u.id, tenant_id: u.tenant_id, username: u.username, email: u.email,
    role: u.role, lastLoginAt: u.last_login_at,
    tenant_name: u.tenant_name, primary_colour: u.primary_colour,
  });
});

// POST /api/admin/auth/change-password
router.post('/change-password', requireAdmin, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password and new_password required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  const result = await query('SELECT password_hash FROM admin_users WHERE id = $1', [req.admin.sub]);
  const user = result.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const match = await bcrypt.compare(current_password, user.password_hash);
  if (!match) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(new_password, SALT_ROUNDS);
  await query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [newHash, req.admin.sub]);

  return res.json({ ok: true });
});

module.exports = router;
