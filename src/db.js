import dotenv from 'dotenv';
import pkg from 'pg';
dotenv.config();
const { Pool } = pkg;

// Neon: sslmode=require in connection string
const ssl = (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require'))
  ? { rejectUnauthorized: false }
  : false;

export const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

export async function ensureTables() {
  const client = await db.connect();
  try {
    await client.query(`ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country_code text,
  ADD COLUMN IF NOT EXISTS country_name text;`);

await client.query(`ALTER TABLE events
  ADD COLUMN IF NOT EXISTS country_code text;`);

    await client.query(`create table if not exists users (
      id serial primary key,
      vk_id varchar(64) unique not null,
      first_name text,
      last_name text,
      avatar text,
      balance integer default 0,
      ref_by varchar(64),
      created_at timestamp default now(),
      updated_at timestamp default now()
    );`);

    await client.query(`create table if not exists transactions (
      id serial primary key,
      user_id integer references users(id) on delete cascade,
      type varchar(32) not null,
      amount integer not null,
      meta jsonb,
      created_at timestamp default now()
    );`);

    await client.query(`create table if not exists events (
      id serial primary key,
      user_id integer references users(id) on delete set null,
      event_type varchar(64) not null,
      payload jsonb,
      ip text,        -- text: чтобы не падать на нескольких IP в x-forwarded-for
      ua text,
      created_at timestamp default now()
    );`);
  

// --- Linking tables ---
await client.query(`create table if not exists auth_accounts (
  id serial primary key,
  user_id integer references users(id) on delete cascade,
  provider varchar(16) not null,
  provider_user_id varchar(128) not null,
  username text,
  phone_hash text,
  meta jsonb,
  created_at timestamp default now(),
  updated_at timestamp default now(),
  unique(provider, provider_user_id)
);`);
await client.query('create index if not exists idx_auth_accounts_phone_hash on auth_accounts(phone_hash)');
await client.query(`create table if not exists link_codes (
  id serial primary key,
  user_id integer references users(id) on delete cascade,
  code varchar(16) unique not null,
  expires_at timestamp not null,
  used_at timestamp,
  created_at timestamp default now()
);`);
await client.query(`create table if not exists link_audit (
  id serial primary key,
  primary_id integer,
  merged_id integer,
  method varchar(32),
  source varchar(32),
  ip text,
  ua text,
  details jsonb,
  created_at timestamp default now()
);`);
} finally {
    client.release();
  }
}

export async function upsertUser({ vk_id, first_name, last_name, avatar }) {
  const q = `insert into users (vk_id, first_name, last_name, avatar)
    values ($1,$2,$3,$4)
    on conflict (vk_id) do update set
      first_name = excluded.first_name,
      last_name  = excluded.last_name,
      avatar     = excluded.avatar,
      updated_at = now()
    returning *;`;
  const { rows } = await db.query(q, [vk_id, first_name, last_name, avatar]);
  return rows[0];
}

export async function getUserByVkId(vk_id) {
  const { rows } = await db.query('select * from users where vk_id = $1', [vk_id]);
  return rows[0] || null;
}

export async function getUserById(id) {
  const { rows } = await db.query('select * from users where id = $1', [id]);
  return rows[0] || null;
}

export async function logEvent({ user_id, event_type, payload, ip, ua, country_code }) {
  await db.query(
    'insert into events (user_id, event_type, payload, ip, ua, country_code) values ($1,$2,$3,$4,$5,$6)',
    [user_id || null, event_type, payload || null, ip || null, ua || null, country_code || null]
  );
}


export async function updateUserCountryIfNull(userId, { country_code, country_name }) {
  if (!userId || !country_code) return;
  await db.query(
    `UPDATE users
       SET country_code = COALESCE(country_code, $2),
           country_name = COALESCE(country_name, $3)
     WHERE id = $1`,
    [userId, country_code, country_name || country_code]
  );
}
