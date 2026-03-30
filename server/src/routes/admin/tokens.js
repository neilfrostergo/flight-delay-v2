'use strict';

const express = require('express');
const crypto  = require('crypto');
const Joi     = require('joi');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');
const { sendSingleTripOutreach, sendReturnTripOutreach, sendAnnualMultiTripOutreach } = require('../../services/notificationService');

const router = express.Router();

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex
}

// GET /api/admin/tokens?page=1&limit=50&used=false
router.get('/', async (req, res) => {
  const scope  = adminTenantScope(req);
  const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  if (scope !== null) { params.push(scope); conditions.push(`t.tenant_id = $${params.length}`); }
  else if (req.query.tenant_id) { params.push(req.query.tenant_id); conditions.push(`t.tenant_id = $${params.length}`); }

  if (req.query.used === 'false') conditions.push('t.used_at IS NULL AND t.expires_at > NOW()');
  if (req.query.used === 'true')  conditions.push('t.used_at IS NOT NULL');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) FROM pre_validation_tokens t ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT t.id, t.tenant_id, tn.name AS tenant_name, t.policy_number, t.email,
            t.expires_at, t.used_at, t.registration_id, t.created_at,
            au.username AS created_by_username
     FROM pre_validation_tokens t
     JOIN tenants tn ON tn.id = t.tenant_id
     LEFT JOIN admin_users au ON au.id = t.created_by
     ${where}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // Build registration URL for each token
  const rows = result.rows.map((row) => ({
    ...row,
    // URL hint — actual subdomain depends on tenant config; admin assembles the full URL
    tokenUrl: `?token=${row.policy_number ? '' : ''}${row.id}`, // placeholder; SPA builds full URL
  }));

  return res.json({ total, page, limit, tokens: result.rows });
});

// POST /api/admin/tokens — generate a single token
const tokenSchema = Joi.object({
  policy_number: Joi.string().trim().max(100).required(),
  email:         Joi.string().trim().email().max(255).required(),
  tenant_id:     Joi.number().integer().optional(), // superadmin can specify tenant
});

router.post('/', async (req, res) => {
  const scope = adminTenantScope(req);

  const { error, value } = tokenSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  // Determine which tenant gets this token
  let tenantId = scope;
  if (scope === null && value.tenant_id) {
    tenantId = value.tenant_id; // superadmin specified tenant
  }
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant_id required for superadmin token generation' });
  }

  // Fetch tenant for TTL
  const tenantResult = await query('SELECT token_ttl_days, subdomain FROM tenants WHERE id = $1', [tenantId]);
  if (tenantResult.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  const tenant = tenantResult.rows[0];

  const token = generateToken();
  const expiresAt = new Date(Date.now() + tenant.token_ttl_days * 24 * 60 * 60 * 1000);

  const result = await query(
    `INSERT INTO pre_validation_tokens (tenant_id, token, policy_number, email, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, token, policy_number, email, expires_at`,
    [tenantId, token, value.policy_number, value.email, expiresAt, req.admin.sub]
  );

  const row = result.rows[0];
  const tokenUrl = `https://${tenant.subdomain}/register?token=${row.token}`;

  return res.status(201).json({ ...row, tokenUrl });
});

// POST /api/admin/tokens/send-outreach — send registration outreach email for a token
router.post('/send-outreach', async (req, res) => {
  const scope = adminTenantScope(req);
  const { token_id, first_name, type } = req.body || {};

  if (!token_id || !first_name || !type) {
    return res.status(400).json({ error: 'token_id, first_name and type are required' });
  }
  if (!['single', 'return', 'amt'].includes(type)) {
    return res.status(400).json({ error: 'type must be single, return or amt' });
  }

  const params = [token_id];
  const tenantClause = scope !== null ? 'AND t.tenant_id = $2' : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT t.id, t.token, t.policy_number, t.email, t.used_at, t.expires_at,
            tn.id AS tenant_id, tn.name, tn.primary_colour, tn.support_email, tn.subdomain
     FROM pre_validation_tokens t
     JOIN tenants tn ON tn.id = t.tenant_id
     WHERE t.id = $1 ${tenantClause}`,
    params
  );

  if (result.rows.length === 0) return res.status(404).json({ error: 'Token not found' });

  const row = result.rows[0];
  if (row.used_at) return res.status(400).json({ error: 'Token has already been used' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Token has expired' });

  const tenant = { id: row.tenant_id, name: row.name, primary_colour: row.primary_colour, support_email: row.support_email };
  const tokenUrl = `https://${row.subdomain}/register?token=${row.token}`;
  const args = { firstName: first_name, email: row.email, policyNumber: row.policy_number, tokenUrl, tenant };

  if (type === 'single') await sendSingleTripOutreach(args);
  else if (type === 'return') await sendReturnTripOutreach(args);
  else await sendAnnualMultiTripOutreach(args);

  return res.json({ ok: true });
});

// DELETE /api/admin/tokens/:id — revoke (expire immediately)
router.delete('/:id', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [req.params.id];
  const tenantClause = scope !== null ? `AND tenant_id = $2` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `UPDATE pre_validation_tokens SET expires_at = NOW()
     WHERE id = $1 ${tenantClause} AND used_at IS NULL
     RETURNING id`,
    params
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Token not found or already used' });
  return res.json({ ok: true });
});

module.exports = router;
