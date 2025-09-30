-- 001_init.sql
-- Base schema for Postgres deployment (idempotent)

CREATE TABLE IF NOT EXISTS users (
  id               BIGSERIAL PRIMARY KEY,
  provider         TEXT,
  provider_user_id TEXT,
  balance          INTEGER NOT NULL DEFAULT 0,
  cluster_id       UUID,
  primary_user_id  BIGINT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'provider'
  ) THEN
    ALTER TABLE users ADD COLUMN provider TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'provider_user_id'
  ) THEN
    ALTER TABLE users ADD COLUMN provider_user_id TEXT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'balance'
  ) THEN
    ALTER TABLE users ADD COLUMN balance INTEGER NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'cluster_id'
  ) THEN
    ALTER TABLE users ADD COLUMN cluster_id UUID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'primary_user_id'
  ) THEN
    ALTER TABLE users ADD COLUMN primary_user_id BIGINT;
  END IF;
END
$$;

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
