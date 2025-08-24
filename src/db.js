import pkg from 'pg';
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
ADD COLUMN IF NOT EXISTS vk_id text UNIQUE,
ADD COLUMN IF NOT EXISTS first_name text,
ADD COLUMN IF NOT EXISTS last_name text,
ADD COLUMN IF NOT EXISTS avatar text;`);
  } finally {
    client.release();
  }
}

export async function upsertUser({ vk_id, first_name, last_name, avatar }) {
  const sql = `
INSERT INTO users (vk_id, first_name, last_name, avatar)
VALUES ($1,$2,$3,$4)
ON CONFLICT (vk_id) DO UPDATE SET
  first_name = EXCLUDED.first_name,
  last_name  = EXCLUDED.last_name,
  avatar     = EXCLUDED.avatar
RETURNING *;`;
  const { rows } = await db.query(sql, [vk_id, first_name, last_name, avatar]);
  return rows[0];
}

export async function logEvent({ user_id, event_type, payload, ip, ua, country_code }) {
  await db.query(
    'INSERT INTO events (user_id, event_type, payload, ip, ua, country_code) VALUES ($1,$2,$3,$4,$5,$6)',
    [user_id || null, event_type, payload || null, ip || null, ua || null, country_code || null]
  );
}
