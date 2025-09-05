// src/merge.js
import { db } from './db.js';

/**
 * ensureClusterId
 * Назначает cluster_id = id для всех пользователей, у кого cluster_id NULL.
 * Безопасно вызывать на старте.
 */
export async function ensureClusterId(){
  await db.run('UPDATE users SET cluster_id = id WHERE cluster_id IS NULL');
}

/**
 * resolvePrimaryUserId
 * Возвращает id «первичного» пользователя в кластере.
 * По умолчанию — минимальный id в кластере.
 */
export async function resolvePrimaryUserId(userId){
  const row = await db.get('SELECT COALESCE(cluster_id, id) AS cid FROM users WHERE id = ?', [userId]);
  const cid = row ? row.cid : userId;
  const pri = await db.get('SELECT MIN(id) AS id FROM users WHERE COALESCE(cluster_id, id) = ?', [cid]);
  return pri?.id ?? userId;
}

/**
 * mergeUsers
 * Присоединяет secondary к кластеру primary (меняет cluster_id у secondary).
 */
export async function mergeUsers(primaryId, secondaryId){
  const cid = await resolvePrimaryUserId(primaryId);
  await db.run('UPDATE users SET cluster_id = ? WHERE id = ?', [cid, secondaryId]);
  return { ok: true, clusterId: cid };
}

/**
 * mergeSuggestions
 * Заглушка: вернёт пустой список.
 */
export async function mergeSuggestions(){
  return [];
}

/**
 * autoMergeByDevice
 * Заглушка: вернёт false.
 */
export async function autoMergeByDevice(){
  return false;
}
