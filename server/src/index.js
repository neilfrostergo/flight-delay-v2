'use strict';

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs   = require('fs');

const config = require('./config');
const resolveTenant = require('./middleware/resolveTenant');
const requestLogger = require('./middleware/requestLogger');
const { registrationLimiter, loginLimiter, validateLimiter } = require('./middleware/rateLimiter');
const requireAdmin = require('./middleware/requireAdmin');

// Routes — public
const tenantConfigRouter = require('./routes/tenantConfig');
const flightLookupRouter = require('./routes/flightLookup');
const airportsRouter     = require('./routes/airports');
const carriersRouter     = require('./routes/carriers');
const validatePolicyRouter = require('./routes/validatePolicy');
const validateTokenRouter = require('./routes/validateToken');
const registerRouter       = require('./routes/register');
const documentsRouter      = require('./routes/documents');
const customerPortalRouter = require('./routes/customerPortal');
const scanDocumentRouter   = require('./routes/scanDocument');

// Routes — admin
const adminAuthRouter = require('./routes/admin/auth');
const adminTenantsRouter = require('./routes/admin/tenants');
const adminRegistrationsRouter = require('./routes/admin/registrations');
const adminFlightsRouter = require('./routes/admin/flights');
const adminPaymentsRouter = require('./routes/admin/payments');
const adminTokensRouter = require('./routes/admin/tokens');
const adminApiKeysRouter = require('./routes/admin/apikeys');
const adminSimulateRouter = require('./routes/admin/simulate');
const adminRequestLogRouter = require('./routes/admin/requestLog');
const adminUsersRouter = require('./routes/admin/adminUsers');
const adminTenantSettingsRouter = require('./routes/admin/tenantSettings');
const adminCoverholdersRouter = require('./routes/admin/coverholders');
const adminDocumentsRouter    = require('./routes/admin/documents');

// Background services
const eventSource = require('./services/eventSource');

const app = express();

// Trust the first proxy hop (Azure Container Apps / Front Door)
app.set('trust proxy', 1);

// Health check — used by Front Door and Container Apps liveness probes
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet({
  hsts: config.isProduction ? undefined : false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'fonts.googleapis.com'],
      fontSrc: ["'self'", 'fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: config.isProduction ? [] : null,
    },
  },
}));

// ── CORS ─────────────────────────────────────────────────────────────────────
// Public customer API: open (any origin — tenant subdomain serves the SPA)
app.use('/api/tenant-config', cors());
app.use('/api/validate-policy', cors());
app.use('/api/validate-token', cors());
app.use('/api/flight-lookup', cors());
app.use('/api/registrations', cors());
app.use('/api/airports', cors());
app.use('/api/carriers', cors());
app.use('/api/documents', cors());
app.use('/api/customer', cors());

// Admin API: restricted to configured origin
app.use('/api/admin', cors({
  origin: config.cors.adminOrigin,
  credentials: true,
}));

// ── General middleware ───────────────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb' }));

// ── Tenant resolution (runs on all requests) ─────────────────────────────────
app.use(resolveTenant);

// ── Request logging (all /api/* calls) ───────────────────────────────────────
app.use('/api', requestLogger);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── Public routes ─────────────────────────────────────────────────────────────
app.use('/api/tenant-config', tenantConfigRouter);
app.use('/api/airports', airportsRouter);
app.use('/api/carriers', carriersRouter);
app.use('/api/flight-lookup', validateLimiter, flightLookupRouter);
app.use('/api/validate-policy', validateLimiter, validatePolicyRouter);
app.use('/api/validate-token', validateLimiter, validateTokenRouter);
app.use('/api/registrations', registrationLimiter, registerRouter);
app.use('/api/documents', documentsRouter);
app.use('/api/scan-document', cors(), scanDocumentRouter);
app.use('/api/customer', customerPortalRouter);

// ── Admin auth (no requireAdmin — handles its own auth) ───────────────────────
app.use('/api/admin/auth/login', loginLimiter);
app.use('/api/admin/auth', adminAuthRouter);

// ── Admin routes (all protected) ──────────────────────────────────────────────
app.use('/api/admin/tenants', requireAdmin.requireSuperAdmin, adminTenantsRouter);
app.use('/api/admin/registrations', requireAdmin.requireAdmin, adminRegistrationsRouter);
app.use('/api/admin/flights', requireAdmin.requireAdmin, adminFlightsRouter);
app.use('/api/admin/payments', requireAdmin.requireAdmin, adminPaymentsRouter);
app.use('/api/admin/tokens', requireAdmin.requireAdmin, adminTokensRouter);
app.use('/api/admin/apikeys', requireAdmin.requireSuperAdmin, adminApiKeysRouter);
app.use('/api/admin/users', requireAdmin.requireAdmin, adminUsersRouter);
app.use('/api/admin/tenant-settings', requireAdmin.requireAdmin, adminTenantSettingsRouter);
app.use('/api/admin/simulator', requireAdmin.requireAdmin, adminSimulateRouter);
app.use('/api/admin/request-log', requireAdmin.requireSuperAdmin, adminRequestLogRouter);
app.use('/api/admin/coverholders', requireAdmin.requireSuperAdmin, adminCoverholdersRouter);
app.use('/api/admin/documents',   requireAdmin.requireAdmin, adminDocumentsRouter);

// ── Static files ──────────────────────────────────────────────────────────────
const CUSTOMER_DIR = path.join(__dirname, '..', '..', 'customer');
const ADMIN_DIR    = path.join(__dirname, '..', '..', 'admin');
const LANDING_DIR  = path.join(__dirname, '..', '..', 'landing');

app.use('/admin', express.static(ADMIN_DIR));
// Serve static assets from both dirs but disable automatic index.html serving —
// the catch-all below handles HTML based on tenant presence.
app.use('/', express.static(CUSTOMER_DIR, { index: false }));
app.use('/', express.static(LANDING_DIR, { index: false }));

// SPA fallbacks
app.get('/admin', (_req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')));
app.get('/admin/*path', (_req, res) => res.sendFile(path.join(ADMIN_DIR, 'index.html')));
// Tenant requests → customer SPA; base-domain requests → generic landing page
const CUSTOMER_HTML = fs.readFileSync(path.join(CUSTOMER_DIR, 'index.html'), 'utf8');
const DEMO_ACCOUNTS_SCRIPT = `<script>
window.__DEMO_ACCOUNTS__ = {
  demo: [
    { policy: 'POL-001-ACTIVE', email: 'sarah.johnson@example.com',  desc: 'AMT · couple' },
    { policy: 'POL-002-ACTIVE', email: 'j.williams@example.com',     desc: 'Single trip' },
    { policy: 'POL-003-ACTIVE', email: 'emma.davies@example.com',    desc: 'AMT · family' },
    { policy: 'POL-004-ACTIVE', email: 'm.alhassan@example.com',     desc: 'AMT · couple' },
    { policy: 'POL-005-ACTIVE', email: 'charlotte.baker@example.com',desc: 'Return trip · couple' },
  ],
  ergo: [
    { policy: 'ERGO-AMT-2026-001', email: 'thomas.muller@ergo-demo.de',   desc: 'AMT · couple' },
    { policy: 'ERGO-RET-2026-042', email: 'sophie.klein@ergo-demo.de',    desc: 'Return trip' },
    { policy: 'ERGO-SGL-2026-117', email: 'lukas.becker@ergo-demo.de',    desc: 'Single trip · family' },
  ],
  staysure: [
    { policy: 'SS-AMT-2026-3301', email: 'patricia.hughes@staysure-demo.co.uk', desc: 'AMT · couple' },
    { policy: 'SS-RET-2026-8820', email: 'margaret.thornton@staysure-demo.co.uk', desc: 'Return trip · couple' },
    { policy: 'SS-SGL-2026-5504', email: 'dorothy.pearson@staysure-demo.co.uk',  desc: 'Single trip' },
  ],
};
</script>`;

app.get('*path', (req, res) => {
  if (req.tenant) {
    if (config.nodeEnv === 'development') {
      return res.send(CUSTOMER_HTML.replace('</head>', DEMO_ACCOUNTS_SCRIPT + '</head>'));
    }
    return res.sendFile(path.join(CUSTOMER_DIR, 'index.html'));
  } else {
    res.sendFile(path.join(LANDING_DIR, 'index.html'));
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[error]', err.message, err.stack);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: config.isProduction ? 'Internal server error' : err.message,
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(config.port, () => {
  console.log(`[server] flight-delay-v2 running on port ${config.port} (${config.nodeEnv})`);
  eventSource.start().catch(err => {
    console.error('[server] Failed to start event source:', err.message);
    process.exit(1);
  });
});

// Graceful shutdown — important for Event Hub to commit final checkpoints
process.on('SIGTERM', async () => {
  console.log('[server] SIGTERM received — shutting down gracefully');
  server.close(async () => {
    await eventSource.stop();
    process.exit(0);
  });
});

module.exports = app;
