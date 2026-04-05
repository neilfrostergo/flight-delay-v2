# Infrastructure Documentation

This folder contains reference documentation for the flight-delay-v2 Azure infrastructure.

## Documents

| File | Description |
|------|-------------|
| [azure-infrastructure.md](azure-infrastructure.md) | Comprehensive audit of all Azure resources across production and UAT environments |

## Quick Reference

| What | Where |
|------|-------|
| Subscription | AI Corp Landing Zone (`3fc25908-60fa-46ed-9027-6890ee798270`) |
| Azure AD Tenant | ERGO Travel Group (`d5200dfe-1ac0-4607-a991-1d18b6051750`) |
| Production resource group | `fdv2-prod-rg` |
| UAT resource group | `fdv2-uat-rg` |
| Container registry | `fdv2acr.azurecr.io` |
| Production domain | `*.delayedpaid.co.uk` |
| UAT domain | `*.uat.delayedpaid.co.uk` |
| GitHub repo | `neilfrostergo/flight-delay-v2` |
| OIDC app registration | `fdv2-github-actions` (`d6f06cd5-5232-4ced-ad19-6a8b5183e6c6`) |

## Sections in azure-infrastructure.md

1. Overview
2. Subscriptions & Resource Groups
3. Networking (VNets, subnets, NAT gateway, private endpoints, DNS, Front Door)
4. Container Infrastructure (Registry, Container App Environments, Container Apps, Jobs)
5. Database (PostgreSQL Flexible Servers)
6. Key Vaults
7. Messaging (Event Hubs)
8. Observability (Log Analytics, Application Insights, Alerting)
9. Identity & Access (Managed identities, RBAC, OIDC app registration)
10. CI/CD (GitHub Actions workflows)
11. Storage
12. Communication Services
13. Resource naming conventions
14. Gaps / items requiring attention
