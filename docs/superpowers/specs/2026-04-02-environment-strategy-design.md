# Environment Strategy Design — Flight Delay v2

**Date:** 2026-04-02
**Status:** Approved

---

## Goal

Establish a three-tier environment strategy (Dev → UAT → Production) with Git Flow branching, a lightweight UAT environment on Azure that cannot process real policies or payments, and a manual promotion gate from UAT to production.

---

## Environment Overview

| | Dev | UAT | Production |
|---|---|---|---|
| Infrastructure | Docker Compose (local) | Azure `fdv2-uat-rg` | Azure `fdv2-prod-rg` |
| Branch | `feature/*` | `develop` | `main` |
| Deployment | Manual (`docker compose up`) | Auto on push to `develop` | Auto on push to `main` |
| Domain | `localhost:3000` | `*.uat.delayedpaid.co.uk` | `*.delayedpaid.co.uk` |
| `BASE_DOMAIN` | `localhost` | `uat.delayedpaid.co.uk` | `delayedpaid.co.uk` |
| `NODE_ENV` | `development` | `uat` | `production` |
| Real payments | ❌ Stub | ❌ Stub (enforced) | ✅ Live |
| Real policy API | ❌ Stub | ❌ Stub or sandbox | ✅ Live |
| Event Hub | ❌ DB poller | ❌ DB poller | ✅ Azure Event Hub |
| Front Door / WAF | ❌ | ❌ Direct ACA URL | ✅ |
| Est. monthly cost | £0 | ~£40–60 | ~£504–574 |

---

## Git Flow Branching

```
feature/my-change  →  develop  →  main
     (local)           (UAT)      (PROD)
```

- **`feature/*` branches**: Developer creates from `develop`, works locally with Docker Compose, opens PR back to `develop` when ready.
- **`develop` branch**: Auto-deploys to UAT on every push. This is what UAT testers use.
- **`main` branch**: Auto-deploys to production. Updated only by merging `develop` → `main` via PR.
- **Hotfixes**: Branch from `main`, fix, merge to `main` (deploy to prod), then also merge to `develop` to keep branches in sync.

### Promotion: UAT → Production

1. UAT testing complete (internal + external sign-off)
2. Open PR: `develop` → `main`
3. Merge the PR (no second approver required for now — add GitHub Environment approval gate when team grows)
4. GitHub Actions detects push to `main` → builds image → deploys to production (~3 minutes)

---

## UAT Azure Infrastructure

All resources in `fdv2-uat-rg`, UK South.

### VNet: `fdv2-uat-vnet` (10.101.0.0/16)

| Subnet | CIDR | Contents |
|---|---|---|
| `fdv2-uat-aca-subnet` | 10.101.0.0/21 | Container Apps Environment |
| `fdv2-uat-data-subnet` | 10.101.8.0/24 | PostgreSQL Flexible Server |
| `fdv2-uat-pe-subnet` | 10.101.9.0/24 | Key Vault private endpoint |

### Compute

- **Container Apps Environment**: `fdv2-uat-aca-env` — VNet-integrated, external ingress
- **Container App**: `fdv2-uat-app` — min 0 replicas, max 2, Consumption profile
- **Scale schedule**: min replicas = 1 at 08:00 UTC, min replicas = 0 at 19:00 UTC (Mon–Fri)

### Data

- **PostgreSQL Flexible Server**: `fdv2-uat-postgres`
  - SKU: Burstable B1ms (1 vCore, 2 GB RAM)
  - No zone-redundant HA
  - 32 GB storage
  - VNet-injected, no public endpoint
  - Private DNS zone: `postgres.database.azure.com` (shared or new)

### Secrets & Identity

- **Key Vault**: `fdv2-uat-keyvault` — own secrets, private endpoint in `fdv2-uat-pe-subnet`
- **Managed Identity**: `fdv2-uat-identity` — separate from production identity

### Shared with Production

- **Azure Container Registry** (`fdv2acr`) — same images deployed to both environments
- **Azure DNS Zone** (`delayedpaid.co.uk`) — wildcard `*.uat` CNAME added

### Not included in UAT

- Front Door Premium (too expensive — UAT accessed via direct Container Apps URL)
- NAT Gateway (no static outbound IP needed — no real third-party API calls)
- Event Hub (DB poller used instead)
- Azure Monitor alerts (optional — can add later)

---

## Safety Controls (UAT cannot process real policies/payments)

| Risk | Control |
|---|---|
| Real customer registers | `NODE_ENV=uat` forces stub policy validator — no live policy API calls |
| Real payment sent | Modulr stub mode forced — no live Modulr credentials in UAT Key Vault |
| Tester confused about environment | Yellow "UAT ENVIRONMENT — NOT FOR REAL REGISTRATIONS" banner in admin SPA and customer SPA when `NODE_ENV=uat` |
| Real email sent to customer | `DEV_EMAIL_OVERRIDE` set in UAT to internal test inbox — all outbound email redirected |
| UAT data bleeds into production | Separate database, separate Key Vault, separate resource group — zero shared state |
| `uat` used as a tenant slug in production | Reserved slugs blocklist in `POST /api/admin/tenants` — `uat`, `www`, `api`, `admin`, `health`, `mail`, `staging`, `dev`, `test` are rejected |

---

## Tenant Subdomain Structure

Tenant slugs work identically in both environments — the `BASE_DOMAIN` env var controls the subdomain stripping:

- Production: `ergo.delayedpaid.co.uk` → `BASE_DOMAIN=delayedpaid.co.uk` → slug = `ergo`
- UAT: `ergo.uat.delayedpaid.co.uk` → `BASE_DOMAIN=uat.delayedpaid.co.uk` → slug = `ergo`

DNS records required (once `delayedpaid.co.uk` is on Azure DNS):
- `*.uat.delayedpaid.co.uk` CNAME → `fdv2-uat-app.<aca-env-domain>.uksouth.azurecontainerapps.io`

Each UAT tenant has its own row in the UAT database — completely isolated from production tenants of the same slug name.

---

## GitHub Actions Changes

### New workflow: `.github/workflows/deploy-uat.yml`

- Triggers on push to `develop`
- Builds image tagged `:develop-<sha>`
- Pushes to `fdv2acr`
- Deploys to `fdv2-uat-app`

### Existing workflow: `.github/workflows/deploy.yml`

- Rename to `deploy-prod.yml` for clarity
- Triggers on push to `main` (unchanged)
- Deploys to `fdv2-app` (unchanged)

### OIDC Federated Credentials

Add a second federated credential to the existing `fdv2-github-actions` app registration:
- Subject: `repo:neilfrostergo/flight-delay-v2:ref:refs/heads/develop`
- Same tenant/subscription/client ID as production

Add additional role assignments for UAT:
- `AcrPush` on `fdv2acr` (already granted — shared ACR)
- `Contributor` on `fdv2-uat-app` Container App

---

## Code Changes Required

### 1. Reserved slug validation (`server/src/routes/admin/tenants.js`)

Add a blocklist check to the `POST /api/admin/tenants` route:

```js
const RESERVED_SLUGS = ['uat', 'www', 'api', 'admin', 'health', 'mail', 'smtp', 'staging', 'dev', 'test'];

if (RESERVED_SLUGS.includes(slug)) {
  return res.status(400).json({ error: `Slug "${slug}" is reserved` });
}
```

### 2. UAT environment banner (`customer/index.html` + `admin/index.html`)

Add a yellow banner when `NODE_ENV=uat` is returned in the tenant config response:

```html
<!-- shown only when env === 'uat' -->
<div id="uat-banner" style="display:none;background:#d29922;color:#000;text-align:center;padding:8px;font-weight:bold">
  ⚠️ UAT ENVIRONMENT — NOT FOR REAL REGISTRATIONS
</div>
```

### 3. Expose `NODE_ENV` in tenant config response (`server/src/routes/tenantConfig.js`)

Add `env: config.nodeEnv` to the tenant config response so the SPA can read it.

### 4. Stub enforcement for `NODE_ENV=uat`

In `policyValidator.js` and `modulr.js`, treat `NODE_ENV=uat` the same as `NODE_ENV=development` — always use stub mode regardless of tenant config.

---

## Out of Scope

- Azure DevOps migration (can swap GitHub Actions for Azure Pipelines at any time — same Azure infrastructure)
- Staging environment between UAT and prod (can add later as a third Container Apps revision)
- Multi-region UAT
- UAT Front Door / WAF (not cost-justified)
