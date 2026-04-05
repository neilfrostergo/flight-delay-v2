-- Migration 017: add 'awaiting_document' to flight_registrations status check

ALTER TABLE flight_registrations
  DROP CONSTRAINT IF EXISTS flight_registrations_status_check;

ALTER TABLE flight_registrations
  ADD CONSTRAINT flight_registrations_status_check
  CHECK (status IN ('active', 'paid', 'cancelled', 'awaiting_document'));
