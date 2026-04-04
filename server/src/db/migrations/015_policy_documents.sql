-- Migration 015: policy document URLs on registrations
-- Stores policy wording, IPID and key facts URLs from the PolicyHub scheme response.
ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS policy_wording_url  TEXT,
  ADD COLUMN IF NOT EXISTS policy_wording_name TEXT,
  ADD COLUMN IF NOT EXISTS ipid_url            TEXT,
  ADD COLUMN IF NOT EXISTS ipid_name           TEXT,
  ADD COLUMN IF NOT EXISTS key_facts_url       TEXT,
  ADD COLUMN IF NOT EXISTS key_facts_name      TEXT;
