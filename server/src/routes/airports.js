'use strict';

const express = require('express');
const airportDb = require('../data/airports.json');

const router = express.Router();

// Build a search-friendly index once at startup
const airports = Object.entries(airportDb).map(([iata, a]) => ({
  iata,
  name: a.name,
  city: a.city,
  country: a.country,
  _search: `${iata} ${a.name} ${a.city} ${a.country}`.toLowerCase(),
}));

// GET /api/airports?q=heathrow  →  [{ iata, name, city, country }, …]
router.get('/', (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (q.length < 2) return res.json([]);

  const results = [];
  for (const a of airports) {
    if (a._search.includes(q)) {
      results.push({ iata: a.iata, name: a.name, city: a.city, country: a.country });
      if (results.length >= 8) break;
    }
  }
  return res.json(results);
});

module.exports = router;
