'use strict';

const express = require('express');
const bcrypt  = require('bcryptjs');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');

const router = express.Router();
const SALT_ROUNDS = 12;

// Scope helper — superadmin can specify a tenant_id; tenant admin is locked to their own
function effectiveTenantId(req, bodyTenantId) {
  if (req.admin.role === 'superadmin') return bodyTenantId || null;
  return req.admin.tenant_id;
}

// GET /api/admin/users — list admin users in scope
router.get('/', async (req, res) => {
  const scope = adminTenantScope(req);
  const result = await query(
    `SELECT u.id, u.tenant_id, t.name AS tenant_name,
            u.username, u.email, u.role, u.is_active, u.last_login_at, u.created_at
     FROM admin_users u
     LEFT JOIN tenants t ON t.id = u.tenant_id
     WHERE ($1::int IS NULL OR u.tenant_id = $1)
       AND u.role != 'superadmin'
     ORDER BY u.tenant_id NULLS LAST, u.username`,
    [scope]
  );
  return res.json(result.rows);
});

// POST /api/admin/users — create an admin user
router.post('/', async (req, res) => {
  const { username, email, password, role = 'admin', tenant_id } = req.body || {};

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  if (!['admin', 'readonly'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin or readonly' });
  }

  const assignedTenantId = effectiveTenantId(req, tenant_id ? parseInt(tenant_id, 10) : null);

  // Tenant admins must create users for their own tenant
  if (req.admin.role !== 'superadmin' && assignedTenantId !== req.admin.tenant_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const hash = await bcrypt.hash(password, SALT_ROUNDS);

  try {
    const result = await query(
      `INSERT INTO admin_users (tenant_id, username, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, tenant_id, username, email, role, is_active, created_at`,
      [assignedTenantId, username.trim(), email.trim().toLowerCase(), hash, role]
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.constraint === 'admin_users_username_key') return res.status(409).json({ error: 'Username already taken' });
    if (err.constraint === 'admin_users_email_key')    return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
});

// PATCH /api/admin/users/:id — update username / email / role / is_active
router.patch('/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  // Fetch the target user
  const existing = await query('SELECT id, tenant_id, role FROM admin_users WHERE id = $1', [userId]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found' });

  const target = existing.rows[0];
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Cannot modify a superadmin' });

  // Tenant admin can only edit users in their own tenant
  if (req.admin.role !== 'superadmin' && target.tenant_id !== req.admin.tenant_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { username, email, role, is_active } = req.body || {};
  const allowed = ['admin', 'readonly'];

  const fields = [];
  const params = [];

  if (username !== undefined) { fields.push(`username = $${params.length + 1}`); params.push(username.trim()); }
  if (email    !== undefined) { fields.push(`email = $${params.length + 1}`);    params.push(email.trim().toLowerCase()); }
  if (role     !== undefined) {
    if (!allowed.includes(role)) return res.status(400).json({ error: 'role must be admin or readonly' });
    fields.push(`role = $${params.length + 1}`); params.push(role);
  }
  if (is_active !== undefined) { fields.push(`is_active = $${params.length + 1}`); params.push(Boolean(is_active)); }

  if (fields.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(userId);
  try {
    const result = await query(
      `UPDATE admin_users SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id, tenant_id, username, email, role, is_active`,
      params
    );
    return res.json(result.rows[0]);
  } catch (err) {
    if (err.constraint === 'admin_users_username_key') return res.status(409).json({ error: 'Username already taken' });
    if (err.constraint === 'admin_users_email_key')    return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }
});

// POST /api/admin/users/:id/reset-password
router.post('/:id/reset-password', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  const { new_password } = req.body || {};
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'new_password must be at least 8 characters' });
  }

  const existing = await query('SELECT id, tenant_id, role FROM admin_users WHERE id = $1', [userId]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found' });

  const target = existing.rows[0];
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Cannot reset a superadmin password this way' });

  if (req.admin.role !== 'superadmin' && target.tenant_id !== req.admin.tenant_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const hash = await bcrypt.hash(new_password, SALT_ROUNDS);
  await query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  return res.json({ ok: true });
});

// DELETE /api/admin/users/:id
router.delete('/:id', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });
  if (userId === req.admin.sub) return res.status(409).json({ error: 'You cannot delete your own account' });

  const existing = await query('SELECT id, tenant_id, role FROM admin_users WHERE id = $1', [userId]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found' });

  const target = existing.rows[0];
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Cannot delete a superadmin' });

  if (req.admin.role !== 'superadmin' && target.tenant_id !== req.admin.tenant_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await query('UPDATE pre_validation_tokens SET created_by = NULL WHERE created_by = $1', [userId]);
  await query('DELETE FROM admin_users WHERE id = $1', [userId]);
  return res.json({ ok: true });
});

module.exports = router;
