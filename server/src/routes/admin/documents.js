'use strict';

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { query } = require('../../db/connection');
const { adminTenantScope } = require('../../middleware/requireAdmin');
const { triggerDeferredPayment } = require('../../services/delayProcessor');
const blob        = require('../../services/blobStorage');
const { renderFirstPage } = require('../../services/pdfRenderer');

const UPLOADS_DIR = path.join(__dirname, '..', '..', '..', 'uploads');

const router = express.Router();

// Statuses that require a human to look at the document before payment can proceed
const REVIEW_STATUSES = ['pending_ai', 'partial_match', 'no_match', 'unreadable'];

// GET /api/admin/documents?page=1&limit=50&status=pending_ai
router.get('/', async (req, res) => {
  const scope  = adminTenantScope(req);
  const page   = Math.max(1, parseInt(req.query.page  || '1', 10));
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const offset = (page - 1) * limit;

  const params = [];
  const conditions = [];

  // Tenant scoping
  if (scope !== null) { params.push(scope); conditions.push(`d.tenant_id = $${params.length}`); }
  else if (req.query.tenant_id) { params.push(req.query.tenant_id); conditions.push(`d.tenant_id = $${params.length}`); }

  // Status filter — default to all review statuses
  if (req.query.status && REVIEW_STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    conditions.push(`d.match_status = $${params.length}`);
  } else {
    params.push(REVIEW_STATUSES);
    conditions.push(`d.match_status = ANY($${params.length})`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countResult = await query(
    `SELECT COUNT(*) FROM registration_documents d ${where}`,
    params
  );
  const total = parseInt(countResult.rows[0].count, 10);

  params.push(limit, offset);
  const result = await query(
    `SELECT
       d.id,
       d.match_status,
       d.original_name,
       d.mime_type,
       d.file_size_bytes,
       d.parse_method,
       d.parsed_flight_numbers,
       d.parsed_dates,
       d.match_confidence,
       d.ai_genuine,
       d.ai_confidence,
       d.ai_passenger_name,
       d.ai_reason,
       d.uploaded_at,
       d.blob_url,
       r.id                      AS registration_id,
       r.policy_number,
       r.first_name,
       r.last_name,
       r.email,
       tn.id                     AS tenant_id,
       tn.name                   AS tenant_name,
       fr.id                     AS flight_reg_id,
       fr.flight_number,
       fr.dep_date,
       fr.status                 AS flight_status,
       fr.pending_flight_event_id
     FROM registration_documents d
     JOIN registrations r    ON r.id  = d.registration_id
     JOIN tenants tn         ON tn.id = d.tenant_id
     LEFT JOIN flight_registrations fr ON fr.id = COALESCE(d.flight_registration_id, d.matched_flight_id)
     ${where}
     ORDER BY d.uploaded_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return res.json({ total, page, limit, documents: result.rows });
});

// PATCH /api/admin/documents/:id  { action: 'approve' | 'reject' }
router.patch('/:id', async (req, res) => {
  const scope  = adminTenantScope(req);
  const docId  = parseInt(req.params.id, 10);
  const action = req.body?.action;

  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ error: 'action must be approve or reject' });
  }

  // Fetch the document (with tenant scope check)
  const patchParams = [docId, REVIEW_STATUSES];
  let tenantClause = '';
  if (scope !== null) { patchParams.push(scope); tenantClause = `AND d.tenant_id = $${patchParams.length}`; }

  const docResult = await query(
    `SELECT d.id, d.match_status, d.flight_registration_id, d.matched_flight_id,
            fr.status AS flight_status, fr.pending_flight_event_id
     FROM registration_documents d
     LEFT JOIN flight_registrations fr
       ON fr.id = COALESCE(d.flight_registration_id, d.matched_flight_id)
     WHERE d.id = $1 AND d.match_status = ANY($2)
     ${tenantClause}`,
    patchParams
  );

  if (docResult.rows.length === 0) {
    return res.status(404).json({ error: 'Document not found or not awaiting review' });
  }

  const doc     = docResult.rows[0];
  const newStatus = action === 'approve' ? 'matched' : 'rejected';

  await query(
    `UPDATE registration_documents SET match_status = $1 WHERE id = $2`,
    [newStatus, doc.id]
  );

  // If approved and the linked flight is awaiting a document, trigger the deferred payment
  if (action === 'approve'
      && doc.flight_status === 'awaiting_document'
      && doc.pending_flight_event_id) {
    const flightRegId = doc.flight_registration_id || doc.matched_flight_id;
    triggerDeferredPayment(flightRegId, doc.pending_flight_event_id)
      .catch(err => console.error('[admin/documents] triggerDeferredPayment error:', err.message));
  }

  return res.json({ ok: true, match_status: newStatus });
});

// GET /api/admin/documents/:id/content — serve the raw file for inline preview
router.get('/:id/content', async (req, res) => {
  const scope = adminTenantScope(req);
  const docId = parseInt(req.params.id, 10);

  const params = [docId];
  const tenantClause = scope !== null ? `AND d.tenant_id = $2` : '';
  if (scope !== null) params.push(scope);

  const result = await query(
    `SELECT d.registration_id, d.stored_name, d.mime_type
     FROM registration_documents d
     WHERE d.id = $1 ${tenantClause}`,
    params
  );

  if (result.rows.length === 0) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const { registration_id, stored_name, mime_type } = result.rows[0];
  const isPdf = mime_type === 'application/pdf';

  // Fetch the raw file buffer
  let fileBuffer;
  if (blob.isAvailable()) {
    try {
      const blobKey = blob.blobName(registration_id, stored_name);
      fileBuffer = await blob.downloadToBuffer(blobKey);
    } catch (err) {
      console.error('[admin/documents] blob download error:', err.message);
      return res.status(502).json({ error: 'Could not retrieve document' });
    }
  } else {
    const filePath = path.join(UPLOADS_DIR, String(registration_id), stored_name);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }
    fileBuffer = fs.readFileSync(filePath);
  }

  // PDFs: render first page to PNG so no PDF reader required
  if (isPdf) {
    const png = await renderFirstPage(fileBuffer);
    if (png) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Disposition', 'inline');
      return res.send(png);
    }
    // pdftoppm not installed — fall through and serve raw PDF
  }

  res.setHeader('Content-Type', mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', 'inline');
  return res.send(fileBuffer);
});

module.exports = router;
