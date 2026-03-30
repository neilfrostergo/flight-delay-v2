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
            policy_api_url, policy_api_mode, cover_benefit_name,
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
    'SELECT policy_api_key_enc, modulr_api_key_enc, slug FROM tenants WHERE id = $1',
    [tenantId]
  );
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  const prev = existing.rows[0];

  const {
    name, support_email, logo_url, primary_colour, terms_url,
    policy_api_url, policy_api_key, policy_api_mode, cover_benefit_name,
    modulr_account_id, modulr_api_key, modulr_mode,
    token_ttl_days, delay_threshold_minutes, min_hours_before_dep,
  } = req.body || {};

  const policyKeyEnc = policy_api_key ? encrypt(policy_api_key) : prev.policy_api_key_enc;
  const modulrKeyEnc = modulr_api_key  ? encrypt(modulr_api_key)  : prev.modulr_api_key_enc;

  await query(
    `UPDATE tenants SET
       name=$1, support_email=$2, logo_url=$3, primary_colour=$4, terms_url=$5,
       policy_api_url=$6, policy_api_key_enc=$7, policy_api_mode=$8, cover_benefit_name=$9,
       modulr_account_id=$10, modulr_api_key_enc=$11, modulr_mode=$12,
       token_ttl_days=$13, delay_threshold_minutes=$14, min_hours_before_dep=$15,
       updated_at=NOW()
     WHERE id=$16`,
    [
      name || null, support_email || null, logo_url || null,
      primary_colour || '#1a56db', terms_url || null,
      policy_api_url || null, policyKeyEnc, policy_api_mode || 'stub',
      cover_benefit_name || 'Flight Delay',
      modulr_account_id || null, modulrKeyEnc, modulr_mode || 'stub',
      token_ttl_days || 7, delay_threshold_minutes || 180, min_hours_before_dep || 24,
      tenantId,
    ]
  );

  invalidateTenantCache(prev.slug);
  return res.json({ ok: true });
});

module.exports = router;
