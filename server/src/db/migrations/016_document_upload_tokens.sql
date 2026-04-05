-- Migration 016: document upload tokens + deferred payment tracking

-- Tokenised links sent to customers when a delay/cancellation is triggered
-- but no validated document exists yet. Token allows portal auto-login
-- direct to the specific flight's upload form.
CREATE TABLE IF NOT EXISTS document_upload_tokens (
  id                     SERIAL PRIMARY KEY,
  token                  CHAR(64) NOT NULL UNIQUE,
  tenant_id              INT NOT NULL REFERENCES tenants(id),
  registration_id        INT NOT NULL REFERENCES registrations(id),
  flight_registration_id INT NOT NULL REFERENCES flight_registrations(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  used_at                TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_doc_upload_tokens_token ON document_upload_tokens(token);
CREATE INDEX IF NOT EXISTS idx_doc_upload_tokens_flight ON document_upload_tokens(flight_registration_id);

-- Track the flight_event that triggered a deferred payment,
-- so we can execute it once a document is validated.
ALTER TABLE flight_registrations
  ADD COLUMN IF NOT EXISTS pending_flight_event_id INT REFERENCES flight_events(id);
