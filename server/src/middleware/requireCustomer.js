'use strict';

const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * Verify a customer JWT (type: 'customer').
 * Attaches { sub: registrationId, tenant_id, type } to req.customer.
 */
module.exports = function requireCustomer(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Please log in to access your policy' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), config.jwt.secret);
    if (decoded.type !== 'customer') {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.customer = decoded; // { sub: registrationId, tenant_id, type: 'customer' }
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Session expired — please log in again' });
  }
};
