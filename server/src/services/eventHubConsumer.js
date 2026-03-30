'use strict';

/**
 * Azure Event Hub consumer for OAG flight alert events.
 *
 * Receives flight state updates from OAG via Azure Event Hub and passes them
 * to the delay processor. Uses Azure Blob Storage for checkpointing so the
 * consumer resumes from the correct position after a restart.
 *
 * Only used in production (NODE_ENV=production).
 * Development uses the 30s DB poller in eventSource.js instead.
 */

const { EventHubConsumerClient, earliestEventPosition } = require('@azure/event-hubs');
const { ContainerClient }       = require('@azure/storage-blob');
const { BlobCheckpointStore }   = require('@azure/eventhubs-checkpointstore-blob');
const { query }                 = require('../db/connection');
const delayProcessor            = require('./delayProcessor');

let _consumerClient  = null;
let _subscription    = null;

// Map an OAG Event Hub payload to a flight_events row.
// OAG sends departure outGateVariation (minutes) as the delay indicator.
// Adjust field paths here if OAG's actual schema differs.
async function mapAndStoreOAGEvent(body) {
  const carrierCode  = body.carrierCode  || body.carrier?.iata;
  const flightNumber = body.flightNumber || body.flightNum;
  const depDate      = body.departureDate || body.departure?.date?.local;
  const state        = body.state || body.flightState || 'Unknown';
  const delayMinutes = Math.max(0, body.departure?.outGateVariation || body.delayMinutes || 0);

  if (!carrierCode || !flightNumber || !depDate) {
    console.warn('[eventHub] Skipping event — missing carrierCode/flightNumber/depDate:', JSON.stringify(body).slice(0, 200));
    return null;
  }

  // Look up the subscription ID from our DB
  const subResult = await query(
    `SELECT id FROM flight_alert_subscriptions
     WHERE carrier_code = $1 AND flight_number = $2 AND dep_date = $3 AND status = 'active'
     LIMIT 1`,
    [carrierCode, flightNumber, depDate]
  );

  if (subResult.rows.length === 0) {
    console.log(`[eventHub] No active subscription for ${carrierCode}${flightNumber} ${depDate} — ignoring`);
    return null;
  }

  const subscriptionId = subResult.rows[0].id;

  // Insert into flight_events (same schema as the DB poller path)
  const eventResult = await query(
    `INSERT INTO flight_events (subscription_id, state, delay_minutes, raw_payload)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [subscriptionId, state, delayMinutes, JSON.stringify(body)]
  );

  return eventResult.rows[0];
}

async function start(config) {
  if (_subscription) {
    console.warn('[eventHub] Consumer already running');
    return;
  }

  const containerClient  = new ContainerClient(config.storageConnectionString, config.storageContainerName);
  await containerClient.createIfNotExists();

  const checkpointStore  = new BlobCheckpointStore(containerClient);
  _consumerClient = new EventHubConsumerClient(
    EventHubConsumerClient.defaultConsumerGroupName,
    config.connectionString,
    config.eventHubName,
    checkpointStore
  );

  _subscription = _consumerClient.subscribe(
    {
      processEvents: async (events, context) => {
        for (const event of events) {
          try {
            const body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
            const eventRow = await mapAndStoreOAGEvent(body);
            if (eventRow) {
              await delayProcessor.processEvent(eventRow);
            }
            await context.updateCheckpoint(event);
          } catch (err) {
            console.error('[eventHub] Error processing event:', err.message);
          }
        }
      },
      processError: async (err) => {
        console.error('[eventHub] Consumer error:', err.message);
      },
    },
    { startPosition: earliestEventPosition }
  );

  console.log(`[eventHub] Azure Event Hub consumer started — listening on "${config.eventHubName}"`);
}

async function stop() {
  try {
    if (_subscription)   await _subscription.close();
    if (_consumerClient) await _consumerClient.close();
    _subscription   = null;
    _consumerClient = null;
    console.log('[eventHub] Consumer stopped');
  } catch (err) {
    console.error('[eventHub] Error stopping consumer:', err.message);
  }
}

module.exports = { start, stop };
