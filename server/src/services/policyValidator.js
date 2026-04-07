'use strict';

const { decrypt } = require('./encryption');
const { query } = require('../db/connection');

// ─────────────────────────────────────────────────────────────────────────────
// STUB MODE
// Returns a realistic mock response for any well-formed input.
// Used when tenant.policy_api_mode = 'stub' (the default for new tenants).
// ─────────────────────────────────────────────────────────────────────────────

// Known demo policies with realistic data
const DEMO_POLICIES = {
  // Annual multi-trip — covers all of 2026
  'POL-001-ACTIVE': {
    firstName: 'Sarah', lastName: 'Johnson',
    policyType: 'annual_multi_trip',
    travelers: [
      { firstName: 'Sarah', lastName: 'Johnson' },
      { firstName: 'Tom',   lastName: 'Johnson' },
    ],
    payoutPence: 25000,
    coverStartDate: '2026-01-01',
    coverEndDate:   '2026-12-31',
    geographicArea: 'Europe',
    policyIssueDate: '2025-12-15',
  },
  // Single trip — LHR → MAD, two weeks away (relative to 2026-03-31)
  'POL-002-ACTIVE': {
    firstName: 'James', lastName: 'Williams',
    policyType: 'single_trip',
    travelers: [{ firstName: 'James', lastName: 'Williams' }],
    payoutPence: 25000,
    coverStartDate: '2026-04-10',
    coverEndDate:   '2026-04-17',
    geographicArea: 'Europe',
    policyIssueDate: '2026-03-01',
  },
  // Annual multi-trip — family, covers 2026–2027
  'POL-003-ACTIVE': {
    firstName: 'Emma', lastName: 'Davies',
    policyType: 'annual_multi_trip',
    travelers: [
      { firstName: 'Emma',   lastName: 'Davies'  },
      { firstName: 'Oliver', lastName: 'Davies'  },
      { firstName: 'Lily',   lastName: 'Davies'  },
    ],
    payoutPence: 20000,
    coverStartDate: '2026-02-01',
    coverEndDate:   '2027-01-31',
    geographicArea: 'Worldwide',
    policyIssueDate: '2026-01-20',
  },
  // Annual multi-trip — couple, covers 2026–2027
  'POL-004-ACTIVE': {
    firstName: 'Mohammed', lastName: 'Al-Hassan',
    policyType: 'annual_multi_trip',
    travelers: [
      { firstName: 'Mohammed', lastName: 'Al-Hassan' },
      { firstName: 'Fatima',   lastName: 'Al-Hassan' },
    ],
    payoutPence: 30000,
    coverStartDate: '2026-01-15',
    coverEndDate:   '2027-01-14',
    geographicArea: 'Worldwide (exc. USA & Canada)',
    policyIssueDate: '2026-01-10',
  },
  // Single trip — return trip, flying next month
  'POL-005-ACTIVE': {
    firstName: 'Charlotte', lastName: 'Baker',
    policyType: 'return_trip',
    travelers: [
      { firstName: 'Charlotte', lastName: 'Baker' },
      { firstName: 'Daniel',    lastName: 'Baker' },
    ],
    payoutPence: 15000,
    coverStartDate: '2026-05-01',
    coverEndDate:   '2026-05-14',
    geographicArea: 'Europe',
    policyIssueDate: '2026-04-01',
  },

  // ── Ergo demo accounts ────────────────────────────────────────────────────
  'ERGO-AMT-2026-001': {
    firstName: 'Thomas', lastName: 'Müller',
    policyType: 'annual_multi_trip',
    travelers: [
      { firstName: 'Thomas', lastName: 'Müller' },
      { firstName: 'Anna',   lastName: 'Müller' },
    ],
    payoutPence: 30000,
    coverStartDate: '2026-01-01',
    coverEndDate:   '2026-12-31',
    geographicArea: 'Europe',
    policyIssueDate: '2025-12-20',
  },
  'ERGO-RET-2026-042': {
    firstName: 'Sophie', lastName: 'Klein',
    policyType: 'return_trip',
    travelers: [{ firstName: 'Sophie', lastName: 'Klein' }],
    payoutPence: 25000,
    coverStartDate: '2026-05-01',
    coverEndDate:   '2026-05-21',
    geographicArea: 'Europe',
    policyIssueDate: '2026-04-05',
  },
  'ERGO-SGL-2026-117': {
    firstName: 'Lukas', lastName: 'Becker',
    policyType: 'single_trip',
    travelers: [
      { firstName: 'Lukas',  lastName: 'Becker' },
      { firstName: 'Mia',    lastName: 'Becker' },
      { firstName: 'Noah',   lastName: 'Becker' },
    ],
    payoutPence: 20000,
    coverStartDate: '2026-04-14',
    coverEndDate:   '2026-04-28',
    geographicArea: 'Worldwide',
    policyIssueDate: '2026-03-10',
  },

  // ── Staysure demo accounts ────────────────────────────────────────────────
  'SS-AMT-2026-3301': {
    firstName: 'Patricia', lastName: 'Hughes',
    policyType: 'annual_multi_trip',
    travelers: [
      { firstName: 'Patricia', lastName: 'Hughes' },
      { firstName: 'Gerald',   lastName: 'Hughes' },
    ],
    payoutPence: 25000,
    coverStartDate: '2026-01-01',
    coverEndDate:   '2026-12-31',
    geographicArea: 'Europe',
    policyIssueDate: '2025-12-18',
  },
  'SS-RET-2026-8820': {
    firstName: 'Margaret', lastName: 'Thornton',
    policyType: 'return_trip',
    travelers: [
      { firstName: 'Margaret', lastName: 'Thornton' },
      { firstName: 'Ronald',   lastName: 'Thornton' },
    ],
    payoutPence: 30000,
    coverStartDate: '2026-06-01',
    coverEndDate:   '2026-06-15',
    geographicArea: 'Worldwide (exc. USA & Canada)',
    policyIssueDate: '2026-05-10',
  },
  'SS-SGL-2026-5504': {
    firstName: 'Dorothy', lastName: 'Pearson',
    policyType: 'single_trip',
    travelers: [{ firstName: 'Dorothy', lastName: 'Pearson' }],
    payoutPence: 20000,
    coverStartDate: '2026-04-20',
    coverEndDate:   '2026-04-27',
    geographicArea: 'Europe',
    policyIssueDate: '2026-04-01',
  },
};

function stubValidate(policyNumber, email) {
  if (!policyNumber || !email) {
    return { valid: false, errorMessage: 'Policy number and email are required' };
  }

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) {
    return { valid: false, errorMessage: 'Invalid email address' };
  }

  function buildCoverSummary(travelDelayLimit) {
    return [
      { name: 'Travel Delay',          limit: travelDelayLimit, excess: 0,   description: 'Payable after a qualifying 12-hour delay' },
      { name: 'Cancellation',          limit: 3000,             excess: 100, description: 'Trip cancellation for covered reasons' },
      { name: 'Emergency Medical',     limit: 10000000,         excess: 100, description: 'Medical and repatriation expenses abroad' },
      { name: 'Missed Departure',      limit: 1000,             excess: 0,   description: 'Additional travel costs due to missed departure' },
      { name: 'Personal Possessions',  limit: 1500,             excess: 50,  description: 'Loss, theft or damage to belongings' },
      { name: 'Personal Liability',    limit: 2000000,          excess: 0,   description: 'Legal liability to third parties' },
    ];
  }

  // Return rich data for known demo policies
  const demo = DEMO_POLICIES[policyNumber.toUpperCase()];
  if (demo) {
    const payoutGbp = Math.round(demo.payoutPence / 100);
    return { valid: true, rawResponse: { stub: true }, coverSummary: buildCoverSummary(payoutGbp), ...demo };
  }

  // For unknown policies derive deterministic values and default to annual multi-trip
  const seed = policyNumber.replace(/\D/g, '').slice(-3) || '250';
  const payoutGbp = [100, 150, 200, 250, 500][parseInt(seed, 10) % 5];

  return {
    valid: true,
    firstName: 'Demo',
    lastName: 'Customer',
    policyType: 'annual_multi_trip',
    travelers: [
      { firstName: 'Demo',      lastName: 'Customer' },
      { firstName: 'Traveling', lastName: 'Companion' },
    ],
    payoutPence: payoutGbp * 100,
    coverStartDate: new Date().toISOString().slice(0, 10),
    coverEndDate:   new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    coverSummary:   buildCoverSummary(payoutGbp),
    geographicArea: 'Europe',
    policyIssueDate: null,
    rawResponse: { stub: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE MODE — PolicyHub API
// GET {tenant.policy_api_url}/api/policies/search?id=<policyNumber>
// Auth: X-Api-Key header — key decrypted from tenant.policy_api_key_enc
//
// Response structure:
//   { success, hasData, data[0]: { clients[], scheme: { schemeCover[], policyType }, status, startDate, endDate } }
//
// status: 3 = Active
// Cover benefits: scheme.schemeCover[] — find entry where sectionName includes cover_benefit_name
// ─────────────────────────────────────────────────────────────────────────────

// Active status code in PolicyHub
const POLICYHUB_STATUS_ACTIVE = 3;

async function liveValidate(tenant, policyNumber, email, { skipEmailMatch = false } = {}) {
  if (!tenant.policy_api_key_id) {
    return { valid: false, errorMessage: 'No policy API configured for this tenant' };
  }

  let apiKey, baseUrl;
  try {
    const keyRow = await query(
      'SELECT key_enc, endpoint_url FROM shared_api_keys WHERE id = $1 AND is_active = true',
      [tenant.policy_api_key_id]
    );
    if (keyRow.rows.length === 0) {
      return { valid: false, errorMessage: 'Policy validation service unavailable' };
    }
    apiKey = decrypt(keyRow.rows[0].key_enc);
    baseUrl = keyRow.rows[0].endpoint_url.replace(/\/$/, '');
  } catch (err) {
    console.error('[policyValidator] Failed to load API key for tenant', tenant.slug, err.message);
    return { valid: false, errorMessage: 'Policy validation service unavailable' };
  }
  const coverHolderParam = tenant.policy_api_coverholder_key
    ? `&coverHolderKey=${encodeURIComponent(tenant.policy_api_coverholder_key)}`
    : '';
  const url = `${baseUrl}/api/policies/search?id=${encodeURIComponent(policyNumber)}${coverHolderParam}`;

  let body;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Api-Key': apiKey },
      signal: AbortSignal.timeout(30000),
    });

    if (res.status === 401) {
      return { valid: false, errorMessage: 'Policy validation service authentication failed' };
    }
    if (!res.ok) {
      throw new Error(`Policy API HTTP ${res.status}`);
    }

    body = await res.json();
    const p = body.data?.[0] || {};
    console.log('[policyValidator] POLICY TOP-LEVEL KEYS:', Object.keys(p));
    console.log('[policyValidator] POLICY DATES/AREA:', JSON.stringify({
      startDate: p.startDate, endDate: p.endDate,
      issueDate: p.issueDate, inceptionDate: p.inceptionDate,
      createdDate: p.createdDate, dateCreated: p.dateCreated,
      geographicArea: p.geographicArea, area: p.area, destination: p.destination,
      region: p.region, territory: p.territory,
    }));
    console.log('[policyValidator] SCHEME:', JSON.stringify(p.scheme, null, 2));
  } catch (err) {
    console.error('[policyValidator] Policy API request failed:', err.message);
    return { valid: false, errorMessage: 'Policy validation service unavailable' };
  }

  if (!body.success || !body.hasData || !body.data || body.data.length === 0) {
    return { valid: false, errorMessage: 'Policy not found' };
  }

  const policy = body.data[0];

  // Must be Active (status 3)
  if (policy.status !== POLICYHUB_STATUS_ACTIVE) {
    return { valid: false, errorMessage: 'Policy is not active' };
  }

  const leadClient = (policy.clients || []).find(c => c.relationshipId === 1) || policy.clients?.[0];

  // Email must match the lead client (case-insensitive) — skipped in token flow
  // where the token itself is the identity proof and the policy system may have placeholder emails.
  if (!skipEmailMatch) {
    if (!leadClient?.email || leadClient.email.toLowerCase() !== email.toLowerCase()) {
      return { valid: false, errorMessage: 'Email address does not match policy records' };
    }
  }

  // Find the flight delay cover benefit in scheme.schemeCover
  const benefitName = (tenant.cover_benefit_name || 'delay').toLowerCase();
  const schemeCover = policy.scheme?.schemeCover || [];

  const coverItem = schemeCover.find(
    (c) => c.sectionName && c.sectionName.toLowerCase().includes(benefitName)
  );

  if (!coverItem) {
    return {
      valid: false,
      errorMessage: `No "${tenant.cover_benefit_name || 'delay'}" benefit found on this policy`,
    };
  }

  const payoutPence = Math.round((coverItem.limit || 0) * 100);
  if (payoutPence <= 0) {
    return { valid: false, errorMessage: 'Benefit limit is zero — policy not eligible' };
  }

  // Derive policy type from scheme.policyType
  const schemeType = (policy.scheme?.policyType || '').toLowerCase();
  let policyType = 'single_trip';
  if (schemeType.includes('annual') || schemeType.includes('multi')) {
    policyType = 'annual_multi_trip';
  } else if (schemeType.includes('return')) {
    policyType = 'return_trip';
  }

  // Map all cover benefits for the cover summary
  const coverSummary = schemeCover.map(c => ({
    name:        c.sectionName  || '',
    limit:       c.limit        || 0,
    excess:      c.excess       || 0,
    description: c.description  || '',
  }));

  return {
    valid: true,
    firstName:      leadClient.firstName || '',
    lastName:       leadClient.lastName  || '',
    policyType,
    travelers:      (policy.clients || []).map(c => ({ firstName: c.firstName || '', lastName: c.lastName || '' })),
    payoutPence,
    coverStartDate: policy.startDate || null,
    coverEndDate:   policy.endDate   || null,
    coverSummary,
    geographicArea: policy.geographicArea || policy.geographic_area || policy.area || null,
    policyIssueDate: policy.issueDate || policy.inceptionDate || policy.issue_date || null,
    policyWordingUrl:  policy.policyWordingDocumentUrl || null,
    policyWordingName: 'Policy Wording',
    ipidUrl:           policy.ipidFileUrl || null,
    ipidName:          'IPID',
    keyFactsUrl:       (policy.keyFactsDocumentUrl && !policy.keyFactsDocumentUrl.endsWith('/') ? policy.keyFactsDocumentUrl : null),
    keyFactsName:      'Key Facts',
    rawResponse:    body,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a customer's travel insurance policy.
 *
 * @param {object} tenant  - The resolved tenant row from the DB
 * @param {string} policyNumber
 * @param {string} email
 * @returns {Promise<{
 *   valid: boolean,
 *   firstName?: string,
 *   lastName?: string,
 *   payoutPence?: number,
 *   coverStartDate?: string,
 *   coverEndDate?: string,
 *   rawResponse?: object,
 *   errorMessage?: string
 * }>}
 */
async function validatePolicy(tenant, policyNumber, email, options = {}) {
  if (tenant.policy_api_mode === 'live') {
    return liveValidate(tenant, policyNumber, email, options);
  }
  return stubValidate(policyNumber, email);
}

module.exports = { validatePolicy };
