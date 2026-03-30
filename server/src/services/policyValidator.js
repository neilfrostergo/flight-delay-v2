'use strict';

const { decrypt } = require('./encryption');

// ─────────────────────────────────────────────────────────────────────────────
// STUB MODE
// Returns a realistic mock response for any well-formed input.
// Used when tenant.policy_api_mode = 'stub' (the default for new tenants).
// ─────────────────────────────────────────────────────────────────────────────

// Known demo policies with realistic data
const DEMO_POLICIES = {
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
  },
  'POL-002-PAID': {
    firstName: 'James', lastName: 'Williams',
    policyType: 'single_trip',
    travelers: [{ firstName: 'James', lastName: 'Williams' }],
    payoutPence: 25000,
    coverStartDate: '2026-03-15',
    coverEndDate:   '2026-03-22',
  },
  'POL-003-PENDING': {
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
  },
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

  // Return rich data for known demo policies
  const demo = DEMO_POLICIES[policyNumber.toUpperCase()];
  if (demo) {
    return { valid: true, rawResponse: { stub: true }, ...demo };
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
    rawResponse: { stub: true },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE MODE — Ergo Connect API
// POST {tenant.policy_api_url}/api/PolicySearch/getpolicy
// Auth: Bearer <decrypted tenant.policy_api_key_enc>
//
// Production swap point: to integrate a different insurer's API, update only
// the liveValidate() function below and adjust the field mapping.
// ─────────────────────────────────────────────────────────────────────────────
async function liveValidate(tenant, policyNumber, email) {
  let bearerToken;
  try {
    bearerToken = decrypt(tenant.policy_api_key_enc);
  } catch (err) {
    console.error('[policyValidator] Failed to decrypt API key for tenant', tenant.slug, err.message);
    return { valid: false, errorMessage: 'Policy validation service unavailable' };
  }

  const baseUrl = tenant.policy_api_url.replace(/\/$/, '');
  const url = `${baseUrl}/api/PolicySearch/getpolicy`;

  let body;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ policyNumber, pageSize: 1 }),
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 401) {
      return { valid: false, errorMessage: 'Policy validation service authentication failed' };
    }
    if (!res.ok) {
      throw new Error(`Policy API HTTP ${res.status}`);
    }

    body = await res.json();
  } catch (err) {
    console.error('[policyValidator] Policy API request failed:', err.message);
    return { valid: false, errorMessage: 'Policy validation service unavailable' };
  }

  if (!body.statusissuccessful || !body.data || body.data.length === 0) {
    return { valid: false, errorMessage: 'Policy not found' };
  }

  const policy = body.data[0];

  // Must be Active
  if (policy.status !== 'Active') {
    return { valid: false, errorMessage: 'Policy is not active' };
  }

  // Email must match (case-insensitive)
  if (!policy.policyHolderEmailAddress ||
      policy.policyHolderEmailAddress.toLowerCase() !== email.toLowerCase()) {
    return { valid: false, errorMessage: 'Email address does not match policy records' };
  }

  // Find the flight delay cover benefit
  const benefitName = (tenant.cover_benefit_name || 'Flight Delay').toLowerCase();
  const coverItem = (policy.cover || []).find(
    (c) => c.name && c.name.toLowerCase().includes(benefitName)
  );

  if (!coverItem) {
    return {
      valid: false,
      errorMessage: `No "${tenant.cover_benefit_name || 'Flight Delay'}" benefit found on this policy`,
    };
  }

  const payoutPence = Math.round((coverItem.limit || 0) * 100);
  if (payoutPence <= 0) {
    return { valid: false, errorMessage: 'Benefit limit is zero — policy not eligible' };
  }

  return {
    valid: true,
    firstName: policy.policyHolderFirstName || '',
    lastName: policy.policyHolderLastName || '',
    payoutPence,
    coverStartDate: policy.startDate || null,
    coverEndDate: policy.endDate || null,
    rawResponse: body,
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
async function validatePolicy(tenant, policyNumber, email) {
  if (tenant.policy_api_mode === 'live') {
    return liveValidate(tenant, policyNumber, email);
  }
  // Default to stub
  return stubValidate(policyNumber, email);
}

module.exports = { validatePolicy };
