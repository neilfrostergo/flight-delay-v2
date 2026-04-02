'use strict';

const express = require('express');
const Joi = require('joi');
const { validatePolicy } = require('../services/policyValidator');

const router = express.Router();

const schema = Joi.object({
  policy_number: Joi.string().trim().min(1).max(100).required(),
  email: Joi.string().trim().email().max(255).required(),
});

// POST /api/validate-policy
router.post('/', async (req, res) => {
  if (!req.tenant) {
    return res.status(404).json({ error: 'Tenant not found' });
  }

  const { error, value } = schema.validate(req.body);
  if (error) {
    return res.status(400).json({ error: error.details[0].message });
  }

  const result = await validatePolicy(req.tenant, value.policy_number, value.email);

  if (!result.valid) {
    return res.status(422).json({ error: result.errorMessage || 'Policy validation failed' });
  }

  return res.json({
    valid: true,
    firstName: result.firstName,
    lastName: result.lastName,
    policyType: result.policyType || 'single_trip',
    travelers: result.travelers || [{ firstName: result.firstName, lastName: result.lastName }],
    payoutPence: result.payoutPence,
    coverStartDate: result.coverStartDate,
    coverEndDate: result.coverEndDate,
    coverSummary: result.coverSummary || null,
    policyNumber: value.policy_number,
  });
});

module.exports = router;
