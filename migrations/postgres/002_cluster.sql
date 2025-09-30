-- 002_cluster.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS cluster_id UUID;
ALTER TABLE users ADD COLUMN IF NOT EXISTS primary_user_id BIGINT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'cluster_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS users_cluster_idx ON users (cluster_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'primary_user_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS users_primary_idx ON users (primary_user_id);
  END IF;
END
$$;
