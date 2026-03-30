'use strict';

/**
 * Core delay event processing engine.
 * Called by eventSource for each unprocessed flight_events row.
 *
 * For each active flight_registration linked to the event's subscription:
 *   1. Checks if delay threshold or cancellation is met
 *   2. Guards against duplicate payouts (idempotent)
 *   3. Decrypts bank details
 *   4. Triggers Modulr payout
 *   5. Records payment in DB
 *   6. Sends customer email
 *   7. Updates registration/flight statuses
 */

const { query, withTransaction } = require('../db/connection');
const { decrypt }                = require('./encryption');
const modulr                     = require('./modulr');
const { sendPayoutNotification } = require('./notificationService');

async function processEvent(eventRow) {
  const { id: eventId, subscription_id, state, delay_minutes } = eventRow;

  // Find all active flight_registrations linked to this subscription,
  // with their parent registration (for bank details + payout amount) and tenant config.
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
       AND fr.status = 'active'
       AND r.status  = 'active'`,
    [subscription_id]
  );

  for (const row of flightRegsResult.rows) {
    const isCancellation = (state || '').toLowerCase().includes('cancel');
    const thresholdMinutes = row.delay_threshold_minutes || 180;
    const isThresholdMet = !isCancellation && delay_minutes >= thresholdMinutes;

    if (!isCancellation && !isThresholdMet) {
      // Not delayed enough and not cancelled — skip this flight registration
      continue;
    }

    // Guard: skip if a payment already exists and succeeded (or is processing)
    const existingPayment = await query(
      `SELECT id FROM payments
       WHERE flight_registration_id = $1 AND status IN ('paid','processing')
       LIMIT 1`,
      [row.fr_id]
    );
    if (existingPayment.rows.length > 0) {
      console.log(`[delayProcessor] Skipping ${row.flight_number} reg ${row.reg_id} — payment already exists`);
      continue;
    }

    // Decrypt bank details
    let sortCode, accountNumber;
    try {
      sortCode      = decrypt(row.bank_sort_code_enc);
      accountNumber = decrypt(row.bank_account_enc);
    } catch (err) {
      console.error(`[delayProcessor] Failed to decrypt bank details for reg ${row.reg_id}:`, err.message);
      continue;
    }

    const tenant = {
      id:                row.tenant_id,
      slug:              row.tenant_slug,
      modulr_mode:       row.modulr_mode,
      modulr_account_id: row.modulr_account_id,
      modulr_api_key_enc: row.modulr_api_key_enc,
      primary_colour:    row.primary_colour,
      name:              row.tenant_name,
      support_email:     row.tenant_support_email,
    };

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
          `UPDATE flight_registrations SET status = 'paid', updated_at = NOW() WHERE id = $1`,
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

      // Send customer email (fire-and-forget)
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

  // Mark the event processed regardless of individual flight outcomes
  await query(`UPDATE flight_events SET processed_at = NOW() WHERE id = $1`, [eventId]);
}

module.exports = { processEvent };
