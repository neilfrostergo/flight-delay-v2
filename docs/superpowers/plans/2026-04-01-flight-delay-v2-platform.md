# Flight Delay v2 Platform — Retrospective Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-tenant flight delay insurance SaaS platform that automates policy validation, flight registration, delay detection, and Faster Payments payouts for multiple insurance brands from a single codebase.

**Architecture:** A single Express 5 / Node.js 20 server resolves tenants from subdomains and serves white-labelled customer and admin SPAs. Flight events are consumed from OAG (via Azure Event Hub in production, DB poller in dev) and trigger automated payouts via Modulr. All sensitive data (bank details, API keys) is AES-256-GCM encrypted at rest.

**Tech Stack:** Node.js 20, Express 5, PostgreSQL 16, JWT (jsonwebtoken), bcrypt, Joi, Nodemailer, Docker Compose, vanilla JS SPAs

---

## File Map

| File | Responsibility |
|------|---------------|
| `server/src/index.js` | Express app assembly — middleware, route mounts, static serving, graceful shutdown |
| `server/src/config.js` | Env var validation; exports typed config object |
| `server/src/db/connection.js` | pg Pool, `query()`, `withTransaction()` helpers |
| `server/src/db/migrate.js` | Idempotent SQL migration runner |
| `server/src/db/seedAdmin.js` | Seed superadmin user |
| `server/src/db/seedDemo.js` | Seed demo tenant data |
| `server/src/db/migrations/001_schema.sql` | All core tables |
| `server/src/db/migrations/002_seed_data.sql` | Demo tenant + placeholder OAG key |
| `server/src/db/migrations/003_documents.sql` | Document storage table |
| `server/src/db/migrations/004_document_matching.sql` | Flight matching columns on documents |
| `server/src/db/migrations/005_ref_data.sql` | airports / carriers reference tables |
| `server/src/db/migrations/006_tenant_links.sql` | claim_url, my_account_url on tenants |
| `server/src/db/migrations/007_policy_api_secret.sql` | policy_api_secret_enc column |
| `server/src/db/migrations/008_max_days_before_dep.sql` | max_days_before_dep column |
| `server/src/db/migrations/009_portal_label.sql` | portal_label column |
| `server/src/middleware/resolveTenant.js` | Host → slug → tenant lookup with 30s cache |
| `server/src/middleware/requireAdmin.js` | JWT verify; requireAdmin / requireSuperAdmin / requireTenantAdmin |
| `server/src/middleware/requireCustomer.js` | JWT verify for customer portal sessions |
| `server/src/middleware/rateLimiter.js` | Per-route express-rate-limit instances |
| `server/src/middleware/requestLogger.js` | Writes all /api/* calls to request_log |
| `server/src/routes/tenantConfig.js` | GET /api/tenant-config — public branding |
| `server/src/routes/validatePolicy.js` | POST /api/validate-policy |
| `server/src/routes/validateToken.js` | POST /api/validate-token |
| `server/src/routes/flightLookup.js` | GET /api/flight-lookup (OAG) |
| `server/src/routes/airports.js` | GET /api/airports — typeahead |
| `server/src/routes/carriers.js` | GET /api/carriers — reference data |
| `server/src/routes/register.js` | POST /api/registrations + confirmation |
| `server/src/routes/customerPortal.js` | Customer portal sessions + registration view |
| `server/src/routes/scanDocument.js` | POST /api/scan-document (boarding pass / itinerary OCR) |
| `server/src/routes/documents.js` | Document CRUD |
| `server/src/routes/admin/auth.js` | Login, /me, change-password |
| `server/src/routes/admin/tenants.js` | Superadmin tenant CRUD + stats |
| `server/src/routes/admin/tenantSettings.js` | Tenant-scoped settings (tenant admins) |
| `server/src/routes/admin/adminUsers.js` | Admin user management |
| `server/src/routes/admin/registrations.js` | Scoped list / detail / patch / CSV export |
| `server/src/routes/admin/flights.js` | Scoped flight_registrations list |
| `server/src/routes/admin/payments.js` | Scoped payments + retry |
| `server/src/routes/admin/tokens.js` | Pre-validation token lifecycle |
| `server/src/routes/admin/apikeys.js` | shared_api_keys vault (superadmin) |
| `server/src/routes/admin/simulate.js` | Inject test flight events |
| `server/src/routes/admin/requestLog.js` | request_log viewer (superadmin) |
| `server/src/services/encryption.js` | AES-256-GCM encrypt / decrypt / isEncrypted |
| `server/src/services/policyValidator.js` | Stub + live Ergo Connect client |
| `server/src/services/modulr.js` | Modulr Faster Payments stub / live |
| `server/src/services/delayProcessor.js` | Core payout flow: flight event → payment |
| `server/src/services/notificationService.js` | Tenant-branded email notifications |
| `server/src/services/oagAlerts.js` | OAG flight alert subscription management |
| `server/src/services/eventSource.js` | 30s DB poller (dev) / Azure Event Hub swap point |
| `server/src/services/eventHubConsumer.js` | Azure Event Hub consumer (production) |
| `server/src/services/documentParser.js` | OCR / AI document parsing for boarding passes |
| `server/src/scripts/syncReferenceData.js` | Sync airports + carriers from CSV |
| `customer/index.html` | 6-step white-labelled customer SPA (vanilla JS) |
| `admin/index.html` | Multi-tenant admin SPA (vanilla JS) |

---

## Task 1: Project Scaffold & Database Foundation

**Files:**
- Create: `server/package.json`
- Create: `server/src/config.js`
- Create: `server/src/db/connection.js`
- Create: `server/src/db/migrate.js`
- Create: `server/src/db/migrations/001_schema.sql`
- Create: `docker-compose.yml`
- Create: `Dockerfile`

- [x] **Step 1: Initialise Node project**

```bash
cd server && npm init -y
npm install express helmet cors compression express-rate-limit pg bcrypt jsonwebtoken joi nodemailer dotenv
npm install --save-dev nodemon
```

- [x] **Step 2: Write config.js — validate env vars at startup**

```js
'use strict';
const Joi = require('joi');
const schema = Joi.object({
  DATABASE_URL:        Joi.string().required(),
  JWT_SECRET:          Joi.string().min(32).required(),
  ENCRYPTION_KEY:      Joi.string().hex().length(64).required(),
  PORT:                Joi.number().default(3000),
  NODE_ENV:            Joi.string().valid('development','production').default('development'),
  BASE_DOMAIN:         Joi.string().default('localhost'),
  DEV_TENANT_SLUG:     Joi.string().optional(),
  ADMIN_CORS_ORIGIN:   Joi.string().default('*'),
  ADMIN_SEED_PASSWORD: Joi.string().optional(),
  SMTP_HOST:           Joi.string().optional(),
  SMTP_PORT:           Joi.number().default(587),
  SMTP_USER:           Joi.string().optional(),
  SMTP_PASS:           Joi.string().optional(),
  DEV_EMAIL_OVERRIDE:  Joi.string().email().optional(),
}).unknown(true);
const { error, value } = schema.validate(process.env);
if (error) throw new Error(`Config error: ${error.message}`);
module.exports = {
  db:              { url: value.DATABASE_URL },
  jwt:             { secret: value.JWT_SECRET },
  encryptionKey:   value.ENCRYPTION_KEY,
  port:            value.PORT,
  nodeEnv:         value.NODE_ENV,
  isProduction:    value.NODE_ENV === 'production',
  baseDomain:      value.BASE_DOMAIN,
  devTenantSlug:   value.DEV_TENANT_SLUG,
  cors:            { adminOrigin: value.ADMIN_CORS_ORIGIN },
  smtp:            { host: value.SMTP_HOST, port: value.SMTP_PORT, user: value.SMTP_USER, pass: value.SMTP_PASS },
  devEmailOverride: value.DEV_EMAIL_OVERRIDE,
  adminSeedPassword: value.ADMIN_SEED_PASSWORD,
};
```

- [x] **Step 3: Write 001_schema.sql** — all tables: tenants, admin_users, pre_validation_tokens, registrations, flight_alert_subscriptions, flight_registrations, flight_events, payments, notifications, shared_api_keys, audit_log, request_log. All monetary values integer pence. All FK constraints. All indexes.

- [x] **Step 4: Write db/connection.js — pg Pool with query() helper**

```js
'use strict';
const { Pool } = require('pg');
const config = require('../config');
const pool = new Pool({ connectionString: config.db.url });
async function query(text, params) { return pool.query(text, params); }
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally { client.release(); }
}
module.exports = { query, withTransaction, pool };
```

- [x] **Step 5: Write db/migrate.js — read migrations/ dir, run each SQL file in order, idempotent**

- [x] **Step 6: Write docker-compose.yml** — services: db (postgres:16-alpine), app (node:20-alpine). Volumes for pg data. Environment vars from .env.

- [x] **Step 7: Commit**

```bash
git add server/ docker-compose.yml Dockerfile
git commit -m "feat: project scaffold, DB schema, migrations runner"
```

---

## Task 2: Core Middleware

**Files:**
- Create: `server/src/middleware/resolveTenant.js`
- Create: `server/src/middleware/requireAdmin.js`
- Create: `server/src/middleware/requireCustomer.js`
- Create: `server/src/middleware/rateLimiter.js`
- Create: `server/src/middleware/requestLogger.js`

- [x] **Step 1: Write resolveTenant.js — extract subdomain from Host, cache tenant row for 30s**

```js
'use strict';
const { query } = require('../db/connection');
const config = require('../config');
const cache = new Map(); // slug → { tenant, expiresAt }

function invalidateTenantCache(slug) { cache.delete(slug); }

module.exports = async function resolveTenant(req, res, next) {
  try {
    let slug = null;
    if (!config.isProduction && req.headers['x-tenant-slug']) {
      slug = req.headers['x-tenant-slug'];
    } else if (!config.isProduction && config.devTenantSlug) {
      slug = config.devTenantSlug;
    } else {
      const host = (req.headers.host || '').split(':')[0];
      const parts = host.split('.');
      if (parts.length > 2) slug = parts[0];
    }
    if (!slug) { req.tenant = null; return next(); }
    const cached = cache.get(slug);
    if (cached && cached.expiresAt > Date.now()) { req.tenant = cached.tenant; return next(); }
    const result = await query('SELECT * FROM tenants WHERE slug=$1 AND is_active=TRUE', [slug]);
    const tenant = result.rows[0] || null;
    cache.set(slug, { tenant, expiresAt: Date.now() + 30_000 });
    req.tenant = tenant;
    next();
  } catch (err) { next(err); }
};

module.exports.invalidateTenantCache = invalidateTenantCache;
```

- [x] **Step 2: Write requireAdmin.js — verify JWT, attach req.admin; provide requireAdmin, requireSuperAdmin, requireTenantAdmin**

- [x] **Step 3: Write requireCustomer.js — verify customer JWT, attach req.customer; handle policy-only tokens (sub: null)**

- [x] **Step 4: Write rateLimiter.js — registrationLimiter (10/15m), validateLimiter (20/15m), loginLimiter (5/15m)**

- [x] **Step 5: Write requestLogger.js — log method, path, status, duration_ms, ip, user_agent, tenant_id to request_log**

- [x] **Step 6: Commit**

```bash
git add server/src/middleware/
git commit -m "feat: add middleware — tenant resolution, auth, rate limiting, request logging"
```

---

## Task 3: Encryption Service

**Files:**
- Create: `server/src/services/encryption.js`

- [x] **Step 1: Write encryption.js — AES-256-GCM encrypt/decrypt, format: base64iv:base64tag:base64cipher**

```js
'use strict';
const crypto = require('crypto');
const config = require('../config');
const KEY = Buffer.from(config.encryptionKey, 'hex');
const ALGO = 'aes-256-gcm';

function encrypt(plaintext) {
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), encrypted.toString('base64')].join(':');
}

function decrypt(ciphertext) {
  const [ivB64, tagB64, dataB64] = ciphertext.split(':');
  const decipher = crypto.createDecipheriv(ALGO, KEY, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function isEncrypted(value) { return typeof value === 'string' && value.split(':').length === 3; }

module.exports = { encrypt, decrypt, isEncrypted };
```

- [x] **Step 2: Commit**

```bash
git add server/src/services/encryption.js
git commit -m "feat: AES-256-GCM encryption service"
```

---

## Task 4: Policy Validator Service

**Files:**
- Create: `server/src/services/policyValidator.js`

- [x] **Step 1: Write stub mode** — returns valid mock response for any well-formed policy number. Includes demo policies for ergo and staysure tenants. Returns `{ valid, firstName, lastName, payoutPence, coverStartDate, coverEndDate }`.

- [x] **Step 2: Write live mode** — calls `POST {tenant.policy_api_url}/api/PolicySearch/getpolicy` with decrypted bearer token. Validates: status === 'Active', email matches (case-insensitive), finds cover by `tenant.cover_benefit_name`. Returns same shape as stub.

- [x] **Step 3: Export `validatePolicy(tenant, policyNumber, email)` — dispatches to stub or live based on `tenant.policy_api_mode`**

- [x] **Step 4: Commit**

```bash
git add server/src/services/policyValidator.js
git commit -m "feat: policy validator service (stub + live Ergo Connect)"
```

---

## Task 5: Public API Routes

**Files:**
- Create: `server/src/routes/tenantConfig.js`
- Create: `server/src/routes/validatePolicy.js`
- Create: `server/src/routes/validateToken.js`
- Create: `server/src/routes/flightLookup.js`
- Create: `server/src/routes/airports.js`
- Create: `server/src/routes/carriers.js`

- [x] **Step 1: Write tenantConfig.js — GET /api/tenant-config** — returns branding fields from req.tenant; 404 if no tenant. Cache-Control: public, max-age=300. Includes `portalLabel`, `minHoursBeforeDep`, `maxDaysBeforeDep`.

- [x] **Step 2: Write validatePolicy.js — POST /api/validate-policy** — validates body with Joi, calls policyValidator, returns policy fields (never bank details).

- [x] **Step 3: Write validateToken.js — POST /api/validate-token** — looks up token, checks not used/expired/wrong tenant, returns policy fields without consuming.

- [x] **Step 4: Write flightLookup.js — GET /api/flight-lookup** — calls OAG Flight Info API with decrypted shared API key. Returns normalised flight array. Handles both flight-number and route modes.

- [x] **Step 5: Write airports.js — GET /api/airports?q=** — typeahead search against airports reference table.

- [x] **Step 6: Write carriers.js — GET /api/carriers** — returns all active carriers.

- [x] **Step 7: Commit**

```bash
git add server/src/routes/tenantConfig.js server/src/routes/validatePolicy.js \
        server/src/routes/validateToken.js server/src/routes/flightLookup.js \
        server/src/routes/airports.js server/src/routes/carriers.js
git commit -m "feat: public API routes — tenant config, policy validation, flight lookup, reference data"
```

---

## Task 6: Registration Route

**Files:**
- Create: `server/src/routes/register.js`

- [x] **Step 1: Write POST /api/registrations** — Joi validation, check for duplicate flights (409 if any already registered for this policy), encrypt bank details, upsert registration, create flight_registrations, subscribe OAG alerts, send confirmation email.

- [x] **Step 2: Write GET /api/registrations/:id/confirmation** — returns registration summary by UUID-style lookup (no bank details ever returned).

- [x] **Step 3: Duplicate flight guard** — before insert, query existing flight_registrations for this tenant+policy combination. Throw 409 with descriptive message listing the duplicate flights.

```js
const duplicates = value.flights.filter(f => registered.has(`${f.flight_number}|${f.dep_date}`));
if (duplicates.length > 0) {
  const names = duplicates.map(f => `${f.flight_number} on ${f.dep_date}`).join(', ');
  throw Object.assign(new Error(`Flight already registered: ${names}`), { statusCode: 409 });
}
```

- [x] **Step 4: Commit**

```bash
git add server/src/routes/register.js
git commit -m "feat: registration route with duplicate flight guard and OAG subscription"
```

---

## Task 7: Payout Pipeline

**Files:**
- Create: `server/src/services/modulr.js`
- Create: `server/src/services/delayProcessor.js`
- Create: `server/src/services/oagAlerts.js`
- Create: `server/src/services/eventSource.js`
- Create: `server/src/services/eventHubConsumer.js`

- [x] **Step 1: Write modulr.js** — stub mode returns `{ paymentId: 'STUB-...', reference: 'STUB' }`; live mode calls Modulr Faster Payments API with decrypted key. Both modes accept `{ tenant, registrationId, amountPence, sortCode, accountNumber }`.

- [x] **Step 2: Write delayProcessor.js — processEvent(event)**:
  1. Load all active flight_registrations for the subscription
  2. For each, check delay_minutes >= tenant.delay_threshold_minutes
  3. Skip if payment already exists for this flight_registration
  4. Decrypt bank details
  5. Call modulr.pay()
  6. Insert payment row
  7. Send payment notification email

- [x] **Step 3: Write oagAlerts.js — subscribe(flightNumber, depDate)** — calls OAG Alerts API in live mode; in stub mode writes to flight_alert_subscriptions with null oag_alert_id.

- [x] **Step 4: Write eventSource.js** — polls flight_events WHERE processed_at IS NULL every 30s, calls delayProcessor.processEvent(), marks processed. Exposes start() and stop(). Comment marks Azure Event Hub swap point.

- [x] **Step 5: Write eventHubConsumer.js** — Azure Event Hub consumer for production; same interface as eventSource.js.

- [x] **Step 6: Commit**

```bash
git add server/src/services/
git commit -m "feat: payout pipeline — delay processor, Modulr integration, OAG alerts, event source"
```

---

## Task 8: Notification Service

**Files:**
- Create: `server/src/services/notificationService.js`

- [x] **Step 1: Write buildEmailHtml(tenant, content)** — tenant-branded HTML email wrapper: primary colour header with logo (or text fallback), white body, footer with terms/support links.

- [x] **Step 2: Write sendRegistrationConfirmation(tenant, registration, flights)** — lists registered flights, payout amount, policy holder name.

- [x] **Step 3: Write sendPaymentNotification(tenant, registration, flight, payment)** — confirms payout sent with amount and flight details.

- [x] **Step 4: Route all outgoing email through `_send()` which applies DEV_EMAIL_OVERRIDE** — all non-production emails go to `config.devEmailOverride` if set.

```js
async function _send(ctx, subject, html, text) {
  const to = config.devEmailOverride || ctx.email;
  await transport.sendMail({ from: FROM_ADDRESS, to, subject, html, text });
}
```

- [x] **Step 5: Commit**

```bash
git add server/src/services/notificationService.js
git commit -m "feat: tenant-branded email notifications with logo and dev override"
```

---

## Task 9: Customer Portal

**Files:**
- Create: `server/src/routes/customerPortal.js`
- Modify: `server/src/middleware/requireCustomer.js`

- [x] **Step 1: Write POST /api/customer/sessions** — accepts policy_number + email. Looks up registration; if found, issues customer JWT with sub=registration.id. If not found, calls policy API and issues policy-only JWT with sub=null embedding all policy fields in token payload.

- [x] **Step 2: Write GET /api/customer/registration** — if sub is null, returns policy info from JWT payload with `status: 'not_registered'` and empty flights array. If sub is set, queries DB and returns full registration with flights.

- [x] **Step 3: Write POST /api/customer/flights** — adds a flight to an existing registration (requires sub not null).

- [x] **Step 4: Commit**

```bash
git add server/src/routes/customerPortal.js server/src/middleware/requireCustomer.js
git commit -m "feat: customer portal — sessions, registration view, policy-only access"
```

---

## Task 10: Admin Routes

**Files:**
- Create: `server/src/routes/admin/auth.js`
- Create: `server/src/routes/admin/tenants.js`
- Create: `server/src/routes/admin/tenantSettings.js`
- Create: `server/src/routes/admin/adminUsers.js`
- Create: `server/src/routes/admin/registrations.js`
- Create: `server/src/routes/admin/flights.js`
- Create: `server/src/routes/admin/payments.js`
- Create: `server/src/routes/admin/tokens.js`
- Create: `server/src/routes/admin/apikeys.js`
- Create: `server/src/routes/admin/simulate.js`
- Create: `server/src/routes/admin/requestLog.js`

- [x] **Step 1: Write auth.js** — POST /login (bcrypt compare, issue JWT `{ sub, username, role, tenant_id }`), GET /me, POST /change-password.

- [x] **Step 2: Write tenants.js (superadmin only)** — CRUD for tenants. POST/PUT encrypt policy_api_key, policy_api_secret, modulr_api_key before insert. PUT preserves existing encrypted keys if new plaintext not supplied. DELETE is soft (is_active = FALSE). Calls invalidateTenantCache on update/delete.

- [x] **Step 3: Write registrations.js** — list (with filters: status, search, date range, pagination), detail, PATCH status, CSV export. All queries scoped by `adminTenantScope(req)` — null for superadmin (no WHERE), tenant_id for tenant admins.

- [x] **Step 4: Write flights.js, payments.js** — scoped lists. payments.js includes retry endpoint that re-attempts failed Modulr payments.

- [x] **Step 5: Write tokens.js** — CRUD for pre_validation_tokens. POST generates 64-char hex token. GET lists with used/expired status. Tokens are consumed (used_at set) during registration.

- [x] **Step 6: Write apikeys.js (superadmin only)** — CRUD for shared_api_keys. GET /reveal/:id decrypts and returns key (writes to audit_log).

- [x] **Step 7: Write simulate.js** — POST injects a flight_event row for a given flight_registration, triggering the delay processor. Writes to audit_log.

- [x] **Step 8: Write requestLog.js (superadmin only)** — paginated view of request_log with tenant filter.

- [x] **Step 9: Write adminUsers.js** — list/create/update/delete admin users. Superadmin can manage users across all tenants; tenant admins can only manage users for their own tenant.

- [x] **Step 10: Write tenantSettings.js** — tenant admins can update their own tenant's branding and operational settings (but not API keys or mode switches — superadmin only).

- [x] **Step 11: Commit**

```bash
git add server/src/routes/admin/
git commit -m "feat: admin routes — auth, tenant CRUD, registrations, payments, tokens, simulator"
```

---

## Task 11: Express App Assembly

**Files:**
- Create: `server/src/index.js`

- [x] **Step 1: Assemble app** — Helmet (CSP), CORS (open for customer routes, restricted for admin), compression, JSON body parser, resolveTenant on all routes, requestLogger on /api/*, rate limiters on appropriate routes.

- [x] **Step 2: Mount all routes** — public routes, admin routes (behind requireAdmin), static file serving for customer SPA, admin SPA, landing page.

- [x] **Step 3: SPA fallbacks** — tenant requests → customer/index.html; base-domain requests → landing/index.html; /admin/* → admin/index.html.

- [x] **Step 4: Global error handler** — returns err.statusCode or 500; hides message in production.

- [x] **Step 5: Graceful shutdown on SIGTERM** — close HTTP server, stop eventSource (commits Azure Event Hub checkpoints).

- [x] **Step 6: Commit**

```bash
git add server/src/index.js
git commit -m "feat: Express app assembly with security middleware and graceful shutdown"
```

---

## Task 12: Document Scanning

**Files:**
- Create: `server/src/services/documentParser.js`
- Create: `server/src/routes/scanDocument.js`
- Create: `server/src/routes/documents.js`
- Create: `server/src/db/migrations/003_documents.sql`
- Create: `server/src/db/migrations/004_document_matching.sql`

- [x] **Step 1: Write 003_documents.sql** — documents table: id, tenant_id, registration_id, file_type, raw_text, parsed_flights (JSONB), created_at.

- [x] **Step 2: Write 004_document_matching.sql** — add matched_flight_number, match_confidence columns to documents.

- [x] **Step 3: Write documentParser.js** — accepts PDF/image buffer, extracts text (pdfjs / tesseract), parses flight number + departure date patterns from text. Returns `{ flightNumber, depDate, confidence }`.

- [x] **Step 4: Write scanDocument.js — POST /api/scan-document** — accepts multipart file upload, calls documentParser, returns parsed flight details.

- [x] **Step 5: Write documents.js** — CRUD for stored documents.

- [x] **Step 6: Commit**

```bash
git add server/src/services/documentParser.js server/src/routes/scanDocument.js \
        server/src/routes/documents.js server/src/db/migrations/003_documents.sql \
        server/src/db/migrations/004_document_matching.sql
git commit -m "feat: document scanning — boarding pass and itinerary OCR"
```

---

## Task 13: Reference Data

**Files:**
- Create: `server/src/db/migrations/005_ref_data.sql`
- Create: `server/src/scripts/syncReferenceData.js`

- [x] **Step 1: Write 005_ref_data.sql** — airports table (iata_code, name, city, country), carriers table (iata_code, name). Both with UNIQUE on iata_code.

- [x] **Step 2: Write syncReferenceData.js** — reads MASTER_LOCATION.csv and MASTER_CARRIER.csv, upserts into airports and carriers tables.

- [x] **Step 3: Run migration and sync**

```bash
cd server && npm run migrate
node src/scripts/syncReferenceData.js
```

- [x] **Step 4: Commit**

```bash
git add server/src/db/migrations/005_ref_data.sql server/src/scripts/
git commit -m "feat: airports and carriers reference data with CSV sync script"
```

---

## Task 14: Schema Migrations 006–009

**Files:**
- Create: `server/src/db/migrations/006_tenant_links.sql`
- Create: `server/src/db/migrations/007_policy_api_secret.sql`
- Create: `server/src/db/migrations/008_max_days_before_dep.sql`
- Create: `server/src/db/migrations/009_portal_label.sql`

- [x] **Step 1: 006 — add claim_url, my_account_url to tenants**

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS claim_url VARCHAR(500),
  ADD COLUMN IF NOT EXISTS my_account_url VARCHAR(500);
```

- [x] **Step 2: 007 — add policy_api_secret_enc**

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS policy_api_secret_enc TEXT;
```

- [x] **Step 3: 008 — add max_days_before_dep**

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS max_days_before_dep INTEGER DEFAULT 40;
```

- [x] **Step 4: 009 — add portal_label**

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS portal_label VARCHAR(100) DEFAULT 'My Account';
```

- [x] **Step 5: Run migrations**

```bash
cd server && npm run migrate
```

- [x] **Step 6: Commit**

```bash
git add server/src/db/migrations/006_tenant_links.sql server/src/db/migrations/007_policy_api_secret.sql \
        server/src/db/migrations/008_max_days_before_dep.sql server/src/db/migrations/009_portal_label.sql
git commit -m "feat: schema migrations 006-009 — tenant links, API secret, max days, portal label"
```

---

## Task 15: Customer SPA

**Files:**
- Modify: `customer/index.html`

The customer SPA is a single vanilla JS file with 6 steps: (1) Policy validation, (2) Flight search + basket, (3) Bank details, (4) Review + submit, (5) Confirmation, and a (6) Customer portal.

- [x] **Step 1: Tenant branding** — on load, fetch /api/tenant-config; apply primary colour as CSS variable, set logo, portal button label. Show 404 page if no tenant.

- [x] **Step 2: Step 1 — Policy validation** — submit policy number + email, call /api/validate-policy; on success store validated state, advance to step 2. Show demo accounts box per tenant.

- [x] **Step 3: Step 2 — Flight search** — flight number mode and route mode. OAG lookup. Add to basket. Document scan shortcut (boarding pass / itinerary upload). Enforce minHoursBeforeDep, maxDaysBeforeDep, cover date window.

- [x] **Step 4: Step 3 — Bank details** — sort code + account number inputs. Client-side format validation only.

- [x] **Step 5: Step 4 — Review and submit** — shows policy, flights, payment details. POST /api/registrations. On 409 duplicate, show specific error.

- [x] **Step 6: Step 5 — Confirmation** — success screen with registered flights.

- [x] **Step 7: Customer portal** — localStorage session persistence keyed by tenant slug. Login form calls POST /api/customer/sessions. Dashboard shows registration summary, registered flights, add-a-flight form. Logout calls resetApp() to wipe all personal state and return to step 1. portalState.loggedOut flag blocks auto-login after explicit logout.

- [x] **Step 8: Security — resetApp()** — wipe state.validated, state.basket, all form fields, return to step 1 on logout to prevent Back button leaking previous user data.

- [x] **Step 9: Commit**

```bash
git add customer/index.html
git commit -m "feat: customer SPA — 6-step registration flow and customer portal"
```

---

## Task 16: Admin SPA

**Files:**
- Modify: `admin/index.html`

- [x] **Step 1: Auth** — login form issues JWT stored in localStorage. All API calls send Authorization: Bearer token. Superadmin sees all tenants; tenant admins see only their own.

- [x] **Step 2: Registrations view** — filterable table with status, search, date range. Status patch (active/cancelled/paid). CSV export.

- [x] **Step 3: Flights and payments views** — scoped lists with status display.

- [x] **Step 4: Tenant management (superadmin)** — modal form for full tenant CRUD including API keys (write-only), colours, portal label, operational thresholds.

- [x] **Step 5: Admin user management** — create/edit/deactivate admin users. Superadmin sees all; tenant admins see only their tenant.

- [x] **Step 6: Pre-validation tokens** — list, create (copy-link), revoke.

- [x] **Step 7: Simulator** — select a registered flight, inject a flight event with configurable delay minutes. Triggers real payout pipeline.

- [x] **Step 8: API keys vault (superadmin)** — list shared keys, reveal (masked by default, click to decrypt).

- [x] **Step 9: Request log (superadmin)** — paginated HTTP audit trail with tenant filter.

- [x] **Step 10: Commit**

```bash
git add admin/index.html
git commit -m "feat: admin SPA — registrations, tenants, users, tokens, simulator, audit log"
```

---

## Task 17: Azure Event Hub Integration

**Files:**
- Modify: `server/src/services/eventSource.js`
- Modify: `server/src/services/eventHubConsumer.js`

- [x] **Step 1: eventSource.js** — in production when `EVENT_HUB_CONNECTION_STRING` is set, delegate to eventHubConsumer. Otherwise use DB poller. Document the swap point clearly.

- [x] **Step 2: eventHubConsumer.js** — Azure Event Hub consumer using `@azure/event-hubs`. On each event, parse OAG payload, insert into flight_events, call delayProcessor. Commit checkpoint after each processed batch.

- [x] **Step 3: Commit**

```bash
git add server/src/services/eventSource.js server/src/services/eventHubConsumer.js
git commit -m "feat: Azure Event Hub consumer for production OAG event ingestion"
```

---

## UX Fixes Applied (Reference)

These were iterative improvements made during development:

| Fix | Files Changed |
|-----|--------------|
| Duplicate flight 409 error surfaced to user | `register.js` |
| Tenant logo in email header | `notificationService.js` |
| Portal auto-login after logout blocked with `portalState.loggedOut` flag | `customer/index.html` |
| Back button after logout wipes state via `resetApp()` | `customer/index.html` |
| Portal shows policy info even with no registered flights (policy-only JWT) | `customerPortal.js`, `customer/index.html` |
| DEV_EMAIL_OVERRIDE applied globally in `_send()` | `notificationService.js` |
| Portal button label configurable per tenant (`portal_label`) | `tenants.js`, `tenantConfig.js`, `admin/index.html`, migration 009 |
| Demo accounts per tenant on step 1 and portal login | `customer/index.html`, `policyValidator.js` |
| Consistent heading + subtitle on step 1 and portal login | `customer/index.html` |
| Logout + Add a flight buttons on same row (space-between) | `customer/index.html` |
| Empty flights state shows Register/Log out row instead of centred CTA | `customer/index.html` |
