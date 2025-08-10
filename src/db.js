import pkg from 'pg';
const { Pool } = pkg;

// Neon: sslmode=require в строке — ок; иначе включим ssl вручную
const ssl = (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('sslmode=require'))
  ? { rejectUnauthorized: false }
  : false;

export const db = new Pool({ connectionString: process.env.DATABASE_URL, ssl });

export async function ensureTables() {
  const client = await db.connect();
  try {
    await client.query(`create table if not exists users (
      id serial primary key,
      vk_id text unique not null,
      first_name text default '',
      last_name text default '',
      avatar text default '',
      balance bigint default 0,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );`);
    await client.query(`create table if not exists events (
      id serial primary key,
      user_id integer references users(id) on delete set null,
      event_type text not null,
      payload jsonb,
      ip text,
      ua text,
      created_at timestamptz default now()
    );`);
  } finally {
    client.release();
  }
}

export async function upsertUser({ vk_id, first_name, last_name, avatar }) {
  const { rows } = await db.query(`
    insert into users (vk_id, first_name, last_name, avatar)
    values ($1, $2, $3, $4)
    on conflict (vk_id) do update set
      first_name = excluded.first_name,
      last_name  = excluded.last_name,
      avatar     = excluded.avatar,
      updated_at = now()
    returning *;
  `, [vk_id, first_name, last_name, avatar]);
  return rows[0];
}

export async function logEvent({ user_id, event_type, payload, ip, ua }) {
  await db.query(
    'insert into events (user_id, event_type, payload, ip, ua) values ($1,$2,$3,$4,$5)',
    [user_id || null, event_type, payload || null, ip || null, ua || null]
  );
}

export async function getUserById(id) {
  const { rows } = await db.query('select * from users where id = $1', [id]);
  return rows[0] || null;
}
