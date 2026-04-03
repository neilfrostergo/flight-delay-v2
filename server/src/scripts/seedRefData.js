'use strict';

/**
 * Seeds ref_airports and ref_carriers from local CSV files.
 *
 * Safe to run on any environment — skips tables that already have data.
 * Use --force to truncate and reload (dev only).
 *
 * Run:
 *   node src/scripts/seedRefData.js
 *   node src/scripts/seedRefData.js --force
 *
 * Source data:
 *   src/data/ref_airports.csv  (from Snowflake MASTER_LOCATION dump)
 *   src/data/ref_carriers.csv  (from Snowflake MASTER_CARRIER dump)
 *
 * For production reference data use the Snowflake sync job instead.
 */

require('dotenv').config();

const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function query(sql, params) {
  const client = await pool.connect();
  try { return await client.query(sql, params); }
  finally { client.release(); }
}

const FORCE  = process.argv.includes('--force');
const DATA   = path.join(__dirname, '..', 'data');
const BATCH  = 500; // rows per INSERT statement

// ── CSV parser ───────────────────────────────────────────────────────────────
// Handles quoted fields, escaped double-quotes, empty fields (NULL).

function parseCsv(filepath) {
  const text  = fs.readFileSync(filepath, 'utf8');
  const lines = text.split('\n').filter(l => l.trim());

  function parseLine(line) {
    const fields = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        i++;
        let val = '';
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
          else if (line[i] === '"')                   { i++; break; }
          else                                         { val += line[i++]; }
        }
        fields.push(val);
      } else {
        let val = '';
        while (i < line.length && line[i] !== ',') val += line[i++];
        fields.push(val === '' ? null : val);
      }
      if (line[i] === ',') i++;
    }
    return fields;
  }

  const headers = parseLine(lines[0]);
  return {
    headers,
    rows: lines.slice(1).map(l => {
      const vals = parseLine(l);
      const obj  = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || null; });
      return obj;
    }),
  };
}

// ── Batched upsert ───────────────────────────────────────────────────────────

async function upsertBatch(table, columns, conflictCol, rows) {
  // synced_at is always set to NOW() — exclude from column list, handle separately
  const dataColumns = columns.filter(c => c !== 'synced_at');
  const colList = [...dataColumns, 'synced_at'].join(', ');
  const setCols = dataColumns.filter(c => c !== conflictCol)
    .map(c => `${c} = EXCLUDED.${c}`).join(', ');

  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk   = rows.slice(i, i + BATCH);
    const values  = [];
    const placeholders = chunk.map((row, rowIdx) => {
      const start = rowIdx * dataColumns.length + 1;
      dataColumns.forEach(col => values.push(row[col] ?? null));
      return '(' + dataColumns.map((_, ci) => `$${start + ci}`).join(', ') + ', NOW())';
    });

    await query(
      `INSERT INTO ${table} (${colList})
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (${conflictCol}) DO UPDATE SET ${setCols}, synced_at = NOW()`,
      values
    );
    upserted += chunk.length;
    process.stdout.write(`\r[seed] ${table}: ${upserted}/${rows.length}`);
  }
  console.log('');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (FORCE) {
    console.log('[seed] --force: truncating ref tables…');
    await query('TRUNCATE ref_airports, ref_carriers RESTART IDENTITY CASCADE');
  } else {
    // Skip if already populated
    const [{ rows: [{ count: ac }] }, { rows: [{ count: cc }] }] = await Promise.all([
      query('SELECT COUNT(*) FROM ref_airports'),
      query('SELECT COUNT(*) FROM ref_carriers'),
    ]);
    if (parseInt(ac) > 0 && parseInt(cc) > 0) {
      console.log(`[seed] Tables already populated (${ac} airports, ${cc} carriers) — skipping.`);
      console.log('[seed] Use --force to reload.');
      await pool.end();
      return;
    }
  }

  console.log('[seed] Loading ref_airports from CSV…');
  const { rows: airportRows } = parseCsv(path.join(DATA, 'ref_airports.csv'));
  await upsertBatch('ref_airports', [
    'iata_code', 'icao_code', 'airport_name', 'city',
    'country_code', 'country_name', 'latitude', 'longitude',
    'timezone', 'location_type',
  ], 'iata_code', airportRows);

  console.log('[seed] Loading ref_carriers from CSV…');
  const { rows: carrierRows } = parseCsv(path.join(DATA, 'ref_carriers.csv'));
  await upsertBatch('ref_carriers', [
    'iata_code', 'icao_code', 'oag_code', 'carrier_name',
    'iata_name', 'alliance', 'domicile_country', 'region',
  ], 'iata_code', carrierRows);

  const [{ rows: [{ count: ac }] }, { rows: [{ count: cc }] }] = await Promise.all([
    query('SELECT COUNT(*) FROM ref_airports'),
    query('SELECT COUNT(*) FROM ref_carriers'),
  ]);
  console.log(`\n[seed] Done — ${ac} airports, ${cc} carriers in DB`);
  await pool.end();
}

main().catch(async err => {
  console.error('[seed] Fatal:', err.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
