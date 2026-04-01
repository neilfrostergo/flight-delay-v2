'use strict';

const express = require('express');
const { query } = require('../db/connection');

const router = express.Router();

// GET /api/carriers?q=british  →  [{ iata, name, alliance, country }, …]
// GET /api/carriers/:iata       →  single carrier object or 404
router.get('/', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);

  const results = await query(
    `SELECT iata_code, carrier_name, iata_name, alliance, domicile_country, region
     FROM ref_carriers
     WHERE iata_code    ILIKE $1
        OR carrier_name ILIKE $2
        OR iata_name    ILIKE $2
     ORDER BY
       CASE WHEN iata_code ILIKE $1 THEN 0 ELSE 1 END,
       carrier_name
     LIMIT 10`,
    [`${q}%`, `%${q}%`]
  );

  return res.json(results.rows.map(r => ({
    iata:    r.iata_code,
    name:    r.carrier_name || r.iata_name,
    alliance: r.alliance,
    country: r.domicile_country,
    region:  r.region,
  })));
});

router.get('/:iata', async (req, res) => {
  const iata = req.params.iata.toUpperCase();
  const result = await query(
    `SELECT iata_code, icao_code, oag_code, carrier_name, iata_name, alliance, domicile_country, region
     FROM ref_carriers WHERE iata_code = $1`,
    [iata]
  );
  if (result.rows.length === 0) return res.status(404).json({ error: 'Carrier not found' });
  const r = result.rows[0];
  return res.json({
    iata:    r.iata_code,
    icao:    r.icao_code,
    oag:     r.oag_code,
    name:    r.carrier_name || r.iata_name,
    alliance: r.alliance,
    country: r.domicile_country,
    region:  r.region,
  });
});

module.exports = router;
