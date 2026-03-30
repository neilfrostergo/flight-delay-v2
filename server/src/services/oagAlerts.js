'use strict';

/**
 * OAG Flight Alerts subscription management.
 *
 * POC mode: manages only the local DB subscription table.
 * Production: swap the two clearly-marked sections to make real OAG API calls.
 *
 * Subscriptions are global/shared across all tenants — one OAG alert per unique
 * carrier+flight+date. Multiple flight_registrations (across all tenants) share
 * a single subscription row to avoid duplicate OAG registrations.
 */

const { query } = require('../db/connection');

function parseFlightNumber(flightStr) {
  const m = String(flightStr).trim().toUpperCase().match(/^([A-Z]{2,3})(\d{1,4})[A-Z]?$/);
  if (!m) return null;
  return { carrierCode: m[1], flightNumber: m[2] };
}

async function getOrCreateSubscription(flightNumberStr, depDate) {
  const parsed = parseFlightNumber(flightNumberStr);
  if (!parsed) {
    console.warn(`[oagAlerts] Could not parse flight number: ${flightNumberStr}`);
    return null;
  }
  const { carrierCode, flightNumber } = parsed;

  const existing = await query(
    `SELECT id FROM flight_alert_subscriptions
     WHERE carrier_code = $1 AND flight_number = $2 AND dep_date = $3 AND status = 'active'`,
    [carrierCode, flightNumber, depDate]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id;
  }

  // ── PRODUCTION: replace this block with a real OAG API call ─────────────────
  // const oagAlertId = await createOAGAlert(carrierCode, flightNumber, depDate);
  // ─────────────────────────────────────────────────────────────────────────────
  const oagAlertId = null; // POC stub
  console.log(`[oagAlerts] Registered subscription for ${carrierCode}${flightNumber} on ${depDate}`);

  const result = await query(
    `INSERT INTO flight_alert_subscriptions (carrier_code, flight_number, dep_date, oag_alert_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (carrier_code, flight_number, dep_date)
       DO UPDATE SET status = 'active', updated_at = NOW()
     RETURNING id`,
    [carrierCode, flightNumber, depDate, oagAlertId]
  );

  return result.rows[0].id;
}

async function cleanupExpiredSubscriptions() {
  // Mark subscriptions as completed when all linked flight_registrations are no longer active
  const result = await query(`
    UPDATE flight_alert_subscriptions s
    SET status = 'completed', updated_at = NOW()
    WHERE s.status = 'active'
      AND s.dep_date < CURRENT_DATE
      AND NOT EXISTS (
        SELECT 1 FROM flight_registrations fr
        WHERE fr.flight_subscription_id = s.id AND fr.status = 'active'
      )
    RETURNING id, oag_alert_id, carrier_code, flight_number, dep_date
  `);

  for (const row of result.rows) {
    if (row.oag_alert_id) {
      // ── PRODUCTION: call OAG DELETE /alerts/{id} here ─────────────────────
      console.log(`[oagAlerts] Would delete OAG alert ${row.oag_alert_id} for ${row.carrier_code}${row.flight_number} ${row.dep_date}`);
    } else {
      console.log(`[oagAlerts] Completed POC subscription for ${row.carrier_code}${row.flight_number} ${row.dep_date}`);
    }
  }

  if (result.rows.length > 0) {
    console.log(`[oagAlerts] Cleaned up ${result.rows.length} expired subscription(s)`);
  }
}

module.exports = { getOrCreateSubscription, cleanupExpiredSubscriptions };
