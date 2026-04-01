'use strict';

require('dotenv').config();

const bcrypt = require('bcryptjs');
const { pool, query } = require('./connection');

const DEFAULT_USERNAME = 'admin';
const DEFAULT_EMAIL = 'admin@platform.co.uk';
const SALT_ROUNDS = 12;

async function main() {
  const password = process.env.ADMIN_SEED_PASSWORD;
  if (!password || password.trim() === '') {
    console.error('[seed:admin] ERROR: ADMIN_SEED_PASSWORD environment variable is required.');
    console.error('[seed:admin] Usage: ADMIN_SEED_PASSWORD=yourpassword npm run seed:admin');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('[seed:admin] ERROR: ADMIN_SEED_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  console.log(`[seed:admin] Checking for existing user "${DEFAULT_USERNAME}"...`);

  const existing = await query(
    'SELECT id, username FROM admin_users WHERE username = $1',
    [DEFAULT_USERNAME]
  );

  if (existing.rows.length > 0) {
    console.warn(`[seed:admin] WARNING: Admin user "${DEFAULT_USERNAME}" already exists (id=${existing.rows[0].id}).`);
    console.warn('[seed:admin] No changes made. Use the admin panel to manage users.');
    await pool.end();
    return;
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

  // tenant_id = NULL → superadmin (sees all tenants)
  const result = await query(
    `INSERT INTO admin_users (tenant_id, username, email, password_hash, role, is_active)
     VALUES (NULL, $1, $2, $3, 'superadmin', TRUE)
     RETURNING id, username, email, role`,
    [DEFAULT_USERNAME, DEFAULT_EMAIL, passwordHash]
  );

  const user = result.rows[0];
  console.log('[seed:admin] Created superadmin user:');
  console.log(`  ID:       ${user.id}`);
  console.log(`  Username: ${user.username}`);
  console.log(`  Email:    ${user.email}`);
  console.log(`  Role:     ${user.role}`);
  console.log(`  Tenant:   (none — superadmin)`);
  console.log('');
  console.warn('[seed:admin] IMPORTANT: Change this password immediately after first login!');

  await pool.end();
}

main().catch((err) => {
  console.error('[seed:admin] Fatal error:', err.message);
  process.exit(1);
});
