-- Add scheme name (friendly name from policy API) to registrations.
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS scheme_name VARCHAR(200);
