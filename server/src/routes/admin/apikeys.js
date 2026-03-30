'use strict';

const express = require('express');
const Joi     = require('joi');
const { query } = require('../../db/connection');
const { encrypt, decrypt } = require('../../services/encryption');

const router = express.Router();

// GET /api/admin/apikeys
router.get('/', async (_req, res) => {
  const result = await query(
    `SELECT id, service_name, display_name, endpoint_url, is_active, notes, created_at, updated_at
     FROM shared_api_keys ORDER BY service_name`
  );
  return res.json(result.rows);
});

// POST /api/admin/apikeys
router.post('/', async (req, res) => {
  const schema = Joi.object({
    service_name:  Joi.string().trim().max(100).required(),
    display_name:  Joi.string().trim().max(100).required(),
    key_value:     Joi.string().max(1000).required(),
    endpoint_url:  Joi.string().uri().max(500).allow('', null).optional(),
    is_active:     Joi.boolean().optional(),
    notes:         Joi.string().max(500).allow('', null).optional(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const result = await query(
    `INSERT INTO shared_api_keys (service_name, display_name, key_enc, endpoint_url, is_active, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, service_name, display_name`,
    [
      value.service_name.toLowerCase(), value.display_name,
      encrypt(value.key_value),
      value.endpoint_url || null, value.is_active !== false, value.notes || null,
    ]
  );

  await query(
    `INSERT INTO audit_log (admin_user_id, action, entity_type, entity_id, details)
     VALUES ($1,'create_api_key','shared_api_key',$2,$3)`,
    [req.admin.sub, result.rows[0].id, JSON.stringify({ service_name: value.service_name })]
  );

  return res.status(201).json(result.rows[0]);
});

// GET /api/admin/apikeys/:id/reveal
router.get('/:id/reveal', async (req, res) => {
  const result = await query('SELECT key_enc, service_name FROM shared_api_keys WHERE id = $1', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Key not found' });

  await query(
    `INSERT INTO audit_log (admin_user_id, action, entity_type, entity_id, details)
     VALUES ($1,'reveal_api_key','shared_api_key',$2,$3)`,
    [req.admin.sub, req.params.id, JSON.stringify({ service_name: result.rows[0].service_name })]
  );

  return res.json({ key_value: decrypt(result.rows[0].key_enc) });
});

// PUT /api/admin/apikeys/:id
router.put('/:id', async (req, res) => {
  const schema = Joi.object({
    service_name:  Joi.string().trim().max(100).optional(), // ignored on update but accepted
    display_name:  Joi.string().trim().max(100).optional(),
    key_value:     Joi.string().max(1000).allow('', null).optional(),
    endpoint_url:  Joi.string().uri().max(500).allow('', null).optional(),
    is_active:     Joi.boolean().optional(),
    notes:         Joi.string().max(500).allow('', null).optional(),
  });
  const { error, value } = schema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  const existing = await query('SELECT key_enc FROM shared_api_keys WHERE id = $1', [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: 'Key not found' });

  const keyEnc = value.key_value ? encrypt(value.key_value) : existing.rows[0].key_enc;

  await query(
    `UPDATE shared_api_keys SET
       display_name = COALESCE($1, display_name),
       key_enc = $2,
       endpoint_url = COALESCE($3, endpoint_url),
       is_active = COALESCE($4, is_active),
       notes = COALESCE($5, notes),
       updated_at = NOW()
     WHERE id = $6`,
    [value.display_name || null, keyEnc, value.endpoint_url || null, value.is_active ?? null, value.notes || null, req.params.id]
  );

  return res.json({ ok: true });
});

// DELETE /api/admin/apikeys/:id
router.delete('/:id', async (req, res) => {
  const result = await query('DELETE FROM shared_api_keys WHERE id = $1 RETURNING id', [req.params.id]);
  if (result.rows.length === 0) return res.status(404).json({ error: 'Key not found' });
  return res.json({ ok: true });
});

module.exports = router;
