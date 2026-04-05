-- Migration 021: one-time tokens for admin account setup and password reset

CREATE TABLE IF NOT EXISTS admin_password_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  token       CHAR(64) NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_pw_tokens_token ON admin_password_tokens(token);
