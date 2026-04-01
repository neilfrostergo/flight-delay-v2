-- Configurable label for the "My Account" portal button, per tenant.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS portal_label VARCHAR(100) DEFAULT 'My Account';
