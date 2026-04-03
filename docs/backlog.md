# Backlog

## Production HTTPS — Azure Application Gateway

**What:** Add an Application Gateway in front of the prod Container Apps environment to handle TLS termination for custom domains (`ergo.delayedpaid.co.uk`, `www.delayedpaid.co.uk`, and future tenant subdomains).

**Why:** The prod Container App environment is VNet-internal (`internal: true`), which means Azure managed certificates cannot be issued — Azure's cert validation service has no public route to the app. An Application Gateway sits in the VNet as the public TLS terminator, forwarding traffic internally.

**Scope:**
- Provision Application Gateway v2 in `fdv2-prod-rg` (UK South)
- Configure wildcard listener for `*.delayedpaid.co.uk` (requires a wildcard cert — Let's Encrypt or Azure-purchased)
- Backend pool pointing to the prod Container App internal IP (`10.100.6.51`)
- Health probe on `/api/tenant-config`
- Update `*.delayedpaid.co.uk` and `ergo.delayedpaid.co.uk` DNS to point to Application Gateway public IP instead of Container App FQDN

**Estimated cost:** ~£30–50/month for Application Gateway v2 (small SKU)

**Current workaround:** Prod is accessible over HTTPS via the Azure FQDN directly. Custom domain HTTP works but no TLS.

**UAT is not affected** — UAT environment is external and already has HTTPS via managed certs.
