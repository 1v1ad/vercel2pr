-- 003_provider_idx.sql
CREATE INDEX IF NOT EXISTS users_provider_user_idx
ON users (provider, provider_user_id);
