-- Migration 003: registration documents
-- Stores uploaded booking confirmations / boarding passes

CREATE TABLE IF NOT EXISTS registration_documents (
  id               SERIAL PRIMARY KEY,
  registration_id  INT NOT NULL REFERENCES registrations(id) ON DELETE CASCADE,
  tenant_id        INT REFERENCES tenants(id),
  original_name    TEXT NOT NULL,
  stored_name      TEXT NOT NULL,           -- UUID filename on disk
  mime_type        TEXT,
  file_size_bytes  INT,
  document_type    TEXT DEFAULT 'booking_confirmation',  -- booking_confirmation | boarding_pass | other
  uploaded_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reg_docs_registration ON registration_documents(registration_id);
