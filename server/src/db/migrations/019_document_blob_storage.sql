-- Migration 019: blob storage URL for claim documents

ALTER TABLE registration_documents
  ADD COLUMN IF NOT EXISTS blob_url TEXT;
