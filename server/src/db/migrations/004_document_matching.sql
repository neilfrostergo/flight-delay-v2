-- Migration 004: document analysis and flight matching columns

ALTER TABLE registration_documents
  ADD COLUMN IF NOT EXISTS flight_registration_id INT REFERENCES flight_registrations(id),
  ADD COLUMN IF NOT EXISTS parse_method           TEXT,
  ADD COLUMN IF NOT EXISTS parsed_flight_numbers  TEXT[],
  ADD COLUMN IF NOT EXISTS parsed_dates           TEXT[],
  ADD COLUMN IF NOT EXISTS matched_flight_id      INT REFERENCES flight_registrations(id),
  ADD COLUMN IF NOT EXISTS match_confidence       TEXT,
  ADD COLUMN IF NOT EXISTS match_status           TEXT NOT NULL DEFAULT 'pending';

CREATE INDEX IF NOT EXISTS idx_reg_docs_flight ON registration_documents(flight_registration_id);
