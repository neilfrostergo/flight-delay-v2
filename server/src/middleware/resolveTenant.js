'use strict';

const { query } = require('../db/connection');
const config = require('../config');

// In-memory cache: slug → { tenant, expiresAt }
const _cache = new Map();
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

async function getTenantBySlug(slug) {
  const now = Date.now();
  const cached = _cache.get(slug);
  if (cached && cached.expiresAt > now) {
    return cached.tenant;
  }

  const result = await query(
    'SELECT * FROM tenants WHERE slug = $1 AND is_active = TRUE LIMIT 1',
    [slug]
  );

  const tenant = result.rows[0] || null;
  _cache.set(slug, { tenant, expiresAt: now + CACHE_TTL_MS });
  return tenant;
}

/**
 * Resolves the current tenant from the Host header and attaches it to req.tenant.
 *
 * Production:  Host: ergo.platform.co.uk  →  slug = 'ergo'
 *              Requires BASE_DOMAIN=platform.co.uk
 *
 * Development: Accepts X-Tenant-Slug header as a fallback when the Host header
 *              doesn't match (never honoured in production).
 *
 * req.tenant is set to the full tenants row, or null if unresolvable.
 * Routes that need a tenant should check req.tenant themselves.
 */
async function resolveTenant(req, res, next) {
  try {
    const host = (req.headers.host || '').split(':')[0].toLowerCase(); // strip port
    let slug = null;

    // Try subdomain extraction: ergo.platform.co.uk → slug = ergo
    const baseDomain = config.baseDomain.toLowerCase();
    if (host.endsWith(`.${baseDomain}`)) {
      slug = host.slice(0, host.length - baseDomain.length - 1);
    } else if (host === baseDomain || host === 'localhost') {
      // Root domain / localhost — use dev fallback
      slug = null;
    }

    // Dev fallback: honour explicit X-Tenant-Slug header (never used in production).
    // DEV_TENANT_SLUG is intentionally NOT used as a blanket fallback so that
    // hitting the base domain / localhost returns no tenant (landing page).
    if (!slug && !config.isProduction && req.headers['x-tenant-slug']) {
      slug = req.headers['x-tenant-slug'];
    }

    req.tenant = slug ? await getTenantBySlug(slug) : null;
  } catch (err) {
    console.error('[resolveTenant] Error resolving tenant:', err.message);
    req.tenant = null;
  }

  next();
}

// Expose cache invalidation for admin tenant updates
function invalidateTenantCache(slug) {
  _cache.delete(slug);
}

module.exports = resolveTenant;
module.exports.invalidateTenantCache = invalidateTenantCache;
