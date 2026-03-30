'use strict';

/**
 * Event source — POC implementation using a DB poller.
 *
 * Polls flight_events every 30s for unprocessed rows and passes them
 * to delayProcessor. The delayProcessor never changes between POC and prod.
 *
 * ── PRODUCTION SWAP ─────────────────────────────────────────────────────────
 * Replace start() with an Azure Event Hub consumer:
 *
 *   const { EventHubConsumerClient } = require('@azure/event-hubs');
 *
 *   async function start() {
 *     const client = new EventHubConsumerClient(
 *       EventHubConsumerClient.defaultConsumerGroupName,
 *       process.env.OAG_EVENT_HUB_CONNECTION_STRING
 *     );
 *     client.subscribe({
 *       processEvents: async (events) => {
 *         for (const e of events) {
 *           const mapped = mapOAGEvent(e.body);
 *           const { rows } = await query(
 *             `INSERT INTO flight_events (subscription_id, state, delay_minutes, raw_payload)
 *              VALUES ($1,$2,$3,$4) RETURNING *`,
 *             [mapped.subscriptionId, mapped.state, mapped.delayMinutes, JSON.stringify(e.body)]
 *           );
 *           await delayProcessor.processEvent(rows[0]);
 *         }
 *       },
 *       processError: async (err) => console.error('[eventSource]', err.message),
 *     });
 *     console.log('[eventSource] Azure Event Hub consumer started');
 *   }
 *
 *   function mapOAGEvent(body) {
 *     const depVariation = body.departure?.outGateVariation || 0;
 *     return {
 *       subscriptionId: lookupSubscriptionId(body), // query DB by carrier+flight+date
 *       state:          body.state,
 *       delayMinutes:   Math.max(0, depVariation),
 *     };
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { query }                       = require('../db/connection');
const delayProcessor                  = require('./delayProcessor');
const { cleanupExpiredSubscriptions } = require('./oagAlerts');

const POLL_INTERVAL_MS    = 30 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let _pollTimer    = null;
let _cleanupTimer = null;

async function poll() {
  try {
    const result = await query(
      `SELECT fe.*
       FROM flight_events fe
       WHERE fe.processed_at IS NULL
       ORDER BY fe.created_at ASC
       LIMIT 50`
    );

    for (const row of result.rows) {
      await delayProcessor.processEvent(row);
    }
  } catch (err) {
    console.error('[eventSource] Poll error:', err.message);
  }
}

function start() {
  if (_pollTimer) return;

  console.log(`[eventSource] POC poller started — checking every ${POLL_INTERVAL_MS / 1000}s`);
  poll();
  _pollTimer    = setInterval(poll, POLL_INTERVAL_MS);
  _cleanupTimer = setInterval(cleanupExpiredSubscriptions, CLEANUP_INTERVAL_MS);
}

function stop() {
  clearInterval(_pollTimer);
  clearInterval(_cleanupTimer);
  _pollTimer    = null;
  _cleanupTimer = null;
}

module.exports = { start, stop };
