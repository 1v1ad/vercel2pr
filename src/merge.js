// src/merge.js
import { db } from './db.js';

export async function ensureClusterId(){
  await db.run('UPDATE users SET cluster_id = id WHERE cluster_id IS NULL');
}

export async function resolvePrimaryUserId(userId){
  const row = await db.get('SELECT COALESCE(cluster_id, id) AS cid FROM users WHERE id = ?', [userId]);
  const cid = row ? row.cid : userId;
  const pri = await db.get('SELECT MIN(id) AS id FROM users WHERE COALESCE(cluster_id, id) = ?', [cid]);
  return pri?.id ?? userId;
}

export async function mergeUsers(primaryId, secondaryId){
  const cid = await resolvePrimaryUserId(primaryId);
  await db.run('UPDATE users SET cluster_id = ? WHERE id = ?', [cid, secondaryId]);
  return { ok: true, clusterId: cid };
}

export async function mergeSuggestions(){
  return [];
}

export async function autoMergeByDevice(){
  return false;
}
