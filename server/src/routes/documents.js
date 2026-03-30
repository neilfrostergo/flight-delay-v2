'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db/connection');
const { parseDocument, matchFlights } = require('../services/documentParser');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'server', 'uploads');

const ALLOWED_TYPES = {
  'image/jpeg':       'jpg',
  'image/png':        'png',
  'application/pdf':  'pdf',
};

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = path.join(UPLOADS_DIR, String(req.params.id));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(_req, file, cb) {
    const ext = ALLOWED_TYPES[file.mimetype] || 'bin';
    cb(null, `${uuidv4()}.${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter(_req, file, cb) {
    if (ALLOWED_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF, JPEG and PNG files are accepted'));
    }
  },
});

// POST /api/registrations/:id/documents
router.post('/:id/documents', upload.single('document'), async (req, res) => {
  const registrationId = parseInt(req.params.id, 10);
  if (!req.tenant || isNaN(registrationId)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  // Verify the registration belongs to this tenant
  const regResult = await query(
    'SELECT id FROM registrations WHERE id = $1 AND tenant_id = $2',
    [registrationId, req.tenant.id]
  );
  if (regResult.rows.length === 0) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Registration not found' });
  }

  const docType = req.body.document_type || 'booking_confirmation';

  const result = await query(
    `INSERT INTO registration_documents
       (registration_id, tenant_id, original_name, stored_name, mime_type, file_size_bytes, document_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, original_name, document_type, match_status, uploaded_at`,
    [
      registrationId,
      req.tenant.id,
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      docType,
    ]
  );

  const doc = result.rows[0];

  // Run analysis and link to the correct flight
  try {
    const parsed = await parseDocument(req.file.path, req.file.mimetype);

    const allFlights = await query(
      `SELECT id, flight_number, carrier_code, dep_date FROM flight_registrations
       WHERE registration_id = $1`,
      [registrationId]
    );

    const matchResult = matchFlights(parsed, allFlights.rows);

    let matchStatus, matchedFlightId, matchConfidence, flightRegistrationId;

    if (parsed.parseMethod === 'image_no_ocr') {
      matchStatus = 'image_no_ocr';
    } else if (parsed.parseMethod === 'pdf_error') {
      matchStatus = 'unreadable';
    } else if (matchResult) {
      matchStatus          = matchResult.confidence === 'high' ? 'matched' : 'partial_match';
      matchedFlightId      = matchResult.flightId;
      matchConfidence      = matchResult.confidence;
      flightRegistrationId = matchResult.flightId; // link doc to the matched flight
    } else {
      matchStatus = 'no_match';
      // If only one flight, link the doc to it even without a match
      if (allFlights.rows.length === 1) flightRegistrationId = allFlights.rows[0].id;
    }

    await query(
      `UPDATE registration_documents
       SET parse_method           = $1,
           parsed_flight_numbers  = $2,
           parsed_dates           = $3,
           matched_flight_id      = $4,
           match_confidence       = $5,
           match_status           = $6,
           flight_registration_id = $7
       WHERE id = $8`,
      [
        parsed.parseMethod,
        parsed.flightNumbers,
        parsed.dates,
        matchedFlightId      || null,
        matchConfidence      || null,
        matchStatus,
        flightRegistrationId || null,
        doc.id,
      ]
    );

    doc.match_status = matchStatus;
  } catch (err) {
    console.warn('[documents] Analysis error:', err.message);
  }

  return res.status(201).json(doc);
});

// Multer error handler
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large — maximum size is 10 MB' });
  }
  return res.status(400).json({ error: err.message || 'Upload failed' });
});

module.exports = router;
