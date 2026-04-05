-- Migration 018: AI document verification results

ALTER TABLE registration_documents
  ADD COLUMN IF NOT EXISTS ai_genuine        BOOLEAN,
  ADD COLUMN IF NOT EXISTS ai_confidence     TEXT,
  ADD COLUMN IF NOT EXISTS ai_passenger_name TEXT,
  ADD COLUMN IF NOT EXISTS ai_reason         TEXT;
