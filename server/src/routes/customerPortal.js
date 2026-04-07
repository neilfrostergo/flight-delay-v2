'use strict';

const express  = require('express');
const jwt      = require('jsonwebtoken');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const config          = require('../config');
const { query }       = require('../db/connection');
const requireCustomer = require('../middleware/requireCustomer');
const { parseDocument, matchFlights }      = require('../services/documentParser');
const { getOrCreateSubscription }          = require('../services/oagAlerts');
const { validatePolicy }                   = require('../services/policyValidator');
const { triggerDeferredPayment }           = require('../services/delayProcessor');
const { verifyDocument }                   = require('../services/documentVerifier');
const blob                                 = require('../services/blobStorage');

const os = require('os');
const router = express.Router();

// ── Multer ────────────────────────────────────────────────────────────────────
// Use os.tmpdir() so uploads work in containers where the app directory is
// read-only. Files are only written here briefly before blob upload and are
// always cleaned up immediately after.

const UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'server', 'uploads');

const ALLOWED_TYPES = {
  'image/jpeg':      'jpg',
  'image/png':       'png',
  'application/pdf': 'pdf',
};

const storage = multer.diskStorage({
  destination(_req, _file, cb) {
    const dir = blob.isAvailable() ? os.tmpdir() : UPLOADS_DIR;
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
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (ALLOWED_TYPES[file.mimetype]) cb(null, true);
    else cb(new Error('Only PDF, JPEG and PNG files are accepted'));
  },
});

// ── POST /api/customer/sessions — log in with policy number + email ───────────
router.post('/sessions', async (req, res) => {
  if (!req.tenant) return res.status(404).json({ error: 'Tenant not found' });

  const { policy_number, email } = req.body || {};
  if (!policy_number || !email) {
    return res.status(400).json({ error: 'Policy number and email are required' });
  }

  const result = await query(
    `SELECT id FROM registrations
     WHERE tenant_id = $1
       AND UPPER(policy_number) = UPPER($2)
       AND LOWER(email) = LOWER($3)
       AND status != 'cancelled'`,
    [req.tenant.id, policy_number.trim(), email.trim()]
  );

  if (result.rows.length === 0) {
    // No registration yet — validate via policy API and issue a policy-only session
    // so the portal can still display policy info before the customer registers any flights.
    const policyResult = await validatePolicy(req.tenant, policy_number.trim(), email.trim());
    if (!policyResult.valid) {
      return res.status(401).json({ error: 'No registration found — check your policy number and email' });
    }

    const token = jwt.sign(
      {
        sub:              null, // no registration row
        policy_number:    policy_number.trim().toUpperCase(),
        first_name:       policyResult.firstName,
        last_name:        policyResult.lastName,
        email:            email.trim().toLowerCase(),
        payout_pence:     policyResult.payoutPence,
        cover_start_date: policyResult.coverStartDate || null,
        cover_end_date:   policyResult.coverEndDate   || null,
        policy_type:      policyResult.policyType     || null,
        travelers:        policyResult.travelers       || null,
        cover_summary:    policyResult.coverSummary    || null,
        tenant_id:        req.tenant.id,
        type:             'customer',
      },
      config.jwt.secret,
      { expiresIn: '24h' }
    );
    return res.json({ token, registrationId: null });
  }

  const registrationId = result.rows[0].id;

  // Fetch policy detail fields to include in the JWT payload
  const regDetail = await query(
    `SELECT policy_number, policy_type, travelers, cover_summary,
            policy_wording_url, policy_wording_name,
            ipid_url, ipid_name, key_facts_url, key_facts_name
     FROM registrations WHERE id = $1`,
    [registrationId]
  );
  const regDetailRow = regDetail.rows[0] || {};

  // For registrations created before policy detail columns existed, re-validate
  // the policy to populate the JWT with fresh data (and backfill the DB row).
  let policyDetail = {
    policy_type:          regDetailRow.policy_type          || null,
    travelers:            regDetailRow.travelers             || null,
    cover_summary:        regDetailRow.cover_summary         || null,
    policy_wording_url:   regDetailRow.policy_wording_url   || null,
    policy_wording_name:  regDetailRow.policy_wording_name  || null,
    ipid_url:             regDetailRow.ipid_url             || null,
    ipid_name:            regDetailRow.ipid_name            || null,
    key_facts_url:        regDetailRow.key_facts_url        || null,
    key_facts_name:       regDetailRow.key_facts_name       || null,
  };

  // Re-validate if any key fields are missing (handles registrations created before these columns existed)
  if (!policyDetail.policy_type || !policyDetail.policy_wording_url) {
    const fresh = await validatePolicy(req.tenant, regDetailRow.policy_number, email.trim());
    if (fresh.valid) {
      policyDetail = {
        policy_type:          fresh.policyType          || policyDetail.policy_type   || null,
        travelers:            fresh.travelers            || policyDetail.travelers     || null,
        cover_summary:        fresh.coverSummary        || policyDetail.cover_summary || null,
        policy_wording_url:   fresh.policyWordingUrl    || null,
        policy_wording_name:  fresh.policyWordingName   || null,
        ipid_url:             fresh.ipidUrl             || null,
        ipid_name:            fresh.ipidName            || null,
        key_facts_url:        fresh.keyFactsUrl         || null,
        key_facts_name:       fresh.keyFactsName        || null,
      };
      // Backfill so subsequent logins don't need to re-validate
      await query(
        `UPDATE registrations
            SET policy_type=$1, travelers=$2, cover_summary=$3,
                policy_wording_url=$4, policy_wording_name=$5,
                ipid_url=$6, ipid_name=$7, key_facts_url=$8, key_facts_name=$9
          WHERE id=$10`,
        [
          policyDetail.policy_type,
          JSON.stringify(policyDetail.travelers),
          JSON.stringify(policyDetail.cover_summary),
          policyDetail.policy_wording_url,  policyDetail.policy_wording_name,
          policyDetail.ipid_url,            policyDetail.ipid_name,
          policyDetail.key_facts_url,       policyDetail.key_facts_name,
          registrationId,
        ]
      );
    }
  }

  const token = jwt.sign(
    {
      sub:           registrationId,
      tenant_id:     req.tenant.id,
      type:          'customer',
      policy_type:   policyDetail.policy_type,
      travelers:     policyDetail.travelers,
      cover_summary: policyDetail.cover_summary,
    },
    config.jwt.secret,
    { expiresIn: '24h' }
  );

  return res.json({ token, registrationId });
});

// ── GET /api/customer/upload-token/:token — validate upload link, return session ─
// Public — no requireCustomer. The token itself is the proof of identity.
router.get('/upload-token/:token', async (req, res) => {
  if (!req.tenant) return res.status(404).json({ error: 'Tenant not found' });

  const { token } = req.params;
  if (!token || !/^[0-9a-f]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Invalid token format' });
  }

  const result = await query(
    `SELECT t.flight_registration_id,
            r.id AS reg_id, r.policy_type, r.travelers, r.cover_summary
     FROM document_upload_tokens t
     JOIN registrations r ON r.id = t.registration_id
     WHERE t.token = $1
       AND t.tenant_id = $2
       AND t.used_at IS NULL
       AND t.expires_at > NOW()`,
    [token, req.tenant.id]
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'This link is invalid or has expired' });
  }

  const row = result.rows[0];

  const jwtToken = jwt.sign(
    {
      sub:           row.reg_id,
      tenant_id:     req.tenant.id,
      type:          'customer',
      policy_type:   row.policy_type,
      travelers:     row.travelers,
      cover_summary: row.cover_summary,
    },
    config.jwt.secret,
    { expiresIn: '24h' }
  );

  return res.json({
    token:                jwtToken,
    registrationId:       row.reg_id,
    flightRegistrationId: row.flight_registration_id,
  });
});

// ── GET /api/customer/registration — full detail with flights + documents ─────
router.get('/registration', requireCustomer, async (req, res) => {
  if (!req.tenant || req.customer.tenant_id !== req.tenant.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Policy-only session — no registration row exists yet
  if (!req.customer.sub) {
    return res.json({
      id:               null,
      policy_number:    req.customer.policy_number,
      first_name:       req.customer.first_name,
      last_name:        req.customer.last_name,
      email:            req.customer.email,
      payout_pence:     req.customer.payout_pence,
      cover_start_date: req.customer.cover_start_date || null,
      cover_end_date:   req.customer.cover_end_date   || null,
      policy_type:      req.customer.policy_type      || null,
      travelers:        req.customer.travelers         || null,
      cover_summary:    req.customer.cover_summary     || null,
      status:           'not_registered',
      flights:          [],
    });
  }

  const regResult = await query(
    `SELECT id, policy_number, first_name, last_name, email,
            payout_pence, cover_start_date, cover_end_date, status, created_at,
            policy_type, travelers, cover_summary,
            policy_wording_url, policy_wording_name,
            ipid_url, ipid_name, key_facts_url, key_facts_name
     FROM registrations WHERE id = $1 AND tenant_id = $2`,
    [req.customer.sub, req.tenant.id]
  );
  if (regResult.rows.length === 0) {
    return res.status(404).json({ error: 'Registration not found' });
  }

  const reg = regResult.rows[0];

  // Flights with their associated documents
  const flightsResult = await query(
    `SELECT fr.id, fr.flight_number, fr.carrier_code,
            fr.dep_iata, fr.arr_iata, fr.dep_name, fr.arr_name,
            fr.dep_date, fr.scheduled_dep_time, fr.status,
            COALESCE(
              json_agg(
                json_build_object(
                  'id',                    d.id,
                  'original_name',         d.original_name,
                  'document_type',         d.document_type,
                  'mime_type',             d.mime_type,
                  'file_size_bytes',       d.file_size_bytes,
                  'match_status',          d.match_status,
                  'match_confidence',      d.match_confidence,
                  'parsed_flight_numbers', d.parsed_flight_numbers,
                  'parsed_dates',          d.parsed_dates,
                  'uploaded_at',           d.uploaded_at
                ) ORDER BY d.uploaded_at
              ) FILTER (WHERE d.id IS NOT NULL),
              '[]'
            ) AS documents
     FROM flight_registrations fr
     LEFT JOIN registration_documents d ON (
       d.flight_registration_id = fr.id
       OR (d.matched_flight_id = fr.id AND d.flight_registration_id IS NULL)
     )
     WHERE fr.registration_id = $1
     GROUP BY fr.id
     ORDER BY fr.dep_date`,
    [reg.id]
  );

  return res.json({ ...reg, flights: flightsResult.rows });
});

// ── POST /api/customer/flights/:flightId/documents — upload + analyse ─────────
router.post('/flights/:flightId/documents', requireCustomer, upload.single('document'), async (req, res) => {
  if (!req.tenant || req.customer.tenant_id !== req.tenant.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const flightId      = parseInt(req.params.flightId, 10);
  const registrationId = req.customer.sub;

  if (isNaN(flightId)) return res.status(400).json({ error: 'Invalid flight ID' });
  if (!req.file)       return res.status(400).json({ error: 'No file uploaded' });

  // Verify the flight belongs to this customer's registration
  const flightCheck = await query(
    `SELECT fr.id, fr.flight_number, fr.carrier_code, fr.dep_date
     FROM flight_registrations fr
     JOIN registrations r ON r.id = fr.registration_id
     WHERE fr.id = $1 AND r.id = $2 AND r.tenant_id = $3`,
    [flightId, registrationId, req.tenant.id]
  );

  if (flightCheck.rows.length === 0) {
    fs.unlink(req.file.path, () => {});
    return res.status(404).json({ error: 'Flight not found' });
  }

  const flight       = flightCheck.rows[0];
  const docType      = req.body.document_type || 'booking_confirmation';

  // Insert document record (match_status defaults to 'pending')
  const docResult = await query(
    `INSERT INTO registration_documents
       (registration_id, tenant_id, flight_registration_id,
        original_name, stored_name, mime_type, file_size_bytes, document_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, original_name, document_type, match_status, uploaded_at`,
    [
      registrationId,
      req.tenant.id,
      flightId,
      req.file.originalname,
      req.file.filename,
      req.file.mimetype,
      req.file.size,
      docType,
    ]
  );

  const doc = docResult.rows[0];

  // ── Upload to blob storage (replaces local file in UAT/prod) ──────────────
  const blobKey = blob.blobName(registrationId, req.file.filename);
  let blobUrl;
  try {
    blobUrl = await blob.uploadFile(req.file.path, blobKey, req.file.mimetype);
    if (blobUrl) {
      await query(`UPDATE registration_documents SET blob_url = $1 WHERE id = $2`, [blobUrl, doc.id]);
    }
  } catch (blobErr) {
    // Clean up the local temp file and return a clear error to the client
    fs.unlink(req.file.path, () => {});
    await query('DELETE FROM registration_documents WHERE id = $1', [doc.id]);
    return res.status(500).json({ error: 'Document storage unavailable — please try again shortly' });
  }
  // If blob upload succeeded, req.file.path is deleted. parseDocument will
  // read from blob; if not available (local dev), local path still exists.

  // ── Synchronous document analysis ─────────────────────────────────────────
  try {
    // In blob mode, download to a temp path for pdf-parse (needs a file path)
    let filePath = req.file.path;
    if (blob.isAvailable()) {
      const os   = require('os');
      const tmp  = path.join(os.tmpdir(), req.file.filename);
      await blob.downloadToTemp(blobKey, tmp);
      filePath = tmp;
    }
    const parsed = await parseDocument(filePath, req.file.mimetype);
    // Clean up temp file
    if (blob.isAvailable()) fs.unlink(filePath, () => {});

    // Fetch all flights on this registration for matching
    const allFlights = await query(
      `SELECT fr.id, fr.flight_number, fr.carrier_code, fr.dep_date
       FROM flight_registrations fr
       WHERE fr.registration_id = $1`,
      [registrationId]
    );

    // Attach blob key so verifier can fetch image data if needed
    parsed.blobKey = blobKey;

    const matchResult = matchFlights(parsed, allFlights.rows);

    let matchStatus, matchedFlightId, matchConfidence;

    if (parsed.parseMethod === 'image') {
      matchStatus = 'pending_ai'; // AI will set to matched or rejected below
    } else if (parsed.parseMethod === 'image_error' || parsed.parseMethod === 'unsupported') {
      matchStatus = 'unreadable';
    } else if (parsed.parseMethod === 'pdf_error') {
      matchStatus = 'unreadable';
    } else if (matchResult) {
      matchStatus     = matchResult.confidence === 'high' ? 'matched' : 'partial_match';
      matchedFlightId = matchResult.flightId;
      matchConfidence = matchResult.confidence;
    } else {
      matchStatus = 'no_match';
    }

    // AI authenticity verification — runs for PDF (text) and images (vision)
    let aiResult = { genuine: null, confidence: null, passengerName: null, reason: null };
    const canVerify = (parsed.parseMethod === 'pdf' && parsed.rawText) ||
                      (parsed.parseMethod === 'image' && parsed.base64Image);
    if (canVerify) {
      const targetFlight = allFlights.rows.find(f => f.id === flightId);
      aiResult = await verifyDocument(parsed, targetFlight);

      if (aiResult.genuine === true && parsed.parseMethod === 'image') {
        // Image verified as genuine by AI — treat as matched (regex can't read images)
        matchStatus     = 'matched';
        matchedFlightId = flightId;
        matchConfidence = aiResult.confidence;
      } else if (aiResult.genuine === false && aiResult.confidence === 'high') {
        // AI confident it's not genuine — reject regardless of regex match
        matchStatus = 'rejected';
        console.warn(`[customerPortal] AI rejected document for reg ${registrationId} flight ${flightId}: ${aiResult.reason}`);
      }
    }

    await query(
      `UPDATE registration_documents
       SET parse_method           = $1,
           parsed_flight_numbers  = $2,
           parsed_dates           = $3,
           matched_flight_id      = $4,
           match_confidence       = $5,
           match_status           = $6,
           ai_genuine             = $7,
           ai_confidence          = $8,
           ai_passenger_name      = $9,
           ai_reason              = $10
       WHERE id = $11`,
      [
        parsed.parseMethod,
        parsed.flightNumbers,
        parsed.dates,
        matchedFlightId || null,
        matchConfidence || null,
        matchStatus,
        aiResult.genuine,
        aiResult.confidence,
        aiResult.passengerName,
        aiResult.reason,
        doc.id,
      ]
    );

    doc.match_status          = matchStatus;
    doc.match_confidence      = matchConfidence || null;
    doc.parsed_flight_numbers = parsed.flightNumbers;
    doc.parsed_dates          = parsed.dates;
    doc.parse_method          = parsed.parseMethod;
    doc.ai_genuine            = aiResult.genuine;
    doc.ai_passenger_name     = aiResult.passengerName;

    // If we found a match for a different flight than the one uploaded against,
    // note it but keep the explicit flight association.
    if (matchResult && matchResult.flightId !== flightId && matchResult.confidence === 'high') {
      const matchedFlight = allFlights.rows.find(f => f.id === matchResult.flightId);
      if (matchedFlight) {
        doc.match_note = `Document matched flight ${matchedFlight.flight_number} on ${String(matchedFlight.dep_date).slice(0, 10)}`;
      }
    }

    // If document is validated, check for a deferred payment waiting on this flight
    if (matchStatus === 'matched') {
      const deferredResult = await query(
        `SELECT pending_flight_event_id
         FROM flight_registrations
         WHERE id = $1 AND status = 'awaiting_document' AND pending_flight_event_id IS NOT NULL`,
        [flightId]
      );
      if (deferredResult.rows.length > 0) {
        const { pending_flight_event_id } = deferredResult.rows[0];
        triggerDeferredPayment(flightId, pending_flight_event_id)
          .catch((err) => console.error('[customerPortal] Deferred payment error:', err.message));
      }
    }
  } catch (analysisErr) {
    console.error('[customerPortal] Document analysis error:', analysisErr.message);
    // Don't fail the upload — just return pending status
  }

  return res.status(201).json(doc);
});

// ── POST /api/customer/flights — add a flight to an existing registration ─────
router.post('/flights', requireCustomer, async (req, res) => {
  if (!req.tenant || req.customer.tenant_id !== req.tenant.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    flight_number, carrier_code,
    dep_iata, arr_iata, dep_name, arr_name,
    dep_date, scheduled_dep_time, scheduled_arr_time,
  } = req.body || {};

  if (!flight_number || !dep_date) {
    return res.status(400).json({ error: 'Flight number and departure date are required' });
  }

  const registrationId = req.customer.sub;

  // Enforce minimum hours before departure
  const minHours = req.tenant.min_hours_before_dep || 24;
  const hoursUntil = (new Date(`${dep_date}T00:00:00Z`).getTime() - Date.now()) / 3_600_000;
  if (hoursUntil < minHours) {
    return res.status(422).json({
      error: `Flight must be registered at least ${minHours} hours before departure`,
    });
  }

  // Check registration still active
  const regCheck = await query(
    `SELECT id FROM registrations WHERE id = $1 AND tenant_id = $2 AND status != 'cancelled'`,
    [registrationId, req.tenant.id]
  );
  if (regCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Registration not found' });
  }

  // Prevent duplicates
  const dup = await query(
    `SELECT id FROM flight_registrations
     WHERE registration_id = $1 AND UPPER(flight_number) = UPPER($2) AND dep_date::text LIKE $3 || '%'`,
    [registrationId, flight_number, dep_date]
  );
  if (dup.rows.length > 0) {
    return res.status(409).json({ error: 'This flight is already registered on your account' });
  }

  const result = await query(
    `INSERT INTO flight_registrations
       (registration_id, tenant_id, flight_number, carrier_code,
        dep_iata, dep_name, arr_iata, arr_name,
        dep_date, scheduled_dep_time, scheduled_arr_time, status)
     VALUES ($1,$2,UPPER($3),$4,$5,$6,$7,$8,$9,$10,$11,'active')
     RETURNING id, flight_number, carrier_code, dep_iata, arr_iata, dep_name, arr_name,
               dep_date, scheduled_dep_time, status`,
    [
      registrationId, req.tenant.id,
      flight_number, carrier_code || (flight_number.match(/^[A-Z]{2,3}/i)?.[0].toUpperCase() || ''),
      dep_iata || null, dep_name || null,
      arr_iata || null, arr_name || null,
      dep_date, scheduled_dep_time || null, scheduled_arr_time || null,
    ]
  );

  const fr = result.rows[0];

  // Fire-and-forget OAG subscription
  getOrCreateSubscription(String(fr.flight_number).replace(/[^A-Z0-9]/gi, ''), dep_date)
    .then(subId => {
      if (subId) {
        return query(
          'UPDATE flight_registrations SET flight_subscription_id = $1 WHERE id = $2',
          [subId, fr.id]
        );
      }
    })
    .catch(err => console.warn('[customerPortal] OAG subscription error:', err.message));

  return res.status(201).json({ ...fr, documents: [] });
});

// ── DELETE /api/customer/flights/:flightId — remove a flight registration ─────
router.delete('/flights/:flightId', requireCustomer, async (req, res) => {
  if (!req.tenant || req.customer.tenant_id !== req.tenant.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const flightId       = parseInt(req.params.flightId, 10);
  const registrationId = req.customer.sub;

  if (isNaN(flightId)) return res.status(400).json({ error: 'Invalid flight ID' });

  // Verify ownership; block if already paid out
  const flightCheck = await query(
    `SELECT fr.id, fr.status
     FROM flight_registrations fr
     JOIN registrations r ON r.id = fr.registration_id
     WHERE fr.id = $1 AND r.id = $2 AND r.tenant_id = $3`,
    [flightId, registrationId, req.tenant.id]
  );

  if (flightCheck.rows.length === 0) {
    return res.status(404).json({ error: 'Flight not found' });
  }

  if (flightCheck.rows[0].status === 'paid') {
    return res.status(409).json({ error: 'This flight has already been paid out and cannot be removed' });
  }

  // Delete all child rows that reference this flight_registration (no ON DELETE CASCADE)
  const docs = await query(
    `DELETE FROM registration_documents WHERE flight_registration_id = $1 RETURNING stored_name`,
    [flightId]
  );
  for (const doc of docs.rows) {
    if (blob.isAvailable()) {
      blob.deleteBlob(blob.blobName(registrationId, doc.stored_name));
    } else {
      fs.unlink(path.join(UPLOADS_DIR, String(registrationId), doc.stored_name), () => {});
    }
  }
  // Null out matched_flight_id on docs linked via a different flight_registration
  await query(
    `UPDATE registration_documents SET matched_flight_id = NULL WHERE matched_flight_id = $1`,
    [flightId]
  );
  await query(`DELETE FROM payments               WHERE flight_registration_id = $1`, [flightId]);
  await query(`DELETE FROM notifications           WHERE flight_registration_id = $1`, [flightId]);
  await query(`DELETE FROM document_upload_tokens WHERE flight_registration_id = $1`, [flightId]);
  await query(`DELETE FROM flight_registrations   WHERE id = $1`, [flightId]);

  return res.json({ ok: true });
});

// ── Multer error handler ───────────────────────────────────────────────────────
router.use((err, _req, res, _next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'File too large — maximum size is 10 MB' });
  }
  return res.status(400).json({ error: err.message || 'Upload failed' });
});

module.exports = router;
