// src/merge.js
import crypto from 'crypto';
import { getDb } from './db.js';

/**
 * Гарантируем, что в БД есть cluster_id.
 * - создаём таблицу settings(key TEXT PRIMARY KEY, value TEXT)
 * - пытаемся прочитать cluster_id
 * - если нет — мигрируем из возможных старых мест
 * - если и там нет — генерируем новый и сохраняем
 */
export async function ensureClusterId() {
  const db = await getDb();

  // 1) Базовая таблица настроек
  await db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // 2) Пробуем найти уже сохранённый cluster_id
  let row = await db.get(`SELECT value FROM settings WHERE key = 'cluster_id'`);
  if (row?.value) {
    console.log('[BOOT] cluster_id =', row.value);
    return row.value;
  }

  // 3) Легаси-поиск (если раньше где-то хранили)
  let legacy = null;
  try {
    legacy = (await db.get(`SELECT cluster_id AS value FROM meta LIMIT 1`))?.value || null;
  } catch {}
  if (!legacy) {
    try {
      legacy = (await db.get(`SELECT value FROM kv WHERE key = 'cluster_id'`))?.value || null;
    } catch {}
  }

  // 4) Берём легаси или генерим новый
  const cid = legacy || ('c_' + crypto.randomUUID());

  // 5) Сохраняем в settings (idempotent)
  await db.run(
    `INSERT OR REPLACE INTO settings(key, value) VALUES ('cluster_id', ?)`,
    [cid]
  );

  console.log('[BOOT] cluster_id set to', cid, legacy ? '(migrated)' : '(new)');
  return cid;
}

export async function resolvePrimaryUserId(userId) {
  if (!userId) return null;

  const db = await getDb();
  const user = await db.get(
    `SELECT id, provider, provider_user_id FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) return null;

  const link = await db.get(
    `SELECT person_id FROM person_links WHERE provider = ? AND provider_user_id = ?`,
    [user.provider, String(user.provider_user_id)]
  );
  if (!link) return user.id;

  const personId = link.person_id;
  const person = await db.get(
    `SELECT primary_user_id FROM persons WHERE id = ?`,
    [personId]
  );

  if (person?.primary_user_id) {
    const exists = await db.get(`SELECT id FROM users WHERE id = ?`, [person.primary_user_id]);
    if (exists) return person.primary_user_id;
  }

  const vkAccount = await db.get(
    `
      SELECT u.id
      FROM users u
      JOIN person_links pl
        ON pl.provider = u.provider AND pl.provider_user_id = u.provider_user_id
      WHERE pl.person_id = ? AND u.provider = 'vk'
      ORDER BY datetime(u.created_at) ASC, u.id ASC
      LIMIT 1
    `,
    [personId]
  );
  if (vkAccount?.id) return vkAccount.id;

  const earliestAccount = await db.get(
    `
      SELECT u.id
      FROM users u
      JOIN person_links pl
        ON pl.provider = u.provider AND pl.provider_user_id = u.provider_user_id
      WHERE pl.person_id = ?
      ORDER BY datetime(u.created_at) ASC, u.id ASC
      LIMIT 1
    `,
    [personId]
  );
  if (earliestAccount?.id) return earliestAccount.id;

  return user.id;
}
