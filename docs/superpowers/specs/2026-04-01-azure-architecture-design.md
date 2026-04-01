# Azure Architecture Design — Flight Delay v2

**Date:** 2026-04-01
**Stage:** Growth (production-ready, cost-conscious)
**Region:** UK South
**Estimated cost:** ~£494–564/month (base) + ~£100 Twilio depending on SMS volume

---

## Goal

Deploy the flight-delay-v2 multi-tenant Node.js/Express/PostgreSQL SaaS platform on Azure in a production-ready, fully private, security-hardened configuration that can scale from single-insurer pilot to multi-insurer growth without re-architecture.

---

## Architecture Overview

All inbound traffic enters through **Azure Front Door Premium**, which provides global CDN, WAF (OWASP 3.2), DDoS Standard, and custom domain TLS termination. Front Door connects to the app exclusively via **Private Link** — the Container Apps environment has no public IP. All application infrastructure lives inside an **Azure Virtual Network (10.100.0.0/16)** in UK South. Outbound calls to Twilio and other external APIs exit through a **NAT Gateway** with a static public IP, enabling IP whitelisting at third-party providers.

---

## Components

### Edge — Azure Front Door Premium

- Global anycast CDN with WAF (OWASP 3.2 ruleset), rate limiting, geo-restriction (UK focus), bot protection
- DDoS Standard protection included
- Custom domains: `*.platform.co.uk` wildcard CNAME → Front Door; automatic TLS cert renewal
- Azure DNS: Wildcard `*.platform.co.uk` CNAME record pointing to the Front Door endpoint
- Private Link origin — no public IP on the Container Apps environment

### VNet — 10.100.0.0/16 (UK South)

**Container Apps Subnet — 10.100.1.0/24**

- Azure Container Apps Environment (VNet-integrated)
- Single Node.js 20 container (the existing Dockerfile unchanged)
- Min 1 replica, max 5; scale on HTTP request count
- Internal ingress only (traffic accepted only from Front Door via Private Link)
- Managed identity → Key Vault (no secrets in environment variables)
- Log Analytics workspace for structured logs

**Data Subnet — 10.100.2.0/24**

- Azure Database for PostgreSQL Flexible Server
  - PostgreSQL 16
  - General Purpose D2s_v3 (2 vCores, 8 GB)
  - Zone-redundant high availability (primary + standby in separate AZs)
  - VNet-injected — no public endpoint
  - 7-day point-in-time restore; geo-redundant backups
  - Automatic minor version upgrades

**Private Endpoints Subnet — 10.100.3.0/24**

- **Azure Key Vault** (Standard tier): stores `JWT_SECRET`, `ENCRYPTION_KEY`, SMTP credentials, Event Hub connection string, Twilio Auth Token. Private endpoint only; accessed by app via managed identity.
- **Azure Event Hub** (existing): Standard tier, 2 throughput units, 7-day retention, Blob checkpoint storage. Private endpoint added to bring it into the VNet.

**NAT Gateway Subnet — 10.100.4.0/24**

- Azure NAT Gateway with one Standard Public IP
- All outbound traffic from Container Apps routes through this gateway
- Provides a stable static IP for whitelisting at Twilio, Modulr, OAG, and the Claims API

### Platform Services

**Azure Communication Services**
- Replaces Nodemailer SMTP in production
- Drop-in SMTP relay — no code changes required beyond `SMTP_HOST/PORT/USER/PASS` env vars pointing to the ACS SMTP endpoint
- 10,000 emails/month free, then ~£0.25/1,000
- Built-in bounce handling, suppression lists, delivery tracking

**Twilio (third-party, outbound only)**
- SMS and WhatsApp Business API for payment/delay notifications
- Outbound only — traffic exits via NAT Gateway static IP
- Twilio Auth Token stored in Key Vault
- New `twilioService.js` needed (not in current codebase); phone number opt-in per tenant
- Defer to a separate implementation plan

**Azure Blob Storage (existing)**
- Document uploads (booking confirmations)
- Private container, soft delete 7 days

**Azure Monitor + Log Analytics**
- Container Apps structured logs → Log Analytics workspace
- Application Insights for request tracing and performance
- Alert rules → email / PagerDuty for error rate, latency, container restarts
- 90-day log retention

**Azure Container Registry (Basic tier)**
- Private Docker image store
- Images pushed by GitHub Actions on merge to main
- Pull via managed identity (no registry credentials in the app)

### CI/CD — GitHub Actions

- Source of truth: the existing GitHub repository
- On push to `main`:
  1. `npm test`
  2. `docker build` (multi-stage Dockerfile)
  3. Push image to ACR
  4. Deploy to Container Apps (revision-based rolling deploy)
  5. Manual approval gate before production deploy (GitHub Environments + Required Reviewers)
- **OIDC Workload Identity Federation**: GitHub Actions authenticates to Azure via a federated credential — no stored secrets in GitHub
- Container Apps revision traffic split supports zero-downtime deploys and easy rollback

---

## Networking Summary

| Subnet | CIDR | Contents |
|---|---|---|
| Container Apps | 10.100.1.0/24 | ACA Environment |
| Data | 10.100.2.0/24 | PostgreSQL Flexible Server |
| Private Endpoints | 10.100.3.0/24 | Key Vault, Event Hub |
| NAT Gateway | 10.100.4.0/24 | NAT Gateway + Public IP |

All inter-service traffic stays within the VNet or over Private Link. No service has a public IP except the NAT Gateway egress IP (outbound only) and the Front Door origin (managed by Microsoft).

---

## Security Controls

| Control | Implementation |
|---|---|
| No public app IP | Container Apps internal ingress + Front Door Private Link |
| WAF | OWASP 3.2 ruleset on Front Door Premium |
| DDoS | DDoS Standard on Front Door |
| Secrets management | Azure Key Vault + managed identity (no env var secrets) |
| TLS everywhere | Front Door terminates external TLS; internal traffic over VNet |
| Static egress IP | NAT Gateway — enables IP whitelisting at Twilio, Modulr, OAG |
| Container image | ACR with private pull; no public registry |
| Deploy auth | OIDC federated identity — no long-lived credentials |
| Audit log | Existing `request_log` + `audit_log` tables; 90-day Monitor retention |

---

## Cost Estimate (UK South, growth stage)

| Service | Tier | Est. £/month |
|---|---|---|
| Azure Front Door Premium | 10M requests/month | ~£100 |
| Container Apps | 1–3 replicas avg | ~£50–120 |
| PostgreSQL Flexible Server | D2s_v3 · HA · 128 GB | ~£250 |
| Azure Key Vault | Standard · ~10k ops/month | ~£5 |
| Azure Event Hub | Standard · 2 TU | ~£20 |
| Azure Communication Services | ~50k emails/month | ~£10 |
| Container Registry | Basic | ~£4 |
| Azure Monitor / Log Analytics | 5 GB/day | ~£50 |
| Blob Storage | 100 GB + transactions | ~£5 |
| NAT Gateway | 1 public IP + data processed | ~£10 |
| **Total** | | **~£504–574/month** |

Twilio SMS/WhatsApp is additional (~£0.04–0.08/message depending on channel and destination).

---

## Out of Scope (deferred)

- **Twilio integration code** (`twilioService.js`, per-tenant phone opt-in, DB schema) — separate plan
- **Azure DevOps** — using GitHub Actions for now; can migrate to Azure Pipelines later with minimal changes as the container-based build process is portable
- **Multi-region** — single UK South region appropriate for growth stage; geo-redundant DB backups provide DR baseline
- **Staging environment** — can be added as a second Container Apps environment sharing the same ACR; deferred until needed
