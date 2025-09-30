-- 003_provider_idx.sql
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'provider'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'provider_user_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS users_provider_user_idx ON users (provider, provider_user_id);
  END IF;
END
$$;
