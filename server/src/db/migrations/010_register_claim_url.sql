-- Per-tenant URL for the "Register your claim online" CTA in customer emails.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS register_claim_url VARCHAR(500) DEFAULT NULL;
