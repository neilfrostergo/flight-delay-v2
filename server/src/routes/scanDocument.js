'use strict';

const express = require('express');
const multer  = require('multer');
const os      = require('os');
const fs      = require('fs');
const { parseDocument } = require('../services/documentParser');

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
    return res.json({ flightNumbers: parsed.flightNumbers, dates: parsed.dates });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large — maximum 10 MB' });
  return res.status(400).json({ error: err.message || 'Scan failed' });
});

module.exports = router;
