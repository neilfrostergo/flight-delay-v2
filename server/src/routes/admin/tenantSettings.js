'use strict';

const express = require('express');
const { query } = require('../../db/connection');
const { encrypt } = require('../../services/encryption');
const { invalidateTenantCache } = require('../../middleware/resolveTenant');

const router = express.Router();

// GET /api/admin/tenant-settings — tenant admin reads their own tenant
router.get('/', async (req, res) => {
  const tenantId = req.admin.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'Superadmins use /api/admin/tenants/:id' });

  const result = await query(
    `SELECT id, slug, name, subdomain, logo_url, primary_colour, terms_url, support_email,
            claim_url, register_claim_url, my_account_url,
            policy_api_key_id, policy_api_mode, cover_benefit_name,
            modulr_account_id, modulr_mode,
            token_ttl_days, delay_threshold_minutes, min_hours_before_dep,
            is_active, created_at, updated_at
     FROM tenants WHERE id = $1`,
    [tenantId]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  return res.json(result.rows[0]);
});

// PATCH /api/admin/tenant-settings — tenant admin updates their own tenant
router.patch('/', async (req, res) => {
  const tenantId = req.admin.tenant_id;
  if (!tenantId) return res.status(403).json({ error: 'Superadmins use /api/admin/tenants/:id' });

  const existing = await query(
    'SELECT modulr_api_key_enc, slug FROM tenants WHERE id = $1',
    [tenantId]
  );
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  const prev = existing.rows[0];

  const {
    name, support_email, logo_url, primary_colour, terms_url, claim_url, register_claim_url, my_account_url,
    policy_api_mode, cover_benefit_name,
    modulr_account_id, modulr_api_key, modulr_mode,
    token_ttl_days, delay_threshold_minutes, min_hours_before_dep,
  } = req.body || {};

  const modulrKeyEnc = modulr_api_key ? encrypt(modulr_api_key) : prev.modulr_api_key_enc;

  await query(
    `UPDATE tenants SET
       name=$1, support_email=$2, logo_url=$3, primary_colour=$4, terms_url=$5,
       claim_url=$6, register_claim_url=$7, my_account_url=$8,
       policy_api_mode=$9, cover_benefit_name=$10,
       modulr_account_id=$11, modulr_api_key_enc=$12, modulr_mode=$13,
       token_ttl_days=$14, delay_threshold_minutes=$15, min_hours_before_dep=$16,
       updated_at=NOW()
     WHERE id=$17`,
    [
      name || null, support_email || null, logo_url || null,
      primary_colour || '#1a56db', terms_url || null,
      claim_url || null, register_claim_url || null, my_account_url || null,
      policy_api_mode || 'stub', cover_benefit_name || 'Flight Delay',
      modulr_account_id || null, modulrKeyEnc, modulr_mode || 'stub',
      token_ttl_days || 7, delay_threshold_minutes || 180, min_hours_before_dep || 24,
      tenantId,
    ]
  );

  invalidateTenantCache(prev.slug);
  return res.json({ ok: true });
});

module.exports = router;
