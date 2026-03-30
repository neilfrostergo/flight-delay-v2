'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Verify JWT and attach decoded payload to req.admin.
 * JWT payload: { sub, username, role, tenant_id }
 * tenant_id is null for superadmins.
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorised — no token provided' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.admin = decoded;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Unauthorised — token expired' });
    }
    return res.status(401).json({ error: 'Unauthorised — invalid token' });
  }
}

/**
 * Require superadmin role (tenant_id = null in JWT).
 */
function requireSuperAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (req.admin.role !== 'superadmin') {
      return res.status(403).json({ error: 'Forbidden — superadmin role required' });
    }
    next();
  });
}

/**
 * Require admin scoped to the resolved tenant.
 * Superadmin passes unconditionally.
 * Tenant admin passes only if their tenant_id matches req.tenant.id.
 */
function requireTenantAdmin(req, res, next) {
  requireAdmin(req, res, () => {
    if (req.admin.role === 'superadmin') return next();
    if (!req.tenant) {
      return res.status(400).json({ error: 'Tenant could not be resolved for this request' });
    }
    if (req.admin.tenant_id !== req.tenant.id) {
      return res.status(403).json({ error: 'Forbidden — not authorised for this tenant' });
    }
    next();
  });
}

/**
 * Utility: given req.admin, return the tenant_id scope for DB queries.
 * Superadmin with no tenant → null (no filter applied).
 * Tenant admin → their tenant_id.
 */
function adminTenantScope(req) {
  if (req.admin.role === 'superadmin') return null; // no restriction
  return req.admin.tenant_id;
}

module.exports = { requireAdmin, requireSuperAdmin, requireTenantAdmin, adminTenantScope };
