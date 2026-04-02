'use strict';

/**
 * Modulr Faster Payments integration.
 *
 * POC mode  (tenant.modulr_mode = 'stub'): logs payment details and returns a
 *           synthetic success response. No real money moves.
 *
 * Live mode (tenant.modulr_mode = 'live'): calls the Modulr REST API to initiate
 *           a Faster Payments transfer to the customer's bank account.
 *
 * ── PRODUCTION SWAP ───────────────────────────────────────────────────────────
 * The livePayment() function below contains all the Modulr-specific logic.
 * To go live: configure tenant.modulr_account_id + tenant.modulr_api_key_enc
 * via the admin UI, then set tenant.modulr_mode = 'live'.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { decrypt } = require('./encryption');

const MODULR_API_URL = 'https://api.modulrfinance.com/api-sandbox'; // swap for live URL in prod

// ── STUB ──────────────────────────────────────────────────────────────────────
function stubPayment({ internalPaymentId, amountPence }) {
  const ref = `STUB-${internalPaymentId}-${Date.now()}`;
  console.log(
    `[modulr] STUB payment: id=${internalPaymentId} amount=£${(amountPence / 100).toFixed(2)} ref=${ref}`
  );
  return {
    success: true,
    modulrPaymentId: `STUB-${Date.now()}`,
    modulrReference: ref,
    failureReason: null,
  };
}

// ── LIVE ──────────────────────────────────────────────────────────────────────
async function livePayment(tenant, { sortCode, accountNumber, amountPence, reference, holderName }) {
  let apiKey;
  try {
    apiKey = decrypt(tenant.modulr_api_key_enc);
  } catch (err) {
    console.error('[modulr] Failed to decrypt API key for tenant', tenant.slug, err.message);
    return { success: false, modulrPaymentId: null, modulrReference: null, failureReason: 'API key decryption failed' };
  }

  const baseUrl = (process.env.MODULR_API_URL || MODULR_API_URL).replace(/\/$/, '');
  const url = `${baseUrl}/accounts/${tenant.modulr_account_id}/payments`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      },
      body: JSON.stringify({
        type: 'FASTER_PAYMENTS',
        payee: {
          name:          holderName || 'Policy Holder',
          sortCode:      sortCode.replace(/\D/g, ''),
          accountNumber: accountNumber.replace(/\D/g, ''),
        },
        amount:    (amountPence / 100).toFixed(2),
        reference: reference.slice(0, 18), // FPS 18-char limit
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Modulr HTTP ${res.status}: ${body}`);
    }

    const data = await res.json();
    return {
      success:          data.status === 'PROCESSED' || data.status === 'SUBMITTED',
      modulrPaymentId:  data.id || null,
      modulrReference:  data.reference || reference,
      failureReason:    data.status === 'FAILED' ? (data.message || 'Payment failed') : null,
    };
  } catch (err) {
    console.error('[modulr] Payment API error:', err.message);
    return { success: false, modulrPaymentId: null, modulrReference: null, failureReason: err.message };
  }
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * Send a Faster Payments payout to a customer's bank account.
 *
 * @param {object} tenant              - Full tenant row from DB
 * @param {object} params
 * @param {string} params.sortCode              - 6-digit sort code (plaintext)
 * @param {string} params.accountNumber         - 8-digit account number (plaintext)
 * @param {number} params.amountPence           - Payout amount in pence
 * @param {string} params.reference             - FPS payment reference (max 18 chars)
 * @param {number} params.internalPaymentId     - Our DB payments.id (for logging)
 * @param {string} [params.holderName]          - Account holder name
 *
 * @returns {Promise<{ success: boolean, modulrPaymentId: string|null, modulrReference: string|null, failureReason: string|null }>}
 */
async function sendPayment(tenant, params) {
  const env = process.env.NODE_ENV;
  if (tenant.modulr_mode === 'live' && env !== 'uat' && env !== 'development') {
    return livePayment(tenant, params);
  }
  return stubPayment(params);
}

module.exports = { sendPayment };
