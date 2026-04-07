'use strict';

const express = require('express');
const config = require('../config');
const router = express.Router();

// GET /api/tenant-config
// Returns white-label branding for the resolved tenant. Cached by the browser for 5 minutes.
// Returns 404 if no tenant is resolved (e.g. root domain with no X-Tenant-Slug header in dev).
router.get('/', (req, res) => {
  if (!req.tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  res.set('Cache-Control', 'public, max-age=300');
  return res.json({
    name:          req.tenant.name,
    slug:          req.tenant.slug,
    logoUrl:       req.tenant.logo_url,
    primaryColour: req.tenant.primary_colour,
    termsUrl:      req.tenant.terms_url,
    supportEmail:  req.tenant.support_email,
    portalLabel:   req.tenant.portal_label || 'My Account',
    claimsUrl:     req.tenant.register_claim_url || null,
    // Operational config the customer SPA needs
    minHoursBeforeDep: req.tenant.min_hours_before_dep,
    maxDaysBeforeDep:  req.tenant.max_days_before_dep || 40,
    env:           config.nodeEnv,
    appVersion:    process.env.APP_VERSION || null,
    deployTime:    process.env.DEPLOY_TIME || null,
  });
});

module.exports = router;
