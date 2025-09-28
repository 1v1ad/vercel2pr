ALTER TABLE users ADD COLUMN IF NOT EXISTS cluster_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_user_id BIGINT;
CREATE INDEX IF NOT EXISTS users_cluster_idx ON users (cluster_id);
CREATE INDEX IF NOT EXISTS users_primary_idx ON users (primary_user_id);
