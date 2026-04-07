'use strict';

const express = require('express');
const crypto  = require('crypto');
const multer  = require('multer');
const Joi     = require('joi');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');
const { sendSingleTripOutreach, sendReturnTripOutreach, sendAnnualMultiTripOutreach } = require('../../services/notificationService');
const { validatePolicy } = require('../../services/policyValidator');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function generateToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex
}

// GET /api/admin/tokens?page=1&limit=50&used=false
router.get('/', async (req, res) => {
  const scope  = adminTenantScope(req);
  const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  if (scope !== null) { params.push(scope); conditions.push(`t.tenant_id = $${params.length}`); }
  else if (req.query.tenant_id) { params.push(req.query.tenant_id); conditions.push(`t.tenant_id = $${params.length}`); }

  if (req.query.used === 'false') conditions.push('t.used_at IS NULL AND t.expires_at > NOW()');
  if (req.query.used === 'true')  conditions.push('t.used_at IS NOT NULL');

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await query(`SELECT COUNT(*) FROM pre_validation_tokens t ${where}`, params);
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT t.id, t.tenant_id, tn.name AS tenant_name, t.policy_number, t.email,
            t.expires_at, t.used_at, t.registration_id, t.created_at,
            t.clicked_at, t.last_clicked_at,
            au.username AS created_by_username
     FROM pre_validation_tokens t
     JOIN tenants tn ON tn.id = t.tenant_id
     LEFT JOIN admin_users au ON au.id = t.created_by
     ${where}
     ORDER BY t.created_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  // Build registration URL for each token
  const rows = result.rows.map((row) => ({
    ...row,
    // URL hint — actual subdomain depends on tenant config; admin assembles the full URL
    tokenUrl: `?token=${row.policy_number ? '' : ''}${row.id}`, // placeholder; SPA builds full URL
  }));

  return res.json({ total, page, limit, tokens: result.rows });
});

// POST /api/admin/tokens — generate a single token
const tokenSchema = Joi.object({
  policy_number: Joi.string().trim().max(100).required(),
  email:         Joi.string().trim().email().max(255).required(),
  tenant_id:     Joi.number().integer().optional(), // superadmin can specify tenant
});

router.post('/', async (req, res) => {
  const scope = adminTenantScope(req);

  const { error, value } = tokenSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  // Determine which tenant gets this token
  let tenantId = scope;
  if (scope === null && value.tenant_id) {
    tenantId = value.tenant_id; // superadmin specified tenant
  }
  if (!tenantId) {
    return res.status(400).json({ error: 'tenant_id required for superadmin token generation' });
  }

  // Fetch tenant for TTL
  const tenantResult = await query('SELECT token_ttl_days, subdomain FROM tenants WHERE id = $1', [tenantId]);
  if (tenantResult.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  const tenant = tenantResult.rows[0];

  const token = generateToken();
  const expiresAt = new Date(Date.now() + tenant.token_ttl_days * 24 * 60 * 60 * 1000);

  const result = await query(
    `INSERT INTO pre_validation_tokens (tenant_id, token, policy_number, email, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, token, policy_number, email, expires_at`,
    [tenantId, token, value.policy_number, value.email, expiresAt, req.admin.sub]
  );

  const row = result.rows[0];
  const tokenUrl = `https://${tenant.subdomain}/register?token=${row.token}`;

  return res.status(201).json({ ...row, tokenUrl });
});

// POST /api/admin/tokens/send-outreach — send registration outreach email for a token
// Policy type is looked up from PolicyHub automatically; no need for the admin to specify it.
router.post('/send-outreach', async (req, res) => {
  const scope = adminTenantScope(req);
  const { token_id, first_name } = req.body || {};

  if (!token_id || !first_name) {
    return res.status(400).json({ error: 'token_id and first_name are required' });
  }

  const params = [token_id];
  const tenantClause = scope !== null ? 'AND t.tenant_id = $2' : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT t.id, t.token, t.policy_number, t.email, t.used_at, t.expires_at,
            tn.id AS tenant_id, tn.name, tn.primary_colour, tn.support_email, tn.subdomain,
            tn.policy_api_mode, tn.policy_api_key_id, tn.policy_api_coverholder_key, tn.cover_benefit_name
     FROM pre_validation_tokens t
     JOIN tenants tn ON tn.id = t.tenant_id
     WHERE t.id = $1 ${tenantClause}`,
    params
  );

  if (result.rows.length === 0) return res.status(404).json({ error: 'Token not found' });

  const row = result.rows[0];
  if (row.used_at) return res.status(400).json({ error: 'Token has already been used' });
  if (new Date(row.expires_at) < new Date()) return res.status(400).json({ error: 'Token has expired' });

  // Look up policy type from PolicyHub (email match skipped — placeholder emails in policy system)
  const tenant = {
    id: row.tenant_id, name: row.name, primary_colour: row.primary_colour, support_email: row.support_email,
    policy_api_mode: row.policy_api_mode, policy_api_key_id: row.policy_api_key_id,
    policy_api_coverholder_key: row.policy_api_coverholder_key, cover_benefit_name: row.cover_benefit_name,
  };
  const policyResult = await validatePolicy(tenant, row.policy_number, row.email, { skipEmailMatch: true });
  const policyType = policyResult.valid ? (policyResult.policyType || 'annual_multi_trip') : 'annual_multi_trip';

  const tokenUrl = `https://${row.subdomain}/register?token=${row.token}`;
  const args = { firstName: first_name, email: row.email, policyNumber: row.policy_number, tokenUrl, tenant };

  if (policyType === 'single_trip') await sendSingleTripOutreach(args);
  else if (policyType === 'return_trip') await sendReturnTripOutreach(args);
  else await sendAnnualMultiTripOutreach(args);

  return res.json({ ok: true, policyType });
});

// POST /api/admin/tokens/import — bulk generate tokens from CSV upload
// Input CSV columns: policy_number, email (required); first_name (optional)
// Returns a CSV with the same rows plus token_url, expires_at, status columns
router.post('/import', upload.single('csv'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

  const scope = adminTenantScope(req);
  let tenantId = scope;
  if (scope === null) {
    const tid = parseInt(req.body.tenant_id, 10);
    if (!tid) return res.status(400).json({ error: 'tenant_id required for superadmin import' });
    tenantId = tid;
  }

  const tenantResult = await query(
    'SELECT token_ttl_days, subdomain FROM tenants WHERE id = $1',
    [tenantId]
  );
  if (tenantResult.rows.length === 0) return res.status(404).json({ error: 'Tenant not found' });
  const tenant = tenantResult.rows[0];

  // ── Parse CSV ──────────────────────────────────────────────────────────────
  const text  = req.file.buffer.toString('utf8');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return res.status(400).json({ error: 'CSV must have a header row and at least one data row' });

  const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const policyIdx = headers.indexOf('policy_number');
  const emailIdx  = headers.indexOf('email');
  const nameIdx   = headers.indexOf('first_name');

  if (policyIdx === -1 || emailIdx === -1) {
    return res.status(400).json({ error: 'CSV must contain policy_number and email columns' });
  }

  function parseRow(line) {
    // Simple CSV parse: handles quoted fields
    const fields = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++;
        let val = '';
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
          else if (line[i] === '"') { i++; break; }
          else val += line[i++];
        }
        fields.push(val);
      } else {
        let val = '';
        while (i < line.length && line[i] !== ',') val += line[i++];
        fields.push(val.trim());
      }
      if (line[i] === ',') i++;
    }
    return fields;
  }

  const rows = lines.slice(1).map(parseRow);

  // ── Generate tokens ────────────────────────────────────────────────────────
  const ttlMs    = tenant.token_ttl_days * 24 * 60 * 60 * 1000;
  const results  = [];
  const skipped  = [];

  for (const fields of rows) {
    const policyNumber = fields[policyIdx]?.trim();
    const email        = fields[emailIdx]?.trim();
    const firstName    = nameIdx !== -1 ? (fields[nameIdx]?.trim() || '') : '';

    if (!policyNumber || !email) { skipped.push({ policyNumber, email, reason: 'missing fields' }); continue; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped.push({ policyNumber, email, reason: 'invalid email' }); continue; }

    const token     = generateToken();
    const expiresAt = new Date(Date.now() + ttlMs);

    try {
      await query(
        `INSERT INTO pre_validation_tokens (tenant_id, token, policy_number, email, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING`,
        [tenantId, token, policyNumber, email, expiresAt, req.admin.sub]
      );
      results.push({
        policy_number: policyNumber,
        email,
        first_name:    firstName,
        token_url:     `https://${tenant.subdomain}/register?token=${token}`,
        expires_at:    expiresAt.toISOString(),
        status:        'created',
      });
    } catch (err) {
      skipped.push({ policyNumber, email, reason: err.message });
    }
  }

  if (results.length === 0) {
    return res.status(422).json({ error: 'No valid rows to import', skipped });
  }

  // ── Build output CSV ───────────────────────────────────────────────────────
  const csvHeader = 'policy_number,email,first_name,token_url,expires_at,status\n';
  const csvRows   = results.map(r =>
    [r.policy_number, r.email, r.first_name, r.token_url, r.expires_at, r.status]
      .map(v => `"${(v || '').replace(/"/g, '""')}"`)
      .join(',')
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="tokens-${Date.now()}.csv"`);
  res.send(csvHeader + csvRows);
});

// GET /api/admin/tokens/funnel — funnel stats for the token campaign
router.get('/funnel', async (req, res) => {
  const scope = adminTenantScope(req);
  const tenantClause = scope !== null ? 'WHERE tenant_id = $1' : '';
  const params = scope !== null ? [scope] : [];

  const result = await query(
    `SELECT
       COUNT(*)                                         AS total_issued,
       COUNT(clicked_at)                               AS clicked,
       COUNT(registration_id)                          AS registered,
       COUNT(CASE WHEN r.id IS NOT NULL
                   AND EXISTS (
                     SELECT 1 FROM flight_registrations fr
                     WHERE fr.registration_id = r.id AND fr.status = 'paid'
                   ) THEN 1 END)                       AS paid
     FROM pre_validation_tokens t
     LEFT JOIN registrations r ON r.id = t.registration_id
     ${tenantClause}`,
    params
  );

  const row = result.rows[0];
  return res.json({
    total_issued: parseInt(row.total_issued, 10),
    clicked:      parseInt(row.clicked, 10),
    registered:   parseInt(row.registered, 10),
    paid:         parseInt(row.paid, 10),
  });
});

// DELETE /api/admin/tokens/:id — revoke (expire immediately)
router.delete('/:id', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [req.params.id];
  const tenantClause = scope !== null ? `AND tenant_id = $2` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `UPDATE pre_validation_tokens SET expires_at = NOW()
     WHERE id = $1 ${tenantClause} AND used_at IS NULL
     RETURNING id`,
    params
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Token not found or already used' });
  return res.json({ ok: true });
});

module.exports = router;
