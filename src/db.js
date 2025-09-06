// src/db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const DB_FILE = process.env.SQLITE_FILE || './data.sqlite';

let dbPromise = null;

export async function getDb() {
  if (!dbPromise) {
    dbPromise = open({ filename: DB_FILE, driver: sqlite3.Database });
    const db = await dbPromise;

    await db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS users (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        provider          TEXT    NOT NULL,
        provider_user_id  TEXT    NOT NULL,
        name              TEXT,
        avatar            TEXT,
        balance           INTEGER NOT NULL DEFAULT 0,
        last_login        INTEGER
      );

      CREATE UNIQUE INDEX IF NOT EXISTS ux_users_provider
        ON users(provider, provider_user_id);

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    INTEGER,
        type       TEXT NOT NULL,
        meta       TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
      );
    `);
  }
  return dbPromise;
}

// 🔹 именованный экспорт, которого ждёт merge.js
export const db = await getDb();

/** Создать/обновить пользователя */
export async function upsertUser({ provider, provider_user_id, name, avatar }) {
  const d = await getDb();
  const now = Date.now();

  const existing = await d.get(
    `SELECT * FROM users WHERE provider = ? AND provider_user_id = ?`,
    [provider, String(provider_user_id)]
  );

  if (!existing) {
    await d.run(
      `INSERT INTO users (provider, provider_user_id, name, avatar, last_login)
       VALUES (?, ?, ?, ?, ?)`,
      [provider, String(provider_user_id), name || null, avatar || null, now]
    );
  } else {
    await d.run(
      `UPDATE users
         SET name = COALESCE(?, name),
             avatar = COALESCE(?, avatar),
             last_login = ?
       WHERE id = ?`,
      [name || null, avatar || null, now, existing.id]
    );
  }

  return d.get(
    `SELECT * FROM users WHERE provider = ? AND provider_user_id = ?`,
    [provider, String(provider_user_id)]
  );
}

/** Лог события (аудит/аналитика) */
export async function logEvent(userId, type, meta = {}) {
  const d = await getDb();
  await d.run(
    `INSERT INTO events (user_id, type, meta, created_at)
     VALUES (?, ?, ?, ?)`,
    [userId || null, String(type), JSON.stringify(meta || {}), Date.now()]
  );
}

// Доп. утилиты (по желанию будешь использовать в админке)
export async function getUserById(id) {
  const d = await getDb();
  return d.get(`SELECT * FROM users WHERE id = ?`, [id]);
}

export async function getDailySummary(days = 7) {
  const d = await getDb();
  const msDay = 24 * 60 * 60 * 1000;
  const since = Date.now() - days * msDay;

  const rows = await d.all(
    `SELECT date(created_at/1000, 'unixepoch') as d,
            COUNT(*) FILTER (WHERE type = 'login')   as logins,
            COUNT(*) FILTER (WHERE type = 'deposit') as deposits
     FROM events
     WHERE created_at >= ?
     GROUP BY d
     ORDER BY d ASC`,
    [since]
  );

  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const dte = new Date(Date.now() - i * msDay).toISOString().slice(0, 10);
    const row = rows.find(r => r.d === dte);
    out.push({
      date: dte,
      users: row ? Number(row.logins) || 0 : 0,
      deposits: row ? Number(row.deposits) || 0 : 0,
      revenue: 0
    });
  }
  return out;
}
