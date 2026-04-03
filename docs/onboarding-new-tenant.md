# Onboarding a New Tenant

This guide covers everything needed to bring a new insurance brand onto the platform — from DNS through to a working customer portal.

---

## Prerequisites

- Access to the Azure portal or Azure CLI (`az login`)
- Superadmin credentials for the admin panel
- The tenant's subdomain slug (e.g. `staysure` → `staysure.delayedpaid.co.uk`)
- PolicyHub API key and coverholder key for the tenant (if using live policy validation)
- Modulr account ID and API key (if using live payouts)

---

## Step 1 — Create the tenant in the admin panel

1. Log in to the admin panel at `https://ergo.delayedpaid.co.uk/admin` (or any active tenant subdomain)
2. Log in as superadmin
3. Go to **Tenants → New Tenant**
4. Fill in the required fields:

| Field | Notes |
|-------|-------|
| Slug | Lowercase, alphanumeric, no spaces (e.g. `staysure`). This becomes the subdomain. |
| Name | Display name shown in the admin (e.g. `Staysure`) |
| Subdomain | Full subdomain: `staysure.delayedpaid.co.uk` |
| Primary colour | Hex code for the brand colour (e.g. `#00509e`) |
| Logo URL | Publicly accessible URL to the brand logo |
| Support email | Shown on the customer portal |
| Cover Benefit Name | Must exactly match (as a substring) the benefit name returned by PolicyHub — e.g. `Travel delay benefit` |
| Policy API | Select the PolicyHub API key from the dropdown |
| Coverholder key | Click **Load** next to the Policy API dropdown, then select the correct coverholder from the list |
| Policy API mode | `live` for production, `stub` for testing |
| Modulr account ID / API key | Required for live payouts |
| Modulr mode | `live` for production, `stub` for testing |

5. Click **Save**

---

## Step 2 — Add the custom domain to Azure Container Apps

This gives the tenant their own HTTPS subdomain. Run the following two commands, replacing `SLUG` with the tenant slug:

```bash
# 1. Register the hostname on the Container App
az containerapp hostname add \
  --name fdv2-app \
  --resource-group fdv2-prod-rg \
  --hostname SLUG.delayedpaid.co.uk

# 2. Issue and bind a managed TLS certificate (takes up to 20 minutes)
az containerapp hostname bind \
  --name fdv2-app \
  --resource-group fdv2-prod-rg \
  --hostname SLUG.delayedpaid.co.uk \
  --environment fdv2-aca-env \
  --validation-method CNAME
```

**What these do:**
- Step 1 registers the hostname with Azure so it knows to accept traffic for it
- Step 2 requests a free managed TLS certificate from Azure. Azure verifies ownership by checking the CNAME record already in DNS (`*.delayedpaid.co.uk` → prod app). Certificate issuance takes up to 20 minutes.

**DNS is already handled** — the `*.delayedpaid.co.uk` wildcard CNAME record covers all subdomains automatically. No DNS changes are needed for each new tenant.

To check when the certificate is ready:

```bash
az containerapp hostname list \
  --name fdv2-app \
  --resource-group fdv2-prod-rg \
  --output table
```

Look for `BindingType` changing from `Disabled` to `SniEnabled`.

---

## Step 3 — Verify

Once the certificate is issued, test the tenant:

1. Visit `https://SLUG.delayedpaid.co.uk` — the customer portal should load with the correct branding
2. Visit `https://SLUG.delayedpaid.co.uk/admin` — the admin panel should load
3. Log in with a test policy number to confirm policy validation is working

---

## UAT tenants

For UAT, the wildcard `*.uat.delayedpaid.co.uk` routes to the UAT Container App. UAT uses a single shared TLS certificate managed separately — no per-tenant DNS or certificate step is needed for UAT.

To test a tenant on UAT, simply use `SLUG.uat.delayedpaid.co.uk`. The tenant must exist in the UAT database (either created via the UAT admin panel, or seeded via migration).

---

## Existing tenants

| Tenant | Production URL | Status |
|--------|---------------|--------|
| ERGO | https://ergo.delayedpaid.co.uk | Live |

---

## Reference — key Azure resources

| Resource | Name | Purpose |
|----------|------|---------|
| Resource group | `fdv2-prod-rg` | All production resources |
| Container App | `fdv2-app` | Production app |
| Container App Environment | `fdv2-aca-env` | Hosts the prod Container App |
| DNS zone | `delayedpaid.co.uk` | Managed in `fdv2-prod-rg` |
| Wildcard DNS | `*.delayedpaid.co.uk` | CNAME → `fdv2-app.yellowbeach-70b56e52.uksouth.azurecontainerapps.io` |
| UAT wildcard DNS | `*.uat.delayedpaid.co.uk` | CNAME → `fdv2-uat-app.blackdesert-d8445a44.uksouth.azurecontainerapps.io` |
