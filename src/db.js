import dotenv from 'dotenv';
import pkg from 'pg';
import crypto from 'crypto';

dotenv.config();
const { Pool } = pkg;

const ssl = (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require'))
  ? { rejectUnauthorized: false }
  : false;

export const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

const COOKIE_SECRET   = process.env.COOKIE_SECRET || 'dev_cookie_secret';

/* ───────── Helpers ───────── */
export function hashDeviceId(did) {
  if (!did) return null;
  return crypto.createHash('sha256').update(`${did}|${COOKIE_SECRET}`).digest('hex');
}

/* ───────── Schema ───────── */
export async function ensureTables() {
  const client = await db.connect();
  try {
    await client.query('begin');

    await client.query(`
      create table if not exists users (
        id serial primary key,
        first_name   text,
        last_name    text,
        avatar_url   text,
        balance      integer not null default 0,
        country_code text,
        country_name text,
        created_at   timestamp default now(),
        updated_at   timestamp default now()
      );
    `);
    await client.query(`alter table users add column if not exists country_code text;`);
    await client.query(`alter table users add column if not exists country_name text;`);

    await client.query(`
      create table if not exists events (
        id serial primary key,
        user_id      integer references users(id) on delete set null,
        event_type   text not null,
        payload      jsonb,
        ip           text,
        ua           text,
        country_code text,
        created_at   timestamp default now()
      );
    `);

    await client.query(`
      create table if not exists auth_accounts (
        id serial primary key,
        user_id          integer references users(id) on delete cascade,
        provider         varchar(16) not null,
        provider_user_id varchar(128) not null,
        username         text,
        phone_hash       text,
        meta             jsonb,
        created_at       timestamp default now(),
        unique(provider, provider_user_id)
      );
    `);
    await client.query(`create index if not exists auth_accounts_user_idx on auth_accounts(user_id);`);
    await client.query(`create index if not exists auth_accounts_phone_hash_idx on auth_accounts(phone_hash);`);

    await client.query(`
      create table if not exists device_links (
        id serial primary key,
        device_id_hash text not null unique,
        user_id        integer references users(id) on delete cascade,
        first_seen_at  timestamp default now(),
        last_seen_at   timestamp default now(),
        seen_count     integer not null default 1
      );
    `);

    await client.query(`
      create table if not exists transactions (
        id serial primary key,
        user_id   integer references users(id) on delete cascade,
        type      text    not null,
        amount    integer not null,
        meta      jsonb,
        created_at timestamp default now()
      );
    `);

    await client.query(`
      create or replace function set_updated_at()
      returns trigger as $$
      begin
        new.updated_at = now();
        return new;
      end;
      $$ language plpgsql;
    `);
    await client.query(`
      do $$ begin
        if not exists (select 1 from pg_trigger where tgname = 'users_set_updated_at') then
          create trigger users_set_updated_at
          before update on users
          for each row execute function set_updated_at();
        end if;
      end $$;
    `);

    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

/* ───────── DAO ───────── */
export async function logEvent({ user_id, event_type, payload, ip, ua, country_code }) {
  await db.query(
    `insert into events (user_id, event_type, payload, ip, ua, country_code)
     values ($1,$2,$3,$4,$5,$6)`,
    [user_id || null, event_type, payload || null, ip || null, ua || null, country_code || null]
  );
}

export async function getUserById(id) {
  const { rows } = await db.query('select * from users where id = $1', [id]);
  return rows[0] || null;
}

export async function findUserByAuth(provider, providerUserId) {
  const { rows } = await db.query(
    `select u.* from auth_accounts a
      join users u on u.id = a.user_id
     where a.provider = $1 and a.provider_user_id = $2`,
    [provider, String(providerUserId)]
  );
  return rows[0] || null;
}

export async function findUserIdByDevice(deviceIdHash) {
  const { rows } = await db.query(
    `select user_id from device_links where device_id_hash = $1`,
    [deviceIdHash]
  );
  return rows[0]?.user_id || null;
}

export async function findUserIdByPhoneHash(phash) {
  if (!phash) return null;
  const { rows } = await db.query(
    `select user_id from auth_accounts where phone_hash = $1 limit 1`,
    [phash]
  );
  return rows[0]?.user_id || null;
}

export async function createUser({ first_name, last_name, avatar_url }) {
  const { rows } = await db.query(
    `insert into users (first_name, last_name, avatar_url)
     values ($1,$2,$3) returning *`,
    [first_name || null, last_name || null, avatar_url || null]
  );
  return rows[0];
}

export async function updateUserProfileIfEmpty(userId, { first_name, last_name, avatar_url }) {
  await db.query(
    `update users set
       first_name = coalesce(first_name, $2),
       last_name  = coalesce(last_name,  $3),
       avatar_url = coalesce(avatar_url, $4)
     where id = $1`,
    [userId, first_name || null, last_name || null, avatar_url || null]
  );
}

export async function linkAuthAccount(userId, { provider, provider_user_id, username, phone_hash, meta }) {
  await db.query(
    `insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
         values ($1,$2,$3,$4,$5,$6)
     on conflict (provider, provider_user_id) do update
         set user_id = excluded.user_id,
             username = coalesce(excluded.username, auth_accounts.username),
             phone_hash = coalesce(excluded.phone_hash, auth_accounts.phone_hash),
             meta = coalesce(excluded.meta, auth_accounts.meta)`,
    [userId, provider, String(provider_user_id), username || null, phone_hash || null, meta || null]
  );
}

export async function linkDevice(userId, deviceId) {
  if (!deviceId) return;
  const h = hashDeviceId(deviceId);
  await db.query(
    `insert into device_links (device_id_hash, user_id)
         values ($1,$2)
     on conflict (device_id_hash) do update
         set user_id = excluded.user_id,
             last_seen_at = now(),
             seen_count = device_links.seen_count + 1`,
    [h, userId]
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

export async function mergeUsers(primaryId, secondaryId) {
  if (!primaryId || !secondaryId || primaryId === secondaryId) return primaryId;
  const client = await db.connect();
  try {
    await client.query('begin');

    await client.query(`update auth_accounts set user_id = $1 where user_id = $2`, [primaryId, secondaryId]);
    await client.query(`update device_links set user_id = $1 where user_id = $2`, [primaryId, secondaryId]);
    await client.query(`update transactions set user_id = $1 where user_id = $2`, [primaryId, secondaryId]);

    const { rows } = await client.query(`select balance from users where id = $1`, [secondaryId]);
    const add = rows[0]?.balance || 0;
    if (add) {
      await client.query(`update users set balance = balance + $2 where id = $1`, [primaryId, add]);
    }

    await client.query(`delete from users where id = $1`, [secondaryId]);

    await client.query('commit');
    return primaryId;
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertAndLink({
  provider, provider_user_id, username,
  first_name, last_name, avatar_url,
  phone_hash, device_id
}) {
  let user = await findUserByAuth(provider, provider_user_id);
  let userId = user?.id || null;

  const deviceHash = device_id ? hashDeviceId(device_id) : null;
  const deviceUserId = deviceHash ? await findUserIdByDevice(deviceHash) : null;
  const phoneUserId  = phone_hash ? await findUserIdByPhoneHash(phone_hash) : null;

  if (!userId) {
    if (deviceUserId) userId = deviceUserId;
    else if (phoneUserId) userId = phoneUserId;
    else {
      user = await createUser({ first_name, last_name, avatar_url });
      userId = user.id;
    }
  }

  await linkAuthAccount(userId, { provider, provider_user_id, username, phone_hash, meta: null });
  if (device_id) await linkDevice(userId, device_id);

  // Merge if needed
  const toMerge = [deviceUserId, phoneUserId].filter(Boolean).filter(x => x !== userId);
  let primary = userId;
  for (const other of toMerge) {
    const { rows } = await db.query(
      `select id, created_at from users where id in ($1,$2) order by created_at asc`,
      [primary, other]
    );
    const first  = rows[0]?.id === primary ? primary : other;
    const second = rows[0]?.id === primary ? other   : primary;
    primary = await mergeUsers(first, second);
  }

  // Fill empty profile fields from provider (avatar/name)
  await updateUserProfileIfEmpty(primary, { first_name, last_name, avatar_url });

  const resultUser = await getUserById(primary);
  return resultUser;
}
