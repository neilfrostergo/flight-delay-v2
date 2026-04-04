# Delayed? Paid. — Platform Brief

> Reference document for Claude Code sessions.
> Suggested opening: "I'm working on the Delayed? Paid. platform — please read docs/brief.md and CLAUDE.md before we begin."

---

## Project Overview

**Product:** Flight delay insurance with instant, automatic payouts.
**Domain:** delayedpaid.co.uk
**Distribution:** B2B white-label — multiple insurance brand partners each get their own subdomain
**Parent company:** ERGO Travel Insurance Services Ltd (Munich Re Group)
**Stack:** Node.js 20 / Express 5 / PostgreSQL 16 / Azure Container Apps

---

## Brand Identity

| Token | Value |
|---|---|
| Primary red | `#EE0138` |
| Near-black | `#1a1a1a` |
| White | `#ffffff` |
| Font | Space Grotesk 800 |
| Tagline | "Flight Delay Insurance · Instant Payout" |
| Logo style | Split-block — "Delayed?" in `#1a1a1a` left block, "Paid." in `#EE0138` right block |

---

## Architecture Overview

```
Customer browser
    │
    ├─ GET <slug>.delayedpaid.co.uk/       → customer SPA (customer/index.html)
    └─ GET <slug>.delayedpaid.co.uk/admin  → admin SPA (admin/index.html)
           │
           ▼
    Express server (server/src/index.js)
           │
    resolveTenant middleware
    (Host → slug → tenant DB row, 30s cache)
           │
    ├─ /api/tenant-config       Public branding endpoint
    ├─ /api/validate-policy     Policy + email check (Ergo Connect / stub)
    ├─ /api/validate-token      Pre-validation token consumption
    ├─ /api/flight-lookup       OAG flight search (by number or route)
    ├─ /api/registrations       Submit registration
    ├─ /api/customer/*          Customer portal (JWT-authenticated)
    └─ /api/admin/*             Admin panel (JWT-authenticated, scoped by role)
           │
    PostgreSQL 16
           │
    Azure Event Hub → delayProcessor → Modulr Faster Payments
```

---

## How Customers Register

There are two entry points:

### 1. Direct (self-serve)
Customer visits `<tenant>.delayedpaid.co.uk`, enters their policy number and email. The policy API validates them, returns their cover details and payout amount. They then add their flight(s) and bank details.

### 2. Pre-validation token (frictionless)
Admin generates a token (individually or via CSV bulk upload) linked to a policy number + email. Customer receives a link like `https://<tenant>.delayedpaid.co.uk/?token=<64-hex>`. Clicking it skips policy entry — they land directly at the flight registration step.

---

## Customer Journey (6-step SPA)

```
Step 1 — Policy validation
         Enter policy number + email  →  POST /api/validate-policy
         (or ?token=<hex> in URL  →  POST /api/validate-token)

Step 2 — Flight search
         Search by flight number (OAG) or by route
         Select flight from results; repeat for multi-leg trips

Step 3 — Review basket
         See all selected flights; confirm payout per person

Step 4 — Bank details
         Sort code + account number (AES-256-GCM encrypted at rest)

Step 5 — Confirmation
         Registration complete; upload booking confirmation / boarding pass

My Account portal (always accessible after login)
         View all registered flights + upload documents + add further flights
```

---

## Payout Flow

```
OAG Flight Alert → Azure Event Hub → delayProcessor.js
    │
    ├─ Find all flight_registrations for this flight
    ├─ Check delay_minutes >= tenant.delay_threshold_minutes (default 180)
    ├─ Decrypt bank details
    ├─ POST to Modulr Faster Payments API
    ├─ Insert payment row
    └─ Send customer notification email
```

---

## Multi-Tenancy

Each tenant is one insurance brand. Routing is by subdomain:

```
ergo.delayedpaid.co.uk  →  slug "ergo"   →  tenants row
axa.delayedpaid.co.uk   →  slug "axa"    →  tenants row
```

`resolveTenant.js` strips the base domain from the `Host` header, looks up the slug, and attaches `req.tenant` to every request. A 30s in-memory cache prevents repeated DB round-trips.

In development: pass `X-Tenant-Slug: demo` header, or set `DEV_TENANT_SLUG` in `.env`.

---

## Admin Roles

| Role | Access |
|---|---|
| `superadmin` | All tenants; tenant CRUD; shared API keys; request log |
| `admin` | Own tenant only; registrations, flights, payments, tokens |
| `readonly` | Own tenant; read-only |

`tenant_id = NULL` on `admin_users` = superadmin.

---

## Database Schema

All monetary values are **integer pence**. Encrypted fields use **AES-256-GCM**: `base64iv:base64tag:base64ciphertext`.

### tenants
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| slug | VARCHAR(50) UNIQUE | e.g. `ergo` |
| name | VARCHAR(200) | e.g. `ERGO Travel Insurance` |
| subdomain | VARCHAR(200) UNIQUE | full host: `ergo.delayedpaid.co.uk` |
| logo_url | TEXT | |
| primary_colour | VARCHAR(7) | CSS hex, default `#1a56db` |
| terms_url | TEXT | |
| support_email | VARCHAR(255) | |
| policy_api_key_id | INTEGER → shared_api_keys | FK to shared policy API key (superadmin-managed) |
| policy_api_mode | VARCHAR(10) | `stub` or `live` |
| policy_api_coverholder_key | TEXT | CoverHolder key for PolicyHub API filtering |
| cover_benefit_name | VARCHAR(100) | Match string in cover[] array, default `Flight Delay` |
| modulr_account_id | VARCHAR(100) | |
| modulr_api_key_enc | TEXT | AES-256-GCM encrypted |
| modulr_mode | VARCHAR(10) | `stub` or `live` |
| token_ttl_days | INTEGER | Pre-validation token lifetime, default 7 |
| delay_threshold_minutes | INTEGER | Minutes before payout triggers, default 180 |
| min_hours_before_dep | INTEGER | Minimum notice to register, default 24 |
| max_days_before_dep | INTEGER | How far ahead a flight can be registered, default 40 |
| portal_label | VARCHAR(100) | Header button label, default `My Account` |
| claim_url | VARCHAR(500) | |
| my_account_url | VARCHAR(500) | |
| register_claim_url | VARCHAR(500) | CTA in customer emails |
| is_active | BOOLEAN | |

### admin_users
| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| tenant_id | INTEGER → tenants | NULL = superadmin |
| username | VARCHAR(100) UNIQUE | |
| email | VARCHAR(255) UNIQUE | |
| password_hash | TEXT | bcrypt cost 12 |
| role | VARCHAR(20) | `superadmin`, `admin`, `readonly` |
| is_active | BOOLEAN | |
| last_login_at | TIMESTAMPTZ | |

### registrations
One per policy number per tenant. Bank details never returned in API responses.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| tenant_id | INTEGER → tenants | |
| policy_number | VARCHAR(100) | UNIQUE with tenant_id |
| first_name, last_name | VARCHAR(100) | From policy API |
| email | VARCHAR(255) | |
| payout_pence | INTEGER | From `cover[].limit * 100` |
| cover_start_date, cover_end_date | DATE | |
| policy_type | VARCHAR(50) | `single_trip`, `annual_multi_trip`, `return_trip` |
| travelers | JSONB | Array of `{firstName, lastName}` |
| cover_summary | JSONB | Full cover array from policy API |
| bank_sort_code_enc | TEXT | AES-256-GCM |
| bank_account_enc | TEXT | AES-256-GCM |
| status | VARCHAR(20) | `pending`, `active`, `paid`, `cancelled` |
| pre_validation_token_id | INTEGER → pre_validation_tokens | |
| ip_address | INET | |

### pre_validation_tokens
Admin-generated tokens that let customers skip policy number entry.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| tenant_id | INTEGER → tenants | |
| token | VARCHAR(64) UNIQUE | crypto-random hex |
| policy_number | VARCHAR(100) | |
| email | VARCHAR(255) | |
| expires_at | TIMESTAMPTZ | |
| used_at | TIMESTAMPTZ | NULL = not yet consumed |
| registration_id | INTEGER → registrations | Linked after use |
| created_by | INTEGER → admin_users | |

### flight_alert_subscriptions
Global (no tenant scope). One OAG subscription per unique carrier+flight+date. Shared across all tenants.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| carrier_code | VARCHAR(10) | e.g. `BA` |
| flight_number | VARCHAR(10) | e.g. `BA249` |
| dep_date | DATE | UNIQUE with carrier_code + flight_number |
| oag_alert_id | VARCHAR(255) | NULL in stub mode |
| status | VARCHAR(20) | `active`, `completed`, `cancelled` |

### flight_registrations
Many per registration. Each links to a shared subscription.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| registration_id | INTEGER → registrations | |
| tenant_id | INTEGER → tenants | |
| flight_number | VARCHAR(20) | e.g. `BA249` |
| carrier_code | VARCHAR(10) | |
| dep_iata, arr_iata | VARCHAR(10) | |
| dep_name, arr_name | VARCHAR(255) | Friendly name from ref_airports |
| dep_date | DATE | |
| scheduled_dep_time | VARCHAR(10) | Local HH:MM |
| scheduled_arr_time | VARCHAR(10) | |
| status | VARCHAR(20) | `active`, `paid`, `cancelled` |
| flight_subscription_id | INTEGER → flight_alert_subscriptions | |

### registration_documents
Uploaded booking confirmations and boarding passes, with AI-matched flight associations.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| registration_id | INTEGER → registrations | |
| tenant_id | INTEGER → tenants | |
| flight_registration_id | INTEGER → flight_registrations | Explicit upload target |
| original_name | TEXT | |
| stored_name | TEXT | UUID filename on disk |
| mime_type | TEXT | |
| file_size_bytes | INTEGER | |
| document_type | TEXT | `booking_confirmation`, `boarding_pass`, `other` |
| parse_method | TEXT | How text was extracted |
| parsed_flight_numbers | TEXT[] | Extracted from document |
| parsed_dates | TEXT[] | |
| matched_flight_id | INTEGER → flight_registrations | AI-matched flight |
| match_confidence | TEXT | `high`, `low` |
| match_status | TEXT | `pending`, `matched`, `partial_match`, `no_match`, `unreadable`, `image_no_ocr` |
| uploaded_at | TIMESTAMPTZ | |

### flight_events
Append-only OAG event log. Processed by `delayProcessor.js`.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| subscription_id | INTEGER → flight_alert_subscriptions | |
| state | VARCHAR(50) | `OutGate`, `InAir`, `Landed`, `InGate`, `Canceled` |
| delay_minutes | INTEGER | |
| raw_payload | JSONB | Full OAG event body |
| processed_at | TIMESTAMPTZ | NULL = unprocessed |

### payments
One payout attempt per flight_registration. Retryable on failure.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| tenant_id | INTEGER → tenants | |
| registration_id | INTEGER → registrations | |
| flight_registration_id | INTEGER → flight_registrations | |
| flight_event_id | INTEGER → flight_events | |
| amount_pence | INTEGER | |
| status | VARCHAR(20) | `pending`, `processing`, `paid`, `failed` |
| modulr_payment_id | VARCHAR(100) | |
| modulr_reference | VARCHAR(50) | |
| failure_reason | TEXT | |

### notifications
Customer email delivery log.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| tenant_id, registration_id, flight_registration_id, flight_event_id, payment_id | FKs | |
| channel | VARCHAR(20) | `email` |
| recipient | VARCHAR(255) | |
| subject | TEXT | |
| status | VARCHAR(20) | `pending`, `sent`, `failed` |
| sent_at | TIMESTAMPTZ | |

### shared_api_keys
Superadmin-managed vault. Holds the OAG key and the PolicyHub key.

| Column | Type | Notes |
|---|---|---|
| id | SERIAL PK | |
| service_name | VARCHAR(100) | e.g. `oag`, `policyhub` |
| display_name | VARCHAR(100) | |
| key_enc | TEXT | AES-256-GCM encrypted |
| endpoint_url | VARCHAR(500) | |
| is_active | BOOLEAN | |
| notes | TEXT | |

### ref_airports / ref_carriers
Reference data loaded from Snowflake CSV exports via `npm run seed:ref-data`.

**ref_airports:** `iata_code` (PK), `icao_code`, `airport_name`, `city`, `country_code`, `country_name`, `latitude`, `longitude`, `timezone`, `location_type`, `synced_at`

**ref_carriers:** `iata_code` (PK), `icao_code`, `oag_code`, `carrier_name`, `iata_name`, `alliance`, `domicile_country`, `region`, `synced_at`

Full-text search index on `ref_airports` over `iata_code + airport_name + city`.

### audit_log
Admin action trail. `tenant_id = NULL` = superadmin action.

### request_log
Every `/api/*` call with `tenant_id`, `method`, `path`, `status`, `duration_ms`.

---

## Policy Validation (Ergo Connect / PolicyHub)

**Endpoint:** `POST https://<base_url>/api/policies/search?id={policyNumber}&coverHolderKey={coverHolderKey}`

The `coverHolderKey` is stored per-tenant in `policy_api_coverholder_key`. The API key itself is stored in `shared_api_keys` (superadmin-managed) and referenced by `tenant.policy_api_key_id`.

**Live mode checks:**
1. `data[0].status === 'Active'`
2. `data[0].policyHolderEmailAddress` matches submitted email (case-insensitive)
3. Finds `cover[]` entry where `name === tenant.cover_benefit_name`
4. `payout_pence = Math.round(cover.limit * 100)`

**Stub mode:** Returns mock data for any well-formed input. Used by the demo tenant and in development.

---

## Key Design Decisions

| Decision | Detail |
|---|---|
| Monetary values | Integer pence always. Never floats. |
| Bank details | AES-256-GCM encrypted before insert. Only decrypted in delayProcessor for live payout. Never returned in API responses. |
| Tenant scoping | `adminTenantScope(req)` returns `null` for superadmin (no filter) and `tenant_id` for tenant admins. All scoped routes use this. |
| JWT payload | `{ sub, username, role, tenant_id }`. `tenant_id = null` for superadmin. |
| Pre-validation tokens | URL token is the 64-char hex `token` column, not the row `id`. Consumed in `validateToken.js`, marked `used_at` during registration. |
| OAG subscriptions | Shared globally — if two tenants register the same flight, one subscription row exists and both `flight_registrations` link to it. |
| Stub mode | Both `policyValidator.js` and `modulr.js` have full stub implementations. |
| Event ingestion | `eventSource.js` 30s DB poller in dev; Azure Event Hub consumer in production (`oagEventConsumer.js`). |
| Tenant cache | `resolveTenant.js` exposes `invalidateTenantCache(slug)` — called by `tenants.js` on update/delete. |

---

## Environments

| Environment | Branch | Infrastructure | Domain |
|---|---|---|---|
| Production | `main` | fdv2-prod-rg (Azure, UK South) | `*.delayedpaid.co.uk` |
| UAT | `develop` | fdv2-uat-rg (Azure, UK South) | `*.uat.delayedpaid.co.uk` |
| Local | feature/* | Docker Compose | localhost:3000 |

CI/CD via GitHub Actions + Azure Container Apps. OIDC federated credentials (no stored secrets).

---

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | 64+ random chars |
| `ENCRYPTION_KEY` | Exactly 64 hex chars (32 bytes) for AES-256-GCM |
| `PORT` | HTTP port (default 3000) |
| `NODE_ENV` | `development`, `uat`, or `production` |
| `BASE_DOMAIN` | e.g. `delayedpaid.co.uk` |
| `DEV_TENANT_SLUG` | Fallback tenant slug in dev |
| `ADMIN_CORS_ORIGIN` | Allowed origin for `/api/admin` requests |
| `ADMIN_SEED_PASSWORD` | Password for seeded superadmin |
| `SMTP_HOST/PORT/USER/PASS` | SMTP credentials for customer emails |
| `AZURE_EVENT_HUB_*` | Event Hub connection for production OAG ingestion |

---

## Key External Integrations

| Service | Purpose | Status |
|---|---|---|
| OAG Flight Info Alerts API | Flight status monitoring | Live |
| Modulr | Instant bank transfers (Faster Payments) | Live (stub available) |
| Ergo Connect / PolicyHub | Policy validation | Live (stub available) |
| Azure Event Hub | OAG event ingestion in production | Live |
| Nodemailer / SMTP | Customer notification emails | Live |
| Snowflake | Source of ref_airports / ref_carriers CSV data | Manual sync |
