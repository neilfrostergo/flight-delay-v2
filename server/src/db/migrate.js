'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const { pool, query } = require('./connection');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS migrations_run (
      id          SERIAL PRIMARY KEY,
      filename    VARCHAR(255) UNIQUE NOT NULL,
      run_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getRunMigrations() {
  const result = await query('SELECT filename FROM migrations_run ORDER BY filename');
  return new Set(result.rows.map((r) => r.filename));
}

async function runMigration(filename, sql) {
  console.log(`[migrate] Running: ${filename}`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO migrations_run (filename) VALUES ($1)', [filename]);
    await client.query('COMMIT');
    console.log(`[migrate] Completed: ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  console.log('[migrate] Starting migrations...');

  await ensureMigrationsTable();
  const ran = await getRunMigrations();

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let count = 0;
  for (const file of files) {
    if (ran.has(file)) {
      console.log(`[migrate] Skipping (already run): ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await runMigration(file, sql);
    count++;
  }

  if (count === 0) {
    console.log('[migrate] No new migrations to run.');
  } else {
    console.log(`[migrate] ${count} migration(s) applied successfully.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[migrate] Fatal error:', err.message);
  process.exit(1);
});
