'use strict';

const express = require('express');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');

const router = express.Router();

// Shared tenant-scope SQL fragment
function tenantFilter(scope, paramIdx) {
  return scope !== null ? `AND r.tenant_id = $${paramIdx}` : '';
}

// GET /api/admin/registrations?page=1&limit=50&status=active&search=&tenant_id=
router.get('/', async (req, res) => {
  const scope = adminTenantScope(req);
  const page  = Math.max(1, parseInt(req.query.page  || '1',  10));
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  if (scope !== null) { params.push(scope); conditions.push(`r.tenant_id = $${params.length}`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`r.status = $${params.length}`); }
  if (req.query.search) {
    params.push(`%${req.query.search}%`);
    conditions.push(`(r.policy_number ILIKE $${params.length} OR r.email ILIKE $${params.length} OR r.first_name ILIKE $${params.length} OR r.last_name ILIKE $${params.length})`);
  }
  if (req.query.tenant_id && scope === null) {
    params.push(req.query.tenant_id);
    conditions.push(`r.tenant_id = $${params.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) FROM registrations r ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT r.id, r.tenant_id, t.name AS tenant_name, r.policy_number,
            r.first_name, r.last_name, r.email, r.payout_pence,
            r.cover_start_date, r.cover_end_date, r.status, r.created_at,
            COUNT(fr.id) AS flight_count
     FROM registrations r
     JOIN tenants t ON t.id = r.tenant_id
     LEFT JOIN flight_registrations fr ON fr.registration_id = r.id
     ${where}
     GROUP BY r.id, t.name
     ORDER BY r.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return res.json({ total, page, limit, registrations: result.rows });
});

// GET /api/admin/registrations/export — CSV
router.get('/export', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [];
  const conditions = [];

  if (scope !== null) { params.push(scope); conditions.push(`r.tenant_id = $${params.length}`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`r.status = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const result = await query(
    `SELECT r.policy_number, r.first_name, r.last_name, r.email,
            r.payout_pence, r.status, r.cover_start_date, r.cover_end_date,
            r.created_at, t.name AS tenant
     FROM registrations r
     JOIN tenants t ON t.id = r.tenant_id
     ${where}
     ORDER BY r.created_at DESC`,
    params
  );

  const header = 'policy_number,first_name,last_name,email,payout_gbp,status,cover_start,cover_end,registered_at,tenant\n';
  const rows = result.rows.map((r) =>
    [
      r.policy_number, r.first_name, r.last_name, r.email,
      (r.payout_pence / 100).toFixed(2), r.status,
      r.cover_start_date || '', r.cover_end_date || '',
      r.created_at.toISOString().slice(0, 10), r.tenant,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')
  ).join('\n');

  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="registrations-${new Date().toISOString().slice(0, 10)}.csv"`);
  return res.send('\uFEFF' + header + rows);
});

// GET /api/admin/registrations/:id
router.get('/:id', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [req.params.id];
  const tenantClause = scope !== null ? `AND r.tenant_id = $2` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT r.*, t.name AS tenant_name, t.primary_colour
     FROM registrations r
     JOIN tenants t ON t.id = r.tenant_id
     WHERE r.id = $1 ${tenantClause}`,
    params
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Registration not found' });
  const reg = result.rows[0];

  const [flights, payments, notifications] = await Promise.all([
    query(`SELECT * FROM flight_registrations WHERE registration_id = $1 ORDER BY dep_date`, [reg.id]),
    query(`SELECT * FROM payments WHERE registration_id = $1 ORDER BY created_at DESC`, [reg.id]),
    query(`SELECT id, channel, recipient, subject, status, sent_at, created_at FROM notifications WHERE registration_id = $1 ORDER BY created_at DESC LIMIT 20`, [reg.id]),
  ]);

  // Never return bank details in the JSON response
  delete reg.bank_sort_code_enc;
  delete reg.bank_account_enc;

  return res.json({ ...reg, flights: flights.rows, payments: payments.rows, notifications: notifications.rows });
});

// PATCH /api/admin/registrations/:id/status
router.patch('/:id/status', async (req, res) => {
  const { status } = req.body || {};
  const validStatuses = ['active', 'cancelled', 'paid'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${validStatuses.join(', ')}` });
  }

  const scope = adminTenantScope(req);
  const params = [status, req.params.id];
  const tenantClause = scope !== null ? `AND tenant_id = $3` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `UPDATE registrations SET status = $1, updated_at = NOW() WHERE id = $2 ${tenantClause} RETURNING id`,
    params
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Registration not found' });

  // Audit
  await query(
    `INSERT INTO audit_log (tenant_id, admin_user_id, action, entity_type, entity_id, details)
     VALUES ($1,$2,'update_registration_status','registration',$3,$4)`,
    [req.admin.tenant_id, req.admin.sub, req.params.id, JSON.stringify({ status })]
  );

  return res.json({ ok: true });
});

module.exports = router;
