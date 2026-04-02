-- Replace per-tenant policy API URL/key with a FK to shared_api_keys.
-- Superadmin registers PolicyHub (or any policy API) once in shared_api_keys,
-- then each tenant just points to the relevant entry.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS policy_api_key_id INTEGER REFERENCES shared_api_keys(id) ON DELETE SET NULL;

ALTER TABLE tenants
  DROP COLUMN IF EXISTS policy_api_url,
  DROP COLUMN IF EXISTS policy_api_key_enc,
  DROP COLUMN IF EXISTS policy_api_secret_enc;
