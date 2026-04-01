'use strict';

/**
 * Seeds realistic demo data for the demo tenant.
 * Safe to re-run — skips if data already exists.
 */

const { query, withTransaction } = require('./connection');
const { encrypt } = require('../services/encryption');
const bcrypt = require('bcryptjs');

async function main() {
  console.log('[seed:demo] Starting demo data seed…');

  // ── Get demo tenant ───────────────────────────────────────────────────────
  const tenantRes = await query(`SELECT id FROM tenants WHERE slug = 'demo'`);
  if (tenantRes.rows.length === 0) {
    console.error('[seed:demo] Demo tenant not found. Run migrations first.');
    process.exit(1);
  }
  const tenantId = tenantRes.rows[0].id;
  console.log(`[seed:demo] Demo tenant ID: ${tenantId}`);

  // ── Tenant admin user ─────────────────────────────────────────────────────
  const existing = await query(`SELECT id FROM admin_users WHERE username = 'demo-admin'`);
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('demo1234', 10);
    await query(
      `INSERT INTO admin_users (tenant_id, username, email, password_hash, role)
       VALUES ($1, 'demo-admin', 'admin@demo.localhost', $2, 'admin')`,
      [tenantId, hash]
    );
    console.log('[seed:demo] Created tenant admin: demo-admin / demo1234');
  } else {
    console.log('[seed:demo] Tenant admin already exists, skipping');
  }

  // ── Flight alert subscriptions ────────────────────────────────────────────
  const flights = [
    { carrier: 'BA', number: '0123', depDate: '2026-04-10', oagId: 'OAG-BA0123-20260410' },
    { carrier: 'EK', number: '0027', depDate: '2026-04-15', oagId: 'OAG-EK0027-20260415' },
    { carrier: 'FR', number: '1234', depDate: '2026-04-08', oagId: 'OAG-FR1234-20260408' },
    { carrier: 'LH', number: '0902', depDate: '2026-03-28', oagId: 'OAG-LH0902-20260328' }, // tomorrow — active delay
  ];

  const subIds = {};
  for (const f of flights) {
    const res = await query(
      `INSERT INTO flight_alert_subscriptions (carrier_code, flight_number, dep_date, oag_alert_id, status)
       VALUES ($1, $2, $3, $4, 'active')
       ON CONFLICT (carrier_code, flight_number, dep_date) DO UPDATE SET oag_alert_id = EXCLUDED.oag_alert_id
       RETURNING id`,
      [f.carrier, f.number, f.depDate, f.oagId]
    );
    subIds[`${f.carrier}${f.number}`] = res.rows[0].id;
  }
  console.log('[seed:demo] Flight subscriptions ready');

  // ── Registrations ─────────────────────────────────────────────────────────
  const customers = [
    {
      policy: 'POL-001-ACTIVE',
      first: 'Sarah', last: 'Johnson', email: 'sarah.johnson@example.com',
      payout: 15000, coverStart: '2026-01-01', coverEnd: '2026-12-31',
      status: 'active',
      flights: [
        { sub: 'BA0123', number: 'BA0123', carrier: 'BA', dep: 'LHR', depName: 'London Heathrow', arr: 'JFK', arrName: 'New York JFK', date: '2026-04-10', sched: '09:30', arrSched: '12:45' },
        { sub: 'EK0027', number: 'EK0027', carrier: 'EK', dep: 'LHR', depName: 'London Heathrow', arr: 'DXB', arrName: 'Dubai Intl', date: '2026-04-15', sched: '21:15', arrSched: '07:30' },
      ],
    },
    {
      policy: 'POL-002-PAID',
      first: 'James', last: 'Williams', email: 'j.williams@example.com',
      payout: 25000, coverStart: '2026-01-01', coverEnd: '2026-06-30',
      status: 'paid',
      flights: [
        { sub: 'LH0902', number: 'LH0902', carrier: 'LH', dep: 'LHR', depName: 'London Heathrow', arr: 'FRA', arrName: 'Frankfurt', date: '2026-03-28', sched: '07:05', arrSched: '09:55' },
      ],
    },
    {
      policy: 'POL-003-PENDING',
      first: 'Emma', last: 'Davies', email: 'emma.davies@example.com',
      payout: 10000, coverStart: '2026-02-01', coverEnd: '2026-12-31',
      status: 'pending',
      flights: [
        { sub: 'FR1234', number: 'FR1234', carrier: 'FR', dep: 'STN', depName: 'London Stansted', arr: 'BCN', arrName: 'Barcelona El Prat', date: '2026-04-08', sched: '06:25', arrSched: '09:40' },
      ],
    },
    {
      policy: 'POL-004-ACTIVE',
      first: 'Mohammed', last: 'Al-Hassan', email: 'm.alhassan@example.com',
      payout: 20000, coverStart: '2026-01-15', coverEnd: '2026-12-31',
      status: 'active',
      flights: [
        { sub: 'BA0123', number: 'BA0123', carrier: 'BA', dep: 'LHR', depName: 'London Heathrow', arr: 'JFK', arrName: 'New York JFK', date: '2026-04-10', sched: '09:30', arrSched: '12:45' },
      ],
    },
  ];

  const sortCodeEnc = encrypt('200000');
  const accountEnc  = encrypt('12345678');

  for (const c of customers) {
    const existing = await query(
      `SELECT id FROM registrations WHERE tenant_id = $1 AND policy_number = $2`,
      [tenantId, c.policy]
    );
    if (existing.rows.length > 0) {
      console.log(`[seed:demo] Registration ${c.policy} already exists, skipping`);
      continue;
    }

    await withTransaction(async (client) => {
      const regRes = await client.query(
        `INSERT INTO registrations
           (tenant_id, policy_number, first_name, last_name, email, payout_pence,
            cover_start_date, cover_end_date, bank_sort_code_enc, bank_account_enc,
            status, ip_address)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'127.0.0.1')
         RETURNING id`,
        [tenantId, c.policy, c.first, c.last, c.email, c.payout,
         c.coverStart, c.coverEnd, sortCodeEnc, accountEnc, c.status]
      );
      const regId = regRes.rows[0].id;

      for (const f of c.flights) {
        const subId = subIds[f.sub];
        await client.query(
          `INSERT INTO flight_registrations
             (registration_id, tenant_id, flight_number, carrier_code,
              dep_iata, dep_name, arr_iata, arr_name,
              dep_date, scheduled_dep_time, scheduled_arr_time,
              status, flight_subscription_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [regId, tenantId, f.number, f.carrier,
           f.dep, f.depName, f.arr, f.arrName,
           f.date, f.sched, f.arrSched,
           c.status === 'paid' ? 'paid' : 'active',
           subId]
        );
      }
    });
    console.log(`[seed:demo] Created registration: ${c.policy} (${c.first} ${c.last})`);
  }

  // ── Payment for paid registration ─────────────────────────────────────────
  const paidReg = await query(
    `SELECT r.id, fr.id AS fr_id
     FROM registrations r
     JOIN flight_registrations fr ON fr.registration_id = r.id
     WHERE r.tenant_id = $1 AND r.policy_number = 'POL-002-PAID'
     LIMIT 1`,
    [tenantId]
  );

  if (paidReg.rows.length > 0) {
    const { id: regId, fr_id: frId } = paidReg.rows[0];
    const payExists = await query(`SELECT id FROM payments WHERE registration_id = $1`, [regId]);
    if (payExists.rows.length === 0) {
      // Fake flight event
      const evRes = await query(
        `INSERT INTO flight_events (subscription_id, state, delay_minutes, raw_payload, processed_at)
         VALUES ($1, 'Landed', 210, '{"simulated":true}', NOW()) RETURNING id`,
        [subIds['LH0902']]
      );
      const eventId = evRes.rows[0].id;

      await query(
        `INSERT INTO payments
           (tenant_id, registration_id, flight_registration_id, flight_event_id,
            amount_pence, status, modulr_payment_id, modulr_reference)
         VALUES ($1,$2,$3,$4,$5,'paid','STUB-PAY-001','FDP-20260328-001')`,
        [tenantId, regId, frId, eventId, 25000]
      );

      await query(
        `INSERT INTO notifications
           (tenant_id, registration_id, flight_registration_id, channel, recipient,
            subject, status, sent_at)
         VALUES ($1,$2,$3,'email','j.williams@example.com',
                 'Your flight delay payout has been sent','sent',NOW())`,
        [tenantId, regId, frId]
      );
      console.log('[seed:demo] Created payment + notification for POL-002-PAID');
    }
  }

  // ── Pre-validation tokens ─────────────────────────────────────────────────
  const crypto = require('crypto');
  const adminUser = await query(`SELECT id FROM admin_users WHERE username = 'admin'`);
  const adminId = adminUser.rows[0]?.id;

  const tokensToCreate = [
    { policy: 'POL-NEW-001', email: 'new.customer@example.com', days: 7 },
    { policy: 'POL-NEW-002', email: 'another@example.com', days: 3 },
  ];

  for (const t of tokensToCreate) {
    const exists = await query(
      `SELECT id FROM pre_validation_tokens WHERE tenant_id = $1 AND policy_number = $2`,
      [tenantId, t.policy]
    );
    if (exists.rows.length === 0) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + t.days * 24 * 60 * 60 * 1000);
      await query(
        `INSERT INTO pre_validation_tokens (tenant_id, token, policy_number, email, expires_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [tenantId, token, t.policy, t.email, expiresAt, adminId]
      );
      console.log(`[seed:demo] Created token for ${t.policy} → https://demo.localhost/register?token=${token}`);
    }
  }

  console.log('\n[seed:demo] Done! Summary:');
  console.log('  Admin login (superadmin): admin / changeme');
  console.log('  Admin login (tenant):     demo-admin / demo1234');
  console.log('  Registrations: POL-001-ACTIVE, POL-002-PAID, POL-003-PENDING, POL-004-ACTIVE');
  console.log('  Paid flight:   LH0902 (James Williams, £250 payout)');
  console.log('  Pre-val tokens: 2 unused tokens created');

  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
