'use strict';

const express = require('express');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');

const router = express.Router();

// GET /api/admin/flights?page=1&limit=50&status=active&date_from=&date_to=
router.get('/', async (req, res) => {
  const scope  = adminTenantScope(req);
  const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  if (scope !== null) { params.push(scope); conditions.push(`fr.tenant_id = $${params.length}`); }
  if (req.query.status)    { params.push(req.query.status);    conditions.push(`fr.status = $${params.length}`); }
  if (req.query.date_from) { params.push(req.query.date_from); conditions.push(`fr.dep_date >= $${params.length}`); }
  if (req.query.date_to)   { params.push(req.query.date_to);   conditions.push(`fr.dep_date <= $${params.length}`); }
  if (req.query.flight)    { params.push(`%${req.query.flight}%`); conditions.push(`fr.flight_number ILIKE $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) FROM flight_registrations fr ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT fr.id, fr.flight_number, fr.carrier_code, fr.dep_iata, fr.arr_iata,
            fr.dep_date, fr.scheduled_dep_time, fr.status,
            fr.tenant_id, t.name AS tenant_name,
            r.policy_number, r.first_name, r.last_name, r.email, r.payout_pence,
            fas.oag_alert_id, fas.status AS subscription_status
     FROM flight_registrations fr
     JOIN registrations r ON r.id = fr.registration_id
     JOIN tenants t ON t.id = fr.tenant_id
     LEFT JOIN flight_alert_subscriptions fas ON fas.id = fr.flight_subscription_id
     ${where}
     ORDER BY fr.dep_date ASC, fr.flight_number
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return res.json({ total, page, limit, flights: result.rows });
});

// GET /api/admin/flights/:id
router.get('/:id', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [req.params.id];
  const tenantClause = scope !== null ? `AND fr.tenant_id = $2` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT fr.*, r.policy_number, r.first_name, r.last_name, r.email, r.payout_pence,
            t.name AS tenant_name,
            fas.carrier_code, fas.oag_alert_id, fas.status AS subscription_status
     FROM flight_registrations fr
     JOIN registrations r ON r.id = fr.registration_id
     JOIN tenants t ON t.id = fr.tenant_id
     LEFT JOIN flight_alert_subscriptions fas ON fas.id = fr.flight_subscription_id
     WHERE fr.id = $1 ${tenantClause}`,
    params
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Flight registration not found' });

  const fr = result.rows[0];
  const payments = await query(
    'SELECT * FROM payments WHERE flight_registration_id = $1 ORDER BY created_at DESC',
    [fr.id]
  );

  return res.json({ ...fr, payments: payments.rows });
});

module.exports = router;
