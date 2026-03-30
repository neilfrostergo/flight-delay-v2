'use strict';

/**
 * Event source — switches between implementations based on NODE_ENV.
 *
 * Development:  30s DB poller (no Azure dependencies needed locally)
 * Production:   Azure Event Hub consumer (eventHubConsumer.js)
 *
 * delayProcessor.js is never touched — events reach it the same way either side.
 */

const config                          = require('../config');
const { query }                       = require('../db/connection');
const delayProcessor                  = require('./delayProcessor');
const { cleanupExpiredSubscriptions } = require('./oagAlerts');

const POLL_INTERVAL_MS    = 30 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

let _pollTimer    = null;
let _cleanupTimer = null;

// ── DEV: 30s DB poller ────────────────────────────────────────────────────────
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

function startPoller() {
  if (_pollTimer) return;
  console.log(`[eventSource] DEV poller started — checking every ${POLL_INTERVAL_MS / 1000}s`);
  poll();
  _pollTimer    = setInterval(poll, POLL_INTERVAL_MS);
  _cleanupTimer = setInterval(cleanupExpiredSubscriptions, CLEANUP_INTERVAL_MS);
}

function stopPoller() {
  clearInterval(_pollTimer);
  clearInterval(_cleanupTimer);
  _pollTimer    = null;
  _cleanupTimer = null;
}

// ── PRODUCTION: Azure Event Hub ───────────────────────────────────────────────
async function startEventHub() {
  const eventHubConsumer = require('./eventHubConsumer');
  await eventHubConsumer.start({
    connectionString:    config.eventHub.connectionString,
    eventHubName:        config.eventHub.name,
    storageConnectionString: config.eventHub.storageConnectionString,
    storageContainerName:    config.eventHub.storageContainerName,
  });
  // Cleanup still runs hourly in production
  _cleanupTimer = setInterval(cleanupExpiredSubscriptions, CLEANUP_INTERVAL_MS);
}

async function stopEventHub() {
  clearInterval(_cleanupTimer);
  _cleanupTimer = null;
  const eventHubConsumer = require('./eventHubConsumer');
  await eventHubConsumer.stop();
}

// ── Public interface ──────────────────────────────────────────────────────────
async function start() {
  if (config.isProduction) {
    await startEventHub();
  } else {
    startPoller();
  }
}

async function stop() {
  if (config.isProduction) {
    await stopEventHub();
  } else {
    stopPoller();
  }
}

module.exports = { start, stop };
