'use strict';

const express = require('express');
const Joi = require('joi');
const { withTransaction, query } = require('../db/connection');
const { encrypt } = require('../services/encryption');
const { getOrCreateSubscription } = require('../services/oagAlerts');

const router = express.Router();

const flightSchema = Joi.object({
  flight_number:      Joi.string().trim().uppercase().max(20).required(),
  carrier_code:       Joi.string().trim().uppercase().max(10).required(),
  dep_iata:           Joi.string().trim().uppercase().max(10).allow('', null).optional(),
  dep_name:           Joi.string().trim().max(255).allow('', null).optional(),
  arr_iata:           Joi.string().trim().uppercase().max(10).allow('', null).optional(),
  arr_name:           Joi.string().trim().max(255).allow('', null).optional(),
  dep_date:           Joi.string().isoDate().required(),
  scheduled_dep_time: Joi.string().trim().max(10).allow('', null).optional(),
  scheduled_arr_time: Joi.string().trim().max(10).allow('', null).optional(),
});

const registrationSchema = Joi.object({
  policy_number:           Joi.string().trim().max(100).required(),
  first_name:              Joi.string().trim().max(100).required(),
  last_name:               Joi.string().trim().max(100).required(),
  email:                   Joi.string().trim().email().max(255).required(),
  payout_pence:            Joi.number().integer().min(1).required(),
  cover_start_date:        Joi.string().isoDate().allow(null).optional(),
  cover_end_date:          Joi.string().isoDate().allow(null).optional(),
  bank_sort_code:          Joi.string().trim().replace(/\D/g, '').length(6).required(),
  bank_account:            Joi.string().trim().replace(/\D/g, '').length(8).required(),
  flights:                 Joi.array().items(flightSchema).min(1).max(10).required(),
  pre_validation_token_id: Joi.number().integer().allow(null).optional(),
});

// POST /api/registrations
router.post('/', async (req, res) => {
  if (!req.tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const { error, value } = registrationSchema.validate(req.body, { abortEarly: false });
  if (error) {
    return res.status(400).json({ error: error.details.map((d) => d.message).join('; ') });
  }

  const minHours = req.tenant.min_hours_before_dep || 24;
  const now = Date.now();

  for (const flight of value.flights) {
    const depMs = new Date(`${flight.dep_date}T00:00:00Z`).getTime();
    const hoursUntil = (depMs - now) / (1000 * 60 * 60);
    if (hoursUntil < minHours) {
      return res.status(422).json({
        error: `Flight ${flight.flight_number} on ${flight.dep_date} must be registered at least ${minHours} hours before departure`,
      });
    }
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket?.remoteAddress
    || null;

  let registration;
  try {
    registration = await withTransaction(async (client) => {
      // Upsert registration: insert if new, otherwise fetch the existing row.
      // Annual multi-trip policies re-use the same registration and just add flights.
      const reg = await client.query(
        `INSERT INTO registrations
           (tenant_id, policy_number, first_name, last_name, email,
            payout_pence, cover_start_date, cover_end_date,
            bank_sort_code_enc, bank_account_enc,
            pre_validation_token_id, ip_address, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::inet,'active')
         ON CONFLICT (tenant_id, policy_number) DO NOTHING
         RETURNING id, policy_number, created_at`,
        [
          req.tenant.id,
          value.policy_number,
          value.first_name,
          value.last_name,
          value.email,
          value.payout_pence,
          value.cover_start_date || null,
          value.cover_end_date   || null,
          encrypt(value.bank_sort_code),
          encrypt(value.bank_account),
          value.pre_validation_token_id || null,
          ip,
        ]
      );

      let regRow = reg.rows[0];

      if (!regRow) {
        // Policy already registered — fetch the existing row to add flights to it
        const existing = await client.query(
          `SELECT id, policy_number, created_at
           FROM registrations WHERE tenant_id = $1 AND policy_number = $2`,
          [req.tenant.id, value.policy_number]
        );
        regRow = existing.rows[0];
        if (!regRow) throw new Error('Registration not found after conflict');
      }

      // Fetch already-registered flights to skip exact duplicates
      const existingFlights = await client.query(
        `SELECT flight_number, dep_date::text
         FROM flight_registrations WHERE registration_id = $1`,
        [regRow.id]
      );
      const registered = new Set(
        existingFlights.rows.map(f => `${f.flight_number}|${f.dep_date.slice(0, 10)}`)
      );

      // Insert each flight, silently skipping any already on this registration
      const flightRows = [];
      for (const f of value.flights) {
        if (registered.has(`${f.flight_number}|${f.dep_date}`)) continue;

        const fr = await client.query(
          `INSERT INTO flight_registrations
             (registration_id, tenant_id, flight_number, carrier_code,
              dep_iata, dep_name, arr_iata, arr_name,
              dep_date, scheduled_dep_time, scheduled_arr_time, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'active')
           RETURNING id, flight_number, dep_date`,
          [
            regRow.id, req.tenant.id,
            f.flight_number, f.carrier_code,
            f.dep_iata || null, f.dep_name || null,
            f.arr_iata || null, f.arr_name || null,
            f.dep_date,
            f.scheduled_dep_time || null,
            f.scheduled_arr_time || null,
          ]
        );
        flightRows.push({ ...fr.rows[0], carrier_code: f.carrier_code });
      }

      // Mark pre-validation token as used (new registrations only)
      if (value.pre_validation_token_id && reg.rows[0]) {
        await client.query(
          `UPDATE pre_validation_tokens
           SET used_at = NOW(), registration_id = $1
           WHERE id = $2 AND tenant_id = $3`,
          [regRow.id, value.pre_validation_token_id, req.tenant.id]
        );
      }

      return { regRow, flightRows };
    });
  } catch (err) {
    console.error('[register] DB error:', err.message);
    return res.status(500).json({ error: 'Registration failed — please try again' });
  }

  // Fire-and-forget: set up OAG alert subscriptions for each flight
  for (const fr of registration.flightRows) {
    const flightStr = String(fr.flight_number).replace(/[^A-Z0-9]/gi, '');
    getOrCreateSubscription(flightStr, fr.dep_date.toISOString().slice(0, 10))
      .then((subscriptionId) => {
        if (subscriptionId) {
          return query(
            'UPDATE flight_registrations SET flight_subscription_id = $1 WHERE id = $2',
            [subscriptionId, fr.id]
          );
        }
      })
      .catch((err) => console.error('[register] OAG subscription error:', err.message));
  }

  return res.status(201).json({
    registrationId: registration.regRow.id,
    policyNumber:   registration.regRow.policy_number,
    createdAt:      registration.regRow.created_at,
    flights: registration.flightRows.map((f) => ({
      id:           f.id,
      flightNumber: f.flight_number,
      depDate:      f.dep_date,
    })),
  });
});

// GET /api/registrations/:id/confirmation
// Public read-only — returns registration summary without sensitive fields.
router.get('/:id/confirmation', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!req.tenant || isNaN(id)) {
    return res.status(404).json({ error: 'Not found' });
  }

  const result = await query(
    `SELECT r.id, r.policy_number, r.first_name, r.last_name, r.email,
            r.payout_pence, r.cover_start_date, r.cover_end_date,
            r.status, r.created_at,
            json_agg(json_build_object(
              'id', fr.id,
              'flightNumber', fr.flight_number,
              'depIata', fr.dep_iata,
              'arrIata', fr.arr_iata,
              'depDate', fr.dep_date,
              'status', fr.status
            ) ORDER BY fr.dep_date) AS flights
     FROM registrations r
     JOIN flight_registrations fr ON fr.registration_id = r.id
     WHERE r.id = $1 AND r.tenant_id = $2
     GROUP BY r.id`,
    [id, req.tenant.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Registration not found' });
  }

  return res.json(result.rows[0]);
});

module.exports = router;
