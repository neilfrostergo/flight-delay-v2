'use strict';

/**
 * Syncs reference data from Snowflake into local PostgreSQL.
 *
 * Tables synced:
 *   MASTER_CARRIER  → ref_carriers
 *   MASTER_LOCATION → ref_airports
 *
 * Run manually:
 *   node src/scripts/syncReferenceData.js
 *
 * Production cron: monthly via CronCreate or a scheduled job.
 *
 * Requires env vars:
 *   SNOWFLAKE_ACCOUNT    e.g. oagnavigation-ergotravel
 *   SNOWFLAKE_USER       your Snowflake username
 *   SNOWFLAKE_PASSWORD   your Snowflake password
 *   SNOWFLAKE_WAREHOUSE  e.g. COMPUTE_WH
 *   SNOWFLAKE_DATABASE   e.g. OAG_DATA
 *   SNOWFLAKE_SCHEMA     e.g. PUBLIC
 */

require('dotenv').config();

const snowflake = require('snowflake-sdk');
const { query, withTransaction } = require('../db/connection');

const sf = {
  account:   process.env.SNOWFLAKE_ACCOUNT,
  username:  process.env.SNOWFLAKE_USER,
  password:  process.env.SNOWFLAKE_PASSWORD,
  warehouse: process.env.SNOWFLAKE_WAREHOUSE,
  database:  process.env.SNOWFLAKE_DATABASE,
  schema:    process.env.SNOWFLAKE_SCHEMA || 'PUBLIC',
};

function validateConfig() {
  const missing = ['SNOWFLAKE_ACCOUNT','SNOWFLAKE_USER','SNOWFLAKE_PASSWORD','SNOWFLAKE_WAREHOUSE','SNOWFLAKE_DATABASE']
    .filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing Snowflake env vars: ${missing.join(', ')}`);
  }
}

function createConnection() {
  return new Promise((resolve, reject) => {
    const conn = snowflake.createConnection(sf);
    conn.connect((err, c) => {
      if (err) {
        console.error('[sync] Connect error details:', err.code, err.message, err.sqlState, err.data);
        reject(err);
      } else {
        resolve(c);
      }
    });
  });
}

function executeQuery(conn, sql) {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      complete: (err, _stmt, rows) => err ? reject(err) : resolve(rows || []),
    });
  });
}

async function syncCarriers(conn) {
  console.log('[sync] Fetching MASTER_CARRIER from Snowflake...');
  const rows = await executeQuery(conn, `
    SELECT
      IATA_CARRIER_CODE,
      ICAO_CARRIER_CODE,
      OAG_CARRIER_CODE,
      COALESCE(CARRIER_NAME, OAG_CARRIER_NAME, IATA_CARRIER_NAME_1) AS CARRIER_NAME,
      IATA_CARRIER_NAME_1,
      CARRIER_ALLIANCE,
      AIRLINE_DOMICILE_COUNTRY,
      DOMICILE_REGION
    FROM MASTER_CARRIER
    WHERE IATA_CARRIER_CODE IS NOT NULL
      AND IATA_CARRIER_CODE != ''
      AND (DUPLICATE_CARRIER_CODE_FLAG IS NULL OR DUPLICATE_CARRIER_CODE_FLAG = FALSE)
  `);

  console.log(`[sync] Got ${rows.length} carriers — upserting into ref_carriers...`);

  let upserted = 0;
  // Batch in chunks of 500
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await withTransaction(async (client) => {
      for (const r of chunk) {
        await client.query(
          `INSERT INTO ref_carriers
             (iata_code, icao_code, oag_code, carrier_name, iata_name, alliance, domicile_country, region, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (iata_code) DO UPDATE SET
             icao_code        = EXCLUDED.icao_code,
             oag_code         = EXCLUDED.oag_code,
             carrier_name     = EXCLUDED.carrier_name,
             iata_name        = EXCLUDED.iata_name,
             alliance         = EXCLUDED.alliance,
             domicile_country = EXCLUDED.domicile_country,
             region           = EXCLUDED.region,
             synced_at        = NOW()`,
          [
            r.IATA_CARRIER_CODE,
            r.ICAO_CARRIER_CODE   || null,
            r.OAG_CARRIER_CODE    || null,
            r.CARRIER_NAME        || null,
            r.IATA_CARRIER_NAME_1 || null,
            r.CARRIER_ALLIANCE    || null,
            r.AIRLINE_DOMICILE_COUNTRY || null,
            r.DOMICILE_REGION     || null,
          ]
        );
        upserted++;
      }
    });
    console.log(`[sync] Carriers: ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }

  console.log(`[sync] Carriers done — ${upserted} upserted`);
}

async function syncAirports(conn) {
  console.log('[sync] Fetching MASTER_LOCATION from Snowflake...');
  const rows = await executeQuery(conn, `
    SELECT
      IATA_AIRPORT_CODE,
      ICAO_LOCATION_CODE,
      COALESCE(IATA_AIRPORT_NAME, OAG_AIRPORT_NAME, ICAO_AIRPORT_NAME) AS AIRPORT_NAME,
      IATA_LOCATION_TYPE,
      IATA_COUNTRY_CODE,
      OAG_COUNTRY_NAME,
      TIME_ZONE_CODE,
      TRY_TO_DECIMAL(LATITUDE, 10, 6)  AS LATITUDE,
      TRY_TO_DECIMAL(LONGITUDE, 10, 6) AS LONGITUDE
    FROM MASTER_LOCATION
    WHERE IATA_AIRPORT_CODE IS NOT NULL
      AND IATA_AIRPORT_CODE != ''
      AND (TERMINAL_CODE = '0' OR TERMINAL_CODE IS NULL)
  `);

  console.log(`[sync] Got ${rows.length} airports — upserting into ref_airports...`);

  // Extract city from the VARIANT column isn't available here (it's raw Snowflake VARIANT).
  // OAG_AIRPORT_NAME often contains city context; we store it and parse at query time.

  let upserted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await withTransaction(async (client) => {
      for (const r of chunk) {
        await client.query(
          `INSERT INTO ref_airports
             (iata_code, icao_code, airport_name, country_code, country_name,
              timezone, location_type, latitude, longitude, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (iata_code) DO UPDATE SET
             icao_code     = EXCLUDED.icao_code,
             airport_name  = EXCLUDED.airport_name,
             country_code  = EXCLUDED.country_code,
             country_name  = EXCLUDED.country_name,
             timezone      = EXCLUDED.timezone,
             location_type = EXCLUDED.location_type,
             latitude      = EXCLUDED.latitude,
             longitude     = EXCLUDED.longitude,
             synced_at     = NOW()`,
          [
            r.IATA_AIRPORT_CODE,
            r.ICAO_LOCATION_CODE || null,
            r.AIRPORT_NAME       || null,
            r.IATA_COUNTRY_CODE  || null,
            r.OAG_COUNTRY_NAME   || null,
            r.TIME_ZONE_CODE     || null,
            r.IATA_LOCATION_TYPE || null,
            r.LATITUDE           != null ? parseFloat(r.LATITUDE)  : null,
            r.LONGITUDE          != null ? parseFloat(r.LONGITUDE) : null,
          ]
        );
        upserted++;
      }
    });
    console.log(`[sync] Airports: ${Math.min(i + 500, rows.length)}/${rows.length}`);
  }

  console.log(`[sync] Airports done — ${upserted} upserted`);
}

async function main() {
  validateConfig();

  console.log(`[sync] Connecting to Snowflake (${sf.account})...`);
  const conn = await createConnection();
  console.log('[sync] Connected');

  // Uncomment to explore available schemas/tables:
  // const dbs = await executeQuery(conn, 'SHOW SCHEMAS IN DATABASE OAG_SCHEDULES');
  // dbs.forEach(r => console.log('[schema]', r.name));
  // const tables = await executeQuery(conn, 'SHOW TABLES IN DATABASE OAG_SCHEDULES');
  // tables.forEach(r => console.log('[table]', r.database_name, r.schema_name, r.name));

  try {
    await syncCarriers(conn);
    await syncAirports(conn);
  } finally {
    conn.destroy((err) => { if (err) console.error('[sync] Error closing Snowflake connection:', err.message); });
  }

  const [cCount, aCount] = await Promise.all([
    query('SELECT COUNT(*) FROM ref_carriers'),
    query('SELECT COUNT(*) FROM ref_airports'),
  ]);
  console.log(`\n[sync] Complete — ${cCount.rows[0].count} carriers, ${aCount.rows[0].count} airports in DB`);
  process.exit(0);
}

main().catch(err => {
  console.error('[sync] Fatal error:', err.message, err.cause?.message || '', err.stack?.split('\n')[1] || '');
  process.exit(1);
});
