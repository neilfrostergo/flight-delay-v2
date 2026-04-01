-- Migration 005: reference data tables (airports and carriers from Snowflake)

CREATE TABLE IF NOT EXISTS ref_airports (
  iata_code        VARCHAR(10)  PRIMARY KEY,
  icao_code        VARCHAR(10),
  airport_name     TEXT,
  city             TEXT,
  country_code     VARCHAR(10),
  country_name     TEXT,
  latitude         NUMERIC(10,6),
  longitude        NUMERIC(10,6),
  timezone         TEXT,
  location_type    TEXT,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ref_carriers (
  iata_code        VARCHAR(10)  PRIMARY KEY,
  icao_code        VARCHAR(10),
  oag_code         VARCHAR(10),
  carrier_name     TEXT,
  iata_name        TEXT,
  alliance         TEXT,
  domicile_country TEXT,
  region           TEXT,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ref_airports_search_idx ON ref_airports
  USING gin(to_tsvector('english', coalesce(iata_code,'') || ' ' || coalesce(airport_name,'') || ' ' || coalesce(city,'')));
