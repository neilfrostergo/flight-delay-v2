'use strict';

const express = require('express');
const Joi     = require('joi');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');
const config  = require('../../config');

const router = express.Router();

// GET /api/admin/simulator/subscriptions — active subscriptions for this tenant
router.get('/subscriptions', async (req, res) => {
  const scope = adminTenantScope(req);
  const params = [];
  const tenantClause = scope !== null ? `AND fr.tenant_id = $1` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT fas.id, fas.carrier_code, fas.flight_number, fas.dep_date,
            fas.oag_alert_id, fas.status,
            COUNT(fr.id) AS registration_count
     FROM flight_alert_subscriptions fas
     JOIN flight_registrations fr ON fr.flight_subscription_id = fas.id
     WHERE fas.status = 'active' ${tenantClause}
     GROUP BY fas.id
     ORDER BY fas.dep_date ASC`,
    params
  );

  return res.json(result.rows);
});

// POST /api/admin/simulator/event — inject a simulated flight event
const eventSchema = Joi.object({
  subscription_id: Joi.number().integer().required(),
  state:           Joi.string().valid('OutGate', 'InAir', 'Landed', 'InGate', 'Canceled').required(),
  delay_minutes:   Joi.number().integer().min(0).max(1440).default(0),
});

router.post('/event', async (req, res) => {
  const { error, value } = eventSchema.validate(req.body);
  if (error) return res.status(400).json({ error: error.details[0].message });

  // Verify the subscription exists and (if scoped) belongs to this tenant
  const scope = adminTenantScope(req);
  const params = [value.subscription_id];
  const tenantClause = scope !== null ? `AND EXISTS (SELECT 1 FROM flight_registrations fr WHERE fr.flight_subscription_id = fas.id AND fr.tenant_id = $2)` : '';
  if (scope !== null) params.push(scope);

  const sub = await query(
    `SELECT fas.id, fas.carrier_code, fas.flight_number, fas.dep_date
     FROM flight_alert_subscriptions fas
     WHERE fas.id = $1 ${tenantClause}`,
    params
  );
  if (sub.rows.length === 0) return res.status(404).json({ error: 'Subscription not found' });

  const result = await query(
    `INSERT INTO flight_events (subscription_id, state, delay_minutes, raw_payload)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      value.subscription_id,
      value.state,
      value.delay_minutes,
      JSON.stringify({ simulated: true, injectedBy: req.admin.username, at: new Date().toISOString() }),
    ]
  );

  await query(
    `INSERT INTO audit_log (tenant_id, admin_user_id, action, entity_type, entity_id, details)
     VALUES ($1,$2,'simulate_flight_event','flight_event',$3,$4)`,
    [
      req.admin.tenant_id,
      req.admin.sub,
      result.rows[0].id,
      JSON.stringify({ subscription_id: value.subscription_id, state: value.state, delay_minutes: value.delay_minutes }),
    ]
  );

  return res.status(201).json({ eventId: result.rows[0].id, message: 'Event injected — poller will process within 30s' });
});

// POST /api/admin/simulator/oag-event — simulate a raw OAG Event Hub payload
// Tests the field-mapping logic in eventHubConsumer without a real Event Hub connection.
// BLOCKED IN PRODUCTION.
router.post('/oag-event', async (req, res) => {
  if (config.isProduction) {
    return res.status(403).json({ error: 'OAG payload simulation is not available in production' });
  }

  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Request body must be a JSON object' });
  }

  // Run the same mapping logic as eventHubConsumer.mapAndStoreOAGEvent
  const carrierCode  = body.carrierCode  || body.carrier?.iata;
  const flightNumber = body.flightNumber || body.flightNum;
  const depDate      = body.departureDate || body.departure?.date?.local;
  const state        = body.state || body.flightState || 'Unknown';
  const delayMinutes = Math.max(0, body.departure?.outGateVariation || body.delayMinutes || 0);

  if (!carrierCode || !flightNumber || !depDate) {
    return res.status(422).json({
      error: 'Payload must contain carrierCode (or carrier.iata), flightNumber (or flightNum), and departureDate (or departure.date.local)',
      parsed: { carrierCode, flightNumber, depDate, state, delayMinutes },
    });
  }

  const subResult = await query(
    `SELECT id FROM flight_alert_subscriptions
     WHERE carrier_code = $1 AND flight_number = $2 AND dep_date = $3 AND status = 'active'
     LIMIT 1`,
    [carrierCode, flightNumber, depDate]
  );

  if (subResult.rows.length === 0) {
    return res.status(404).json({
      error: `No active subscription found for ${carrierCode}${flightNumber} on ${depDate}`,
      parsed: { carrierCode, flightNumber, depDate, state, delayMinutes },
    });
  }

  const subscriptionId = subResult.rows[0].id;

  const eventResult = await query(
    `INSERT INTO flight_events (subscription_id, state, delay_minutes, raw_payload)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [subscriptionId, state, delayMinutes, JSON.stringify({ ...body, _simulated: true, _injectedBy: req.admin.username })]
  );

  const eventId = eventResult.rows[0].id;

  const delayProcessor = require('../../services/delayProcessor');
  const eventRow = (await query('SELECT * FROM flight_events WHERE id = $1', [eventId])).rows[0];
  await delayProcessor.processEvent(eventRow);

  return res.status(201).json({
    ok: true,
    eventId,
    parsed: { carrierCode, flightNumber, depDate, state, delayMinutes, subscriptionId },
    message: 'OAG payload mapped, event stored and processed',
  });
});

// GET /api/admin/simulator/notifications — recent notifications for this tenant
router.get('/notifications', async (req, res) => {
  const scope = adminTenantScope(req);
  const limit  = Math.min(100, parseInt(req.query.limit || '50', 10));
  const offset = parseInt(req.query.offset || '0', 10);

  const params = [limit, offset];
  const tenantClause = scope !== null ? `WHERE n.tenant_id = $3` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT n.id, n.tenant_id, n.registration_id, n.flight_registration_id,
            n.channel, n.recipient, n.subject, n.status, n.error_message, n.sent_at, n.created_at,
            r.policy_number, fr.flight_number
     FROM notifications n
     LEFT JOIN registrations r ON r.id = n.registration_id
     LEFT JOIN flight_registrations fr ON fr.id = n.flight_registration_id
     ${tenantClause}
     ORDER BY n.created_at DESC
     LIMIT $1 OFFSET $2`,
    params
  );

  return res.json(result.rows);
});

module.exports = router;
