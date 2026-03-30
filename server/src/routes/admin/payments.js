'use strict';

const express = require('express');
const { query } = require('../../db/connection');
const { decrypt } = require('../../services/encryption');
const modulr = require('../../services/modulr');
const { adminTenantScope } = require('../../middleware/requireAdmin');

const router = express.Router();

// GET /api/admin/payments?page=1&limit=50&status=paid
router.get('/', async (req, res) => {
  const scope  = adminTenantScope(req);
  const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  if (scope !== null) { params.push(scope); conditions.push(`p.tenant_id = $${params.length}`); }
  if (req.query.status) { params.push(req.query.status); conditions.push(`p.status = $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) FROM payments p ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT p.id, p.tenant_id, t.name AS tenant_name,
            p.registration_id, p.flight_registration_id,
            p.amount_pence, p.status, p.modulr_payment_id, p.modulr_reference,
            p.failure_reason, p.created_at, p.updated_at,
            r.policy_number, r.first_name, r.last_name, r.email,
            fr.flight_number, fr.dep_date
     FROM payments p
     JOIN registrations r ON r.id = p.registration_id
     JOIN flight_registrations fr ON fr.id = p.flight_registration_id
     JOIN tenants t ON t.id = p.tenant_id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return res.json({ total, page, limit, payments: result.rows });
});

// GET /api/admin/payments/:id
router.get('/:id', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [req.params.id];
  const tenantClause = scope !== null ? `AND p.tenant_id = $2` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT p.*, r.policy_number, r.first_name, r.last_name, r.email,
            fr.flight_number, fr.dep_date, fr.dep_iata, fr.arr_iata,
            t.name AS tenant_name
     FROM payments p
     JOIN registrations r ON r.id = p.registration_id
     JOIN flight_registrations fr ON fr.id = p.flight_registration_id
     JOIN tenants t ON t.id = p.tenant_id
     WHERE p.id = $1 ${tenantClause}`,
    params
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
  return res.json(result.rows[0]);
});

// POST /api/admin/payments/:id/retry — retry a failed payment
router.post('/:id/retry', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [req.params.id];
  const tenantClause = scope !== null ? `AND p.tenant_id = $2` : '';
  if (scope !== null) params.push(scope);

  const paymentResult = await query(
    `SELECT p.*, r.bank_sort_code_enc, r.bank_account_enc, r.first_name, r.last_name,
            t.modulr_mode, t.modulr_account_id, t.modulr_api_key_enc,
            t.id AS tenant_id, t.slug AS tenant_slug, t.name AS tenant_name
     FROM payments p
     JOIN registrations r ON r.id = p.registration_id
     JOIN tenants t ON t.id = p.tenant_id
     WHERE p.id = $1 ${tenantClause}`,
    params
  );

  if (paymentResult.rows.length === 0) return res.status(404).json({ error: 'Payment not found' });
  const payment = paymentResult.rows[0];

  if (payment.status !== 'failed') {
    return res.status(400).json({ error: 'Only failed payments can be retried' });
  }

  const sortCode      = decrypt(payment.bank_sort_code_enc);
  const accountNumber = decrypt(payment.bank_account_enc);

  const tenant = {
    id: payment.tenant_id, slug: payment.tenant_slug, name: payment.tenant_name,
    modulr_mode: payment.modulr_mode, modulr_account_id: payment.modulr_account_id,
    modulr_api_key_enc: payment.modulr_api_key_enc,
  };

  await query(`UPDATE payments SET status = 'processing', updated_at = NOW() WHERE id = $1`, [payment.id]);

  const modulrResult = await modulr.sendPayment(tenant, {
    sortCode, accountNumber,
    amountPence: payment.amount_pence,
    reference: `FDP-R${payment.id}`.slice(0, 18),
    internalPaymentId: payment.id,
    holderName: `${payment.first_name} ${payment.last_name}`,
  });

  if (modulrResult.success) {
    await query(
      `UPDATE payments SET status='paid', modulr_payment_id=$1, modulr_reference=$2, failure_reason=NULL, updated_at=NOW() WHERE id=$3`,
      [modulrResult.modulrPaymentId, modulrResult.modulrReference, payment.id]
    );
    await query(
      `INSERT INTO audit_log (tenant_id, admin_user_id, action, entity_type, entity_id, details)
       VALUES ($1,$2,'retry_payment','payment',$3,$4)`,
      [payment.tenant_id, req.admin.sub, payment.id, JSON.stringify({ success: true })]
    );
    return res.json({ ok: true, modulrPaymentId: modulrResult.modulrPaymentId });
  } else {
    await query(
      `UPDATE payments SET status='failed', failure_reason=$1, updated_at=NOW() WHERE id=$2`,
      [modulrResult.failureReason, payment.id]
    );
    return res.status(502).json({ error: modulrResult.failureReason || 'Payment failed' });
  }
});

module.exports = router;
