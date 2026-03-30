'use strict';

const express = require('express');
const { query } = require('../../db/connection');

const router = express.Router();

// GET /api/admin/request-log?page=1&limit=100&method=GET&status_class=2&path=&tenant_id=
router.get('/', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page || '1', 10));
  const limit  = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  if (req.query.method) { params.push(req.query.method.toUpperCase()); conditions.push(`method = $${params.length}`); }
  if (req.query.status_class) {
    const cls = parseInt(req.query.status_class, 10);
    params.push(cls * 100, cls * 100 + 99);
    conditions.push(`status BETWEEN $${params.length - 1} AND $${params.length}`);
  }
  if (req.query.path)      { params.push(`%${req.query.path}%`); conditions.push(`path ILIKE $${params.length}`); }
  if (req.query.tenant_id) { params.push(req.query.tenant_id); conditions.push(`tenant_id = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) FROM request_log ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT rl.id, rl.tenant_id, t.name AS tenant_name, rl.method, rl.path,
            rl.status, rl.duration_ms, rl.ip_address, rl.user_agent, rl.created_at
     FROM request_log rl
     LEFT JOIN tenants t ON t.id = rl.tenant_id
     ${where}
     ORDER BY rl.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return res.json({ total, page, limit, logs: result.rows });
});

// DELETE /api/admin/request-log?days=30
router.delete('/', async (req, res) => {
  const days = Math.max(1, parseInt(req.query.days || '30', 10));
  const result = await query(
    `DELETE FROM request_log WHERE created_at < NOW() - ($1 || ' days')::interval RETURNING id`,
    [days]
  );
  return res.json({ deleted: result.rows.length });
});

module.exports = router;
