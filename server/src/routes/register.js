'use strict';

const express = require('express');
const Joi = require('joi');
const { withTransaction, query } = require('../db/connection');
const { encrypt } = require('../services/encryption');
const { getOrCreateSubscription } = require('../services/oagAlerts');
const { sendRegistrationConfirmation } = require('../services/notificationService');

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
  policy_type:             Joi.string().trim().max(50).allow(null).optional(),
  travelers:               Joi.array().items(Joi.object()).allow(null).optional(),
  cover_summary:           Joi.array().items(Joi.object()).allow(null).optional(),
  policy_wording_url:      Joi.string().uri().allow(null, '').optional(),
  policy_wording_name:     Joi.string().max(200).allow(null, '').optional(),
  ipid_url:                Joi.string().uri().allow(null, '').optional(),
  ipid_name:               Joi.string().max(200).allow(null, '').optional(),
  key_facts_url:           Joi.string().uri().allow(null, '').optional(),
  key_facts_name:          Joi.string().max(200).allow(null, '').optional(),
  geographic_area:         Joi.string().max(200).allow(null, '').optional(),
  policy_issue_date:       Joi.string().isoDate().allow(null).optional(),
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
  const maxDays  = req.tenant.max_days_before_dep  || 40;
  const now = Date.now();

  for (const flight of value.flights) {
    const depMs = new Date(`${flight.dep_date}T00:00:00`).getTime();
    const hoursUntil = (depMs - now) / (1000 * 60 * 60);
    const daysUntil  = hoursUntil / 24;

    if (hoursUntil < minHours) {
      return res.status(422).json({
        error: `Flight ${flight.flight_number} on ${flight.dep_date} must be registered at least ${minHours} hours before departure`,
      });
    }
    if (daysUntil > maxDays) {
      return res.status(422).json({
        error: `Flight ${flight.flight_number} on ${flight.dep_date} cannot be registered more than ${maxDays} days before departure`,
      });
    }
    if (value.cover_start_date && flight.dep_date < value.cover_start_date) {
      return res.status(422).json({
        error: `Flight ${flight.flight_number} on ${flight.dep_date} is before your policy cover start date (${value.cover_start_date})`,
      });
    }
    if (value.cover_end_date && flight.dep_date > value.cover_end_date) {
      return res.status(422).json({
        error: `Flight ${flight.flight_number} on ${flight.dep_date} is after your policy cover end date (${value.cover_end_date})`,
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
            pre_validation_token_id, ip_address, status,
            policy_type, travelers, cover_summary,
            policy_wording_url, policy_wording_name,
            ipid_url, ipid_name, key_facts_url, key_facts_name,
            geographic_area, policy_issue_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::inet,'active',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
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
          value.policy_type   || null,
          value.travelers     ? JSON.stringify(value.travelers)     : null,
          value.cover_summary ? JSON.stringify(value.cover_summary) : null,
          value.policy_wording_url  || null,
          value.policy_wording_name || null,
          value.ipid_url            || null,
          value.ipid_name           || null,
          value.key_facts_url       || null,
          value.key_facts_name      || null,
          value.geographic_area     || null,
          value.policy_issue_date   || null,
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

      // Check for duplicate flights — reject if any submitted flight is already registered
      const duplicates = value.flights.filter(f => registered.has(`${f.flight_number}|${f.dep_date}`));
      if (duplicates.length > 0) {
        const names = duplicates.map(f => `${f.flight_number} on ${f.dep_date}`).join(', ');
        throw Object.assign(new Error(`Flight already registered: ${names}`), { statusCode: 409 });
      }

      // Insert each flight
      const flightRows = [];
      for (const f of value.flights) {

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
        flightRows.push({ ...f, ...fr.rows[0] });
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
    if (err.statusCode === 409) {
      return res.status(409).json({ error: err.message });
    }
    console.error('[register] DB error:', err.message);
    return res.status(500).json({ error: 'Registration failed — please try again' });
  }

  // Fire-and-forget: set up OAG alert subscriptions for each flight
  for (const fr of registration.flightRows) {
    const flightStr = String(fr.flight_number).replace(/[^A-Z0-9]/gi, '');
    getOrCreateSubscription(flightStr, fr.dep_date instanceof Date
      ? `${fr.dep_date.getFullYear()}-${String(fr.dep_date.getMonth()+1).padStart(2,'0')}-${String(fr.dep_date.getDate()).padStart(2,'0')}`
      : String(fr.dep_date).slice(0, 10))
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

  // Fire-and-forget: send confirmation email with enriched airport names
  (async () => {
    try {
      const regRow = registration.regRow;
      const flightRows = registration.flightRows;

      // Enrich with airport names from ref_airports
      const iatas = [...new Set([
        ...flightRows.map(f => f.dep_iata).filter(Boolean),
        ...flightRows.map(f => f.arr_iata).filter(Boolean),
      ])];
      let airportMap = {};
      if (iatas.length) {
        const r = await query(
          `SELECT iata_code, airport_name, country_name FROM ref_airports WHERE iata_code = ANY($1)`,
          [iatas]
        );
        r.rows.forEach(a => { airportMap[a.iata_code] = [a.airport_name, a.country_name].filter(Boolean).join(', '); });
      }

      const enrichedFlights = flightRows.map(f => ({
        flight_number:      f.flight_number,
        dep_iata:           f.dep_iata,
        arr_iata:           f.arr_iata,
        dep_name:           airportMap[f.dep_iata] || null,
        arr_name:           airportMap[f.arr_iata] || null,
        dep_date:           f.dep_date,
        scheduled_dep_time: f.scheduled_dep_time || null,
        scheduled_arr_time: f.scheduled_arr_time || null,
      }));

      await sendRegistrationConfirmation(
        { ...regRow, payout_pence: value.payout_pence, email: value.email, first_name: value.first_name },
        enrichedFlights,
        req.tenant
      );
    } catch (err) {
      console.error('[register] Confirmation email error:', err.message);
    }
  })();

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
