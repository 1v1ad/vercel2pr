// vercel2pr/src/db.js
import pkg from 'pg';
const { Pool } = pkg;

const connectionString =
  process.env.DATABASE_URL ||
  process.env.PG_CONNECTION_STRING ||
  process.env.POSTGRES_URL ||
  '';

if (!connectionString) {
  console.warn('[db] DATABASE_URL/PG_CONNECTION_STRING not set');
}

const pool = new Pool({
  connectionString,
  ssl: /neon|render|supabase|aws|heroku/i.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db = {
  query(text, params) {
    return pool.query(text, params);
  },
  end() {
    return pool.end();
  },
};

export default db;
