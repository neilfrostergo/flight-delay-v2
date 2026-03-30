'use strict';

const express = require('express');
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
    // Operational config the customer SPA needs
    minHoursBeforeDep: req.tenant.min_hours_before_dep,
  });
});

module.exports = router;
