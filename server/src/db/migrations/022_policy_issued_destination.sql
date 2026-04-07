-- Add policy issue date and geographic area (destination) to registrations.
-- Both are sourced from the policy API at validation time.

ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS policy_issue_date  DATE,
  ADD COLUMN IF NOT EXISTS geographic_area    VARCHAR(100);
