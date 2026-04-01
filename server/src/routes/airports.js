'use strict';

const express = require('express');
const { query } = require('../db/connection');

const router = express.Router();

// GET /api/airports?q=heathrow  →  [{ iata, name, city, country, country_code, timezone, lat, lng }, …]
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  // Use DB if populated, fall back to JSON file if ref_airports is empty
  const countResult = await query('SELECT COUNT(*) FROM ref_airports');
  if (parseInt(countResult.rows[0].count, 10) > 0) {
    const results = await query(
      `SELECT iata_code, airport_name, city, country_name, country_code, timezone,
              latitude, longitude
       FROM ref_airports
       WHERE (
         iata_code    ILIKE $1 OR
         airport_name ILIKE $2 OR
         city         ILIKE $2 OR
         country_name ILIKE $2
       )
       AND (location_type IS NULL OR location_type NOT IN ('H','R','B'))
       ORDER BY
         CASE WHEN iata_code ILIKE $1 THEN 0 ELSE 1 END,
         airport_name
       LIMIT 8`,
      [`${q}%`, `%${q}%`]
    );
    return res.json(results.rows.map(r => ({
      iata:         r.iata_code,
      name:         r.airport_name,
      city:         r.city,
      country:      r.country_name,
      country_code: r.country_code,
      timezone:     r.timezone,
      lat:          r.latitude  ? parseFloat(r.latitude)  : null,
      lng:          r.longitude ? parseFloat(r.longitude) : null,
    })));
  }

  // Fallback: static JSON (used before first Snowflake sync)
  const airportDb = require('../data/airports.json');
  const airports = Object.entries(airportDb).map(([iata, a]) => ({
    iata, name: a.name, city: a.city, country: a.country,
    _search: `${iata} ${a.name} ${a.city} ${a.country}`.toLowerCase(),
  }));
  const qLower = q.toLowerCase();
  const results = [];
  for (const a of airports) {
    if (a._search.includes(qLower)) {
      results.push({ iata: a.iata, name: a.name, city: a.city, country: a.country });
      if (results.length >= 8) break;
    }
  }
  return res.json(results);
});

module.exports = router;
