'use strict';

/**
 * Core delay event processing engine.
 * Called by eventSource for each unprocessed flight_events row.
 *
 * For each active flight_registration linked to the event's subscription:
 *   1. Checks if delay threshold or cancellation is met
 *   2. Checks for a validated document (match_status = 'matched')
 *      — If none: issues a tokenised upload link, emails the customer,
 *        sets status = 'awaiting_document', defers payment
 *   3. Guards against duplicate payouts (idempotent)
 *   4. Decrypts bank details
 *   5. Triggers Modulr payout
 *   6. Records payment in DB
 *   7. Sends customer email
 *   8. Updates registration/flight statuses
 */

const crypto = require('crypto');

const { query, withTransaction }         = require('../db/connection');
const { decrypt }                        = require('./encryption');
const modulr                             = require('./modulr');
const { sendPayoutNotification,
        sendDocumentUploadRequest }      = require('./notificationService');
const config                             = require('../config');

// ── Token helpers ─────────────────────────────────────────────────────────────

function buildUploadUrl(token, tenant) {
  const host = `${tenant.slug}.${config.baseDomain}`;
  const base = config.isProduction
    ? `https://${host}`
    : `http://${host}:${config.port}`;
  return `${base}?upload_token=${token}`;
}

async function createUploadToken(flightRegId, regId, tenantId) {
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO document_upload_tokens
       (token, tenant_id, registration_id, flight_registration_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO NOTHING`,
    [token, tenantId, regId, flightRegId]
  );
  return token;
}

// ── Payment execution (shared by processEvent and triggerDeferredPayment) ─────

async function executePayment(row, eventId, tenant, isCancellation) {
  // Guard: skip if a payment already exists and succeeded (or is processing)
  const existingPayment = await query(
    `SELECT id FROM payments
     WHERE flight_registration_id = $1 AND status IN ('paid','processing')
     LIMIT 1`,
    [row.fr_id]
  );
  if (existingPayment.rows.length > 0) {
    console.log(`[delayProcessor] Skipping ${row.flight_number} reg ${row.reg_id} — payment already exists`);
    return;
  }

  // Decrypt bank details
  let sortCode, accountNumber;
  try {
    sortCode      = decrypt(row.bank_sort_code_enc);
    accountNumber = decrypt(row.bank_account_enc);
  } catch (err) {
    console.error(`[delayProcessor] Failed to decrypt bank details for reg ${row.reg_id}:`, err.message);
    return;
  }

  const reference = `FDP-${row.reg_id}-${row.fr_id}`.slice(0, 18);

  // Insert payment record (pending) before attempting Modulr
  const paymentResult = await query(
    `INSERT INTO payments
       (tenant_id, registration_id, flight_registration_id, flight_event_id,
        amount_pence, status)
     VALUES ($1,$2,$3,$4,$5,'processing')
     RETURNING id`,
    [row.tenant_id, row.reg_id, row.fr_id, eventId, row.payout_pence]
  );
  const paymentId = paymentResult.rows[0].id;

  // Attempt Modulr payment
  const modulrResult = await modulr.sendPayment(tenant, {
    sortCode,
    accountNumber,
    amountPence:       row.payout_pence,
    reference,
    internalPaymentId: paymentId,
    holderName:        `${row.first_name} ${row.last_name}`,
  });

  if (modulrResult.success) {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payments
         SET status = 'paid', modulr_payment_id = $1, modulr_reference = $2, updated_at = NOW()
         WHERE id = $3`,
        [modulrResult.modulrPaymentId, modulrResult.modulrReference, paymentId]
      );
      await client.query(
        `UPDATE flight_registrations
         SET status = 'paid', pending_flight_event_id = NULL, updated_at = NOW()
         WHERE id = $1`,
        [row.fr_id]
      );
      // Mark parent registration paid if ALL its flights are now paid
      await client.query(
        `UPDATE registrations SET status = 'paid', updated_at = NOW()
         WHERE id = $1
           AND NOT EXISTS (
             SELECT 1 FROM flight_registrations
             WHERE registration_id = $1 AND status != 'paid'
           )`,
        [row.reg_id]
      );
    });

    console.log(`[delayProcessor] Payment ${paymentId} succeeded for reg ${row.reg_id} flight ${row.flight_number}`);

    const registration = {
      id: row.reg_id, policy_number: row.policy_number,
      first_name: row.first_name, last_name: row.last_name, email: row.email,
      payout_pence: row.payout_pence,
    };
    const flightReg = {
      id: row.fr_id, flight_number: row.flight_number,
      dep_iata: row.dep_iata, arr_iata: row.arr_iata, dep_date: row.dep_date,
      flight_event_id: eventId,
    };
    const payment = {
      id: paymentId, amount_pence: row.payout_pence,
      modulr_reference: modulrResult.modulrReference, flight_event_id: eventId,
    };

    sendPayoutNotification(registration, flightReg, payment, tenant, isCancellation ? 'cancellation' : 'delay')
      .catch((err) => console.error('[delayProcessor] Notification error:', err.message));

  } else {
    await query(
      `UPDATE payments SET status = 'failed', failure_reason = $1, updated_at = NOW() WHERE id = $2`,
      [modulrResult.failureReason || 'Unknown error', paymentId]
    );
    console.error(`[delayProcessor] Payment ${paymentId} failed for reg ${row.reg_id}:`, modulrResult.failureReason);
  }
}

// ── Main event processor ──────────────────────────────────────────────────────

async function processEvent(eventRow) {
  const { id: eventId, subscription_id, state, delay_minutes } = eventRow;

  const flightRegsResult = await query(
    `SELECT
       fr.id            AS fr_id,
       fr.flight_number,
       fr.carrier_code,
       fr.dep_iata,
       fr.arr_iata,
       fr.dep_date,
       fr.status        AS fr_status,
       r.id             AS reg_id,
       r.policy_number,
       r.first_name,
       r.last_name,
       r.email,
       r.payout_pence,
       r.bank_sort_code_enc,
       r.bank_account_enc,
       r.status         AS reg_status,
       t.id             AS tenant_id,
       t.slug           AS tenant_slug,
       t.delay_threshold_minutes,
       t.modulr_mode,
       t.modulr_account_id,
       t.modulr_api_key_enc,
       t.primary_colour,
       t.name           AS tenant_name,
       t.support_email  AS tenant_support_email
     FROM flight_registrations fr
     JOIN registrations r  ON r.id  = fr.registration_id
     JOIN tenants t         ON t.id  = fr.tenant_id
     WHERE fr.flight_subscription_id = $1
       AND fr.status IN ('active', 'awaiting_document')
       AND r.status  = 'active'`,
    [subscription_id]
  );

  for (const row of flightRegsResult.rows) {
    const isCancellation  = (state || '').toLowerCase().includes('cancel');
    const thresholdMinutes = row.delay_threshold_minutes || 180;
    const isThresholdMet  = !isCancellation && delay_minutes >= thresholdMinutes;

    if (!isCancellation && !isThresholdMet) {
      continue;
    }

    const tenant = {
      id:                 row.tenant_id,
      slug:               row.tenant_slug,
      modulr_mode:        row.modulr_mode,
      modulr_account_id:  row.modulr_account_id,
      modulr_api_key_enc: row.modulr_api_key_enc,
      primary_colour:     row.primary_colour,
      name:               row.tenant_name,
      support_email:      row.tenant_support_email,
    };

    // Check for a validated document before paying
    const validatedDoc = await query(
      `SELECT id FROM registration_documents
       WHERE flight_registration_id = $1 AND match_status = 'matched'
       LIMIT 1`,
      [row.fr_id]
    );

    if (validatedDoc.rows.length === 0) {
      // No validated document — defer payment and request upload
      // (skip if already awaiting_document to avoid duplicate emails)
      if (row.fr_status === 'awaiting_document') {
        console.log(`[delayProcessor] Already awaiting document for reg ${row.reg_id} flight ${row.flight_number}`);
        continue;
      }

      const token     = await createUploadToken(row.fr_id, row.reg_id, row.tenant_id);
      const uploadUrl = buildUploadUrl(token, tenant);

      await query(
        `UPDATE flight_registrations
         SET status = 'awaiting_document', pending_flight_event_id = $1, updated_at = NOW()
         WHERE id = $2`,
        [eventId, row.fr_id]
      );

      const registration = {
        id: row.reg_id, policy_number: row.policy_number,
        first_name: row.first_name, email: row.email,
      };
      const flightReg = {
        id: row.fr_id, flight_number: row.flight_number,
        dep_iata: row.dep_iata, arr_iata: row.arr_iata, dep_date: row.dep_date,
      };

      sendDocumentUploadRequest(registration, flightReg, uploadUrl, tenant)
        .catch((err) => console.error('[delayProcessor] Upload request email error:', err.message));

      console.log(`[delayProcessor] Deferred payment for reg ${row.reg_id} flight ${row.flight_number} — awaiting document`);
      continue;
    }

    await executePayment(row, eventId, tenant, isCancellation);
  }

  await query(`UPDATE flight_events SET processed_at = NOW() WHERE id = $1`, [eventId]);
}

// ── Deferred payment trigger (called after document is validated) ─────────────

async function triggerDeferredPayment(flightRegId, eventId) {
  const result = await query(
    `SELECT
       fr.id            AS fr_id,
       fr.flight_number,
       fr.carrier_code,
       fr.dep_iata,
       fr.arr_iata,
       fr.dep_date,
       fr.status        AS fr_status,
       r.id             AS reg_id,
       r.policy_number,
       r.first_name,
       r.last_name,
       r.email,
       r.payout_pence,
       r.bank_sort_code_enc,
       r.bank_account_enc,
       r.status         AS reg_status,
       t.id             AS tenant_id,
       t.slug           AS tenant_slug,
       t.delay_threshold_minutes,
       t.modulr_mode,
       t.modulr_account_id,
       t.modulr_api_key_enc,
       t.primary_colour,
       t.name           AS tenant_name,
       t.support_email  AS tenant_support_email,
       fe.state         AS event_state
     FROM flight_registrations fr
     JOIN registrations r  ON r.id  = fr.registration_id
     JOIN tenants t         ON t.id  = fr.tenant_id
     JOIN flight_events fe  ON fe.id = $2
     WHERE fr.id = $1`,
    [flightRegId, eventId]
  );

  if (result.rows.length === 0) {
    console.error(`[delayProcessor] triggerDeferredPayment: flight reg ${flightRegId} or event ${eventId} not found`);
    return;
  }

  const row  = result.rows[0];
  const isCancellation = (row.event_state || '').toLowerCase().includes('cancel');

  const tenant = {
    id:                 row.tenant_id,
    slug:               row.tenant_slug,
    modulr_mode:        row.modulr_mode,
    modulr_account_id:  row.modulr_account_id,
    modulr_api_key_enc: row.modulr_api_key_enc,
    primary_colour:     row.primary_colour,
    name:               row.tenant_name,
    support_email:      row.tenant_support_email,
  };

  // Reset to active so executePayment status updates work correctly
  await query(
    `UPDATE flight_registrations
     SET status = 'active', pending_flight_event_id = NULL, updated_at = NOW()
     WHERE id = $1`,
    [flightRegId]
  );

  await executePayment(row, eventId, tenant, isCancellation);
}

module.exports = { processEvent, triggerDeferredPayment };
