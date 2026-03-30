# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 (LTS) |
| Framework | Express 5 |
| Database | PostgreSQL 16 |
| Auth | JSON Web Tokens (jsonwebtoken) |
| Password hashing | bcrypt |
| Encryption | AES-256-GCM (Node crypto built-in) |
| Validation | Joi |
| Email | Nodemailer |

## Local Development (Docker Compose)

```bash
cp server/.env.example server/.env
# Edit server/.env — generate ENCRYPTION_KEY and JWT_SECRET (see comments in file)

docker compose up db -d
docker compose run --rm app npm run migrate
docker compose run --rm app npm run seed:admin   # requires ADMIN_SEED_PASSWORD in .env
docker compose up
# App: http://localhost:3000 (customer SPA)
# Admin: http://localhost:3000/admin
```

To wipe the database: `docker compose down -v`

In development, pass `X-Tenant-Slug: demo` header to target the demo tenant (no subdomain required). The server reads this header only when `NODE_ENV !== 'production'`.

## Development Commands

All commands run from `server/`:

```bash
npm run dev        # Start with hot-reload (requires server/.env)
npm start          # Production mode
npm run migrate    # Run DB migrations (idempotent)
npm run seed:admin # Create superadmin user (uses ADMIN_SEED_PASSWORD env var)
```

## Architecture

### Multi-Tenancy

Each insurance company ("tenant") has its own subdomain (`ergo.platform.co.uk`). The `resolveTenant.js` middleware reads the `Host` header, strips the base domain, looks up the tenant slug in the DB, and attaches `req.tenant`. A 30-second in-memory Map cache prevents repeated DB hits.

### Request Flow

```
Browser → Express (server/src/index.js)
            ├── Helmet (CSP) + CORS
            ├── resolveTenant middleware (all routes)
            ├── requestLogger middleware (/api/* routes)
            │
            ├── GET /               → customer/index.html  (6-step registration SPA)
            ├── GET /admin          → admin/index.html     (admin SPA)
            │
            ├── /api/tenant-config         → tenant branding (public)
            ├── /api/validate-policy       → Ergo Connect or stub (rate-limited)
            ├── /api/validate-token        → pre-validation token consumption (rate-limited)
            ├── /api/flight-lookup         → OAG Flight Info API (rate-limited)
            ├── /api/registrations         → create registration / fetch confirmation
            │
            └── /api/admin/*               → JWT-protected admin routes
                ├── auth                   login / me / change-password
                ├── tenants                superadmin CRUD
                ├── registrations          list / detail / status patch / CSV export
                ├── flights                flight registration list
                ├── payments               list / retry
                ├── tokens                 pre-validation token management
                ├── apikeys                OAG key vault (superadmin)
                ├── simulator              inject flight events for testing
                └── request-log            HTTP audit log (superadmin)
```

### Directory Structure

```
flight-delay-v2/
├── customer/index.html         6-step white-labeled customer SPA (vanilla JS)
├── admin/index.html            Multi-tenant admin SPA (vanilla JS)
├── docker-compose.yml
├── Dockerfile                  Multi-stage production build
└── server/
    ├── .env.example
    └── src/
        ├── index.js            Express entry — middleware assembly + route mounts
        ├── config.js           Env var validation; exports typed config object
        ├── db/
        │   ├── connection.js   pg Pool + query()/withTransaction()
        │   ├── migrate.js      SQL migration runner (idempotent)
        │   ├── seedAdmin.js    Seeds superadmin (tenant_id = NULL)
        │   └── migrations/
        │       ├── 001_schema.sql  All tables
        │       └── 002_seed_data.sql  Demo tenant + placeholder OAG key
        ├── middleware/
        │   ├── resolveTenant.js    Host→slug→tenant lookup with 30s cache
        │   ├── requireAdmin.js     JWT verify; requireAdmin/requireSuperAdmin/requireTenantAdmin
        │   ├── rateLimiter.js      registrationLimiter/validateLimiter/loginLimiter
        │   └── requestLogger.js    Writes all /api/* calls to request_log
        ├── routes/
        │   ├── tenantConfig.js     GET /api/tenant-config
        │   ├── validatePolicy.js   POST /api/validate-policy
        │   ├── validateToken.js    POST /api/validate-token
        │   ├── flightLookup.js     GET /api/flight-lookup (OAG)
        │   ├── register.js         POST /api/registrations + GET /api/registrations/:id/confirmation
        │   └── admin/
        │       ├── auth.js         Login + JWT
        │       ├── tenants.js      Superadmin tenant CRUD + stats
        │       ├── registrations.js  Scoped list/detail/patch/CSV
        │       ├── flights.js      Scoped flight_registrations
        │       ├── payments.js     Scoped payments + retry
        │       ├── tokens.js       Pre-validation token lifecycle
        │       ├── apikeys.js      shared_api_keys vault
        │       ├── simulate.js     Inject test flight events
        │       └── requestLog.js   request_log viewer (superadmin)
        └── services/
            ├── encryption.js       AES-256-GCM encrypt/decrypt/isEncrypted
            ├── policyValidator.js  Stub + live Ergo Connect client
            ├── modulr.js           Modulr Faster Payments stub/live interface
            ├── delayProcessor.js   Core payout flow (flight event → payment)
            ├── notificationService.js  Tenant-branded email notifications
            ├── oagAlerts.js        OAG flight alert subscription management
            └── eventSource.js      30s DB poller (Azure Event Hub swap point)
```

### Database Schema (key tables)

| Table | Purpose |
|-------|---------|
| `tenants` | One per insurer brand; holds policy API config, Modulr config, branding |
| `admin_users` | `tenant_id = NULL` = superadmin; `tenant_id = X` = tenant admin |
| `pre_validation_tokens` | 64-char hex tokens; customer clicks link to skip manual policy entry |
| `registrations` | Core record; UNIQUE(tenant_id, policy_number); bank details encrypted |
| `flight_registrations` | Many per registration; links to shared subscription |
| `flight_alert_subscriptions` | Global (no tenant_id); shared when multiple tenants have same flight |
| `flight_events` | Append-only event log; processed by delayProcessor |
| `payments` | One per payout attempt; retry-able if failed |
| `notifications` | Customer email delivery tracking |
| `shared_api_keys` | OAG key + any future global keys (superadmin only) |
| `audit_log` | Admin actions: key reveals, simulations, status patches |
| `request_log` | Every /api/* call with tenant_id, status, duration |

### Key Design Decisions

- **Monetary values**: All payout amounts are integer pence. Never use floats for money.
- **Bank detail encryption**: Sort codes and account numbers are AES-256-GCM encrypted before insert. Never returned in API responses. Only decrypted in `delayProcessor` (for live payout) and payment retry.
- **Tenant admin scoping**: `adminTenantScope(req)` returns `null` for superadmin (no WHERE filter) and `tenant_id` for tenant admins. All scoped routes use this helper.
- **JWT payload**: `{ sub, username, role, tenant_id }`. `tenant_id = null` for superadmin.
- **Pre-validation tokens**: The token in the URL is the `token` column (64-char hex), not the row `id`. Tokens are consumed in `validateToken.js` and marked `used_at` during registration.
- **OAG subscriptions**: Shared globally — if ergo and axa both register BA123 on 2025-06-01, one subscription row exists and both tenants' flight_registrations link to it.
- **Payout amount**: Derived from Ergo Connect `cover[].limit` where `cover[].name` matches `tenant.cover_benefit_name` (default `"Flight Delay"`). `payout_pence = Math.round(limit * 100)`.
- **Stub mode**: Both `policyValidator.js` and `modulr.js` have stub implementations. Stub is the default for demo tenant.
- **Production swap point**: `eventSource.js` 30s DB poller → replace with Azure Event Hub consumer for production. Commented in code.
- **Tenant cache invalidation**: `resolveTenant.js` exposes `invalidateTenantCache(slug)` — called by `tenants.js` on update/delete.

## Required Environment Variables

Copy `server/.env.example` to `server/.env`.

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | 64+ random chars for signing JWTs |
| `ENCRYPTION_KEY` | Exactly 64 hex chars (32 bytes) for AES-256-GCM |
| `PORT` | HTTP port (default: 3000) |
| `NODE_ENV` | `development` or `production` |
| `BASE_DOMAIN` | Base domain for subdomain extraction (e.g. `platform.co.uk`) |
| `DEV_TENANT_SLUG` | Fallback tenant slug in dev (also accepts `X-Tenant-Slug` header) |
| `ADMIN_CORS_ORIGIN` | Allowed origin for /api/admin requests |
| `ADMIN_SEED_PASSWORD` | Password for seeded superadmin |
| `SMTP_HOST/PORT/USER/PASS` | SMTP credentials for customer emails |

Generate secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"  # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # ENCRYPTION_KEY
```

## Policy Validation (Ergo Connect)

**Live mode** calls `POST {tenant.policy_api_url}/api/PolicySearch/getpolicy` with bearer token decrypted from `tenant.policy_api_key_enc`. Checks:
1. `data[0].status === 'Active'`
2. `data[0].policyHolderEmailAddress` matches submitted email (case-insensitive)
3. Finds `cover[]` entry where `name === tenant.cover_benefit_name`
4. `payout_pence = Math.round(cover.limit * 100)`

**Stub mode** returns mock data for any well-formed input — used by the demo tenant.
