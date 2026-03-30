'use strict';

const { query } = require('../db/connection');

// Logs all /api/* requests to request_log. Fire-and-forget — never blocks response.
function requestLogger(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim()
      || req.socket?.remoteAddress
      || null;

    query(
      `INSERT INTO request_log (tenant_id, method, path, status, duration_ms, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7)`,
      [
        req.tenant?.id || null,
        req.method,
        req.originalUrl,
        res.statusCode,
        duration,
        ip,
        req.headers['user-agent']?.slice(0, 500) || null,
      ]
    ).catch(err => console.error('[requestLogger] DB write failed:', err.message));
  });

  next();
}

module.exports = requestLogger;
