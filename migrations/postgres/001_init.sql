-- 001_init.sql
-- Base schema for Postgres deployment (idempotent)

CREATE TABLE IF NOT EXISTS users (
  id               BIGSERIAL PRIMARY KEY,
  provider         TEXT        NOT NULL,
  provider_user_id TEXT        NOT NULL,
  name             TEXT,
  avatar           TEXT,
  balance          BIGINT      NOT NULL DEFAULT 0,
  cluster_id       UUID,
  primary_user_id  BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id)
);

CREATE INDEX IF NOT EXISTS users_provider_idx ON users (provider, provider_user_id);

CREATE TABLE IF NOT EXISTS persons (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS person_links (
  person_id        BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  provider         TEXT   NOT NULL,
  provider_user_id TEXT   NOT NULL,
  UNIQUE(provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT,
  type       TEXT    NOT NULL,
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS auth_accounts (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT,
  provider          TEXT    NOT NULL,
  provider_user_id  TEXT    NOT NULL,
  username          TEXT,
  phone_hash        TEXT,
  meta              JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_user_id)
);

CREATE TABLE IF NOT EXISTS link_audit (
  id          BIGSERIAL PRIMARY KEY,
  primary_id  BIGINT,
  merged_id   BIGINT,
  method      TEXT    NOT NULL,
  source      TEXT,
  ip          TEXT,
  ua          TEXT,
  details     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS link_audit_primary_idx ON link_audit (primary_id);
CREATE INDEX IF NOT EXISTS link_audit_merged_idx ON link_audit (merged_id);
