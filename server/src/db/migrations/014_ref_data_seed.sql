-- Migration 014: ref data seed
-- Data is now loaded via: npm run seed:ref-data
-- (Uses src/scripts/seedRefData.js + src/data/ref_airports.csv / ref_carriers.csv)
-- This migration is intentionally empty so existing DBs that already ran it are unaffected.
SELECT 1;
