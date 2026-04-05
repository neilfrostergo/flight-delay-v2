-- Migration 020: click tracking for pre-validation tokens (funnel analytics)

ALTER TABLE pre_validation_tokens
  ADD COLUMN IF NOT EXISTS clicked_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_clicked_at TIMESTAMPTZ;
