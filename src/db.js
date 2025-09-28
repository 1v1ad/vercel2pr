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
      created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
      primary_user_id  INTEGER,
      cluster_id       TEXT
    );
  `);

  // Мягкие миграции для новых колонок (если таблица уже существовала)
  const personColumns = await db.all(`PRAGMA table_info(persons);`);
  const personColumnNames = new Set(personColumns.map((c) => c.name));
  if (!personColumnNames.has('primary_user_id')) {
    await db.exec(`ALTER TABLE persons ADD COLUMN primary_user_id INTEGER`);
  }
  if (!personColumnNames.has('cluster_id')) {
    await db.exec(`ALTER TABLE persons ADD COLUMN cluster_id TEXT`);
  }
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_persons_cluster_id ON persons(cluster_id);`);

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

  await backfillClusterIds();
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
export async function linkAccounts({ left, right, mode = 'manual', primaryUserId = null }) {
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

  const leftUser = await db.get(
    `SELECT id, provider FROM users WHERE provider = ? AND provider_user_id = ?`,
    [left.provider, String(left.provider_user_id)]
  );
  const rightUser = await db.get(
    `SELECT id, provider FROM users WHERE provider = ? AND provider_user_id = ?`,
    [right.provider, String(right.provider_user_id)]
  );

  if (l.person_id === r.person_id) {
    await maybeUpdatePrimary(l.person_id, primaryUserId);
    const personClusterId = await ensurePersonCluster(l.person_id);
    await logMergeEvent({
      mode,
      targetPersonId: l.person_id,
      primarySeedId: leftUser?.id || rightUser?.id || null,
      meta: { left, right, cluster_id: personClusterId, already_linked: true }
    });
    return l.person_id; // уже слиты
  }

  // переносим все ссылки с right.person_id на left.person_id
  await db.run(
    `UPDATE person_links SET person_id = ? WHERE person_id = ?`,
    [l.person_id, r.person_id]
  );
  // сам right.person удаляем
  await db.run(`DELETE FROM persons WHERE id = ?`, [r.person_id]);

  await maybeUpdatePrimary(l.person_id, primaryUserId);
  const personClusterId = await ensurePersonCluster(l.person_id);

  await logMergeEvent({
    mode,
    targetPersonId: l.person_id,
    primarySeedId: leftUser?.id || rightUser?.id || null,
    meta: { left, right, cluster_id: personClusterId }
  });

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

async function maybeUpdatePrimary(personId, preferredUserId) {
  if (!personId) return;
  if (preferredUserId == null) return;

  const belongs = await db.get(
    `
      SELECT 1
      FROM person_links pl
      JOIN users u ON u.provider = pl.provider AND u.provider_user_id = pl.provider_user_id
      WHERE pl.person_id = ? AND u.id = ?
      LIMIT 1
    `,
    [personId, preferredUserId]
  );
  if (belongs) {
    await db.run(`UPDATE persons SET primary_user_id = ? WHERE id = ?`, [preferredUserId, personId]);
  }
}

async function ensurePersonCluster(personId) {
  if (!personId) return null;

  const counts = await db.get(
    `
      SELECT
        SUM(CASE WHEN provider = 'vk' THEN 1 ELSE 0 END) AS vk_count,
        SUM(CASE WHEN provider = 'tg' THEN 1 ELSE 0 END) AS tg_count
      FROM person_links
      WHERE person_id = ?
    `,
    [personId]
  );

  if (!counts) return null;
  if (!counts.vk_count || !counts.tg_count) return null;

  const row = await db.get(`SELECT cluster_id FROM persons WHERE id = ?`, [personId]);
  if (row?.cluster_id) return row.cluster_id;

  const clusterId = `cluster_${crypto.randomUUID()}`;
  await db.run(`UPDATE persons SET cluster_id = ? WHERE id = ?`, [clusterId, personId]);
  return clusterId;
}

async function logMergeEvent({ mode, targetPersonId, primarySeedId, meta }) {
  const type = mode === 'auto' ? 'merge_auto' : 'merge_manual';
  let userId = primarySeedId || null;
  try {
    if (userId) {
      const { resolvePrimaryUserId } = await import('./merge.js');
      userId = await resolvePrimaryUserId(userId);
    }
  } catch {}

  const payload = { ...meta, person_id: targetPersonId || null, mode };
  await logEvent(userId, type, payload);
}

async function backfillClusterIds() {
  const rows = await db.all(`
    SELECT p.id AS person_id
    FROM persons p
    JOIN (
      SELECT
        person_id,
        SUM(CASE WHEN provider = 'vk' THEN 1 ELSE 0 END) AS vk_count,
        SUM(CASE WHEN provider = 'tg' THEN 1 ELSE 0 END) AS tg_count
      FROM person_links
      GROUP BY person_id
    ) agg ON agg.person_id = p.id
    WHERE COALESCE(p.cluster_id, '') = ''
      AND agg.vk_count > 0
      AND agg.tg_count > 0;
  `);

  for (const row of rows) {
    const clusterId = `cluster_${crypto.randomUUID()}`;
    await db.run(`UPDATE persons SET cluster_id = ? WHERE id = ?`, [clusterId, row.person_id]);
  }
}
