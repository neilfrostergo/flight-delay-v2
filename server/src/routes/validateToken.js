'use strict';

const express = require('express');
const Joi = require('joi');
const { query } = require('../db/connection');
const { validatePolicy } = require('../services/policyValidator');

const router = express.Router();

const schema = Joi.object({
  token: Joi.string().trim().hex().length(64).required(),
});

// POST /api/validate-token
// Consumes a pre-validation token and returns the policy holder details.
router.post('/', async (req, res) => {
  if (!req.tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  // Look up the token
  const tokenResult = await query(
    `SELECT * FROM pre_validation_tokens
     WHERE token = $1 AND tenant_id = $2`,
    [value.token, req.tenant.id]
  );

  const tokenRow = tokenResult.rows[0];

  if (!tokenRow) {
    return res.status(422).json({ error: 'Invalid or expired token' });
  }

  if (tokenRow.used_at) {
    return res.status(422).json({ error: 'This token has already been used' });
  }

  if (new Date(tokenRow.expires_at) < new Date()) {
    return res.status(422).json({ error: 'This token has expired' });
  }

  // Validate the policy (using the email + policy number stored in the token)
  const result = await validatePolicy(req.tenant, tokenRow.policy_number, tokenRow.email);

  if (!result.valid) {
    return res.status(422).json({ error: result.errorMessage || 'Policy validation failed' });
  }

  return res.json({
    valid: true,
    tokenId: tokenRow.id,
    firstName: result.firstName,
    lastName: result.lastName,
    email: tokenRow.email,
    payoutPence: result.payoutPence,
    coverStartDate: result.coverStartDate,
    coverEndDate: result.coverEndDate,
    policyNumber: tokenRow.policy_number,
  });
});

module.exports = router;
