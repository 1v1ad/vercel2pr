// src/merge.js
import crypto from 'crypto';
import { getDb, linkAccounts } from './db.js';

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
    [user.provider, user.provider_user_id]
  );
  if (!link?.person_id) return user.id;

  const person = await db.get(
    `SELECT id, primary_user_id FROM persons WHERE id = ?`,
    [link.person_id]
  );
  if (!person) return user.id;

  if (person.primary_user_id) {
    const primary = await db.get(`SELECT id FROM users WHERE id = ?`, [person.primary_user_id]);
    if (primary) return primary.id;
  }

  const candidates = await db.all(
    `
      SELECT u.id, u.provider, u.created_at
      FROM users u
      JOIN person_links pl
        ON pl.provider = u.provider AND pl.provider_user_id = u.provider_user_id
      WHERE pl.person_id = ?
      ORDER BY u.created_at ASC, u.id ASC
    `,
    [person.id]
  );

  if (!candidates.length) return user.id;

  const vk = candidates.find((row) => row.provider === 'vk');
  if (vk) return vk.id;

  return candidates[0].id;
}

export async function autoMergeAccounts({ left, right, reason } = {}) {
  if (!left || !right) {
    throw new Error('autoMergeAccounts: left and right accounts are required');
  }
  const personId = await linkAccounts({ left, right }, { mode: 'auto', reason });
  const db = await getDb();
  const leftUser = await db.get(
    `SELECT id FROM users WHERE provider=? AND provider_user_id=?`,
    [left.provider, String(left.provider_user_id)]
  );
  const rightUser = await db.get(
    `SELECT id FROM users WHERE provider=? AND provider_user_id=?`,
    [right.provider, String(right.provider_user_id)]
  );
  const probe = leftUser?.id || rightUser?.id || null;
  const primary = probe ? await resolvePrimaryUserId(probe) : null;
  return { person_id: personId, primary_user_id: primary };
}

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
