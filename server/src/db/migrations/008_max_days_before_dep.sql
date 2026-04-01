-- Migration 008: per-tenant max days before departure (superadmin-only setting)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_days_before_dep INTEGER DEFAULT 40;
