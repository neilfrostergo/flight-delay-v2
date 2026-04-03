'use strict';

const express = require('express');
const { query } = require('../db/connection');
const { decrypt } = require('../services/encryption');
const config = require('../config');

// In-process airport name cache to avoid repeated DB lookups per request
const _airportCache = new Map();

async function airportName(iata) {
  if (!iata) return null;
  if (_airportCache.has(iata)) return _airportCache.get(iata);
  const result = await query(
    `SELECT airport_name, city, country_name FROM ref_airports WHERE iata_code = $1`,
    [iata]
  );
  if (result.rows.length === 0) { _airportCache.set(iata, null); return null; }
  const r = result.rows[0];
  const name = [r.airport_name, r.city, r.country_name].filter(Boolean).join(', ');
  _airportCache.set(iata, name);
  return name;
}

const router = express.Router();

// Cache the OAG key for 5 minutes to avoid a DB round-trip on every search
let _cachedKey = null;
let _cacheExpiry = 0;

// Cache OAG flight results keyed by "FLIGHT|DATE"
const _flightCache = new Map();
const CACHE_TTL_FUTURE_MS = 30 * 60 * 1000;
const CACHE_TTL_TODAY_MS  =  5 * 60 * 1000;

function getFlightCacheKey(flight, date) {
  return flight.toUpperCase() + '|' + date;
}

function isToday(dateStr) {
  return dateStr === new Date().toISOString().slice(0, 10);
}

async function getOagKey() {
  if (_cachedKey && Date.now() < _cacheExpiry) return _cachedKey;

  // OAG key lives in shared_api_keys (superadmin-managed)
  const result = await query(
    `SELECT key_enc FROM shared_api_keys
     WHERE LOWER(service_name) = 'oag' AND is_active = TRUE LIMIT 1`
  );
  if (result.rows.length === 0 || !result.rows[0].key_enc) return null;

  _cachedKey = decrypt(result.rows[0].key_enc);
  _cacheExpiry = Date.now() + 5 * 60 * 1000;
  return _cachedKey;
}

// Check if a flight is too soon to register.
// Uses the actual departure time (HH:MM local) when known, falling back to end-of-day
// so we never falsely block a flight that departs late in the day.
function calcTooSoon(tenant, date, depTime) {
  if (!tenant) return false;
  const minHours = tenant.min_hours_before_dep || 24;
  const timeStr = depTime && /^\d{2}:\d{2}/.test(depTime) ? depTime.slice(0, 5) : '23:59';
  const depDateTime = new Date(`${date}T${timeStr}:00`);
  return (depDateTime - Date.now()) / (1000 * 60 * 60) < minHours;
}

function calcTooFar(tenant, date) {
  if (!tenant) return false;
  const maxDays = tenant.max_days_before_dep || 40;
  const depDateTime = new Date(`${date}T00:00:00`);
  return (depDateTime - Date.now()) / (1000 * 60 * 60 * 24) > maxDays;
}

function fmtDuration(minutes) {
  if (!minutes || minutes <= 0) return null;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function parseStatus(statusDetails) {
  if (!statusDetails || statusDetails.length === 0) return { status: 'Scheduled', statusClass: 'status-ontime' };
  const latest = statusDetails[statusDetails.length - 1];
  const state  = (latest.state || '').toLowerCase();
  if (state.includes('cancel'))                            return { status: 'Cancelled', statusClass: 'status-delayed' };
  if (state.includes('delay'))                             return { status: 'Delayed',   statusClass: 'status-delayed' };
  if (state.includes('board'))                             return { status: 'Boarding',  statusClass: 'status-ontime'  };
  if (state.includes('airborne') || state.includes('en')) return { status: 'In Flight', statusClass: 'status-live'    };
  if (state.includes('land') || state.includes('arriv'))  return { status: 'Landed',    statusClass: 'status-ontime'  };
  return { status: 'Scheduled', statusClass: 'status-ontime' };
}

// GET /api/flight-lookup/route?origin=LHR&destination=JFK&date=2026-03-28
router.get('/route', async (req, res) => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    return res.status(400).json({ error: 'origin, destination and date required' });
  }

  const dep = origin.trim().toUpperCase();
  const arr = destination.trim().toUpperCase();

  let oagKey;
  try { oagKey = await getOagKey(); } catch (err) {
    console.error('[flight-lookup/route] Key lookup error:', err.message);
    return res.status(503).json({ flights: [], error: 'Flight lookup service unavailable' });
  }

  if (!oagKey) {
    return res.json({ flights: [], stub: true });
  }

  const params = new URLSearchParams({
    DepartureStation:  dep,
    ArrivalStation:    arr,
    DepartureDateTime: date,
    CodeType:          'IATA',
    version:           'v2',
    limit:             '20',
  });

  let oagData;
  const oagUrl = `https://api.oag.com/flight-instances?${params}`;
  try {
    const oagRes = await fetch(oagUrl, {
        headers: { 'Subscription-Key': oagKey },
        signal: AbortSignal.timeout(15000),
      }
    );
    console.log(`[flight-lookup/route] OAG ${oagUrl} → HTTP ${oagRes.status}`);
    if (oagRes.status === 404 || oagRes.status === 204) {
      return res.json({ flights: [] });
    }
    if (!oagRes.ok) {
      const body = await oagRes.text().catch(() => '');
      console.error(`[flight-lookup/route] OAG error body: ${body.slice(0, 300)}`);
      throw new Error(`OAG HTTP ${oagRes.status}`);
    }
    oagData = await oagRes.json();
    console.log(`[flight-lookup/route] OAG returned ${oagData?.data?.length ?? 0} results`);
  } catch (err) {
    console.error('[flight-lookup/route] OAG API error:', err.message);
    if (!config.isProduction) {
      return res.json({ flights: [], stub: true });
    }
    return res.status(502).json({ flights: [], error: 'Flight data unavailable' });
  }

  const raw = Array.isArray(oagData?.data) ? oagData.data : [];

  const [depNameStr, arrNameStr] = await Promise.all([airportName(dep), airportName(arr)]);

  const flights = raw.slice(0, 12).map(f => {
    const carrierCode = f.carrier?.iata || f.marketingCarrier?.iata || '';
    const flightNum   = f.flightNumber  || f.marketingFlightNumber  || '';
    const depTime     = f.departure?.time?.local || f.departure?.scheduledTime?.local || null;
    const arrTime     = f.arrival?.time?.local   || f.arrival?.scheduledTime?.local   || null;
    const depDate     = f.departure?.date?.local || date;
    const arrDate     = f.arrival?.date?.local   || date;
    const { status, statusClass } = parseStatus(f.statusDetails || []);
    return {
      found:        true,
      carrier:      carrierCode,
      number:       `${carrierCode}${flightNum}`,
      carrierCode,
      depIata:      f.departure?.airport?.iata || dep,
      depName:      depNameStr,
      depTime,
      depDate,
      arrIata:      f.arrival?.airport?.iata   || arr,
      arrName:      arrNameStr,
      arrTime,
      arrDate,
      duration:     fmtDuration(f.elapsedTime),
      aircraftIata: f.aircraftType?.iata || null,
      status,
      statusClass,
      tooSoon: calcTooSoon(req.tenant, depDate, depTime),
      tooFar:  calcTooFar(req.tenant, depDate),
    };
  });

  return res.json({ flights });
});

// GET /api/flight-lookup?flight=BA249&date=2026-03-26
router.get('/', async (req, res) => {
  const { flight, date } = req.query;

  if (!flight || !date) {
    return res.status(400).json({ error: 'flight and date query params required' });
  }

  const m = flight.trim().toUpperCase().match(/^([A-Z]{2,3})(\d{1,4})[A-Z]?$/);
  if (!m) {
    return res.status(400).json({ error: 'Invalid flight number format' });
  }
  const [, carrierCode, flightNum] = m;

  // tooSoon is calculated after we know the actual departure time — see calcTooSoon()

  let oagKey;
  try {
    oagKey = await getOagKey();
  } catch (err) {
    console.error('[flight-lookup] Key lookup error:', err.message);
    return res.status(503).json({ found: false, error: 'Flight lookup service unavailable' });
  }

  if (!oagKey) {
    // Stub mode — return realistic fake data so the UI can be tested without a real OAG key
    const stubDepTime = '09:30';
    const stubResult = {
      found:        true,
      carrier:      carrierCode,
      number:       `${carrierCode}${flightNum}`,
      carrierCode,
      flightNum,
      depIata:      'LHR',
      depName:      'London Heathrow',
      depTime:      stubDepTime,
      depDate:      date,
      arrIata:      'JFK',
      arrName:      'New York JFK',
      arrTime:      '12:45',
      arrDate:      date,
      duration:     '7h 15m',
      aircraftIata: '788',
      status:       'Scheduled',
      statusClass:  'status-ontime',
      tooSoon: calcTooSoon(req.tenant, date, stubDepTime),
      tooFar:  calcTooFar(req.tenant, date),
      stub:    true,
    };
    return res.json(stubResult);
  }

  const cacheKey = getFlightCacheKey(flight, date);
  const cached = _flightCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return res.json({ ...cached.data, tooSoon: calcTooSoon(req.tenant, date, cached.data.depTime), tooFar: calcTooFar(req.tenant, date) });
  }

  const params = new URLSearchParams({
    CarrierCode:       carrierCode,
    FlightNumber:      flightNum,
    DepartureDateTime: date,
    CodeType:          'IATA',
    version:           'v2',
  });

  let oagData;
  try {
    const oagStart = Date.now();
    const oagRes = await fetch(
      `https://api.oag.com/flight-instances?${params}`,
      {
        headers: { 'Subscription-Key': oagKey },
        signal: AbortSignal.timeout(10000),
      }
    );
    const oagDuration = Date.now() - oagStart;

    // Log the outbound OAG call
    query(
      `INSERT INTO request_log (tenant_id, method, path, status, duration_ms, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
      [
        req.tenant?.id || null,
        'GET',
        `/oag/flight-instances?flight=${flight}&date=${date}`,
        oagRes.status,
        oagDuration,
        'OAG-outbound',
      ]
    ).catch(() => {});

    if (oagRes.status === 404) {
      const notFound = { found: false };
      _flightCache.set(cacheKey, { data: notFound, expiry: Date.now() + CACHE_TTL_FUTURE_MS });
      return res.json({ ...notFound, tooSoon: false });
    }
    if (!oagRes.ok) {
      const body = await oagRes.text().catch(() => '');
      throw new Error(`OAG HTTP ${oagRes.status}: ${body}`);
    }

    oagData = await oagRes.json();
  } catch (err) {
    _cachedKey = null;
    console.error('[flight-lookup] OAG API error:', err.message);
    if (!config.isProduction) {
      console.warn('[flight-lookup] Falling back to stub response in dev mode');
      return res.json({
        found: true, carrier: carrierCode, number: `${carrierCode}${flightNum}`,
        carrierCode, flightNum,
        depIata: 'LHR', depName: 'London Heathrow', depTime: '09:30', depDate: date,
        arrIata: 'JFK', arrName: 'New York JFK',     arrTime: '12:45', arrDate: date,
        duration: '7h 15m', aircraftIata: '788',
        status: 'Scheduled', statusClass: 'status-ontime',
        tooSoon: calcTooSoon(req.tenant, date, '09:30'),
        tooFar:  calcTooFar(req.tenant, date),
        stub: true,
      });
    }
    return res.status(502).json({ found: false, error: 'Flight data unavailable' });
  }

  if (!oagData.data || oagData.data.length === 0) {
    const notFound = { found: false };
    _flightCache.set(cacheKey, { data: notFound, expiry: Date.now() + CACHE_TTL_FUTURE_MS });
    return res.json({ ...notFound, tooSoon: false });
  }

  const f = oagData.data[0];
  const { status, statusClass } = parseStatus(f.statusDetails);

  const depIata = f.departure?.airport?.iata || null;
  const arrIata = f.arrival?.airport?.iata   || null;

  const [depNameStr, arrNameStr] = await Promise.all([airportName(depIata), airportName(arrIata)]);

  const result = {
    found:        true,
    carrier:      f.carrier?.iata || carrierCode,
    number:       `${carrierCode}${flightNum}`,
    carrierCode,
    flightNum,
    depIata,
    depName:      depNameStr,
    depTime:      f.departure?.time?.local   || null,
    depDate:      f.departure?.date?.local   || date,
    arrIata,
    arrName:      arrNameStr,
    arrTime:      f.arrival?.time?.local     || null,
    arrDate:      f.arrival?.date?.local     || null,
    duration:     fmtDuration(f.elapsedTime),
    aircraftIata: f.aircraftType?.iata || null,
    aircraftIcao: f.aircraftType?.icao || null,
    status,
    statusClass,
  };

  const ttl = isToday(date) ? CACHE_TTL_TODAY_MS : CACHE_TTL_FUTURE_MS;
  _flightCache.set(cacheKey, { data: result, expiry: Date.now() + ttl });

  return res.json({ ...result, tooSoon: calcTooSoon(req.tenant, result.depDate || date, result.depTime), tooFar: calcTooFar(req.tenant, result.depDate || date) });
});

module.exports = router;
