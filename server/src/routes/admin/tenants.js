'use strict';

const express = require('express');
const Joi     = require('joi');
const { query } = require('../../db/connection');
const { encrypt, isEncrypted } = require('../../services/encryption');
const { invalidateTenantCache } = require('../../middleware/resolveTenant');

const router = express.Router();

const tenantSchema = Joi.object({
  slug:                    Joi.string().trim().lowercase().alphanum().min(2).max(50).required(),
  name:                    Joi.string().trim().max(200).required(),
  subdomain:               Joi.string().trim().lowercase().max(200).required(),
  logo_url:                Joi.string().uri().max(500).allow('', null).optional(),
  primary_colour:          Joi.string().trim().pattern(/^#[0-9a-fA-F]{6}$/).allow('', null).optional(),
  terms_url:               Joi.string().uri().max(500).allow('', null).optional(),
  claim_url:               Joi.string().uri().max(500).allow('', null).optional(),
  register_claim_url:      Joi.string().uri().max(500).allow('', null).optional(),
  my_account_url:          Joi.string().uri().max(500).allow('', null).optional(),
  support_email:           Joi.string().email().max(255).allow('', null).optional(),
  policy_api_url:          Joi.string().uri().max(500).allow('', null).optional(),
  policy_api_key:          Joi.string().max(500).allow('', null).optional(), // plaintext — will be encrypted
  policy_api_secret:       Joi.string().max(500).allow('', null).optional(), // plaintext — will be encrypted
  policy_api_mode:         Joi.string().valid('stub', 'live').optional(),
  policy_api_coverholder_key: Joi.string().trim().max(200).allow('', null).optional(),
  cover_benefit_name:      Joi.string().trim().max(100).allow('', null).optional(),
  modulr_account_id:       Joi.string().trim().max(100).allow('', null).optional(),
  modulr_api_key:          Joi.string().max(500).allow('', null).optional(), // plaintext — will be encrypted
  modulr_mode:             Joi.string().valid('stub', 'live').optional(),
  token_ttl_days:          Joi.number().integer().min(1).max(365).optional(),
  delay_threshold_minutes: Joi.number().integer().min(1).optional(),
  min_hours_before_dep:    Joi.number().integer().min(1).max(168).optional(),
  max_days_before_dep:     Joi.number().integer().min(1).max(365).optional(),
  portal_label:            Joi.string().trim().max(100).allow('', null).optional(),
  is_active:               Joi.boolean().optional(),
});

const RESERVED_SLUGS = ['uat', 'www', 'api', 'admin', 'health', 'mail', 'smtp', 'staging', 'dev', 'test'];

// GET /api/admin/tenants
router.get('/', async (_req, res) => {
  const result = await query(
    `SELECT id, slug, name, subdomain, logo_url, primary_colour, terms_url, support_email,
            claim_url, register_claim_url, my_account_url,
            policy_api_url, policy_api_mode, policy_api_coverholder_key, cover_benefit_name,
            modulr_account_id, modulr_mode,
            token_ttl_days, delay_threshold_minutes, min_hours_before_dep, max_days_before_dep,
            portal_label, is_active, created_at, updated_at
     FROM tenants ORDER BY name`
  );
  return res.json(result.rows);
});

// GET /api/admin/tenants/:id
router.get('/:id', async (req, res) => {
  const result = await query(
    `SELECT id, slug, name, subdomain, logo_url, primary_colour, terms_url, support_email,
            claim_url, register_claim_url, my_account_url,
            policy_api_url, policy_api_mode, policy_api_coverholder_key, cover_benefit_name,
            modulr_account_id, modulr_mode,
            token_ttl_days, delay_threshold_minutes, min_hours_before_dep, max_days_before_dep,
            portal_label, is_active, created_at, updated_at
     FROM tenants WHERE id = $1`,
    [req.params.id]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  return res.json(result.rows[0]);
});

// GET /api/admin/tenants/:id/stats
router.get('/:id/stats', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const [regs, flights, payments] = await Promise.all([
    query(`SELECT COUNT(*) AS total, status FROM registrations WHERE tenant_id=$1 GROUP BY status`, [id]),
    query(`SELECT COUNT(*) AS total, status FROM flight_registrations WHERE tenant_id=$1 GROUP BY status`, [id]),
    query(`SELECT COUNT(*) AS total, COALESCE(SUM(amount_pence),0) AS total_pence, status FROM payments WHERE tenant_id=$1 GROUP BY status`, [id]),
  ]);
  return res.json({ registrations: regs.rows, flights: flights.rows, payments: payments.rows });
});

// POST /api/admin/tenants
router.post('/', async (req, res) => {
  const { error, value } = tenantSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  if (RESERVED_SLUGS.includes(value.slug.toLowerCase())) {
    return res.status(400).json({ error: `Slug "${value.slug}" is reserved and cannot be used` });
  }

  const result = await query(
    `INSERT INTO tenants
       (slug, name, subdomain, logo_url, primary_colour, terms_url, support_email,
        claim_url, register_claim_url, my_account_url,
        policy_api_url, policy_api_key_enc, policy_api_mode, policy_api_coverholder_key, cover_benefit_name,
        modulr_account_id, modulr_api_key_enc, modulr_mode,
        token_ttl_days, delay_threshold_minutes, min_hours_before_dep, max_days_before_dep,
        portal_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
     RETURNING id, slug, name`,
    [
      value.slug, value.name, value.subdomain,
      value.logo_url || null, value.primary_colour || '#1a56db',
      value.terms_url || null, value.support_email || null,
      value.claim_url || null, value.register_claim_url || null, value.my_account_url || null,
      value.policy_api_url || null,
      value.policy_api_key ? encrypt(value.policy_api_key) : null,
      value.policy_api_mode || 'stub',
      value.policy_api_coverholder_key || null,
      value.cover_benefit_name || 'Flight Delay',
      value.modulr_account_id || null,
      value.modulr_api_key ? encrypt(value.modulr_api_key) : null,
      value.modulr_mode || 'stub',
      value.token_ttl_days || 7,
      value.delay_threshold_minutes || 180,
      value.min_hours_before_dep || 24,
      value.max_days_before_dep || 40,
      value.portal_label || 'My Account',
    ]
  );
  return res.status(201).json(result.rows[0]);
});

// PUT /api/admin/tenants/:id
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { error, value } = tenantSchema.validate(req.body, { allowUnknown: true });
  if (error) return res.status(400).json({ error: error.details[0].message });

  if (value.slug && RESERVED_SLUGS.includes(value.slug.toLowerCase())) {
    return res.status(400).json({ error: `Slug "${value.slug}" is reserved and cannot be used` });
  }

  // Fetch existing row to preserve encrypted keys if not updated
  const existing = await query('SELECT policy_api_key_enc, policy_api_secret_enc, modulr_api_key_enc, slug FROM tenants WHERE id = $1', [id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  const prev = existing.rows[0];

  const policyKeyEnc    = value.policy_api_key    ? encrypt(value.policy_api_key)    : prev.policy_api_key_enc;
  const policySecretEnc = value.policy_api_secret ? encrypt(value.policy_api_secret) : prev.policy_api_secret_enc;
  const modulrKeyEnc    = value.modulr_api_key    ? encrypt(value.modulr_api_key)    : prev.modulr_api_key_enc;

  await query(
    `UPDATE tenants SET
       slug=$1, name=$2, subdomain=$3, logo_url=$4, primary_colour=$5,
       terms_url=$6, support_email=$7, claim_url=$8, register_claim_url=$9, my_account_url=$10,
       policy_api_url=$11, policy_api_key_enc=$12, policy_api_secret_enc=$13, policy_api_mode=$14,
       policy_api_coverholder_key=$15, cover_benefit_name=$16,
       modulr_account_id=$17, modulr_api_key_enc=$18, modulr_mode=$19,
       token_ttl_days=$20, delay_threshold_minutes=$21, min_hours_before_dep=$22,
       max_days_before_dep=$23, portal_label=$24, is_active=$25, updated_at=NOW()
     WHERE id=$26`,
    [
      value.slug || prev.slug, value.name, value.subdomain,
      value.logo_url || null, value.primary_colour || '#1a56db',
      value.terms_url || null, value.support_email || null,
      value.claim_url || null, value.register_claim_url || null, value.my_account_url || null,
      value.policy_api_url || null, policyKeyEnc, policySecretEnc, value.policy_api_mode || 'stub',
      value.policy_api_coverholder_key || null,
      value.cover_benefit_name || 'Flight Delay',
      value.modulr_account_id || null, modulrKeyEnc, value.modulr_mode || 'stub',
      value.token_ttl_days || 7, value.delay_threshold_minutes || 180,
      value.min_hours_before_dep || 24,
      value.max_days_before_dep || 40,
      value.portal_label || 'My Account',
      value.is_active !== undefined ? value.is_active : true,
      id,
    ]
  );

  invalidateTenantCache(prev.slug);
  if (value.slug && value.slug !== prev.slug) invalidateTenantCache(value.slug);

  return res.json({ ok: true });
});

// DELETE /api/admin/tenants/:id (soft-deactivate)
router.delete('/:id', async (req, res) => {
  const existing = await query('SELECT slug FROM tenants WHERE id = $1', [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });

  await query('UPDATE tenants SET is_active = FALSE, updated_at = NOW() WHERE id = $1', [req.params.id]);
  invalidateTenantCache(existing.rows[0].slug);
  return res.json({ ok: true });
});

module.exports = router;
