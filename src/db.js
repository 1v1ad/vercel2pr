// vercel2pr/src/db.js
// Универсальный пул для Postgres (Neon/Render/любая PaaS)

import pkg from 'pg';
const { Pool } = pkg;

// Берём строку подключения из окружения
const connectionString =
  process.env.DATABASE_URL ||
  process.env.PG_CONNECTION_STRING ||
  process.env.POSTGRES_URL ||
  '';

if (!connectionString) {
  console.warn('[db] DATABASE_URL/PG_CONNECTION_STRING не задан — запросы упадут.');
}

// Для Neon/Render чаще нужен SSL
const pool = new Pool({
  connectionString,
  ssl: /neon|render|supabase|aws|heroku/i.test(connectionString)
    ? { rejectUnauthorized: false }
    : undefined,
  // Можно ограничить пул, чтобы не разгонять бесплатный инстанс
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// Удобная обёртка — совместима с текущим кодом (db.query(...))
export const db = {
  query(text, params) {
    return pool.query(text, params);
  },
  end() {
    return pool.end();
  },
};

// На всякий — default-экспорт
export default db;
