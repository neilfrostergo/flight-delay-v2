-- Migration 007: add policy_api_secret_enc for OAuth2 password flow
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS policy_api_secret_enc VARCHAR(1000);
