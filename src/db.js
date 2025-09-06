// src/db.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

export let db;

/** Инициализация БД и мягкие миграции */
export async function initDB() {
  db = await open({
    filename: process.env.DB_FILE || './data.sqlite',
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA journal_mode = WAL;');

  // users — как и было: отдельная запись на каждый провайдер (vk/tg)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      provider          TEXT    NOT NULL,              -- 'vk' | 'tg'
      provider_user_id  TEXT    NOT NULL,
      name              TEXT,
      avatar            TEXT,
      balance           INTEGER NOT NULL DEFAULT 0,
      created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(provider, provider_user_id)
    );
  `);

  // "Единый человек"
  await db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Привязки аккаунтов к человеку
  await db.exec(`
    CREATE TABLE IF NOT EXISTS person_links (
      person_id        INTEGER NOT NULL,
      provider         TEXT    NOT NULL,
      provider_user_id TEXT    NOT NULL,
      UNIQUE(provider, provider_user_id),
      FOREIGN KEY(person_id) REFERENCES persons(id) ON DELETE CASCADE
    );
  `);

  // Логи событий (для аналитики)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER,
      type       TEXT    NOT NULL,
      meta       TEXT,
      created_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Табличка key-value (например, cluster_id и т.п.)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS kv (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/** Создаёт/обновляет пользователя и гарантирует привязку к person */
export async function upsertUser({ provider, provider_user_id, name, avatar }) {
  if (!provider || !provider_user_id) {
    throw new Error('upsertUser: provider and provider_user_id are required');
  }

  await db.run(
    `
    INSERT INTO users (provider, provider_user_id, name, avatar)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider, provider_user_id) DO UPDATE SET
      name=excluded.name,
      avatar=excluded.avatar
    `,
    [provider, String(provider_user_id), name || null, avatar || null]
  );

  const user = await db.get(
    `SELECT * FROM users WHERE provider = ? AND provider_user_id = ?`,
    [provider, String(provider_user_id)]
  );

  // Ищем person по привязке; если нет — создаём
  let link = await db.get(
    `SELECT person_id FROM person_links WHERE provider = ? AND provider_user_id = ?`,
    [provider, String(provider_user_id)]
  );

  if (!link) {
    const ins = await db.run(`INSERT INTO persons DEFAULT VALUES`);
    const person_id = ins.lastID;
    await db.run(
      `INSERT INTO person_links (person_id, provider, provider_user_id) VALUES (?, ?, ?)`,
      [person_id, provider, String(provider_user_id)]
    );
    link = { person_id };
  }

  return { ...user, person_id: link.person_id };
}

/** Логирование событий */
export async function logEvent(user_id, type, meta = {}) {
  await db.run(
    `INSERT INTO events (user_id, type, meta) VALUES (?, ?, ?)`,
    [user_id || null, String(type), JSON.stringify(meta)]
  );
}

/** Сшивка двух аккаунтов под одного человека (ручная админ-команда) */
export async function linkAccounts({ left, right }) {
  // left/right: { provider, provider_user_id }
  const l = await db.get(
    `SELECT person_id FROM person_links WHERE provider=? AND provider_user_id=?`,
    [left.provider, String(left.provider_user_id)]
  );
  const r = await db.get(
    `SELECT person_id FROM person_links WHERE provider=? AND provider_user_id=?`,
    [right.provider, String(right.provider_user_id)]
  );
  if (!l || !r) throw new Error('linkAccounts: one of links not found');

  if (l.person_id === r.person_id) return l.person_id; // уже слиты

  // переносим все ссылки с right.person_id на left.person_id
  await db.run(
    `UPDATE person_links SET person_id = ? WHERE person_id = ?`,
    [l.person_id, r.person_id]
  );
  // сам right.person удаляем
  await db.run(`DELETE FROM persons WHERE id = ?`, [r.person_id]);
  return l.person_id;
}

/** Утилита для /api/me */
export async function getUserById(id) {
  return db.get(`SELECT * FROM users WHERE id = ?`, [id]);
}
export function getDb() {
  if (!db) throw new Error('db not initialized');
  return db;
}
