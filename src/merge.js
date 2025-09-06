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
