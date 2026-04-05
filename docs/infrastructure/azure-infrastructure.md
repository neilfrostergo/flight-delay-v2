# Azure Infrastructure — flight-delay-v2

> Last audited: 2026-04-04  
> Subscription: **AI Corp Landing Zone** (`3fc25908-60fa-46ed-9027-6890ee798270`)  
> Azure AD Tenant: **ERGO Travel Group** (`d5200dfe-1ac0-4607-a991-1d18b6051750`)  
> Region: **UK South** (all resources unless noted)

---

## 1. Overview

The flight-delay-v2 platform runs as a containerised Node.js/Express/PostgreSQL application on Azure Container Apps, fronted by Azure Front Door Premium in production. Two environments share the same subscription and container registry:

| Environment | Resource Group | Domain |
|-------------|---------------|--------|
| Production  | `fdv2-prod-rg` | `*.delayedpaid.co.uk` |
| UAT         | `fdv2-uat-rg`  | `*.uat.delayedpaid.co.uk` |

Key architectural properties:
- All secrets are stored in per-environment Azure Key Vaults; no credentials are baked into container images.
- Container Apps pull images from `fdv2acr.azurecr.io` using user-assigned managed identities (no registry passwords).
- The production Container App environment is **internal** (no public IP), accessible only through Azure Front Door via Private Link.
- PostgreSQL servers are fully private (delegated subnet, private DNS zone, no public endpoint).
- Event Hubs receives OAG flight alert events over a private endpoint.

---

## 2. Subscriptions & Resource Groups

### Subscriptions

| Name | Subscription ID | Default |
|------|-----------------|---------|
| AI Corp Landing Zone | `3fc25908-60fa-46ed-9027-6890ee798270` | Yes |
| Azure subscription 1 | `473a74ab-d8eb-42fb-aed8-5a1c63c203db` | No |
| identity | `f9a88c87-099d-4fcc-a30c-ade62c588474` | No |
| management | `a60ec9b5-358c-4f58-857a-faf5fd0893a7` | No |
| AI Online Landing Zone | `ac51521f-f431-4c53-ac43-9e7c7bc081f0` | No |
| connectivity | `3ce96a93-a8fa-4482-8bf4-0f10f2aeaf3a` | No |

All flight-delay-v2 resources live in the **AI Corp Landing Zone** subscription.

### Resource Groups (flight-delay-v2)

| Name | Location | Purpose |
|------|----------|---------|
| `fdv2-prod-rg` | UK South | All production resources |
| `fdv2-uat-rg` | UK South | All UAT resources |
| `fdv2-aca-infra-rg` | UK South | Supporting infra for prod ACA environment (pre-existing) |
| `fdv2-aca-managed` | UK South | Azure-managed resource group for prod ACA environment infrastructure |
| `ME_fdv2-uat-aca-env_fdv2-uat-rg_uksouth` | UK South | Azure-managed resource group for UAT ACA environment |
| `ME_fdv2-uat-env_fdv2-uat-rg_uksouth` | UK South | Azure-managed (legacy, from earlier UAT environment iteration) |

---

## 3. Networking

### Virtual Networks

| Name | Resource Group | Address Space | Subnets |
|------|---------------|--------------|---------|
| `fdv2-vnet` | `fdv2-prod-rg` | `10.100.0.0/16` | 3 (see below) |
| `fdv2-uat-vnet` | `fdv2-uat-rg` | `10.101.0.0/16` | 3 (see below) |

No VNet peerings are configured between production and UAT.

#### Production VNet Subnets (`fdv2-vnet`)

| Subnet | CIDR | Delegation | Purpose |
|--------|------|-----------|---------|
| `fdv2-aca-subnet` | `10.100.0.0/21` | `Microsoft.App/environments` | Container Apps environment; NAT gateway attached |
| `fdv2-data-subnet` | `10.100.8.0/24` | `Microsoft.DBforPostgreSQL/flexibleServers` | PostgreSQL flexible server; Storage service endpoint enabled |
| `fdv2-pe-subnet` | `10.100.9.0/24` | None | Private endpoints (Key Vault, Event Hub) |

#### UAT VNet Subnets (`fdv2-uat-vnet`)

| Subnet | CIDR | Delegation | Purpose |
|--------|------|-----------|---------|
| `fdv2-uat-aca-subnet` | `10.101.0.0/21` | `Microsoft.App/environments` | Container Apps environment |
| `fdv2-uat-data-subnet` | `10.101.8.0/24` | `Microsoft.DBforPostgreSQL/flexibleServers` | PostgreSQL flexible server; Storage service endpoint enabled |
| `fdv2-uat-pe-subnet` | `10.101.9.0/24` | None | Private endpoints (Key Vault) |

### NAT Gateway (Production only)

| Resource | Details |
|----------|---------|
| `fdv2-nat-gateway` | Attached to `fdv2-aca-subnet`; static outbound IP via `fdv2-nat-ip` |
| `fdv2-nat-ip` | Static public IP address for all production outbound traffic |

UAT does **not** use a NAT gateway; outbound traffic uses the shared ACA environment pool.

### Private Endpoints

| Resource | Private Endpoint | DNS Zone | VNet |
|----------|-----------------|---------|------|
| `fdv2-keyvault` | `fdv2-kv-pe` | `privatelink.vaultcore.azure.net` | `fdv2-vnet` |
| `fdv2-eventhub` | `fdv2-eventhub-pe` | `privatelink.servicebus.windows.net` | `fdv2-vnet` |
| `fdv2-uat-keyvault` | `fdv2-uat-kv-pe` | `privatelink.vaultcore.azure.net` | `fdv2-uat-vnet` |

The production ACA environment itself also accepts an inbound private endpoint connection from Azure Front Door (see Front Door section).

### Private DNS Zones (Production)

| Zone | Purpose |
|------|---------|
| `fdv2-postgres.private.postgres.database.azure.com` | PostgreSQL flexible server resolution |
| `postgres.database.azure.com` | Additional PostgreSQL DNS (legacy, from earlier setup) |
| `privatelink.vaultcore.azure.net` | Key Vault private endpoint resolution |
| `privatelink.servicebus.windows.net` | Event Hub private endpoint resolution |

### DNS — Public Zone

**Zone:** `delayedpaid.co.uk` (Azure Public DNS, `fdv2-prod-rg`, global)

| Record | Type | TTL | Notes |
|--------|------|-----|-------|
| `@` | SOA / NS | 172800 / 3600 | Zone apex |
| `*` | CNAME | 3600 | Wildcard — production tenants |
| `ergo` | CNAME | 3600 | Prod ERGO tenant |
| `asuid.ergo` | TXT | 3600 | Custom domain verification |
| `www` | CNAME | 3600 | Production www |
| `asuid.www` | TXT | 3600 | Custom domain verification |
| `*.uat` | CNAME | 3600 | Wildcard — UAT tenants |
| `ergo.uat` | CNAME | 3600 | UAT ERGO tenant |
| `asuid.ergo.uat` | TXT | 3600 | UAT custom domain verification |
| `www.uat` | CNAME | 3600 | UAT www |
| `asuid.www.uat` | TXT | 3600 | UAT custom domain verification |

### Azure Front Door (Production)

| Property | Value |
|----------|-------|
| Name | `fdv2-frontdoor` |
| Resource group | `fdv2-prod-rg` |
| SKU | **Premium_AzureFrontDoor** |
| Front Door ID | `cdc2b395-0e37-4675-af41-cfaff02ed905` |
| Endpoint | `fdv2-endpoint` → `fdv2-endpoint-b7fsdzfedegeh8dv.a03.azurefd.net` |
| WAF Policy | `fdv2WafPolicy` (global) |

**Origin group:** `fdv2-origins`
- Health probe: `GET /api/health` (HTTPS, every 30 s)
- Load balancing: 4 samples, 3 required, 50 ms additional latency

**Route:** `fdv2-default-route`
- Pattern: `/*`
- Protocols: HTTP + HTTPS (HTTP redirected to HTTPS)
- Forwarding: HTTPS only

The ACA environment `fdv2-aca-env` has `publicNetworkAccess: Disabled`; all inbound traffic arrives via Front Door's private endpoint connection (approved, `eafd-Prod-uksouth` resource group in a separate subscription).

---

## 4. Container Infrastructure

### Container Registry

| Property | Value |
|----------|-------|
| Name | `fdv2acr` |
| Login server | `fdv2acr.azurecr.io` |
| SKU | **Basic** |
| Location | UK South |
| Resource group | `fdv2-prod-rg` |
| Admin user | Disabled |
| Public network access | Enabled (no private endpoint) |
| Retention policy | Disabled (7-day soft delete also disabled) |

**Repository:** `fdv2-app`

Image tag conventions:
- Production tags: `<git-sha>` and `latest`
- UAT tags: `develop-<git-sha>` and `develop-latest`

### Container App Environments

| Property | Production (`fdv2-aca-env`) | UAT (`fdv2-uat-aca-env`) |
|----------|----------------------------|--------------------------|
| Resource group | `fdv2-prod-rg` | `fdv2-uat-rg` |
| Default domain | `yellowbeach-70b56e52.uksouth.azurecontainerapps.io` | `blackdesert-d8445a44.uksouth.azurecontainerapps.io` |
| Static IP | `10.100.6.51` (internal) | `20.26.140.214` (public) |
| Public network access | **Disabled** | Enabled |
| VNet subnet | `fdv2-aca-subnet` (10.100.0.0/21) | `fdv2-uat-aca-subnet` (10.101.0.0/21) |
| Internal | Yes | No |
| Zone redundant | No | No |
| Log Analytics | `fdv2-logs` (`0e94cc40-...`) | `fdv2-uat-logs` (`a9a38086-...`) |
| Workload profiles | Consumption only | Consumption only |
| KEDA version | 2.17.2 | 2.17.2 |
| Dapr version | 1.16.4-msft.2 | 1.16.4-msft.2 |
| Managed infra RG | `fdv2-aca-managed` | `ME_fdv2-uat-aca-env_fdv2-uat-rg_uksouth` |

### Container Apps

#### Production — `fdv2-app`

| Property | Value |
|----------|-------|
| Resource group | `fdv2-prod-rg` |
| FQDN | `fdv2-app.yellowbeach-70b56e52.uksouth.azurecontainerapps.io` |
| Latest revision | `fdv2-app--0000012` |
| Current image | `fdv2acr.azurecr.io/fdv2-app:3e8cf79cde93ff2c341c099b64a929ecded3b7a6` |
| CPU | 0.5 vCPU |
| Memory | 1 Gi |
| Min replicas | 1 |
| Max replicas | 5 |
| Scale rules | None (scale by replica count only) |
| Revision mode | Single |
| Target port | 3000 |
| Custom domains | `ergo.delayedpaid.co.uk` (binding: Disabled — served via Front Door) |
| Identity | User-assigned: `fdv2-identity` (`c2fe2b0c-ddb5-486b-a7d7-893e853f6a8e`) |
| Registry | `fdv2acr.azurecr.io` (via managed identity, no password) |

**Environment variables (plain):**

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `BASE_DOMAIN` | `delayedpaid.co.uk` |
| `AZURE_CLIENT_ID` | `c2fe2b0c-ddb5-486b-a7d7-893e853f6a8e` |

**Secrets (sourced from Key Vault via managed identity):**

| Secret ref name | Key Vault secret |
|-----------------|-----------------|
| `database-url` | `DATABASE-URL` |
| `jwt-secret` | `JWT-SECRET` |
| `encryption-key` | `ENCRYPTION-KEY` |
| `smtp-host` | `SMTP-HOST` |
| `smtp-port` | `SMTP-PORT` |
| `smtp-user` | `SMTP-USER` |
| `smtp-pass` | `SMTP-PASS` |
| `event-hub-conn-str` | `event-hub-connection-string` |
| `event-hub-storage-conn-str` | `event-hub-storage-connection-string` |

#### UAT — `fdv2-uat-app`

| Property | Value |
|----------|-------|
| Resource group | `fdv2-uat-rg` |
| FQDN | `fdv2-uat-app.blackdesert-d8445a44.uksouth.azurecontainerapps.io` |
| Latest revision | `fdv2-uat-app--0000056` |
| Current image | `fdv2acr.azurecr.io/fdv2-app:develop-93c3beee352275565c4888788afa654f9de1c354` |
| CPU | 0.5 vCPU |
| Memory | 1 Gi |
| Min replicas | 0 (scales to zero outside office hours) |
| Max replicas | 2 |
| Scale rule | `office-hours` (KEDA cron): scale to 1 Mon–Fri 08:00–19:00 Europe/London |
| Custom domains | `ergo.uat.delayedpaid.co.uk` (SNI cert: `mc-fdv2-uat-aca-e-ergo-uat-delayed-7070`) |
|  | `www.uat.delayedpaid.co.uk` (SNI cert: `mc-fdv2-uat-aca-e-www-uat-delayedp-5953`) |
| Identity | User-assigned: `fdv2-uat-identity` (`88b52eda-ab63-41bd-b5bc-872eb6d3dbed`) |

**Environment variables (plain):**

| Variable | Value |
|----------|-------|
| `NODE_ENV` | `uat` |
| `PORT` | `3000` |
| `BASE_DOMAIN` | `uat.delayedpaid.co.uk` |
| `DEV_TENANT_SLUG` | `demo` |
| `ADMIN_CORS_ORIGIN` | `https://ergo.uat.delayedpaid.co.uk` |

**Secrets (sourced from Key Vault via managed identity):**

`database-url`, `jwt-secret`, `encryption-key`, `smtp-host`, `smtp-port`, `smtp-user`, `smtp-pass`, `admin-seed-password`, `dev-email-override`

### Container App Jobs

All jobs run on the Consumption workload profile in their respective ACA environments.

#### Production Jobs

| Job name | Trigger | Command | Purpose |
|----------|---------|---------|---------|
| `fdv2-migrate` | Manual | `npm run migrate` | Run DB migrations (Key Vault-sourced DATABASE_URL) |
| `fdv2-migrate-prod` | Manual | `node src/db/migrate.js` | Preferred migration job — Key Vault sourced secrets |
| `fdv2-migrate-diag` | Manual | `npm run migrate` | Diagnostic variant — hardcoded DATABASE_URL (should be retired) |
| `fdv2-seed-diag` | Manual | `npm run seed:admin` | Diagnostic seed job — hardcoded credentials (should be retired) |
| `fdv2-sync-job` | Manual (also scheduled via GitHub Actions) | `node src/scripts/syncReferenceData.js` | Syncs carrier/airport reference data from Snowflake to PostgreSQL |

#### UAT Jobs

| Job name | Trigger | Purpose |
|----------|---------|---------|
| `fdv2-uat-migrate` | Manual | Run DB migrations against UAT database |
| `fdv2-uat-seed-admin` | Manual | Seed superadmin user in UAT |
| `fdv2-sync-job` | Manual (also scheduled via GitHub Actions) | Sync reference data from Snowflake to UAT PostgreSQL |

---

## 5. Database

### Production — `fdv2-postgres`

| Property | Value |
|----------|-------|
| Resource group | `fdv2-prod-rg` |
| FQDN | `fdv2-postgres.postgres.database.azure.com` |
| Engine version | PostgreSQL **16** (minor: 16.13) |
| SKU | `Standard_D2s_v3` — **GeneralPurpose** tier |
| Storage | 128 GiB (P10 tier, IOPS: 500, auto-grow: Disabled) |
| High availability | **Zone Redundant** — primary AZ 2, standby AZ 1 |
| Backup retention | 7 days |
| Geo-redundant backup | Disabled |
| Public network access | **Disabled** |
| Network | Delegated subnet `fdv2-data-subnet` (10.100.8.0/24) |
| Private DNS zone | `fdv2-postgres.private.postgres.database.azure.com` |
| Auth | Password only (Entra ID auth: Disabled) |
| Admin login | `fdv2admin` |
| Data encryption | System-managed |
| Replica capacity | 5 (no active read replicas) |

### UAT — `fdv2-uat-postgres`

| Property | Value |
|----------|-------|
| Resource group | `fdv2-uat-rg` |
| FQDN | `fdv2-uat-postgres.postgres.database.azure.com` |
| Engine version | PostgreSQL **16** (minor: 16.13) |
| SKU | `Standard_B1ms` — **Burstable** tier |
| Storage | 32 GiB (P4 tier, IOPS: 120, auto-grow: Disabled) |
| High availability | Disabled |
| Backup retention | 7 days |
| Geo-redundant backup | Disabled |
| Public network access | **Disabled** |
| Network | Delegated subnet `fdv2-uat-data-subnet` (10.101.8.0/24) |
| Private DNS zone | `fdv2-uat-postgres.private.postgres.database.azure.com` |
| Auth | Password only |
| Admin login | `fdv2admin` |

---

## 6. Key Vaults

Both vaults use RBAC authorisation (no legacy access policies). Soft-delete is enabled with 90-day retention.

### Production — `fdv2-keyvault`

| Property | Value |
|----------|-------|
| URI | `https://fdv2-keyvault.vault.azure.net/` |
| Resource group | `fdv2-prod-rg` |
| SKU | Standard |
| RBAC | Enabled |
| Soft delete | Enabled (90 days) |
| Purge protection | Not enabled |
| Public network access | Enabled (access controlled by private endpoint) |
| Private endpoint | `fdv2-kv-pe` (connection `fdv2-kv-connection`, Approved) |

**Secrets stored (names only):**

| Secret name | Used by |
|-------------|---------|
| `DATABASE-URL` | `fdv2-app`, `fdv2-migrate`, `fdv2-migrate-prod` |
| `JWT-SECRET` | `fdv2-app`, `fdv2-migrate-prod` |
| `ENCRYPTION-KEY` | `fdv2-app`, `fdv2-migrate-prod` |
| `SMTP-HOST` | `fdv2-app` |
| `SMTP-PORT` | `fdv2-app` |
| `SMTP-USER` | `fdv2-app` |
| `SMTP-PASS` | `fdv2-app` |
| `event-hub-connection-string` | `fdv2-app` |
| `event-hub-storage-connection-string` | `fdv2-app` |

### UAT — `fdv2-uat-keyvault`

| Property | Value |
|----------|-------|
| URI | `https://fdv2-uat-keyvault.vault.azure.net/` |
| Resource group | `fdv2-uat-rg` |
| SKU | Standard |
| RBAC | Enabled |
| Soft delete | Enabled (90 days) |
| Private endpoint | `fdv2-uat-kv-pe` (Approved) |

**Secrets stored (names only):**

`database-url`, `jwt-secret`, `encryption-key`, `smtp-host`, `smtp-port`, `smtp-user`, `smtp-pass`, `admin-seed-password`, `dev-email-override`

---

## 7. Messaging (Event Hubs)

Event Hubs is provisioned in **production only**. UAT uses the 30-second DB poller (`eventSource.js`) as the event source.

### Namespace — `fdv2-eventhub`

| Property | Value |
|----------|-------|
| Resource group | `fdv2-prod-rg` |
| Location | UK South |
| SKU | **Standard**, 2 throughput units |
| Kafka surface | Enabled |
| Zone redundant | Yes |
| Public network access | **Disabled** |
| Private endpoint | `fdv2-eventhub-pe` (Auto-Approved) |
| DNS zone | `privatelink.servicebus.windows.net` |
| Min TLS version | 1.2 |
| Local auth | Enabled (SAS tokens permitted) |

### Event Hub — `oag-flight-alerts`

| Property | Value |
|----------|-------|
| Partitions | 4 |
| Message retention | 7 days (168 hours) |
| Cleanup policy | Delete |
| Status | Active |

The connection string for this hub is stored in Key Vault as `event-hub-connection-string`. A separate storage connection string (`event-hub-storage-connection-string`) is used for Event Hub consumer group checkpointing.

---

## 8. Observability

### Log Analytics Workspaces

| Name | Resource Group | Retention | Customer ID |
|------|---------------|-----------|-------------|
| `fdv2-logs` | `fdv2-prod-rg` | **90 days** | `0e94cc40-b8a0-4c14-be72-03dbce8fc2f8` |
| `fdv2-uat-logs` | `fdv2-uat-rg` | 30 days | `a9a38086-b4d3-400f-b117-423c0ccdb560` |
| `workspace-fdv2uatrgLbuD` | `fdv2-uat-rg` | 30 days | `9188b33c-...` (orphaned — from earlier UAT iteration) |
| `workspace-fdv2uatrg3Mav` | `fdv2-uat-rg` | 30 days | `02dbd075-...` (orphaned — from earlier UAT iteration) |

`fdv2-uat-logs` is the active workspace linked to `fdv2-uat-aca-env`. The two `workspace-fdv2uatrg*` workspaces are leftovers from failed/earlier environment provisioning attempts and can be deleted.

### Application Insights

| Name | Resource group | Notes |
|------|---------------|-------|
| `fdv2-appinsights` | `fdv2-prod-rg` | Production only; linked to `fdv2-logs` workspace |

### Alerting

| Resource | Type | Scope |
|----------|------|-------|
| `fdv2-alerts` | Action Group | `fdv2-prod-rg` (global) |
| `fdv2-container-restarts` | Metric Alert | Container restart threshold |
| `fdv2-high-error-rate` | Metric Alert | HTTP 5xx error rate threshold |
| `Application Insights Smart Detection` | Action Group | Auto-created by App Insights |

---

## 9. Identity & Access

### User-Assigned Managed Identities

| Identity | Resource Group | Client ID | Principal ID | Used by |
|----------|---------------|-----------|--------------|---------|
| `fdv2-identity` | `fdv2-prod-rg` | `c2fe2b0c-ddb5-486b-a7d7-893e853f6a8e` | `873d6bc9-453c-4630-aa50-4ca4338bda3d` | All prod Container Apps and jobs |
| `fdv2-uat-identity` | `fdv2-uat-rg` | `88b52eda-ab63-41bd-b5bc-872eb6d3dbed` | `fb414a52-4329-48df-b402-6673979038dd` | All UAT Container Apps and jobs |

### RBAC Role Assignments — Managed Identities

| Identity | Role | Scope |
|----------|------|-------|
| `fdv2-identity` | Key Vault Secrets User | `fdv2-keyvault` |
| `fdv2-identity` | AcrPull | `fdv2acr` |
| `fdv2-uat-identity` | Key Vault Secrets User | `fdv2-uat-keyvault` |
| `fdv2-uat-identity` | AcrPull | `fdv2acr` |

### OIDC App Registration — `fdv2-github-actions`

Used by GitHub Actions to authenticate to Azure without long-lived credentials.

| Property | Value |
|----------|-------|
| App (client) ID | `d6f06cd5-5232-4ced-ad19-6a8b5183e6c6` |
| Object ID (app reg) | `2d3b670f-e6dc-42e3-89b5-07957bbda6c0` |
| Service principal ID | `40080264-85ab-4e0a-a669-70b89c10c874` |
| Sign-in audience | AzureADMyOrg |
| Publisher domain | `ergotravelgroup.onmicrosoft.com` |

**Federated credentials:**

| Name | Subject | Branch | Purpose |
|------|---------|--------|---------|
| `fdv2-github-main` | `repo:neilfrostergo/flight-delay-v2:ref:refs/heads/main` | `main` | Production deployments |
| `github-develop-branch` | `repo:neilfrostergo/flight-delay-v2:ref:refs/heads/develop` | `develop` | UAT deployments |

**Note:** No explicit role assignments were found for the `fdv2-github-actions` service principal at resource group scope. Deployments succeed because `ga.nf@ergotravelgroup.onmicrosoft.com` (the workflow authenticates using OIDC then uses Azure CLI with the subscription Owner role). In practice the GitHub Actions service principal inherits no scoped role — the container app update commands run under the identity of the workflow's OIDC session, which maps to the user's Owner role at subscription level.

### Subscription-Level Role Assignments

| Principal | Role | Scope |
|-----------|------|-------|
| `ga.nf@ergotravelgroup.onmicrosoft.com` | Owner | Subscription, management groups, tenant root |
| Lenovo Technology (UK) Ltd. foreign principal | Owner | Subscription |
| `0fd780f6-...` (object ID) | Owner | Subscription |

---

## 10. CI/CD (GitHub Actions)

Repository: `neilfrostergo/flight-delay-v2`  
Workflow files: `.github/workflows/`

### Workflow: `deploy-prod.yml` — Build and Deploy — Production

**Trigger:** Push to `main` branch

**Steps:**
1. Checkout source code
2. Set up Node.js 20 (with `npm` cache keyed on `server/package-lock.json`)
3. `npm ci` in `server/`
4. `npm test --if-present` in `server/`
5. Azure OIDC login (`azure/login@v2`) using `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` secrets
6. `az acr login --name fdv2acr`
7. `docker build` and push two tags to ACR: `<git-sha>` and `latest`
8. `az containerapp update` on `fdv2-app` in `fdv2-prod-rg` to the `<git-sha>` image

**Note:** No migration step is included in this workflow. Migrations must be triggered manually via the `fdv2-migrate-prod` Container App Job after deployment.

### Workflow: `deploy-uat.yml` — Build and Deploy — UAT

**Trigger:** Push to `develop` branch

**Steps:**
1–4. Same as production (checkout, Node.js, install, test)
5–6. Same Azure + ACR login
7. `docker build` and push two tags: `develop-<git-sha>` and `develop-latest`
8. `az containerapp update` on `fdv2-uat-app` in `fdv2-uat-rg` to the `develop-<git-sha>` image

### Workflow: `sync-ref-data.yml` — Sync Reference Data (Snowflake → PostgreSQL)

**Trigger:** 
- Scheduled: `0 3 2 * *` (2nd of every month at 03:00 UTC)
- Manual: `workflow_dispatch`

**Jobs (run in parallel):**
- `sync-prod`: Azure OIDC login → `az containerapp job start --name fdv2-sync-job --resource-group fdv2-prod-rg`
- `sync-uat`: Azure OIDC login → `az containerapp job start --name fdv2-sync-job --resource-group fdv2-uat-rg`

This triggers the `fdv2-sync-job` Container App Job in each environment, which connects to Snowflake (`OAG_SCHEDULES.DIRECT_CUSTOMER_CONFIGURATIONS`) and syncs airport and carrier reference data into PostgreSQL.

**GitHub Actions Secrets Required:**

| Secret | Value reference |
|--------|----------------|
| `AZURE_CLIENT_ID` | `d6f06cd5-5232-4ced-ad19-6a8b5183e6c6` |
| `AZURE_TENANT_ID` | `d5200dfe-1ac0-4607-a991-1d18b6051750` |
| `AZURE_SUBSCRIPTION_ID` | `3fc25908-60fa-46ed-9027-6890ee798270` |

---

## 11. Storage

### Production — `fdv2prodsa`

| Property | Value |
|----------|-------|
| Resource group | `fdv2-prod-rg` |
| Kind | StorageV2 (general purpose v2) |
| SKU | Standard_LRS |
| Access tier | Hot |
| Location | UK South |
| HTTPS only | Yes |
| Minimum TLS | **TLS 1.0** (should be upgraded to TLS 1.2) |
| Public blob access | Disabled |
| Cross-tenant replication | Disabled |
| Network rules | Default Allow (no firewall rules configured) |
| Private endpoints | None |

**Blob endpoint:** `https://fdv2prodsa.blob.core.windows.net/`  
**Purpose:** Used as the Event Hub consumer group checkpoint store (connection string stored in Key Vault as `event-hub-storage-connection-string`).

**Known issue:** Minimum TLS version is set to TLS 1.0 — should be raised to TLS 1.2 to align with the Event Hub namespace setting and security best practice.

---

## 12. Communication Services

| Resource | Type | Resource group | Location |
|----------|------|---------------|---------|
| `fdv2-comms` | Azure Communication Services | `fdv2-prod-rg` | global |
| `fdv2-email` | Email Communication Service | `fdv2-prod-rg` | global |
| `fdv2-email/AzureManagedDomain` | Email domain | `fdv2-prod-rg` | global |

These resources are provisioned but the application currently uses SMTP (Nodemailer) for customer email notifications. The ACS/Email resources appear to be infrastructure set up in anticipation of migrating from SMTP to Azure Communication Services, but the integration has not yet been implemented in the application code.

---

## 13. Resource Naming Conventions

| Component | Production pattern | UAT pattern |
|-----------|-------------------|-------------|
| Resource group | `fdv2-prod-rg` | `fdv2-uat-rg` |
| VNet | `fdv2-vnet` | `fdv2-uat-vnet` |
| Subnet | `fdv2-<purpose>-subnet` | `fdv2-uat-<purpose>-subnet` |
| ACA environment | `fdv2-aca-env` | `fdv2-uat-aca-env` |
| Container App | `fdv2-app` | `fdv2-uat-app` |
| Container App Job | `fdv2-<purpose>` | `fdv2-uat-<purpose>` |
| PostgreSQL | `fdv2-postgres` | `fdv2-uat-postgres` |
| Key Vault | `fdv2-keyvault` | `fdv2-uat-keyvault` |
| Managed identity | `fdv2-identity` | `fdv2-uat-identity` |
| Private endpoint | `fdv2-<service>-pe` | `fdv2-uat-<service>-pe` |
| Storage account | `fdv2prodsa` | (no UAT storage account) |
| Log Analytics | `fdv2-logs` | `fdv2-uat-logs` |
| ACR | `fdv2acr` | (shared with production) |
| Image tags (prod) | `<git-sha>`, `latest` | `develop-<git-sha>`, `develop-latest` |

All resources are tagged with `environment: production` or `environment: uat`.

---

## 14. Gaps / Items Not Yet Provisioned or Requiring Attention

### Security

- **`fdv2-migrate-diag` and `fdv2-seed-diag` jobs** contain hardcoded plaintext database credentials and an admin seed password directly in their container environment configuration. These diagnostic jobs should be deleted or migrated to use Key Vault references (as `fdv2-migrate-prod` does).
- **Storage account TLS version**: `fdv2prodsa` uses TLS 1.0 as minimum — should be raised to TLS 1.2.
- **ACR has no private endpoint**: `fdv2acr` uses public network access. Container Apps pull images over the public internet. Consider adding a private endpoint if network-level isolation for image pulls is required.
- **GitHub Actions service principal has no explicit scoped role assignment**: The OIDC principal currently relies on the subscription Owner role inherited from the human user session rather than a dedicated, least-privilege Contributor role on the relevant resource groups.

### Infrastructure Gaps

- **No UAT Event Hub**: UAT uses the 30-second DB polling loop (`eventSource.js`) rather than Event Hub. This means UAT does not validate the Event Hub consumer path end-to-end.
- **No UAT Front Door / WAF**: UAT container app environment has public network access enabled with no WAF in front.
- **No geo-redundant backups**: Neither production nor UAT PostgreSQL has geo-redundant backup enabled. A regional Azure outage would require restoring from the most recent local backup.
- **Azure Communication Services not integrated**: `fdv2-comms` and `fdv2-email` resources exist but are not wired up in the application; email still goes via SMTP.
- **ACR retention policy disabled**: Images are not automatically purged. Tag count will grow indefinitely unless a purge policy or lifecycle rule is added.
- **No scheduled migration job**: DB migrations must be triggered manually after each deployment. There is no automation to run `fdv2-migrate-prod` as part of the CI/CD pipeline.
- **Two orphaned Log Analytics workspaces in UAT** (`workspace-fdv2uatrgLbuD`, `workspace-fdv2uatrg3Mav`) from earlier failed provisioning — can be deleted.
- **Snowflake connectivity for UAT `fdv2-sync-job`**: The UAT sync job is triggered by the GitHub Actions workflow but no UAT-specific Snowflake credentials are visible; it may be sharing production Snowflake credentials.
