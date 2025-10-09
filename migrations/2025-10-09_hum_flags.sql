alter table if exists users
  add column if not exists merged_via_proof boolean default false,
  add column if not exists hum_id bigint;

update users set hum_id = id where hum_id is null;
