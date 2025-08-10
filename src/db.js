import dotenv from 'dotenv';
import pkg from 'pg';
dotenv.config();
const { Pool } = pkg;

const ssl =
  process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require')
    ? { rejectUnauthorized: false }
    : false;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl
});

export async function ensureTables() {
  const client = await db.connect();
  try {
    await client.query(`
      create table if not exists users (
        id serial primary key,
        vk_id varchar(64) unique not null,
        first_name text,
        last_name text,
        avatar text,
        balance integer default 0, -- копейки
        ref_by varchar(64),
        created_at timestamp default now(),
        updated_at timestamp default now()
      );
    `);
    await client.query(`
      create table if not exists transactions (
        id serial primary key,
        user_id integer references users(id) on delete cascade,
        type varchar(32) not null,           -- deposit/withdraw/win/loss/bonus/adjust
        amount integer not null,             -- копейки (+/-)
        meta jsonb,
        created_at timestamp default now()
      );
    `);
    await client.query(`
      create table if not exists events (
        id serial primary key,
        user_id integer references users(id) on delete set null,
        event varchar(64) not null,
        meta jsonb,
        ip inet,
        ua text,
        created_at timestamp default now()
      );
    `);
  } finally {
    client.release();
  }
}

export async function upsertUser({ vk_id, first_name, last_name, avatar }) {
  const q = `
    insert into users (vk_id, first_name, last_name, avatar)
    values ($1,$2,$3,$4)
    on conflict (vk_id) do update set
      first_name = excluded.first_name,
      last_name  = excluded.last_name,
      avatar     = excluded.avatar,
      updated_at = now()
    returning *;
  `;
  const { rows } = await db.query(q, [vk_id, first_name, last_name, avatar]);
  return rows[0];
}

export async function getUserByVkId(vk_id) {
  const { rows } = await db.query('select * from users where vk_id = $1', [vk_id]);
  return rows[0] || null;
}

export async function logEvent(user_id, event, meta = {}, ip = null, ua = '') {
  await db.query(
    'insert into events (user_id, event, meta, ip, ua) values ($1,$2,$3,$4,$5)',
    [user_id, event, meta, ip, ua]
  );
}
