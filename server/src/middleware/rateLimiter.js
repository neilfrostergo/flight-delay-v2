'use strict';

const rateLimit = require('express-rate-limit');

const isDev = process.env.NODE_ENV !== 'production';

// In development, use a permissive no-op limiter so testing isn't blocked
const devLimiter = rateLimit({ windowMs: 1000, max: 10000, standardHeaders: false, legacyHeaders: false });

// Public registration + flight lookup: 20 requests per 15 minutes per IP
const registrationLimiter = isDev ? devLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later' },
});

// Policy validation + token: 10 per 15 minutes per IP
const validateLimiter = isDev ? devLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — please try again later' },
});

// Admin login: 10 attempts per 15 minutes per IP
const loginLimiter = isDev ? devLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts — please try again later' },
});

module.exports = { registrationLimiter, validateLimiter, loginLimiter };
