# Environment Strategy (Dev / UAT / Production) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Git Flow `develop` branch that auto-deploys to a lightweight UAT environment on Azure (`fdv2-uat-rg`), with safety controls preventing real registrations/payments, plus the corresponding code changes and DNS wiring.

**Architecture:** The production stack (`fdv2-prod-rg`) already exists. This plan creates a parallel UAT stack (`fdv2-uat-rg`) using the same ACR image but with `NODE_ENV=uat`, a separate PostgreSQL database, and separate Key Vault. GitHub Actions builds and deploys to UAT on every push to `develop`, and to production on every push to `main`.

**Tech Stack:** Node.js 20 / Express, PostgreSQL 16, Azure Container Apps, Azure Key Vault (RBAC), Azure Container Registry (`fdv2acr`), GitHub Actions OIDC.

---

## File Structure

| Action | File | Change |
|---|---|---|
| Modify | `server/src/routes/admin/tenants.js` | Add reserved slug blocklist before INSERT |
| Modify | `server/src/routes/tenantConfig.js` | Expose `env: config.nodeEnv` in response |
| Modify | `customer/index.html` | Add UAT banner HTML + show it when `env === 'uat'` |
| Modify | `admin/index.html` | Add UAT banner HTML + show it after `initApp()` fetches tenant-config |
| Modify | `server/src/services/policyValidator.js` | Force stub when `NODE_ENV` is `uat` or `development` |
| Modify | `server/src/services/modulr.js` | Force stub when `NODE_ENV` is `uat` or `development` |
| Create | `.github/workflows/deploy-uat.yml` | New CI/CD workflow triggered on push to `develop` |

---

## Task 1: Reserved Slug Validation

**Why:** The spec requires that slugs like `uat`, `www`, `api`, `admin`, `staging`, `dev`, `test` cannot be registered as tenant slugs in production, to prevent them conflicting with infrastructure subdomains.

**Files:**
- Modify: `server/src/routes/admin/tenants.js`

- [ ] **Step 1: Open `server/src/routes/admin/tenants.js` and find the POST route**

  The `POST /` route starts at line 80. After the Joi validation (line 82), add the reserved slug check before the INSERT.

- [ ] **Step 2: Add the reserved slug blocklist**

  In `server/src/routes/admin/tenants.js`, replace this block:

  ```js
  // POST /api/admin/tenants
  router.post('/', async (req, res) => {
    const { error, value } = tenantSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    const result = await query(
  ```

  With:

  ```js
  const RESERVED_SLUGS = ['uat', 'www', 'api', 'admin', 'health', 'mail', 'smtp', 'staging', 'dev', 'test'];

  // POST /api/admin/tenants
  router.post('/', async (req, res) => {
    const { error, value } = tenantSchema.validate(req.body);
    if (error) return res.status(400).json({ error: error.details[0].message });

    if (RESERVED_SLUGS.includes(value.slug)) {
      return res.status(400).json({ error: `Slug "${value.slug}" is reserved and cannot be used` });
    }

    const result = await query(
  ```

- [ ] **Step 3: Test manually**

  Start the app locally:
  ```bash
  cd server && npm run dev
  ```

  In a new terminal, try creating a tenant with a reserved slug (replace the token with a valid superadmin JWT):
  ```bash
  curl -s -X POST http://localhost:3000/api/admin/tenants \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <SUPERADMIN_JWT>" \
    -H "X-Tenant-Slug: demo" \
    -d '{"slug":"uat","name":"Test","subdomain":"uat.delayedpaid.co.uk","policy_api_mode":"stub","modulr_mode":"stub"}' | jq .
  ```

  Expected response:
  ```json
  { "error": "Slug \"uat\" is reserved and cannot be used" }
  ```

  Also verify a valid slug still works:
  ```bash
  curl -s -X POST http://localhost:3000/api/admin/tenants \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <SUPERADMIN_JWT>" \
    -H "X-Tenant-Slug: demo" \
    -d '{"slug":"myinsurer","name":"My Insurer","subdomain":"myinsurer.delayedpaid.co.uk","policy_api_mode":"stub","modulr_mode":"stub"}' | jq .
  ```

  Expected: `201 Created` with `{ "id": ..., "slug": "myinsurer", "name": "My Insurer" }`.

- [ ] **Step 4: Commit**

  ```bash
  git add server/src/routes/admin/tenants.js
  git commit -m "feat: block reserved slugs (uat, admin, www, etc.) from tenant creation"
  ```

---

## Task 2: Expose `env` in Tenant Config Response

**Why:** The customer and admin SPAs need to know whether they're running in UAT so they can show the warning banner. The cleanest way is to include the environment name in the existing `/api/tenant-config` response.

**Files:**
- Modify: `server/src/routes/tenantConfig.js`

- [ ] **Step 1: Add the config import**

  In `server/src/routes/tenantConfig.js`, the file currently starts with:
  ```js
  'use strict';

  const express = require('express');
  ```

  Change it to:
  ```js
  'use strict';

  const express = require('express');
  const config = require('../config');
  ```

- [ ] **Step 2: Add `env` to the response**

  In the same file, find the `res.json({...})` call. It currently ends with:
  ```js
      minHoursBeforeDep: req.tenant.min_hours_before_dep,
      maxDaysBeforeDep:  req.tenant.max_days_before_dep || 40,
    });
  ```

  Change it to:
  ```js
      minHoursBeforeDep: req.tenant.min_hours_before_dep,
      maxDaysBeforeDep:  req.tenant.max_days_before_dep || 40,
      env:               config.nodeEnv,
    });
  ```

- [ ] **Step 3: Test manually**

  ```bash
  curl -s http://localhost:3000/api/tenant-config \
    -H "X-Tenant-Slug: demo" | jq .env
  ```

  Expected: `"development"` (on local). When deployed to UAT with `NODE_ENV=uat`, this will return `"uat"`.

- [ ] **Step 4: Commit**

  ```bash
  git add server/src/routes/tenantConfig.js
  git commit -m "feat: expose NODE_ENV in /api/tenant-config response as 'env' field"
  ```

---

## Task 3: UAT Banner — Customer SPA

**Why:** UAT testers must not think they are registering a real claim. A prominent yellow banner at the top of the page makes it obvious this is a test environment.

**Files:**
- Modify: `customer/index.html`

- [ ] **Step 1: Add the banner HTML**

  In `customer/index.html`, find the `<body>` tag (line 1016) and the `<header>` element that immediately follows it. Insert the banner **before** the header:

  Find:
  ```html
  <body>

  <!-- ── Header ────────────────────────────────────────────────────────────────── -->
  <header class="header" id="app-header">
  ```

  Replace with:
  ```html
  <body>

  <!-- ── UAT Banner ────────────────────────────────────────────────────────────── -->
  <div id="uat-banner" style="display:none;background:#d29922;color:#000;text-align:center;padding:8px 16px;font-weight:600;font-size:14px;letter-spacing:0.01em">
    ⚠️ UAT ENVIRONMENT — NOT FOR REAL REGISTRATIONS
  </div>

  <!-- ── Header ────────────────────────────────────────────────────────────────── -->
  <header class="header" id="app-header">
  ```

- [ ] **Step 2: Show the banner when `env === 'uat'`**

  In `customer/index.html`, find the tenant-config fetch handler (around line 1414). It currently reads:

  ```js
    const res = await fetch('/api/tenant-config', { headers: tenantHeader() });
    if (res.ok) {
      state.tenant = await res.json();
      applyBranding(state.tenant);
      state.minHoursBeforeDep = state.tenant.minHoursBeforeDep || 24;
      state.maxDaysBeforeDep  = state.tenant.maxDaysBeforeDep  || 40;
      document.querySelectorAll('#min-hours').forEach(el => el.textContent = state.minHoursBeforeDep);
    }
  ```

  Change it to:

  ```js
    const res = await fetch('/api/tenant-config', { headers: tenantHeader() });
    if (res.ok) {
      state.tenant = await res.json();
      applyBranding(state.tenant);
      state.minHoursBeforeDep = state.tenant.minHoursBeforeDep || 24;
      state.maxDaysBeforeDep  = state.tenant.maxDaysBeforeDep  || 40;
      document.querySelectorAll('#min-hours').forEach(el => el.textContent = state.minHoursBeforeDep);
      if (state.tenant.env === 'uat') {
        document.getElementById('uat-banner').style.display = '';
      }
    }
  ```

- [ ] **Step 3: Test manually**

  In local development, `NODE_ENV=development` so the banner will not show (correct). To confirm the HTML is valid and the banner logic works, temporarily change your local `.env` to `NODE_ENV=uat` and restart the dev server:

  ```bash
  # In server/.env temporarily set: NODE_ENV=uat
  npm run dev
  ```

  Open `http://localhost:3000` — the yellow banner should appear at the top. Change back to `NODE_ENV=development` when done.

- [ ] **Step 4: Commit**

  ```bash
  git add customer/index.html
  git commit -m "feat: show UAT environment banner in customer SPA when NODE_ENV=uat"
  ```

---

## Task 4: UAT Banner — Admin SPA

**Why:** Admin users need the same warning. The admin SPA does not currently call tenant-config, so we add a call in `initApp()` to check the environment.

**Files:**
- Modify: `admin/index.html`

- [ ] **Step 1: Add the banner HTML**

  In `admin/index.html`, find `<div id="app">` (line 237). Insert the banner immediately after it, before the topbar:

  Find:
  ```html
  <div id="app">
    <!-- Topbar -->
    <div id="topbar">
  ```

  Replace with:
  ```html
  <div id="app">
    <!-- UAT Banner -->
    <div id="uat-banner" style="display:none;background:#d29922;color:#000;text-align:center;padding:8px 16px;font-weight:600;font-size:14px">
      ⚠️ UAT ENVIRONMENT — NOT FOR REAL REGISTRATIONS
    </div>
    <!-- Topbar -->
    <div id="topbar">
  ```

- [ ] **Step 2: Fetch tenant-config in `initApp()` and show banner**

  In `admin/index.html`, find the end of `initApp()` (around line 1070). It currently ends with:

  ```js
    nav('dashboard');
  }
  ```

  Change it to:

  ```js
    nav('dashboard');

    // Show UAT banner if running in UAT environment
    try {
      const cfgRes = await fetch('/api/tenant-config');
      if (cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (cfg.env === 'uat') {
          document.getElementById('uat-banner').style.display = '';
        }
      }
    } catch (_) {}
  }
  ```

  **Note on why this works:** `/api/tenant-config` is a public endpoint that returns the environment name. It works without authentication. The `try/catch` means a failure here never blocks the admin login flow.

- [ ] **Step 3: Test manually**

  Same as Task 3 — set `NODE_ENV=uat` in `server/.env`, restart, open `http://localhost:3000/admin`, log in. The yellow banner should appear at the top of the admin app. Change back to `NODE_ENV=development` when done.

- [ ] **Step 4: Commit**

  ```bash
  git add admin/index.html
  git commit -m "feat: show UAT environment banner in admin SPA when NODE_ENV=uat"
  ```

---

## Task 5: Force Stub Mode When `NODE_ENV=uat`

**Why:** Even if a tenant is accidentally configured with `policy_api_mode=live` or `modulr_mode=live` in UAT, the app must never call real external APIs or move real money. `NODE_ENV=uat` overrides tenant config and always uses stub mode.

**Files:**
- Modify: `server/src/services/policyValidator.js`
- Modify: `server/src/services/modulr.js`

- [ ] **Step 1: Update `validatePolicy()` in policyValidator.js**

  In `server/src/services/policyValidator.js`, find the `validatePolicy` function at the bottom of the file:

  ```js
  async function validatePolicy(tenant, policyNumber, email) {
    if (tenant.policy_api_mode === 'live') {
      return liveValidate(tenant, policyNumber, email);
    }
    // Default to stub
    return stubValidate(policyNumber, email);
  }
  ```

  Replace with:

  ```js
  async function validatePolicy(tenant, policyNumber, email) {
    const env = process.env.NODE_ENV;
    if (tenant.policy_api_mode === 'live' && env !== 'uat' && env !== 'development') {
      return liveValidate(tenant, policyNumber, email);
    }
    return stubValidate(policyNumber, email);
  }
  ```

  **What changed:** Added a guard — even if the tenant has `policy_api_mode=live`, the live path is skipped when `NODE_ENV` is `uat` or `development`. This matches the existing implicit behaviour for development (where tenants use stub mode) and makes it explicit and enforced.

- [ ] **Step 2: Update `sendPayment()` in modulr.js**

  In `server/src/services/modulr.js`, find the `sendPayment` function:

  ```js
  async function sendPayment(tenant, params) {
    if (tenant.modulr_mode === 'live') {
      return livePayment(tenant, params);
    }
    return stubPayment(params);
  }
  ```

  Replace with:

  ```js
  async function sendPayment(tenant, params) {
    const env = process.env.NODE_ENV;
    if (tenant.modulr_mode === 'live' && env !== 'uat' && env !== 'development') {
      return livePayment(tenant, params);
    }
    return stubPayment(params);
  }
  ```

- [ ] **Step 3: Test manually**

  Set `NODE_ENV=uat` in `server/.env`. If you have a tenant with `policy_api_mode=live` configured, attempt a policy validation in the customer SPA — it should return stub data (mock response) rather than calling the live API. Check the server logs for `[policyValidator]` — there should be no live API call.

- [ ] **Step 4: Commit**

  ```bash
  git add server/src/services/policyValidator.js server/src/services/modulr.js
  git commit -m "feat: force stub mode in policyValidator and modulr when NODE_ENV=uat"
  ```

---

## Task 6: Create the `develop` Branch

**Why:** The Git Flow model requires a `develop` branch that UAT deploys from. All feature work is merged into `develop` first, then promoted to `main` (production) via PR.

**Files:** None (Git operations only)

- [ ] **Step 1: Verify you are on `main` and it is up to date**

  ```bash
  git checkout main
  git pull origin main
  ```

  Expected: Already on 'main'. Your branch is up to date.

- [ ] **Step 2: Create the `develop` branch from the current state of `main`**

  ```bash
  git checkout -b develop
  ```

  This creates a new local branch called `develop` that starts at the same commit as `main`. Everything built so far (the production app) is now the baseline for UAT.

- [ ] **Step 3: Push `develop` to GitHub**

  ```bash
  git push -u origin develop
  ```

  Expected output includes: `Branch 'develop' set up to track remote branch 'develop' from 'origin'`.

- [ ] **Step 4: Verify on GitHub**

  Run:
  ```bash
  gh api repos/neilfrostergo/flight-delay-v2/branches --jq '.[].name'
  ```

  Expected output should include both `main` and `develop`.

---

## Task 7: UAT Azure — Resource Group, VNet, and Subnets

**Why:** Azure organises resources into "resource groups" — think of it as a folder in the cloud. Everything UAT-related goes in `fdv2-uat-rg`. The VNet is a private network in Azure that our containers and database use to talk to each other securely without going over the public internet.

**Files:** None (Azure CLI only)

- [ ] **Step 1: Log in to Azure CLI**

  ```bash
  az login
  ```

  A browser window will open. Sign in with your Azure account. Once done, the terminal will show your subscription details.

- [ ] **Step 2: Create the UAT resource group**

  ```bash
  az group create \
    --name fdv2-uat-rg \
    --location uksouth
  ```

  **What this does:** Creates a folder in Azure (UK South region) called `fdv2-uat-rg`. All UAT resources will live here.

  Expected output includes: `"provisioningState": "Succeeded"`.

- [ ] **Step 3: Create the VNet (the private network)**

  ```bash
  az network vnet create \
    --name fdv2-uat-vnet \
    --resource-group fdv2-uat-rg \
    --location uksouth \
    --address-prefix 10.101.0.0/16
  ```

  **What this does:** Creates a private network with address space `10.101.0.0/16` — that means it can host up to 65,536 private IP addresses. (Production uses `10.100.0.0/16` so there's no overlap.)

  Expected output includes: `"provisioningState": "Succeeded"`.

- [ ] **Step 4: Create the Container Apps subnet**

  ```bash
  az network vnet subnet create \
    --name fdv2-uat-aca-subnet \
    --resource-group fdv2-uat-rg \
    --vnet-name fdv2-uat-vnet \
    --address-prefix 10.101.0.0/21 \
    --delegations Microsoft.App/environments
  ```

  **What this does:** Carves out a portion of the VNet (`10.101.0.0/21` = 2,048 addresses) and reserves it for Azure Container Apps. The `--delegations` flag tells Azure that only Container Apps is allowed to use this subnet. It needs a `/21` minimum because Container Apps reserves many internal IPs.

- [ ] **Step 5: Create the database subnet**

  ```bash
  az network vnet subnet create \
    --name fdv2-uat-data-subnet \
    --resource-group fdv2-uat-rg \
    --vnet-name fdv2-uat-vnet \
    --address-prefix 10.101.8.0/24
  ```

  **What this does:** 256-address subnet for the PostgreSQL database. The database will be injected here so it's only accessible from within the VNet — not from the public internet.

- [ ] **Step 6: Create the private endpoint subnet**

  ```bash
  az network vnet subnet create \
    --name fdv2-uat-pe-subnet \
    --resource-group fdv2-uat-rg \
    --vnet-name fdv2-uat-vnet \
    --address-prefix 10.101.9.0/24 \
    --disable-private-endpoint-network-policies true
  ```

  **What this does:** 256-address subnet for "private endpoints" (private connections to Azure services like Key Vault). The `--disable-private-endpoint-network-policies` flag is required by Azure — it disables a network rule that conflicts with how private endpoints work.

- [ ] **Step 7: Verify the subnets**

  ```bash
  az network vnet subnet list \
    --resource-group fdv2-uat-rg \
    --vnet-name fdv2-uat-vnet \
    --query '[].{name:name, prefix:addressPrefix}' \
    --output table
  ```

  Expected:
  ```
  Name                    Prefix
  ----------------------  ---------------
  fdv2-uat-aca-subnet     10.101.0.0/21
  fdv2-uat-data-subnet    10.101.8.0/24
  fdv2-uat-pe-subnet      10.101.9.0/24
  ```

---

## Task 8: UAT Azure — PostgreSQL Flexible Server

**Why:** UAT needs its own database, completely separate from production. No data can be shared between environments.

**Files:** None (Azure CLI only)

- [ ] **Step 1: Choose a strong PostgreSQL admin password**

  Generate a password (you'll store it in Key Vault in the next task):
  ```bash
  node -e "console.log(require('crypto').randomBytes(20).toString('base64url'))"
  ```

  Copy the output. You'll use it as `<DB_ADMIN_PASSWORD>` in the next step. **Save it somewhere safe — you'll need it again for the DATABASE_URL secret.**

- [ ] **Step 2: Create the PostgreSQL server**

  ```bash
  az postgres flexible-server create \
    --name fdv2-uat-postgres \
    --resource-group fdv2-uat-rg \
    --location uksouth \
    --sku-name Standard_B1ms \
    --tier Burstable \
    --storage-size 32 \
    --version 16 \
    --admin-user fdv2admin \
    --admin-password "<DB_ADMIN_PASSWORD>" \
    --vnet fdv2-uat-vnet \
    --subnet fdv2-uat-data-subnet \
    --yes
  ```

  **What this does:**
  - `Standard_B1ms` / `Burstable` = the cheapest tier (1 vCore, 2GB RAM). Fine for UAT.
  - `--storage-size 32` = 32GB storage
  - `--vnet` + `--subnet` = puts the database inside the private network (no public internet access)
  - `--yes` = automatically creates the private DNS zone (`fdv2-uat-postgres.private.postgres.database.azure.com`) that allows our Container App to find the database by name

  This command takes **5–10 minutes**. Expected final output: `"state": "Ready"`.

- [ ] **Step 3: Create the application database**

  ```bash
  az postgres flexible-server db create \
    --server-name fdv2-uat-postgres \
    --resource-group fdv2-uat-rg \
    --database-name fdv2
  ```

- [ ] **Step 4: Verify the server is reachable (check status)**

  ```bash
  az postgres flexible-server show \
    --name fdv2-uat-postgres \
    --resource-group fdv2-uat-rg \
    --query '{state:state, fqdn:fullyQualifiedDomainName}' \
    --output json
  ```

  Expected:
  ```json
  {
    "state": "Ready",
    "fqdn": "fdv2-uat-postgres.postgres.database.azure.com"
  }
  ```

  The full DATABASE_URL for UAT will be:
  ```
  postgresql://fdv2admin:<DB_ADMIN_PASSWORD>@fdv2-uat-postgres.postgres.database.azure.com/fdv2?sslmode=require
  ```
  Keep this for Task 9 where you add it to Key Vault.

---

## Task 9: UAT Azure — Key Vault, Managed Identity, and Private Endpoint

**Why:** Secrets (database passwords, JWT keys, encryption keys) must not be stored in environment variables as plain text. Key Vault is Azure's secrets manager. The "managed identity" is how the Container App proves to Key Vault that it's allowed to read the secrets — no passwords needed.

**Files:** None (Azure CLI only)

- [ ] **Step 1: Create the managed identity**

  ```bash
  az identity create \
    --name fdv2-uat-identity \
    --resource-group fdv2-uat-rg \
    --location uksouth
  ```

  **What this does:** Creates a "managed identity" — think of it as a service account that Azure manages for you. The Container App will use this identity to authenticate to Key Vault without needing a password.

- [ ] **Step 2: Save the identity details for later commands**

  ```bash
  IDENTITY_PRINCIPAL_ID=$(az identity show \
    --name fdv2-uat-identity \
    --resource-group fdv2-uat-rg \
    --query principalId -o tsv)

  IDENTITY_CLIENT_ID=$(az identity show \
    --name fdv2-uat-identity \
    --resource-group fdv2-uat-rg \
    --query clientId -o tsv)

  echo "Principal ID: $IDENTITY_PRINCIPAL_ID"
  echo "Client ID: $IDENTITY_CLIENT_ID"
  ```

  Write these down — you'll need them in Task 10.

- [ ] **Step 3: Create the Key Vault**

  ```bash
  az keyvault create \
    --name fdv2-uat-keyvault \
    --resource-group fdv2-uat-rg \
    --location uksouth \
    --enable-rbac-authorization true
  ```

  **What this does:** Creates a Key Vault (Azure's secrets manager) using RBAC (role-based access control) — the same model as production's `fdv2-keyvault`. The vault name must be globally unique; if `fdv2-uat-keyvault` is taken, try `fdv2uat-keyvault`.

- [ ] **Step 4: Grant the managed identity permission to read secrets**

  ```bash
  KV_ID=$(az keyvault show \
    --name fdv2-uat-keyvault \
    --resource-group fdv2-uat-rg \
    --query id -o tsv)

  az role assignment create \
    --role "Key Vault Secrets User" \
    --assignee-object-id $IDENTITY_PRINCIPAL_ID \
    --assignee-principal-type ServicePrincipal \
    --scope $KV_ID
  ```

  **What this does:** Grants the `fdv2-uat-identity` service account the `Key Vault Secrets User` role, which allows it to read secret values. Nothing else.

- [ ] **Step 5: Generate application secrets**

  Generate a JWT secret:
  ```bash
  node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
  ```
  Save the output as `<JWT_SECRET>`.

  Generate an encryption key:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
  Save the output as `<ENCRYPTION_KEY>`.

  Generate an admin seed password:
  ```bash
  node -e "console.log(require('crypto').randomBytes(12).toString('base64url'))"
  ```
  Save the output as `<ADMIN_SEED_PASSWORD>`.

- [ ] **Step 6: Store secrets in Key Vault**

  Grant yourself access to add secrets first:
  ```bash
  MY_OBJECT_ID=$(az ad signed-in-user show --query id -o tsv)

  az role assignment create \
    --role "Key Vault Secrets Officer" \
    --assignee-object-id $MY_OBJECT_ID \
    --assignee-principal-type User \
    --scope $KV_ID
  ```

  Now add the secrets. Run each command separately:

  ```bash
  # Database connection string (replace <DB_ADMIN_PASSWORD> from Task 8)
  az keyvault secret set \
    --vault-name fdv2-uat-keyvault \
    --name database-url \
    --value "postgresql://fdv2admin:<DB_ADMIN_PASSWORD>@fdv2-uat-postgres.postgres.database.azure.com/fdv2?sslmode=require"

  # JWT signing key
  az keyvault secret set \
    --vault-name fdv2-uat-keyvault \
    --name jwt-secret \
    --value "<JWT_SECRET>"

  # AES-256-GCM encryption key (exactly 64 hex chars)
  az keyvault secret set \
    --vault-name fdv2-uat-keyvault \
    --name encryption-key \
    --value "<ENCRYPTION_KEY>"

  # Superadmin seed password (used once when running migrations)
  az keyvault secret set \
    --vault-name fdv2-uat-keyvault \
    --name admin-seed-password \
    --value "<ADMIN_SEED_PASSWORD>"

  # Redirect all outbound emails to this address in UAT (prevents real emails to customers)
  # Replace with your own internal test inbox
  az keyvault secret set \
    --vault-name fdv2-uat-keyvault \
    --name dev-email-override \
    --value "uat-test@yourdomain.com"
  ```

  **Note on SMTP:** UAT will reuse the same SMTP credentials as production (Azure Communication Services). You do NOT need to store SMTP credentials in UAT Key Vault — set them as plain environment variables on the Container App in Task 10, since they're not sensitive (the `DEV_EMAIL_OVERRIDE` secret ensures no real customer emails are sent anyway). If you want to store SMTP creds in Key Vault too, follow the same `az keyvault secret set` pattern.

- [ ] **Step 7: Create the Key Vault private endpoint**

  This ensures the Key Vault is only accessible from within the VNet (not the public internet):

  ```bash
  # Disable private endpoint policies on the PE subnet (if not already done in Task 7)
  az network vnet subnet update \
    --name fdv2-uat-pe-subnet \
    --resource-group fdv2-uat-rg \
    --vnet-name fdv2-uat-vnet \
    --disable-private-endpoint-network-policies true

  # Create the private endpoint
  az network private-endpoint create \
    --name fdv2-uat-kv-pe \
    --resource-group fdv2-uat-rg \
    --location uksouth \
    --subnet fdv2-uat-pe-subnet \
    --vnet-name fdv2-uat-vnet \
    --private-connection-resource-id $KV_ID \
    --group-id vault \
    --connection-name fdv2-uat-kv-pe-conn
  ```

- [ ] **Step 8: Create the private DNS zone for Key Vault**

  Without a private DNS zone, containers inside the VNet won't be able to resolve `fdv2-uat-keyvault.vault.azure.net` to the private IP:

  ```bash
  az network private-dns zone create \
    --resource-group fdv2-uat-rg \
    --name "privatelink.vaultcore.azure.net"

  az network private-dns link vnet create \
    --resource-group fdv2-uat-rg \
    --zone-name "privatelink.vaultcore.azure.net" \
    --name fdv2-uat-kv-dns-link \
    --virtual-network fdv2-uat-vnet \
    --registration-enabled false
  ```

  Get the private IP of the Key Vault endpoint and create the DNS record:

  ```bash
  PE_NIC_ID=$(az network private-endpoint show \
    --name fdv2-uat-kv-pe \
    --resource-group fdv2-uat-rg \
    --query 'networkInterfaces[0].id' -o tsv)

  KV_PRIVATE_IP=$(az network nic show \
    --ids $PE_NIC_ID \
    --query 'ipConfigurations[0].privateIPAddress' -o tsv)

  echo "Key Vault private IP: $KV_PRIVATE_IP"

  az network private-dns record-set a add-record \
    --resource-group fdv2-uat-rg \
    --zone-name "privatelink.vaultcore.azure.net" \
    --record-set-name fdv2-uat-keyvault \
    --ipv4-address $KV_PRIVATE_IP
  ```

- [ ] **Step 9: Grant ACR pull rights to the managed identity**

  The Container App uses this identity to pull Docker images from ACR:

  ```bash
  ACR_ID=$(az acr show \
    --name fdv2acr \
    --query id -o tsv)

  az role assignment create \
    --role AcrPull \
    --assignee-object-id $IDENTITY_PRINCIPAL_ID \
    --assignee-principal-type ServicePrincipal \
    --scope $ACR_ID
  ```

---

## Task 10: UAT Azure — Container Apps Environment and App

**Why:** The Container Apps Environment is the hosting platform (like a Kubernetes cluster, but managed). The Container App is the actual running instance of the flight-delay-v2 server.

**Files:** None (Azure CLI only)

- [ ] **Step 1: Get the ACA subnet ID**

  ```bash
  ACA_SUBNET_ID=$(az network vnet subnet show \
    --name fdv2-uat-aca-subnet \
    --resource-group fdv2-uat-rg \
    --vnet-name fdv2-uat-vnet \
    --query id -o tsv)

  echo "ACA subnet ID: $ACA_SUBNET_ID"
  ```

- [ ] **Step 2: Create the Container Apps Environment**

  ```bash
  az containerapp env create \
    --name fdv2-uat-aca-env \
    --resource-group fdv2-uat-rg \
    --location uksouth \
    --infrastructure-subnet-resource-id $ACA_SUBNET_ID \
    --internal-only false
  ```

  **What this does:** Creates the Container Apps platform inside the VNet. `--internal-only false` means it has a public HTTPS endpoint (needed for testers to access it from their browsers). This takes **3–5 minutes**.

  Expected final line: `"provisioningState": "Succeeded"`.

- [ ] **Step 3: Get the identity and Key Vault URIs for secret references**

  ```bash
  IDENTITY_ID=$(az identity show \
    --name fdv2-uat-identity \
    --resource-group fdv2-uat-rg \
    --query id -o tsv)

  KV_URI="https://fdv2-uat-keyvault.vault.azure.net/secrets"

  echo "Identity resource ID: $IDENTITY_ID"
  echo "Key Vault URI prefix: $KV_URI"
  ```

- [ ] **Step 4: Get SMTP credentials from production Key Vault**

  UAT reuses the production ACS SMTP credentials (emails are safe because `DEV_EMAIL_OVERRIDE` redirects them):

  ```bash
  SMTP_USER=$(az keyvault secret show \
    --vault-name fdv2-keyvault \
    --name smtp-user \
    --query value -o tsv)

  SMTP_PASS=$(az keyvault secret show \
    --vault-name fdv2-keyvault \
    --name smtp-pass \
    --query value -o tsv)
  ```

  If your production vault uses different secret names, adjust accordingly. If SMTP isn't set up yet, use empty strings for now — emails just won't send in UAT.

- [ ] **Step 5: Create the Container App**

  This is the longest command — it creates the app with all environment variables and Key Vault secret references. Run it as one block:

  ```bash
  az containerapp create \
    --name fdv2-uat-app \
    --resource-group fdv2-uat-rg \
    --environment fdv2-uat-aca-env \
    --image fdv2acr.azurecr.io/fdv2-app:latest \
    --registry-server fdv2acr.azurecr.io \
    --registry-identity $IDENTITY_ID \
    --target-port 3000 \
    --ingress external \
    --min-replicas 0 \
    --max-replicas 2 \
    --user-assigned $IDENTITY_ID \
    --secrets \
      "database-url=keyvaultref:${KV_URI}/database-url,identityref:${IDENTITY_ID}" \
      "jwt-secret=keyvaultref:${KV_URI}/jwt-secret,identityref:${IDENTITY_ID}" \
      "encryption-key=keyvaultref:${KV_URI}/encryption-key,identityref:${IDENTITY_ID}" \
      "admin-seed-password=keyvaultref:${KV_URI}/admin-seed-password,identityref:${IDENTITY_ID}" \
      "dev-email-override=keyvaultref:${KV_URI}/dev-email-override,identityref:${IDENTITY_ID}" \
      "smtp-pass=${SMTP_PASS}" \
    --env-vars \
      NODE_ENV=uat \
      PORT=3000 \
      BASE_DOMAIN=uat.delayedpaid.co.uk \
      DEV_TENANT_SLUG=demo \
      ADMIN_CORS_ORIGIN="https://ergo.uat.delayedpaid.co.uk" \
      SMTP_HOST=smtp.azurecomm.net \
      SMTP_PORT=587 \
      SMTP_USER="${SMTP_USER}" \
      DATABASE_URL=secretref:database-url \
      JWT_SECRET=secretref:jwt-secret \
      ENCRYPTION_KEY=secretref:encryption-key \
      ADMIN_SEED_PASSWORD=secretref:admin-seed-password \
      DEV_EMAIL_OVERRIDE=secretref:dev-email-override
  ```

  **What the `secretref:` prefix does:** Instead of storing the secret value directly in the environment variable (which would be visible in the Azure Portal), the Container App reads the value from the named secret at runtime. The Key Vault reference (`keyvaultref:...`) tells Azure where to fetch the secret from.

  This takes **2–3 minutes**.

- [ ] **Step 6: Get the UAT app URL**

  ```bash
  az containerapp show \
    --name fdv2-uat-app \
    --resource-group fdv2-uat-rg \
    --query 'properties.configuration.ingress.fqdn' -o tsv
  ```

  This returns a URL like `fdv2-uat-app.yellowish-1234abcd.uksouth.azurecontainerapps.io`. Open it in a browser — you should see the customer SPA loading (it may 500 until migrations are run in Task 11).

- [ ] **Step 7: Add the office-hours scale schedule**

  This brings the UAT app to life at 08:00 UTC and scales it to zero at 19:00 UTC on weekdays, to save money:

  ```bash
  az containerapp update \
    --name fdv2-uat-app \
    --resource-group fdv2-uat-rg \
    --scale-rule-name office-hours \
    --scale-rule-type cron \
    --scale-rule-metadata \
      timezone="Europe/London" \
      start="0 8 * * 1-5" \
      end="0 19 * * 1-5" \
      desiredReplicas="1"
  ```

  **What this means:** Mon–Fri, at 08:00 London time, ensure at least 1 replica is running. At 19:00, scale back to 0 (free). Weekends stay at 0 replicas unless there's active traffic.

---

## Task 11: Seed the UAT Database

**Why:** The database exists but has no tables yet. The app's migration runner creates all the tables. We also need to create the superadmin user so you can log in to the admin portal.

**Files:** None (Azure Container Apps job via CLI)

- [ ] **Step 1: Run the migrations**

  Container Apps can run one-off jobs. This command starts the app container with `npm run migrate` as the command instead of the normal web server:

  ```bash
  az containerapp job create \
    --name fdv2-uat-migrate \
    --resource-group fdv2-uat-rg \
    --environment fdv2-uat-aca-env \
    --trigger-type Manual \
    --replica-timeout 300 \
    --image fdv2acr.azurecr.io/fdv2-app:latest \
    --registry-server fdv2acr.azurecr.io \
    --registry-identity $IDENTITY_ID \
    --user-assigned $IDENTITY_ID \
    --secrets \
      "database-url=keyvaultref:${KV_URI}/database-url,identityref:${IDENTITY_ID}" \
      "jwt-secret=keyvaultref:${KV_URI}/jwt-secret,identityref:${IDENTITY_ID}" \
      "encryption-key=keyvaultref:${KV_URI}/encryption-key,identityref:${IDENTITY_ID}" \
    --env-vars \
      NODE_ENV=uat \
      DATABASE_URL=secretref:database-url \
      JWT_SECRET=secretref:jwt-secret \
      ENCRYPTION_KEY=secretref:encryption-key \
    --command "node" \
    --args "src/db/migrate.js"
  ```

  Then trigger it:
  ```bash
  az containerapp job start \
    --name fdv2-uat-migrate \
    --resource-group fdv2-uat-rg
  ```

  Watch the logs until it finishes:
  ```bash
  az containerapp job execution list \
    --name fdv2-uat-migrate \
    --resource-group fdv2-uat-rg \
    --query '[0].{status:properties.status,started:properties.startTime}' \
    --output json
  ```

  Wait until `"status": "Succeeded"`.

- [ ] **Step 2: Seed the superadmin user**

  ```bash
  az containerapp job create \
    --name fdv2-uat-seed-admin \
    --resource-group fdv2-uat-rg \
    --environment fdv2-uat-aca-env \
    --trigger-type Manual \
    --replica-timeout 120 \
    --image fdv2acr.azurecr.io/fdv2-app:latest \
    --registry-server fdv2acr.azurecr.io \
    --registry-identity $IDENTITY_ID \
    --user-assigned $IDENTITY_ID \
    --secrets \
      "database-url=keyvaultref:${KV_URI}/database-url,identityref:${IDENTITY_ID}" \
      "jwt-secret=keyvaultref:${KV_URI}/jwt-secret,identityref:${IDENTITY_ID}" \
      "encryption-key=keyvaultref:${KV_URI}/encryption-key,identityref:${IDENTITY_ID}" \
      "admin-seed-password=keyvaultref:${KV_URI}/admin-seed-password,identityref:${IDENTITY_ID}" \
    --env-vars \
      NODE_ENV=uat \
      DATABASE_URL=secretref:database-url \
      JWT_SECRET=secretref:jwt-secret \
      ENCRYPTION_KEY=secretref:encryption-key \
      ADMIN_SEED_PASSWORD=secretref:admin-seed-password \
    --command "node" \
    --args "src/db/seedAdmin.js"

  az containerapp job start \
    --name fdv2-uat-seed-admin \
    --resource-group fdv2-uat-rg
  ```

  Check it succeeds:
  ```bash
  az containerapp job execution list \
    --name fdv2-uat-seed-admin \
    --resource-group fdv2-uat-rg \
    --query '[0].properties.status' -o tsv
  ```

  Expected: `Succeeded`.

- [ ] **Step 3: Verify the UAT app loads**

  Get the UAT URL (from Task 10 Step 6) and open it in a browser. The customer SPA should load with the yellow UAT banner visible.

  Try logging in to the admin portal at `<UAT_URL>/admin` with username `admin` and the `<ADMIN_SEED_PASSWORD>` you generated in Task 9.

---

## Task 12: GitHub Actions — OIDC Federated Credential for `develop`

**Why:** The existing production CI/CD uses OIDC (passwordless authentication) to access Azure. We need to add a second trusted subject for the `develop` branch so GitHub Actions can also deploy to UAT without storing any Azure passwords.

**Files:** None (Azure + GitHub CLI)

- [ ] **Step 1: Find the app registration object ID**

  ```bash
  APP_OBJECT_ID=$(az ad app list \
    --display-name fdv2-github-actions \
    --query '[0].id' -o tsv)

  echo "App registration object ID: $APP_OBJECT_ID"
  ```

- [ ] **Step 2: Add the `develop` branch federated credential**

  ```bash
  az ad app federated-credential create \
    --id $APP_OBJECT_ID \
    --parameters '{
      "name": "github-develop-branch",
      "issuer": "https://token.actions.githubusercontent.com",
      "subject": "repo:neilfrostergo/flight-delay-v2:ref:refs/heads/develop",
      "description": "GitHub Actions OIDC for develop branch (UAT deployments)",
      "audiences": ["api://AzureADTokenExchange"]
    }'
  ```

  **What this does:** Tells Azure AD "trust JWT tokens from GitHub Actions, but only when they come from the `develop` branch of the `neilfrostergo/flight-delay-v2` repository".

- [ ] **Step 3: Grant the service principal `Contributor` access to the UAT Container App**

  ```bash
  # Get the service principal object ID (different from the app registration object ID)
  SP_OBJECT_ID=$(az ad sp list \
    --display-name fdv2-github-actions \
    --query '[0].id' -o tsv)

  UAT_APP_ID=$(az containerapp show \
    --name fdv2-uat-app \
    --resource-group fdv2-uat-rg \
    --query id -o tsv)

  az role assignment create \
    --role Contributor \
    --assignee-object-id $SP_OBJECT_ID \
    --assignee-principal-type ServicePrincipal \
    --scope $UAT_APP_ID
  ```

  **What this does:** Allows the `fdv2-github-actions` service principal to update the UAT Container App (change the image tag on each deploy).

- [ ] **Step 4: Verify existing GitHub secrets are present**

  The `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` secrets already exist in the repo (set up during production CI/CD). Confirm:

  ```bash
  gh secret list --repo neilfrostergo/flight-delay-v2
  ```

  Expected to see at minimum:
  ```
  AZURE_CLIENT_ID
  AZURE_TENANT_ID
  AZURE_SUBSCRIPTION_ID
  ```

  If any are missing, check with the production deploy.yml — the same three secrets are used for UAT.

---

## Task 13: GitHub Actions — `deploy-uat.yml` Workflow

**Why:** Whenever code is pushed to `develop`, GitHub Actions should automatically build a Docker image, push it to ACR, and deploy it to the UAT Container App. This is identical to the production workflow but targets UAT resources and uses a different image tag.

**Files:**
- Create: `.github/workflows/deploy-uat.yml`

- [ ] **Step 1: Create the workflow file**

  Create `.github/workflows/deploy-uat.yml` with this content:

  ```yaml
  name: Build and Deploy — UAT

  on:
    push:
      branches: [develop]

  permissions:
    id-token: write   # Required for OIDC login to Azure
    contents: read

  jobs:
    build-and-deploy:
      runs-on: ubuntu-latest

      steps:
        - name: Checkout
          uses: actions/checkout@v4

        - name: Set up Node.js
          uses: actions/setup-node@v4
          with:
            node-version: '20'
            cache: 'npm'
            cache-dependency-path: server/package-lock.json

        - name: Install dependencies
          run: npm ci
          working-directory: server

        - name: Run tests
          run: npm test --if-present
          working-directory: server

        - name: Log in to Azure
          uses: azure/login@v2
          with:
            client-id: ${{ secrets.AZURE_CLIENT_ID }}
            tenant-id: ${{ secrets.AZURE_TENANT_ID }}
            subscription-id: ${{ secrets.AZURE_SUBSCRIPTION_ID }}

        - name: Log in to ACR
          run: az acr login --name fdv2acr

        - name: Build and push image to ACR
          run: |
            docker build \
              -t fdv2acr.azurecr.io/fdv2-app:develop-${{ github.sha }} \
              -t fdv2acr.azurecr.io/fdv2-app:develop-latest \
              .
            docker push fdv2acr.azurecr.io/fdv2-app:develop-${{ github.sha }}
            docker push fdv2acr.azurecr.io/fdv2-app:develop-latest

        - name: Deploy to UAT Container App
          run: |
            az containerapp update \
              --name fdv2-uat-app \
              --resource-group fdv2-uat-rg \
              --image fdv2acr.azurecr.io/fdv2-app:develop-${{ github.sha }}
  ```

  **Also rename the production workflow for clarity:**
  ```bash
  git mv .github/workflows/deploy.yml .github/workflows/deploy-prod.yml
  ```
  Update the `name:` field at the top of `deploy-prod.yml` from `Build and Deploy` to `Build and Deploy — Production` so the two workflows are easy to distinguish in the GitHub Actions UI.

  **Key differences from `deploy-prod.yml`:**
  - Triggers on `develop` branch (not `main`)
  - Image tagged `develop-<sha>` and `develop-latest` (not `latest`) so UAT and production images are distinguishable in ACR
  - Deploys to `fdv2-uat-app` / `fdv2-uat-rg` (not `fdv2-app` / `fdv2-prod-rg`)

- [ ] **Step 2: Commit and push to trigger the first UAT deployment**

  ```bash
  git add .github/workflows/deploy-uat.yml
  git commit -m "ci: add deploy-uat.yml workflow for automatic UAT deployments on push to develop"
  git push origin develop
  ```

- [ ] **Step 3: Watch the GitHub Actions run**

  ```bash
  gh run list --repo neilfrostergo/flight-delay-v2 --branch develop
  ```

  Or open GitHub in a browser → Actions tab → "Build and Deploy — UAT". The run should pass with a green tick. Expected duration: ~3–4 minutes.

- [ ] **Step 4: Verify UAT is running the new image**

  ```bash
  az containerapp revision list \
    --name fdv2-uat-app \
    --resource-group fdv2-uat-rg \
    --query '[0].{image:properties.template.containers[0].image, active:properties.active}' \
    --output json
  ```

  The `image` field should show `fdv2acr.azurecr.io/fdv2-app:develop-<commit-sha>`.

---

## Task 14: DNS — `*.uat.delayedpaid.co.uk` Wildcard CNAME

**Why:** UAT tenants should be accessible at `ergo.uat.delayedpaid.co.uk` etc. A wildcard CNAME record `*.uat` pointing at the Container App URL means any tenant slug will resolve to the UAT app automatically.

**Files:** None (Azure DNS CLI)

- [ ] **Step 1: Get the UAT Container App domain**

  ```bash
  UAT_FQDN=$(az containerapp show \
    --name fdv2-uat-app \
    --resource-group fdv2-uat-rg \
    --query 'properties.configuration.ingress.fqdn' -o tsv)

  echo "UAT app domain: $UAT_FQDN"
  ```

  This will be something like `fdv2-uat-app.yellowish-1234abcd.uksouth.azurecontainerapps.io`.

- [ ] **Step 2: Add the wildcard CNAME record**

  ```bash
  az network dns record-set cname set-record \
    --resource-group fdv2-prod-rg \
    --zone-name delayedpaid.co.uk \
    --record-set-name "*.uat" \
    --cname $UAT_FQDN
  ```

  **What this does:** Creates a DNS record so that `anything.uat.delayedpaid.co.uk` resolves to the UAT Container App. The DNS zone `delayedpaid.co.uk` lives in `fdv2-prod-rg` (shared with production).

- [ ] **Step 3: Verify DNS is resolving**

  DNS propagation typically takes a few minutes. Check with:

  ```bash
  nslookup ergo.uat.delayedpaid.co.uk
  ```

  Expected output should show a CNAME chain ending at the Container App domain:
  ```
  ergo.uat.delayedpaid.co.uk  canonical name = fdv2-uat-app.yellowish-1234abcd.uksouth.azurecontainerapps.io
  ```

  If it shows `NXDOMAIN`, wait 2–3 minutes and try again.

- [ ] **Step 4: Update `ADMIN_CORS_ORIGIN` on the Container App**

  Now that DNS is set up, update the CORS origin to the wildcard pattern so any tenant subdomain is accepted by the admin SPA:

  ```bash
  az containerapp update \
    --name fdv2-uat-app \
    --resource-group fdv2-uat-rg \
    --set-env-vars ADMIN_CORS_ORIGIN="https://*.uat.delayedpaid.co.uk"
  ```

  **Note:** If the server's CORS middleware uses an exact match (not a pattern), you may need to update to wildcard CORS or list specific tenants. Check `server/src/index.js` — if it uses `corsOptions.origin` with a string comparison, update to accept any subdomain ending in `.uat.delayedpaid.co.uk`.

- [ ] **Step 5: Test end-to-end**

  Open `https://ergo.uat.delayedpaid.co.uk` in a browser. You should see:
  1. The customer SPA loading with Ergo branding
  2. The yellow UAT banner at the top: "⚠️ UAT ENVIRONMENT — NOT FOR REAL REGISTRATIONS"

  Open `https://ergo.uat.delayedpaid.co.uk/admin` and log in. The admin SPA should also show the yellow banner.

- [ ] **Step 6: Commit any remaining changes and push**

  ```bash
  git status
  git add -A
  git commit -m "chore: finalize environment strategy implementation"
  git push origin develop
  ```

---

## Summary

| Component | UAT Value |
|---|---|
| Resource group | `fdv2-uat-rg` |
| VNet | `fdv2-uat-vnet` (10.101.0.0/16) |
| Container App URL | `fdv2-uat-app.<hash>.uksouth.azurecontainerapps.io` |
| Tenant URL pattern | `*.uat.delayedpaid.co.uk` |
| `NODE_ENV` | `uat` |
| Database | `fdv2-uat-postgres.postgres.database.azure.com` |
| Key Vault | `fdv2-uat-keyvault` |
| CI trigger | Push to `develop` branch |
| Image tag | `develop-<sha>` |
| Payments | Always stub (enforced in code) |
| Policy API | Always stub (enforced in code) |
| Emails | Redirected to `DEV_EMAIL_OVERRIDE` address |
