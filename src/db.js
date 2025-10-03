import dotenv from 'dotenv';
import postgres from 'postgres';
dotenv.config();

// --- Настройка SSL для Neon/Render ---
const needSSL = process.env.DATABASE_URL && /sslmode=require|neon/i.test(process.env.DATABASE_URL);
const ssl = needSSL ? { rejectUnauthorized: false } : undefined;

// Единый клиент (аналог Pool)
const sql = postgres(process.env.DATABASE_URL, {
  ssl,
  max: 10,
  idle_timeout: 30,
  connect_timeout: 30
});

// Адаптер в стиль node-postgres Pool
export const db = {
  async query(text, params = []) {
    const rows = await sql.unsafe(text, params);
    return { rows };
  },
  async connect() {
    return {
      query: (t, p) => db.query(t, p),
      release: () => {}
    };
  },
  async end() { await sql.end(); }
};

// --- Инициализация схемы (оставляем твою логику) ---
export async function ensureTables() {
  // безопасные ALTER'ы
  await db.query(`alter table if exists users
    add column if not exists country_code text,
    add column if not exists country_name text,
    add column if not exists meta jsonb default '{}'::jsonb;`);

  await db.query(`alter table if exists events
    add column if not exists country_code text;`);

  // таблицы
  await db.query(`create table if not exists users (
    id serial primary key,
    vk_id varchar(64) unique not null,
    first_name text,
    last_name text,
    avatar text,
    balance integer default 0,
    ref_by varchar(64),
    meta jsonb default '{}'::jsonb,
    created_at timestamp default now(),
    updated_at timestamp default now()
  );`);

  await db.query(`create table if not exists transactions (
    id serial primary key,
    user_id integer references users(id) on delete cascade,
    type varchar(32) not null,
    amount integer not null,
    meta jsonb,
    created_at timestamp default now()
  );`);

  await db.query(`create table if not exists events (
    id serial primary key,
    user_id integer references users(id) on delete set null,
    event_type varchar(64) not null,
    payload jsonb,
    ip text,
    ua text,
    created_at timestamp default now()
  );`);

  await db.query(`create table if not exists auth_accounts (
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

  // индексы (idempotent)
  await db.query(`create index if not exists events_created_at on events(created_at);`);
  await db.query(`create index if not exists idx_auth_accounts_phone_hash on auth_accounts(phone_hash);`);
  await db.query(`create index if not exists auth_accounts_provider_user on auth_accounts(provider, provider_user_id);`);
  await db.query(`create index if not exists auth_accounts_device on auth_accounts ((meta->>'device_id'));`);
  await db.query(`create index if not exists users_merged_into on users (((meta->>'merged_into')::int));`);

  await db.query(`create table if not exists link_codes (
    id serial primary key,
    user_id integer references users(id) on delete cascade,
    code varchar(16) unique not null,
    expires_at timestamp not null,
    used_at timestamp,
    created_at timestamp default now()
  );`);

  await db.query(`create table if not exists admin_topups (
    id serial primary key,
    admin_name text,
    admin_ip text,
    ua text,
    user_id integer references users(id) on delete set null,
    amount integer not null,
    reason text not null,
    headers jsonb,
    created_at timestamp default now()
  );`);

  await db.query(`create table if not exists link_audit (
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
}

// Нужна в авторизации VK/TG
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
