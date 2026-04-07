'use strict';

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const { query } = require('../db/connection');
const { parseDocument, matchFlights, normaliseFlight } = require('../services/documentParser');
const { verifyDocument } = require('../services/documentVerifier');
const blob = require('../services/blobStorage');

const router = express.Router();

const UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'server', 'uploads');

const ALLOWED_TYPES = {
  'image/jpeg':       'jpg',
  'image/png':        'png',
  'application/pdf':  'pdf',
};

const storage = multer.diskStorage({
  destination(req, _file, cb) {
    const dir = blob.isAvailable() ? os.tmpdir() : path.join(UPLOADS_DIR, String(req.params.id));
    if (!blob.isAvailable()) fs.mkdirSync(dir, { recursive: true });
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

  // Upload to blob storage if available
  const blobKey = blob.blobName(registrationId, req.file.filename);
  if (blob.isAvailable()) {
    try {
      await blob.uploadFile(req.file.path, blobKey, req.file.mimetype);
    } catch (blobErr) {
      fs.unlink(req.file.path, () => {});
      await query('DELETE FROM registration_documents WHERE id = $1', [doc.id]);
      return res.status(500).json({ error: 'Document storage unavailable — please try again shortly' });
    }
  }

  // Run analysis and link to the correct flight
  try {
    let filePath = req.file.path;
    if (blob.isAvailable()) {
      const tmp = path.join(os.tmpdir(), req.file.filename);
      await blob.downloadToTemp(blobKey, tmp);
      filePath = tmp;
    }

    const parsed = await parseDocument(filePath, req.file.mimetype);
    if (blob.isAvailable()) fs.unlink(filePath, () => {});

    const allFlights = await query(
      `SELECT id, flight_number, carrier_code, dep_date FROM flight_registrations
       WHERE registration_id = $1`,
      [registrationId]
    );

    // AI verification — run before matching so it can override regex noise
    const canVerify = (parsed.parseMethod === 'pdf' && parsed.rawText) ||
                      (parsed.parseMethod === 'pdf_image') ||
                      (parsed.parseMethod === 'image' && parsed.base64Image);
    let aiResult = { genuine: null, confidence: null, passengerName: null, flightNumber: null, flightDate: null, reason: null };
    if (canVerify) {
      parsed.blobKey = blobKey;
      aiResult = await verifyDocument(parsed, null);
      if (aiResult.flightNumber) {
        const aiNorm = normaliseFlight(aiResult.flightNumber);
        const matchesRegistered = allFlights.rows.some(f => normaliseFlight(f.flight_number) === aiNorm);
        if (matchesRegistered) {
          parsed.flightNumbers = [aiResult.flightNumber];
          if (aiResult.flightDate) parsed.dates = [aiResult.flightDate];
        }
      }
    }

    const matchResult = matchFlights(parsed, allFlights.rows);

    let matchStatus, matchedFlightId, matchConfidence, flightRegistrationId;

    if (parsed.parseMethod === 'image') {
      if (aiResult.genuine === true) {
        matchStatus = 'matched';
        matchedFlightId = allFlights.rows[0]?.id;
        matchConfidence = aiResult.confidence;
        flightRegistrationId = matchedFlightId;
      } else {
        matchStatus = 'pending_ai';
      }
    } else if (parsed.parseMethod === 'image_error' || parsed.parseMethod === 'unsupported') {
      matchStatus = 'unreadable';
    } else if (parsed.parseMethod === 'pdf_error') {
      matchStatus = 'unreadable';
    } else if (aiResult.genuine === false && aiResult.confidence === 'high') {
      matchStatus = 'rejected';
    } else if (matchResult) {
      matchStatus          = matchResult.confidence === 'high' ? 'matched' : 'partial_match';
      matchedFlightId      = matchResult.flightId;
      matchConfidence      = matchResult.confidence;
      flightRegistrationId = matchResult.flightId;
    } else {
      matchStatus = 'no_match';
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
           flight_registration_id = $7,
           ai_genuine             = $8,
           ai_confidence          = $9,
           ai_passenger_name      = $10,
           ai_reason              = $11
       WHERE id = $12`,
      [
        parsed.parseMethod,
        parsed.flightNumbers,
        parsed.dates,
        matchedFlightId      || null,
        matchConfidence      || null,
        matchStatus,
        flightRegistrationId || null,
        aiResult.genuine,
        aiResult.confidence,
        aiResult.passengerName,
        aiResult.reason,
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
