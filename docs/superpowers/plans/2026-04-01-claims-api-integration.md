# Claims API Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing Ergo Connect policy validator (POST + OAuth2) with the new Claims API (GET + `X-API-Key` + `coverHolderKey`), and add a coverholder picker to the superadmin tenant modal so the coverholder key can be selected from a live list.

**Architecture:** Four sequential changes — (1) DB column, (2) data-layer routes, (3) backend proxy endpoint + `policyValidator.js` rewrite, (4) admin SPA. The stub validator is never touched. Payout extraction from `policyOptions[]` is structurally complete but logs the raw array for inspection once a real test key is available — that one field name is deferred.

**Tech Stack:** Node.js 20 / Express 5 / PostgreSQL 16 / Joi / native `fetch` (Node 20 built-in) / vanilla JS admin SPA

---

## File map

| File | Change |
|---|---|
| `server/src/db/migrations/011_claims_api.sql` | CREATE — adds `policy_api_coverholder_key` column |
| `server/src/routes/admin/tenants.js` | MODIFY — Joi schema + both SELECTs + INSERT + UPDATE |
| `server/src/routes/admin/tenantSettings.js` | MODIFY — SELECT (read-only for tenant admin) |
| `server/src/routes/admin/coverholderProxy.js` | CREATE — superadmin proxy → Claims API `/api/coverholders` |
| `server/src/index.js` | MODIFY — import + mount coverholderProxy route |
| `server/src/services/policyValidator.js` | MODIFY — remove OAuth2, rewrite `liveValidate()` for Claims API |
| `admin/index.html` | MODIFY — tenant modal coverholder picker + hide secret field + settings read-only display |

---

### Task 1: DB migration — add `policy_api_coverholder_key`

**Files:**
- Create: `server/src/db/migrations/011_claims_api.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Claims API: per-tenant coverholder key (short code, e.g. "CH001").
-- The existing policy_api_key_enc column now stores the Claims API X-API-Key.
-- policy_api_secret_enc is no longer used but retained to avoid a destructive migration.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS policy_api_coverholder_key VARCHAR(100) DEFAULT NULL;
```

- [ ] **Step 2: Run the migration**

```bash
docker compose run --rm app npm run migrate
```

Expected: `011_claims_api.sql` appears in the migration output with no errors.

- [ ] **Step 3: Verify the column exists**

```bash
docker compose exec db psql -U postgres -d flightdelay -c "\d tenants" | grep coverholder
```

Expected: a line containing `policy_api_coverholder_key | character varying(100)`

- [ ] **Step 4: Commit**

```bash
git add server/src/db/migrations/011_claims_api.sql
git commit -m "feat: add policy_api_coverholder_key column to tenants"
```

---

### Task 2: Thread `policy_api_coverholder_key` through the backend routes

**Files:**
- Modify: `server/src/routes/admin/tenants.js`
- Modify: `server/src/routes/admin/tenantSettings.js`

**Context — current parameter numbering in `tenants.js`:**

INSERT currently has 22 params (`$1–$22`). We insert `policy_api_coverholder_key` between `policy_api_mode` and `cover_benefit_name`, making it 23 params.

UPDATE currently ends at `WHERE id=$25`. After inserting the new column after `policy_api_mode=$14`, everything from `$15` onwards shifts by one, making it `WHERE id=$26`.

The `tenantSettings.js` PATCH does **not** include `policy_api_coverholder_key` — tenant admins cannot change it, only superadmin can. The GET SELECT is updated so the SPA can display it read-only.

- [ ] **Step 1: Add to the Joi schema in `tenants.js` (line 25, after `policy_api_mode`)**

```js
  policy_api_coverholder_key: Joi.string().trim().max(100).allow('', null).optional(),
```

- [ ] **Step 2: Add to both GET SELECT queries in `tenants.js` (lines 43 and 57)**

Change:
```js
            policy_api_url, policy_api_mode, cover_benefit_name,
```
to (in **both** SELECT blocks):
```js
            policy_api_url, policy_api_mode, policy_api_coverholder_key, cover_benefit_name,
```

- [ ] **Step 3: Replace the POST INSERT block in `tenants.js` (lines 84–112)**

```js
  const result = await query(
    `INSERT INTO tenants
       (slug, name, subdomain, logo_url, primary_colour, terms_url, support_email,
        claim_url, register_claim_url, my_account_url,
        policy_api_url, policy_api_key_enc, policy_api_mode, policy_api_coverholder_key,
        cover_benefit_name,
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
```

- [ ] **Step 4: Replace the PUT UPDATE block in `tenants.js` (lines 131–155)**

```js
  await query(
    `UPDATE tenants SET
       slug=$1, name=$2, subdomain=$3, logo_url=$4, primary_colour=$5,
       terms_url=$6, support_email=$7, claim_url=$8, register_claim_url=$9, my_account_url=$10,
       policy_api_url=$11, policy_api_key_enc=$12, policy_api_secret_enc=$13, policy_api_mode=$14,
       policy_api_coverholder_key=$15,
       cover_benefit_name=$16, modulr_account_id=$17, modulr_api_key_enc=$18, modulr_mode=$19,
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
```

- [ ] **Step 5: Add `policy_api_coverholder_key` to the GET SELECT in `tenantSettings.js`**

Change:
```js
            policy_api_url, policy_api_mode, cover_benefit_name,
```
to:
```js
            policy_api_url, policy_api_mode, policy_api_coverholder_key, cover_benefit_name,
```

The PATCH query in `tenantSettings.js` does not change — the coverholder key is superadmin-only.

- [ ] **Step 6: Verify the server starts cleanly**

```bash
docker compose up app
```

Expected: `[server] flight-delay-v2 running on port 3000` — no crash or query error.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/admin/tenants.js server/src/routes/admin/tenantSettings.js
git commit -m "feat: thread policy_api_coverholder_key through tenants and tenantSettings routes"
```

---

### Task 3: Coverholder proxy endpoint

**Files:**
- Create: `server/src/routes/admin/coverholderProxy.js`
- Modify: `server/src/index.js`

**Context:** The admin SPA cannot call the Claims API directly (CORS, key exposure). This proxy accepts a base URL and plaintext API key (entered by the superadmin during tenant setup, before the key is saved/encrypted), calls `GET {url}/api/coverholders` with `X-API-Key`, and returns the list. Mounted under `requireSuperAdmin`.

- [ ] **Step 1: Create `server/src/routes/admin/coverholderProxy.js`**

```js
'use strict';

const express = require('express');

const router = express.Router();

// POST /api/admin/coverholder-proxy
// Body: { url: string, apiKey: string }
// Proxies to GET {url}/api/coverholders with X-API-Key header.
// Returns: { coverholders: [{ key: string, name: string }] }
router.post('/', async (req, res) => {
  const { url, apiKey } = req.body || {};
  if (!url || !apiKey) {
    return res.status(400).json({ error: 'url and apiKey are required' });
  }

  let baseUrl;
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('bad protocol');
    baseUrl = url.replace(/\/$/, '');
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const upstream = await fetch(`${baseUrl}/api/coverholders`, {
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (upstream.status === 401) {
      return res.status(400).json({ error: 'Invalid API key — the Claims API rejected it' });
    }
    if (!upstream.ok) {
      return res.status(400).json({ error: `Claims API returned HTTP ${upstream.status}` });
    }

    const data = await upstream.json();
    if (!data.success || !data.hasData) {
      return res.json({ coverholders: [] });
    }
    return res.json({ coverholders: data.data });
  } catch (err) {
    return res.status(400).json({ error: `Could not reach Claims API: ${err.message}` });
  }
});

module.exports = router;
```

- [ ] **Step 2: Import the route in `server/src/index.js`**

After the last admin route import (around line 40), add:
```js
const adminCoverholderProxyRouter = require('./routes/admin/coverholderProxy');
```

- [ ] **Step 3: Mount the route in `server/src/index.js`**

Immediately after:
```js
app.use('/api/admin/tenants', requireAdmin.requireSuperAdmin, adminTenantsRouter);
```
add:
```js
app.use('/api/admin/coverholder-proxy', requireAdmin.requireSuperAdmin, adminCoverholderProxyRouter);
```

- [ ] **Step 4: Smoke-test the proxy (no real API key needed)**

Start the server and get a superadmin JWT from `POST /api/admin/auth/login`. Then:

```bash
curl -s -X POST http://localhost:3000/api/admin/coverholder-proxy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <jwt>" \
  -d '{"url":"https://app-claimsapi-d-uks-001.azurewebsites.net","apiKey":"bad-key"}' | jq .
```

Expected (with a bad key, the upstream returns 401):
```json
{ "error": "Invalid API key — the Claims API rejected it" }
```

Test without JWT — should get HTTP 401 from `requireSuperAdmin`.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/admin/coverholderProxy.js server/src/index.js
git commit -m "feat: add coverholder proxy endpoint for superadmin tenant setup"
```

---

### Task 4: Rewrite `policyValidator.js` live mode for Claims API

**Files:**
- Modify: `server/src/services/policyValidator.js`

**Context:** The current `liveValidate()` (lines 219–318) uses `POST` + OAuth2 Bearer token against the old Ergo Connect API. The new Claims API uses `GET` + `X-API-Key` header. The `_tokenCache` map and `getOauth2Token()` function (lines 185–217) are fully removed — no token caching is needed.

**New call:** `GET {baseUrl}/api/policies/search?id={policyNumber}&coverHolderKey={coverHolderKey}`

**Response envelope:** `{ success: bool, hasData: bool, data: [{ ... }] }` — always check `success && hasData` before touching `data`.

**Email auth:** Find `clients[].relationship === 'Lead'`, compare their `email` field. If no Lead is tagged, fall back to `clients[0]`.

**Payout:** `policyOptions[]` field names are not yet known — a real test call is needed. The code logs the full array and tries the four most common field names (`limit`, `amount`, `value`, `benefitAmount`). When a test is run and the field name is confirmed, update the single `??` chain.

- [ ] **Step 1: Delete `_tokenCache` and `getOauth2Token` (lines 185–217)**

Remove the entire block from:
```js
// Per-tenant token cache: slug → { token, expiresAt }
const _tokenCache = new Map();
```
down to and including the closing `}` of `getOauth2Token`.

- [ ] **Step 2: Replace `liveValidate()` (lines 219–318)**

Replace the entire function with:

```js
async function liveValidate(tenant, policyNumber, email) {
  let apiKey;
  try {
    apiKey = decrypt(tenant.policy_api_key_enc);
  } catch (err) {
    console.error('[policyValidator] Failed to decrypt API key for tenant', tenant.slug, err.message);
    return { valid: false, errorMessage: 'Policy validation service unavailable' };
  }

  const baseUrl = tenant.policy_api_url.replace(/\/$/, '');
  const coverHolderKey = tenant.policy_api_coverholder_key || '';
  const url = `${baseUrl}/api/policies/search?id=${encodeURIComponent(policyNumber)}&coverHolderKey=${encodeURIComponent(coverHolderKey)}`;

  let body;
  try {
    const res = await fetch(url, {
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(15000),
    });

    if (res.status === 401) {
      return { valid: false, errorMessage: 'Policy validation service authentication failed' };
    }
    if (!res.ok) {
      throw new Error(`Claims API HTTP ${res.status}`);
    }

    body = await res.json();
  } catch (err) {
    console.error('[policyValidator] Claims API request failed:', err.message);
    return { valid: false, errorMessage: 'Policy validation service unavailable' };
  }

  if (!body.success || !body.hasData || !body.data || body.data.length === 0) {
    return { valid: false, errorMessage: 'Policy not found' };
  }

  const policy = body.data[0];

  // Claims API uses integer status: 1 = Active
  if (policy.status !== 1) {
    return { valid: false, errorMessage: 'Policy is not active' };
  }

  // Find lead policyholder for email authentication
  const leadClient = (policy.clients || []).find(
    (c) => c.relationship && c.relationship.toLowerCase() === 'lead'
  ) || policy.clients?.[0];

  if (!leadClient?.email) {
    console.error('[policyValidator] No lead client email in response for policy', policyNumber);
    return { valid: false, errorMessage: 'Policy holder contact details not found' };
  }

  if (leadClient.email.toLowerCase() !== email.toLowerCase()) {
    return { valid: false, errorMessage: 'Email address does not match policy records' };
  }

  // ── Payout extraction ─────────────────────────────────────────────────────
  // policyOptions[] field names are not yet confirmed — needs a real test call.
  // The full array is logged below so field names can be identified from server logs.
  // Once confirmed, update the `??` chain to the single correct field name.
  const benefitName = (tenant.cover_benefit_name || 'Flight Delay').toLowerCase();
  const matchingOption = (policy.policyOptions || []).find(
    (opt) => opt.name && opt.name.toLowerCase().includes(benefitName)
  );

  if (!matchingOption) {
    console.warn('[policyValidator] No matching benefit. policyOptions[]:', JSON.stringify(policy.policyOptions));
    return {
      valid: false,
      errorMessage: `No "${tenant.cover_benefit_name || 'Flight Delay'}" benefit found on this policy`,
    };
  }

  // Try common field names — replace with confirmed field name after test call
  const amount = matchingOption.limit ?? matchingOption.amount ?? matchingOption.value ?? matchingOption.benefitAmount ?? null;
  if (amount === null) {
    console.warn('[policyValidator] Benefit found but amount field unknown. Option:', JSON.stringify(matchingOption));
    return { valid: false, errorMessage: 'Benefit amount could not be determined — contact support' };
  }

  const payoutPence = Math.round(amount * 100);
  if (payoutPence <= 0) {
    return { valid: false, errorMessage: 'Benefit limit is zero — policy not eligible' };
  }

  // ── Policy type mapping ───────────────────────────────────────────────────
  // Claims API returns strings like "SingleTrip", "AnnualMultiTrip", "ReturnTrip"
  const ptRaw = (policy.policyType || '').toLowerCase().replace(/[_\s-]/g, '');
  let policyType = 'single_trip';
  if (ptRaw.includes('annual') || ptRaw.includes('amt') || ptRaw.includes('multitrip')) {
    policyType = 'annual_multi_trip';
  } else if (ptRaw.includes('return')) {
    policyType = 'return_trip';
  }

  const travelers = (policy.clients || []).map((c) => ({
    firstName: c.firstName || '',
    lastName:  c.lastName  || '',
  }));

  return {
    valid: true,
    firstName:     leadClient.firstName || '',
    lastName:      leadClient.lastName  || '',
    policyType,
    travelers:     travelers.length > 0 ? travelers : [{ firstName: leadClient.firstName || '', lastName: leadClient.lastName || '' }],
    payoutPence,
    coverStartDate: policy.startDate || null,
    coverEndDate:   policy.endDate   || null,
    rawResponse: body,
  };
}
```

- [ ] **Step 3: Update the JSDoc above `validatePolicy()` to reference the new field**

Change:
```js
 * @param {object} tenant  - The resolved tenant row from the DB
```
to:
```js
 * @param {object} tenant  - The resolved tenant row (must have policy_api_coverholder_key set for live mode)
```

- [ ] **Step 4: Verify stub mode still works**

```bash
curl -s -X POST http://localhost:3000/api/validate-policy \
  -H "Content-Type: application/json" \
  -H "X-Tenant-Slug: demo" \
  -d '{"policy_number":"POL-001-ACTIVE","email":"sarah.johnson@example.com"}' | jq .
```

Expected:
```json
{
  "valid": true,
  "firstName": "Sarah",
  "lastName": "Johnson",
  "policyType": "annual_multi_trip",
  "payoutPence": 25000
}
```

- [ ] **Step 5: Commit**

```bash
git add server/src/services/policyValidator.js
git commit -m "feat: rewrite liveValidate() for Claims API — GET + X-API-Key + coverHolderKey"
```

---

### Task 5: Admin SPA — coverholder picker + settings cleanup

**Files:**
- Modify: `admin/index.html`

**Context:** Three changes to the admin SPA:

1. **Superadmin tenant modal** — add a coverholder `<select>` + "Fetch Coverholders" button after the Policy API Key field. The button calls `POST /api/admin/coverholder-proxy` and populates the dropdown.
2. **Tenant settings page Policy API tab** — hide the now-unused Policy Secret field; add a read-only Coverholder Key display.
3. **JS** — new `fetchCoverholders()` function; update `openTenantModal`, `saveTenant`, `populateSettings`.

The `esc()` and `api()` helpers already exist in the SPA.

- [ ] **Step 1: Add the coverholder picker to the superadmin tenant modal**

After the Policy API Key `<div class="form-group">` block (the one containing `tm-policy-key`, ending around line 731 with `<small>Stored encrypted.</small>`):

```html
    <div class="form-group">
      <label>Coverholder</label>
      <div style="display:flex;gap:8px;align-items:flex-start">
        <select id="tm-coverholder-key" style="flex:1">
          <option value="">— fetch coverholders first —</option>
        </select>
        <button type="button" class="btn btn-outline btn-sm" id="tm-fetch-coverholders-btn"
                onclick="fetchCoverholders()" style="white-space:nowrap">Fetch Coverholders</button>
      </div>
      <small id="tm-coverholder-status" style="color:var(--muted)">Enter the API URL and key above, then click Fetch Coverholders.</small>
    </div>
```

- [ ] **Step 2: Add `fetchCoverholders()` to the script section**

Find the `function openTenantModal(tenant)` declaration and add this function immediately before it:

```js
async function fetchCoverholders() {
  const btn      = document.getElementById('tm-fetch-coverholders-btn');
  const statusEl = document.getElementById('tm-coverholder-status');
  const select   = document.getElementById('tm-coverholder-key');

  const url    = document.getElementById('tm-policy-url').value.trim();
  const apiKey = document.getElementById('tm-policy-key').value.trim();

  if (!url || !apiKey) {
    statusEl.textContent = 'Enter the Policy API URL and API key first.';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Fetching…';
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'Contacting Claims API…';

  const res = await api('POST', '/api/admin/coverholder-proxy', { url, apiKey });
  btn.disabled = false;
  btn.textContent = 'Fetch Coverholders';

  if (!res?.ok) {
    statusEl.textContent = res?.data?.error || 'Failed to fetch coverholders';
    statusEl.style.color = 'var(--danger)';
    return;
  }

  const coverholders = res.data?.coverholders || [];
  const currentKey   = select.value;

  select.innerHTML = '<option value="">— select coverholder —</option>' +
    coverholders.map(c =>
      `<option value="${esc(c.key)}"${c.key === currentKey ? ' selected' : ''}>${esc(c.name)} (${esc(c.key)})</option>`
    ).join('');

  if (coverholders.length === 0) {
    statusEl.textContent = 'No coverholders returned from the API.';
    statusEl.style.color = 'var(--warn)';
  } else {
    statusEl.textContent = `${coverholders.length} coverholder(s) loaded.`;
    statusEl.style.color = 'var(--success)';
  }
}
```

- [ ] **Step 3: Update `openTenantModal` to restore the stored coverholder key**

In `openTenantModal(tenant)`, after the line:
```js
  document.getElementById('tm-portal-label').value = tenant?.portal_label || '';
```

Add:
```js
  const chKey    = tenant?.policy_api_coverholder_key || '';
  const chSelect = document.getElementById('tm-coverholder-key');
  chSelect.innerHTML = chKey
    ? `<option value="${esc(chKey)}" selected>${esc(chKey)} (re-fetch to see full list)</option>`
    : '<option value="">— fetch coverholders first —</option>';
  document.getElementById('tm-coverholder-status').textContent = 'Enter the API URL and key above, then click Fetch Coverholders.';
  document.getElementById('tm-coverholder-status').style.color = 'var(--muted)';
```

- [ ] **Step 4: Add `policy_api_coverholder_key` to `saveTenant()` body**

In `saveTenant()`, after the `policy_api_mode` line:
```js
    policy_api_mode:     document.getElementById('tm-policy-mode').value,
```

Add:
```js
    policy_api_coverholder_key: document.getElementById('tm-coverholder-key').value || null,
```

- [ ] **Step 5: Hide the Policy Secret field in the tenant settings page**

Find the form-group div containing `st-policy-secret` (lines 642–646) and add `style="display:none"` to the outer div:

```html
          <div class="form-group" style="display:none">
            <label>Policy API Password / Secret</label>
            <input id="st-policy-secret" type="password" placeholder="Leave blank to keep existing" />
            <small>Not used by the Claims API — retained for backwards compatibility.</small>
          </div>
```

- [ ] **Step 6: Add read-only Coverholder Key to the tenant settings Policy API tab**

After the `settings-tab-policy-api` mode/benefit row (after the closing `</div>` of the `form-row` on line 661), add:

```html
          <div class="form-group">
            <label>Coverholder Key</label>
            <input id="st-coverholder-key" readonly style="background:var(--bg);cursor:default" />
            <small>Set by superadmin. Contact your platform administrator to change this.</small>
          </div>
```

- [ ] **Step 7: Populate the read-only field in `populateSettings(t)`**

In the `populateSettings(t)` function, add after the `st-policy-mode` line:
```js
  document.getElementById('st-coverholder-key').value = t.policy_api_coverholder_key || '';
```

- [ ] **Step 8: Manual end-to-end test**

1. Log in as superadmin → open Edit Tenant on any tenant
2. Enter a valid Policy API URL and key → click "Fetch Coverholders"
3. Confirm dropdown populates with `name (key)` entries
4. Select a coverholder → Save → reopen the same tenant → confirm the dropdown shows the saved key
5. Log in as tenant admin → Settings → Policy API tab → confirm Coverholder Key shows value, is read-only
6. Confirm the Policy API Secret field is hidden

- [ ] **Step 9: Commit**

```bash
git add admin/index.html
git commit -m "feat: add coverholder picker to tenant modal, read-only display in settings"
```

---

## After receiving the test API key

When a real key is available, run:

```bash
curl -s "https://app-claimsapi-d-uks-001.azurewebsites.net/api/policies/search?id=<a-real-policy>&coverHolderKey=<ch-key>" \
  -H "X-API-Key: <real-key>" | jq '.data[0].policyOptions'
```

Inspect the logged output in the server or the direct response to see what field name holds the benefit amount (likely `limit`, `amount`, or `value`). Then in `policyValidator.js`, replace:

```js
const amount = matchingOption.limit ?? matchingOption.amount ?? matchingOption.value ?? matchingOption.benefitAmount ?? null;
```

with the single confirmed field, e.g.:
```js
const amount = matchingOption.limit ?? null;
```

Also confirm the exact string values returned for `policyType` and update the mapping in `liveValidate()` if the guesses (`"SingleTrip"`, `"AnnualMultiTrip"`, `"ReturnTrip"`) are wrong.
