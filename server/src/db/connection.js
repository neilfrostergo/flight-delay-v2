'use strict';

const { Pool, types } = require('pg');
const config = require('../config');

// Return DATE columns as ISO strings (e.g. "2026-04-28") rather than Date objects.
// Without this, String(dateCol).slice(0,10) gives "Mon Apr 28" not "2026-04-28".
types.setTypeParser(1082, v => v);

const pool = new Pool({
  connectionString: config.db.url,
  ssl: config.isProduction ? { rejectUnauthorized: true } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('connect', () => {
  if (process.env._PG_CONNECTED !== '1') {
    process.env._PG_CONNECTED = '1';
    console.log('[db] Connected to PostgreSQL');
  }
});

pool.on('error', (err) => {
  console.error('[db] Unexpected pool error:', err.message);
});

async function query(sql, params) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
