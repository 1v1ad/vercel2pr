// src/merge.js
import crypto from 'crypto';
import { isPostgres, query } from './db.js';

/**
 * Гарантируем, что в БД есть cluster_id.
 * Для SQLite fallback таблица создаётся в init, для Postgres полагаемся на миграции.
 */
export async function ensureClusterId() {
  if (!isPostgres()) {
    const current = await query(`SELECT value FROM settings WHERE key = 'cluster_id'`);
    if (current.rows[0]?.value) {
      console.log('[BOOT] cluster_id =', current.rows[0].value);
      return current.rows[0].value;
    }

    let legacy = null;
    try {
      const old = await query(`SELECT cluster_id AS value FROM meta LIMIT 1`);
      legacy = old.rows[0]?.value || null;
    } catch {}
    if (!legacy) {
      try {
        const kv = await query(`SELECT value FROM kv WHERE key = 'cluster_id'`);
        legacy = kv.rows[0]?.value || null;
      } catch {}
    }

    const cid = legacy || 'c_' + crypto.randomUUID();
    await query(
      `INSERT INTO settings(key, value) VALUES ('cluster_id', $1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [cid]
    );
    console.log('[BOOT] cluster_id set to', cid, legacy ? '(migrated)' : '(new)');
    return cid;
  }

  const existing = await query(`SELECT value FROM settings WHERE key = 'cluster_id' LIMIT 1`);
  if (existing.rows[0]?.value) {
    console.log('[BOOT] cluster_id =', existing.rows[0].value);
    return existing.rows[0].value;
  }

  let legacy = null;
  try {
    const old = await query(`SELECT cluster_id AS value FROM meta LIMIT 1`);
    legacy = old.rows[0]?.value || null;
  } catch {}
  if (!legacy) {
    try {
      const kv = await query(`SELECT value FROM kv WHERE key = 'cluster_id'`);
      legacy = kv.rows[0]?.value || null;
    } catch {}
  }

  const cid = legacy || 'c_' + crypto.randomUUID();
  await query(
    `INSERT INTO settings (key, value)
     VALUES ('cluster_id', $1)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [cid]
  );
  console.log('[BOOT] cluster_id set to', cid, legacy ? '(migrated)' : '(new)');
  return cid;
}
