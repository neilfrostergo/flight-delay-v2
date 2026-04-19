'use strict';

// HTTP Basic Auth gate — activated only when SITE_BASIC_AUTH is set.
// Format: SITE_BASIC_AUTH=username:password
// Exempts health checks. Use on UAT to prevent public discovery.
module.exports = function siteAuth(req, res, next) {
  const creds = process.env.SITE_BASIC_AUTH;
  if (!creds) return next();

  const [expectedUser, ...rest] = creds.split(':');
  const expectedPass = rest.join(':'); // allow colons in password

  // Exempt health checks so load balancer probes still work
  if (req.path === '/api/health' || req.path === '/health') return next();

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const [user, ...passParts] = decoded.split(':');
    const pass = passParts.join(':');
    if (user === expectedUser && pass === expectedPass) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="DelayedPaid UAT"');
  res.status(401).send('Unauthorized');
};
