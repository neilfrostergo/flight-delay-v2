'use strict';

const express = require('express');
const crypto  = require('crypto');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');
const { sendAdminInvite, sendAdminPasswordReset } = require('../../services/notificationService');
const config = require('../../config');

const router = express.Router();

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex
}

function adminBaseUrl() {
  // Use ADMIN_CORS_ORIGIN as the base — it's already the admin app's origin
  return config.cors.adminOrigin || 'http://localhost:3000';
}

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

// POST /api/admin/users — create an admin user and send an invite email
router.post('/', async (req, res) => {
  const { username, email, role = 'admin', tenant_id } = req.body || {};

  if (!username || !email) {
    return res.status(400).json({ error: 'username and email are required' });
  }
  if (!['admin', 'readonly'].includes(role)) {
    return res.status(400).json({ error: 'role must be admin or readonly' });
  }

  const assignedTenantId = effectiveTenantId(req, tenant_id ? parseInt(tenant_id, 10) : null);

  if (req.admin.role !== 'superadmin' && assignedTenantId !== req.admin.tenant_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Create account with a placeholder password hash — cannot be used until set via token
  const placeholderHash = '!unset';

  let newUser;
  try {
    const result = await query(
      `INSERT INTO admin_users (tenant_id, username, email, password_hash, role, is_active)
       VALUES ($1, $2, $3, $4, $5, FALSE)
       RETURNING id, tenant_id, username, email, role, is_active, created_at`,
      [assignedTenantId, username.trim(), email.trim().toLowerCase(), placeholderHash, role]
    );
    newUser = result.rows[0];
  } catch (err) {
    if (err.constraint === 'admin_users_username_key') return res.status(409).json({ error: 'Username already taken' });
    if (err.constraint === 'admin_users_email_key')    return res.status(409).json({ error: 'Email already registered' });
    throw err;
  }

  // Generate a 48-hour invite token and send the email
  const token    = generateToken();
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
  await query(
    `INSERT INTO admin_password_tokens (user_id, token, purpose, expires_at)
     VALUES ($1, $2, 'invite', $3)`,
    [newUser.id, token, expiresAt]
  );

  const setPasswordUrl = `${adminBaseUrl()}/admin?set_password_token=${token}`;
  try {
    await sendAdminInvite({ username: newUser.username, email: newUser.email, setPasswordUrl });
  } catch (emailErr) {
    console.error('[adminUsers] Failed to send invite email:', emailErr.message);
    // Don't fail the request — admin can resend
  }

  return res.status(201).json({ ...newUser, invite_sent: true });
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

// POST /api/admin/users/:id/reset-password — send a password-reset email (no password accepted here)
router.post('/:id/reset-password', async (req, res) => {
  const userId = parseInt(req.params.id, 10);
  if (isNaN(userId)) return res.status(400).json({ error: 'Invalid user ID' });

  const existing = await query(
    'SELECT id, tenant_id, username, email, role FROM admin_users WHERE id = $1',
    [userId]
  );
  if (existing.rows.length === 0) return res.status(404).json({ error: 'User not found' });

  const target = existing.rows[0];
  if (target.role === 'superadmin') return res.status(403).json({ error: 'Cannot reset a superadmin password this way' });

  if (req.admin.role !== 'superadmin' && target.tenant_id !== req.admin.tenant_id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Expire any existing unused tokens for this user
  await query(
    `UPDATE admin_password_tokens SET expires_at = NOW()
     WHERE user_id = $1 AND used_at IS NULL`,
    [userId]
  );

  const token     = generateToken();
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await query(
    `INSERT INTO admin_password_tokens (user_id, token, purpose, expires_at)
     VALUES ($1, $2, 'reset', $3)`,
    [userId, token, expiresAt]
  );

  const setPasswordUrl = `${adminBaseUrl()}/admin?set_password_token=${token}`;
  try {
    await sendAdminPasswordReset({ username: target.username, email: target.email, setPasswordUrl });
  } catch (emailErr) {
    console.error('[adminUsers] Failed to send reset email:', emailErr.message);
    return res.status(500).json({ error: 'Failed to send reset email' });
  }

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
