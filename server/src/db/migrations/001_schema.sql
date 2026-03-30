-- ============================================================
-- flight-delay-v2: core multi-tenant schema
-- All monetary values are integer pence.
-- Encrypted fields use AES-256-GCM: base64iv:base64tag:base64ciphertext
-- ============================================================

-- ============================================================
-- tenants — one row per insurance company/brand
-- ============================================================
CREATE TABLE IF NOT EXISTS tenants (
    id                      SERIAL PRIMARY KEY,
    slug                    VARCHAR(50)  UNIQUE NOT NULL,   -- subdomain key: 'ergo', 'axa'
    name                    VARCHAR(200) NOT NULL,           -- 'ERGO Travel Insurance'
    subdomain               VARCHAR(200) UNIQUE NOT NULL,   -- full host: 'ergo.platform.co.uk'

    -- White-label branding (returned publicly via /api/tenant-config)
    logo_url                TEXT,
    primary_colour          VARCHAR(7)   DEFAULT '#1a56db', -- CSS hex colour
    terms_url               TEXT,
    support_email           VARCHAR(255),

    -- Policy validation API (per-tenant; stubbed until configured)
    policy_api_url          TEXT,
    policy_api_key_enc      TEXT,                           -- AES-256-GCM encrypted bearer token
    policy_api_mode         VARCHAR(10)  DEFAULT 'stub'
                                CHECK (policy_api_mode IN ('stub', 'live')),
    cover_benefit_name      VARCHAR(100) DEFAULT 'Flight Delay', -- name to match in cover[] array

    -- Modulr payment config (per-tenant)
    modulr_account_id       VARCHAR(100),
    modulr_api_key_enc      TEXT,                           -- AES-256-GCM encrypted
    modulr_mode             VARCHAR(10)  DEFAULT 'stub'
                                CHECK (modulr_mode IN ('stub', 'live')),

    -- Behaviour config
    token_ttl_days          INTEGER      DEFAULT 7,         -- pre-validation token TTL
    delay_threshold_minutes INTEGER      DEFAULT 180,       -- minutes before payout triggers (3h)
    min_hours_before_dep    INTEGER      DEFAULT 24,        -- minimum hours before departure to register

    is_active               BOOLEAN      DEFAULT TRUE,
    created_at              TIMESTAMPTZ  DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug      ON tenants (slug);
CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants (subdomain);

-- ============================================================
-- admin_users
-- tenant_id = NULL → superadmin (sees all tenants)
-- tenant_id = FK   → tenant admin (sees own tenant only)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
    id              SERIAL PRIMARY KEY,
    tenant_id       INTEGER      REFERENCES tenants (id) ON DELETE CASCADE,
    username        VARCHAR(100) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   TEXT         NOT NULL,              -- bcrypt, cost 12
    role            VARCHAR(20)  DEFAULT 'admin'
                        CHECK (role IN ('superadmin', 'admin', 'readonly')),
    is_active       BOOLEAN      DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_users_tenant_id ON admin_users (tenant_id);

-- ============================================================
-- registrations
-- One per policy number per tenant. Bank details encrypted.
-- UNIQUE(tenant_id, policy_number) prevents duplicate registrations.
-- ============================================================
CREATE TABLE IF NOT EXISTS registrations (
    id                          SERIAL PRIMARY KEY,
    tenant_id                   INTEGER      NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    -- From policy validation API
    policy_number               VARCHAR(100) NOT NULL,
    first_name                  VARCHAR(100) NOT NULL,
    last_name                   VARCHAR(100) NOT NULL,
    email                       VARCHAR(255) NOT NULL,
    payout_pence                INTEGER      NOT NULL,  -- from cover[].limit * 100
    cover_start_date            DATE,
    cover_end_date              DATE,

    -- Bank details — AES-256-GCM encrypted; NEVER returned in API JSON
    bank_sort_code_enc          TEXT,
    bank_account_enc            TEXT,

    status                      VARCHAR(20)  DEFAULT 'active'
                                    CHECK (status IN ('pending', 'active', 'paid', 'cancelled')),

    pre_validation_token_id     INTEGER,                -- FK added after pre_validation_tokens table
    ip_address                  INET,
    created_at                  TIMESTAMPTZ  DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ  DEFAULT NOW(),

    UNIQUE (tenant_id, policy_number)
);

CREATE INDEX IF NOT EXISTS idx_registrations_tenant_id     ON registrations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_registrations_email         ON registrations (email, tenant_id);
CREATE INDEX IF NOT EXISTS idx_registrations_policy_number ON registrations (policy_number, tenant_id);
CREATE INDEX IF NOT EXISTS idx_registrations_status        ON registrations (status, tenant_id);
CREATE INDEX IF NOT EXISTS idx_registrations_created_at    ON registrations (created_at DESC);

-- ============================================================
-- pre_validation_tokens
-- Generated by admin or insurer; links a policy to a customer email.
-- Customer clicks URL → policy pre-validated without typing policy number.
-- ============================================================
CREATE TABLE IF NOT EXISTS pre_validation_tokens (
    id              SERIAL PRIMARY KEY,
    tenant_id       INTEGER      NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    token           VARCHAR(64)  UNIQUE NOT NULL,       -- crypto-random hex
    policy_number   VARCHAR(100) NOT NULL,
    email           VARCHAR(255) NOT NULL,
    expires_at      TIMESTAMPTZ  NOT NULL,
    used_at         TIMESTAMPTZ,                        -- NULL = not yet consumed
    registration_id INTEGER      REFERENCES registrations (id),
    created_by      INTEGER      REFERENCES admin_users (id),
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pvt_tenant_id ON pre_validation_tokens (tenant_id);
CREATE INDEX IF NOT EXISTS idx_pvt_token     ON pre_validation_tokens (token);
CREATE INDEX IF NOT EXISTS idx_pvt_policy    ON pre_validation_tokens (policy_number, tenant_id);

-- Add FK from registrations back to pre_validation_tokens
ALTER TABLE registrations
    ADD CONSTRAINT fk_registrations_token
    FOREIGN KEY (pre_validation_token_id) REFERENCES pre_validation_tokens (id);

-- ============================================================
-- flight_alert_subscriptions
-- Global/shared across all tenants — one OAG subscription per unique
-- carrier+flight+date combination. Multiple flight_registrations (across
-- all tenants) share one subscription row to avoid duplicate OAG alerts.
-- ============================================================
CREATE TABLE IF NOT EXISTS flight_alert_subscriptions (
    id              SERIAL PRIMARY KEY,
    carrier_code    VARCHAR(10)  NOT NULL,
    flight_number   VARCHAR(10)  NOT NULL,
    dep_date        DATE         NOT NULL,
    oag_alert_id    VARCHAR(255),                       -- NULL in stub/POC mode
    status          VARCHAR(20)  DEFAULT 'active'
                        CHECK (status IN ('active', 'completed', 'cancelled')),
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW(),
    UNIQUE (carrier_code, flight_number, dep_date)
);

CREATE INDEX IF NOT EXISTS idx_fas_dep_date ON flight_alert_subscriptions (dep_date);
CREATE INDEX IF NOT EXISTS idx_fas_status   ON flight_alert_subscriptions (status);

-- ============================================================
-- flight_registrations
-- One per flight per registration. Many flights per registration.
-- ============================================================
CREATE TABLE IF NOT EXISTS flight_registrations (
    id                      SERIAL PRIMARY KEY,
    registration_id         INTEGER      NOT NULL REFERENCES registrations (id) ON DELETE CASCADE,
    tenant_id               INTEGER      NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,

    -- Flight details (from OAG lookup at registration time)
    flight_number           VARCHAR(20)  NOT NULL,      -- 'BA249'
    carrier_code            VARCHAR(10)  NOT NULL,      -- 'BA'
    dep_iata                VARCHAR(10),
    dep_name                VARCHAR(255),
    arr_iata                VARCHAR(10),
    arr_name                VARCHAR(255),
    dep_date                DATE         NOT NULL,
    scheduled_dep_time      VARCHAR(10),                -- local HH:MM
    scheduled_arr_time      VARCHAR(10),

    status                  VARCHAR(20)  DEFAULT 'active'
                                CHECK (status IN ('active', 'paid', 'cancelled')),

    flight_subscription_id  INTEGER      REFERENCES flight_alert_subscriptions (id),

    created_at              TIMESTAMPTZ  DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fr_registration_id ON flight_registrations (registration_id);
CREATE INDEX IF NOT EXISTS idx_fr_tenant_id        ON flight_registrations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_fr_dep_date         ON flight_registrations (dep_date);
CREATE INDEX IF NOT EXISTS idx_fr_subscription_id  ON flight_registrations (flight_subscription_id);
CREATE INDEX IF NOT EXISTS idx_fr_status           ON flight_registrations (status, tenant_id);

-- ============================================================
-- flight_events — append-only OAG event log (identical to v1)
-- ============================================================
CREATE TABLE IF NOT EXISTS flight_events (
    id              SERIAL PRIMARY KEY,
    subscription_id INTEGER      NOT NULL REFERENCES flight_alert_subscriptions (id),
    state           VARCHAR(50)  NOT NULL,   -- OutGate | InAir | Landed | InGate | Canceled
    delay_minutes   INTEGER      DEFAULT 0,
    raw_payload     JSONB,
    processed_at    TIMESTAMPTZ,             -- NULL = unprocessed
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flight_events_unprocessed
    ON flight_events (created_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_flight_events_subscription_id
    ON flight_events (subscription_id);

-- ============================================================
-- payments — one payout attempt per flight_registration
-- ============================================================
CREATE TABLE IF NOT EXISTS payments (
    id                      SERIAL PRIMARY KEY,
    tenant_id               INTEGER      NOT NULL REFERENCES tenants (id),
    registration_id         INTEGER      NOT NULL REFERENCES registrations (id),
    flight_registration_id  INTEGER      NOT NULL REFERENCES flight_registrations (id),
    flight_event_id         INTEGER      REFERENCES flight_events (id),

    amount_pence            INTEGER      NOT NULL,
    status                  VARCHAR(20)  DEFAULT 'pending'
                                CHECK (status IN ('pending', 'processing', 'paid', 'failed')),

    -- Modulr response fields
    modulr_payment_id       VARCHAR(100),
    modulr_reference        VARCHAR(50),
    failure_reason          TEXT,

    created_at              TIMESTAMPTZ  DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_tenant_id        ON payments (tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_registration_id  ON payments (registration_id);
CREATE INDEX IF NOT EXISTS idx_payments_fr_id            ON payments (flight_registration_id);
CREATE INDEX IF NOT EXISTS idx_payments_status           ON payments (status, tenant_id);
CREATE INDEX IF NOT EXISTS idx_payments_created_at       ON payments (created_at DESC);

-- ============================================================
-- notifications — email log (extended from v1)
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
    id                      SERIAL PRIMARY KEY,
    tenant_id               INTEGER      REFERENCES tenants (id),
    registration_id         INTEGER      REFERENCES registrations (id),
    flight_registration_id  INTEGER      REFERENCES flight_registrations (id),
    flight_event_id         INTEGER      REFERENCES flight_events (id),
    payment_id              INTEGER      REFERENCES payments (id),
    channel                 VARCHAR(20)  DEFAULT 'email',
    recipient               VARCHAR(255) NOT NULL,
    subject                 TEXT,
    status                  VARCHAR(20)  DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sent', 'failed')),
    error_message           TEXT,
    sent_at                 TIMESTAMPTZ,
    created_at              TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_id       ON notifications (tenant_id);
CREATE INDEX IF NOT EXISTS idx_notifications_registration_id ON notifications (registration_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at      ON notifications (created_at DESC);

-- ============================================================
-- shared_api_keys — superadmin only (OAG key lives here)
-- ============================================================
CREATE TABLE IF NOT EXISTS shared_api_keys (
    id              SERIAL PRIMARY KEY,
    service_name    VARCHAR(100) NOT NULL,
    display_name    VARCHAR(100) NOT NULL,
    key_enc         TEXT         NOT NULL,  -- AES-256-GCM encrypted
    endpoint_url    VARCHAR(500),
    is_active       BOOLEAN      DEFAULT TRUE,
    notes           TEXT,
    created_at      TIMESTAMPTZ  DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  DEFAULT NOW()
);

-- ============================================================
-- audit_log — admin action trail (scoped by tenant_id)
-- NULL tenant_id = superadmin action
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_log (
    id              SERIAL PRIMARY KEY,
    tenant_id       INTEGER      REFERENCES tenants (id),
    admin_user_id   INTEGER      REFERENCES admin_users (id),
    action          VARCHAR(100) NOT NULL,
    entity_type     VARCHAR(50),
    entity_id       TEXT,
    details         JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_id   ON audit_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_admin_user  ON audit_log (admin_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at  ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action      ON audit_log (action);

-- ============================================================
-- request_log — HTTP audit trail (adds tenant_id vs v1)
-- ============================================================
CREATE TABLE IF NOT EXISTS request_log (
    id          SERIAL PRIMARY KEY,
    tenant_id   INTEGER      REFERENCES tenants (id),
    method      VARCHAR(10)  NOT NULL,
    path        TEXT         NOT NULL,
    status      INTEGER,
    duration_ms INTEGER,
    ip_address  INET,
    user_agent  TEXT,
    created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_request_log_created_at ON request_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_log_tenant_id  ON request_log (tenant_id);
CREATE INDEX IF NOT EXISTS idx_request_log_status     ON request_log (status);
