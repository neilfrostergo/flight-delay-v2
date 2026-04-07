'use strict';

const express = require('express');
const multer  = require('multer');
const os      = require('os');
const fs      = require('fs');
const { parseDocument } = require('../services/documentParser');
const { query } = require('../db/connection');

const router = express.Router();

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF, JPEG or PNG files are accepted'));
  },
});

// POST /api/scan-document — parse a document and return extracted flight/date hints.
// No auth required; no data is saved to the database.
router.post('/', upload.single('document'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const parsed = await parseDocument(req.file.path, req.file.mimetype);

    // Filter flight numbers to only those whose carrier prefix is a known IATA code.
    // This removes booking references (e.g. ZNF0099) that match the regex but aren't flights.
    let flightNumbers = parsed.flightNumbers;
    if (flightNumbers.length > 1) {
      const codes = flightNumbers.map(f => f.replace(/\d+$/, '').replace(/\s/g, ''));
      const rows = await query(
        `SELECT iata_code FROM carriers WHERE iata_code = ANY($1)`,
        [codes]
      );
      const validCodes = new Set(rows.rows.map(r => r.iata_code));
      const filtered = flightNumbers.filter(f => validCodes.has(f.replace(/\d+$/, '').replace(/\s/g, '')));
      if (filtered.length) flightNumbers = filtered;
    }

    // Sort dates descending so the latest (most likely departure) comes first.
    const dates = [...parsed.dates].sort((a, b) => b.localeCompare(a));

    return res.json({ flightNumbers, dates });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large — maximum 10 MB' });
  return res.status(400).json({ error: err.message || 'Scan failed' });
});

module.exports = router;
