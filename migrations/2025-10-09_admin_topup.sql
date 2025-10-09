alter table if exists events
  add column if not exists amount bigint,
  add column if not exists meta jsonb default '{}'::jsonb;
