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

**DNS:** The `*.delayedpaid.co.uk` wildcard handles traffic routing, but Azure cert validation requires an explicit CNAME per hostname. Add it first:

```bash
az network dns record-set cname set-record \
  --resource-group fdv2-prod-rg \
  --zone-name delayedpaid.co.uk \
  --record-set-name "SLUG" \
  --cname fdv2-app.yellowbeach-70b56e52.uksouth.azurecontainerapps.io
```

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

The wildcard `*.uat.delayedpaid.co.uk` routes to the UAT Container App, but each UAT subdomain still needs its own TLS certificate. UAT subdomains also require an extra DNS TXT record for Azure domain verification (because the CNAME is a wildcard, not a direct match).

Run the following for each new UAT tenant, replacing `SLUG`:

```bash
# 1. Add explicit CNAME for the UAT subdomain
az network dns record-set cname set-record \
  --resource-group fdv2-prod-rg \
  --zone-name delayedpaid.co.uk \
  --record-set-name "SLUG.uat" \
  --cname fdv2-uat-app.blackdesert-d8445a44.uksouth.azurecontainerapps.io

# 2. Add the domain verification TXT record (get the token from the error output of step 3 if needed)
az network dns record-set txt add-record \
  --resource-group fdv2-prod-rg \
  --zone-name delayedpaid.co.uk \
  --record-set-name "asuid.SLUG.uat" \
  --value "<TOKEN FROM AZURE>"

# 3. Register the hostname (run this first to get the token if you don't have it)
az containerapp hostname add \
  --name fdv2-uat-app \
  --resource-group fdv2-uat-rg \
  --hostname SLUG.uat.delayedpaid.co.uk

# 3. Issue and bind a managed TLS certificate
az containerapp hostname bind \
  --name fdv2-uat-app \
  --resource-group fdv2-uat-rg \
  --hostname SLUG.uat.delayedpaid.co.uk \
  --environment fdv2-uat-aca-env \
  --validation-method CNAME
```

**Getting the TXT token:** Run step 3 first — if the TXT record is missing, Azure will return an error message containing the required token value. Copy it, add the TXT record (step 2), then re-run step 3.

To check certificate status:

```bash
az containerapp hostname list \
  --name fdv2-uat-app \
  --resource-group fdv2-uat-rg \
  --output table
```

---

## Existing tenants

| Tenant | Production URL | UAT URL | Status |
|--------|---------------|---------|--------|
| ERGO | https://ergo.delayedpaid.co.uk | https://ergo.uat.delayedpaid.co.uk | Live |

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
