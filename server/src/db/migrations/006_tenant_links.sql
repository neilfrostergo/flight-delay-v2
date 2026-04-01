-- Migration 006: add configurable links to tenants

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS claim_url      VARCHAR(500),
  ADD COLUMN IF NOT EXISTS my_account_url VARCHAR(500);
