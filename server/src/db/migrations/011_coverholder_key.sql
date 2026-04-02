-- Add coverholder key to tenants for PolicyHub API filtering
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS policy_api_coverholder_key TEXT;
