-- Migration 013: add policy_type, travelers, cover_summary to registrations
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS policy_type   VARCHAR(50),
  ADD COLUMN IF NOT EXISTS travelers     JSONB,
  ADD COLUMN IF NOT EXISTS cover_summary JSONB;
