import dotenv from 'dotenv';
import pkg from 'pg';
dotenv.config();
const { Pool } = pkg;

// Neon требует SSL. Если в строке есть sslmode=require — включаем tls.
const ssl =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false;

export const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

export async function ensureTables() {
  const client = await db.connect();
  try {
    // ── users
    await client.query(`
      create table if not exists users (
        id           serial primary key,
        vk_id        text unique not null,
        first_name   text,
        last_name    text,
        avatar       text,
        balance      integer default 0,
        ref_by       text,
        country_code char(2),
        country_name text,
        created_at   timestamp default now(),
        updated_at   timestamp default now()
      );
    `);

    // ── transactions
    await client.query(`
      create table if not exists transactions (
        id        serial primary key,
        user_id   integer references users(id) on delete cascade,
        type      varchar(32) not null,
        amount    integer not null,
        meta      jsonb,
        created_at timestamp default now()
      );
    `);

    // ── events
    await client.query(`
      create table if not exists events (
        id          serial primary key,
        user_id     integer,
        event_type  text,
        payload     jsonb,
        ip          text,
        ua          text,
        country_code char(2),
        created_at  timestamp default now()
      );
    `);
    await client.query(`create index if not exists idx_events_user on events(user_id);`);

    // ── auth_accounts: связки провайдеров (vk/tg/…)
    await client.query(`
      create table if not exists auth_accounts (
        id                serial primary key,
        user_id           integer references users(id) on delete cascade,
        provider          varchar(16) not null,
        provider_user_id  varchar(128) not null,
        username          text,
        phone_hash        text,
        meta              jsonb,
        created_at        timestamp default now(),
        updated_at        timestamp default now(),
        unique(provider, provider_user_id)
      );
    `);
    await client.query(`create index if not exists idx_auth_accounts_phone_hash on auth_accounts(phone_hash);`);

    // ── link_codes: коды LINK-XXXX
    await client.query(`
      create table if not exists link_codes (
        id         serial primary key,
        user_id    integer references users(id) on delete cascade,
        code       varchar(16) unique not null,
        expires_at timestamp not null,
        used_at    timestamp,
        created_at timestamp default now()
      );
    `);

    // ── link_audit: журнал склеек
    await client.query(`
      create table if not exists link_audit (
        id          serial primary key,
        primary_id  integer,
        merged_id   integer,
        method      varchar(32),
        source      varchar(32),
        ip          text,
        ua          text,
        details     jsonb,
        created_at  timestamp default now()
      );
    `);
  } finally {
    client.release();
  }
}

// Создаёт/обновляет пользователя по уникальному vk_id (мы кладём туда и tg:123 для TG)
export async function upsertUser({ vk_id, first_name, last_name, avatar }) {
  const q = `
    insert into users (vk_id, first_name, last_name, avatar)
    values ($1,$2,$3,$4)
    on conflict (vk_id) do update set
      first_name = coalesce(excluded.first_name, users.first_name),
      last_name  = coalesce(excluded.last_name,  users.last_name),
      avatar     = coalesce(excluded.avatar,     users.avatar),
      updated_at = now()
    returning *;
  `;
  const { rows } = await db.query(q, [vk_id, first_name || null, last_name || null, avatar || null]);
  return rows[0];
}

export async function getUserById(id) {
  const { rows } = await db.query(`select * from users where id = $1`, [id]);
  return rows[0] || null;
}

export async function ensureAuthAccount({ user_id, provider, provider_user_id, username = null, meta = null }) {
  if (!user_id || !provider || !provider_user_id) return;
  await db.query(
    `insert into auth_accounts (user_id, provider, provider_user_id, username, meta)
     values ($1,$2,$3,$4,$5)
     on conflict (provider, provider_user_id) do update set
       user_id = excluded.user_id,
       username = coalesce(excluded.username, auth_accounts.username),
       meta = coalesce(excluded.meta, auth_accounts.meta),
       updated_at = now()`,
    [user_id, provider, String(provider_user_id), username, meta]
  );
}

export async function logEvent({ user_id, event_type, payload, ip, ua, country_code }) {
  await db.query(
    `insert into events (user_id, event_type, payload, ip, ua, country_code)
     values ($1,$2,$3,$4,$5,$6)`,
    [user_id || null, event_type, payload || null, ip || null, ua || null, country_code || null]
  );
}

export async function updateUserCountryIfNull(userId, { country_code, country_name }) {
  if (!userId || !country_code) return;
  await db.query(
    `update users
       set country_code = coalesce(country_code, $2),
           country_name = coalesce(country_name, $3)
     where id = $1`,
    [userId, country_code, country_name || country_code]
  );
}
