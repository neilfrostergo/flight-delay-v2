'use strict';

const express = require('express');
const { decrypt } = require('../../services/encryption');
const { query } = require('../../db/connection');

const router = express.Router();

// GET /api/admin/coverholders?tenantId=<id>
// Proxies the PolicyHub /api/coverholders endpoint for the given tenant.
// Returns an array of { key, name } objects for the superadmin dropdown.
router.get('/', async (req, res) => {
  const tenantId = parseInt(req.query.tenantId, 10);
  if (!tenantId || isNaN(tenantId)) {
    return res.status(400).json({ error: 'tenantId query parameter is required' });
  }

  const result = await query(
    'SELECT policy_api_url, policy_api_key_enc FROM tenants WHERE id = $1',
    [tenantId]
  );
  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const tenant = result.rows[0];
  if (!tenant.policy_api_url || !tenant.policy_api_key_enc) {
    return res.status(422).json({ error: 'Tenant has no policy API configured' });
  }

  let apiKey;
  try {
    apiKey = decrypt(tenant.policy_api_key_enc);
  } catch {
    return res.status(500).json({ error: 'Failed to decrypt API key' });
  }

  const baseUrl = tenant.policy_api_url.replace(/\/$/, '');
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

  return res.json(Array.isArray(body) ? body : []);
});

module.exports = router;
