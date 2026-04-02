'use strict';

const express = require('express');
const { decrypt } = require('../../services/encryption');
const { query } = require('../../db/connection');

const router = express.Router();

// GET /api/admin/coverholders?keyId=<shared_api_keys id>
// Proxies the PolicyHub /api/coverholders endpoint using a shared API key entry.
// Returns an array of { key, name } objects for the tenant coverholder dropdown.
router.get('/', async (req, res) => {
  const keyId = parseInt(req.query.keyId, 10);
  if (!keyId || isNaN(keyId)) {
    return res.status(400).json({ error: 'keyId query parameter is required' });
  }

  const result = await query(
    'SELECT key_enc, endpoint_url FROM shared_api_keys WHERE id = $1 AND is_active = true',
    [keyId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'API key not found or inactive' });
  }

  const { key_enc, endpoint_url } = result.rows[0];
  if (!endpoint_url) {
    return res.status(422).json({ error: 'API key entry has no endpoint URL configured' });
  }

  let apiKey;
  try {
    apiKey = decrypt(key_enc);
  } catch {
    return res.status(500).json({ error: 'Failed to decrypt API key' });
  }

  const baseUrl = endpoint_url.replace(/\/$/, '');
  const url = `${baseUrl}/api/coverholders`;

  let body;
  try {
    const upstream = await fetch(url, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(15000),
    });
    if (!upstream.ok) {
      return res.status(502).json({ error: `PolicyHub returned HTTP ${upstream.status}` });
    }
    body = await upstream.json();
  } catch (err) {
    return res.status(502).json({ error: `PolicyHub request failed: ${err.message}` });
  }

  const holders = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : []);
  return res.json(holders);
});

module.exports = router;
