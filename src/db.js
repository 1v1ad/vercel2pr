// src/db.js
import crypto from 'crypto';
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
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      cluster_id       TEXT,
      primary_user_id  INTEGER,
      created_at       TEXT NOT NULL DEFAULT (datetime('now'))
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

  async function ensureColumn(table, column, definition) {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  await ensureColumn('persons', 'cluster_id', 'TEXT');
  await ensureColumn('persons', 'primary_user_id', 'INTEGER');

  await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_persons_cluster_id ON persons(cluster_id) WHERE cluster_id IS NOT NULL;`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_persons_primary_user ON persons(primary_user_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_person_links_person ON person_links(person_id);`);

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
    await db.run(`UPDATE persons SET primary_user_id = ? WHERE id = ?`, [user.id, person_id]);
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

async function ensureClusterForPerson(personId) {
  if (!personId) return null;
  const providers = await db.all(
    `SELECT DISTINCT provider FROM person_links WHERE person_id = ?`,
    [personId]
  );
  const haveVK = providers.some((row) => row.provider === 'vk');
  const haveTG = providers.some((row) => row.provider === 'tg');
  if (!haveVK || !haveTG) return null;

  const row = await db.get(`SELECT cluster_id FROM persons WHERE id = ?`, [personId]);
  if (row?.cluster_id) return row.cluster_id;

  const clusterId = 'cluster_' + crypto.randomUUID();
  await db.run(`UPDATE persons SET cluster_id = ? WHERE id = ?`, [clusterId, personId]);
  return clusterId;
}

/** Сшивка двух аккаунтов под одного человека (ручная админ-команда) */
export async function linkAccounts({ left, right }, options = {}) {
  const mode = options.mode === 'auto' ? 'auto' : 'manual';
  const reason = options.reason ? String(options.reason) : null;
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

  const leftUser = await db.get(
    `SELECT * FROM users WHERE provider=? AND provider_user_id=?`,
    [left.provider, String(left.provider_user_id)]
  );
  const rightUser = await db.get(
    `SELECT * FROM users WHERE provider=? AND provider_user_id=?`,
    [right.provider, String(right.provider_user_id)]
  );
  const leftPerson = await db.get(`SELECT * FROM persons WHERE id = ?`, [l.person_id]);
  const rightPerson = await db.get(`SELECT * FROM persons WHERE id = ?`, [r.person_id]);

  // переносим все ссылки с right.person_id на left.person_id
  await db.run(
    `UPDATE person_links SET person_id = ? WHERE person_id = ?`,
    [l.person_id, r.person_id]
  );
  // сам right.person удаляем
  await db.run(`DELETE FROM persons WHERE id = ?`, [r.person_id]);

  if (rightPerson?.primary_user_id && !leftPerson?.primary_user_id) {
    const exists = await db.get(`SELECT id FROM users WHERE id = ?`, [rightPerson.primary_user_id]);
    if (exists) {
      await db.run(`UPDATE persons SET primary_user_id = ? WHERE id = ?`, [rightPerson.primary_user_id, l.person_id]);
    }
  }

  if (rightPerson?.cluster_id && !leftPerson?.cluster_id) {
    await db.run(`UPDATE persons SET cluster_id = ? WHERE id = ?`, [rightPerson.cluster_id, l.person_id]);
  }

  const clusterId = await ensureClusterForPerson(l.person_id);

  let primaryUserId = leftUser?.id || rightUser?.id || null;
  try {
    const { resolvePrimaryUserId } = await import('./merge.js');
    const probe = leftUser?.id || rightUser?.id || null;
    if (resolvePrimaryUserId && probe) {
      primaryUserId = await resolvePrimaryUserId(probe);
    }
  } catch {}

  const meta = {
    left,
    right,
    person_id: l.person_id,
    cluster_id: clusterId,
    mode,
  };
  if (reason) meta.reason = reason;

  await logEvent(primaryUserId, mode === 'auto' ? 'merge_auto' : 'merge_manual', meta);
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

export async function closeDB() {
  if (db) {
    await db.close();
    db = null;
  }
}
