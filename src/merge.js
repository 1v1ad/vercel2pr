import crypto from 'crypto';
import { query, tx } from './db.js';

async function readSetting(key) {
  try {
    const { rows } = await query(`SELECT value FROM settings WHERE key = ?`, [key]);
    if (rows.length && rows[0].value) return rows[0].value;
  } catch {}
  try {
    const { rows } = await query(`SELECT value FROM kv WHERE key = ?`, [key]);
    if (rows.length && rows[0].value) return rows[0].value;
  } catch {}
  return null;
}

async function writeSetting(key, value) {
  const sql = `INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`;
  try {
    await query(sql, [key, value]);
    return true;
  } catch {}
  try {
    await query(
      `INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
    return true;
  } catch {}
  return false;
}

export async function ensureClusterId() {
  const existing = await readSetting('cluster_id');
  if (existing) {
    console.log('[BOOT] cluster_id =', existing);
    return existing;
  }

  const cid = 'c_' + crypto.randomUUID();
  const stored = await writeSetting('cluster_id', cid);
  if (stored) {
    console.log('[BOOT] cluster_id set to', cid);
  } else {
    console.warn('[BOOT] failed to persist cluster_id, using runtime value');
  }
  return cid;
}

export async function resolvePrimaryUserId(userId) {
  if (!userId) throw new Error('invalid_user_id');

  let currentId = Number(userId);
  const visited = new Set();

  while (true) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    const { rows } = await query(
      `SELECT id, primary_user_id FROM users WHERE id = ?`,
      [currentId]
    );
    if (!rows.length) {
      if (currentId !== userId) return Number(currentId) || null;
      throw new Error('user_not_found');
    }
    const row = rows[0];
    const primary = Number(row.primary_user_id || 0);
    if (!primary || primary === row.id) {
      return row.id;
    }
    currentId = primary;
  }

  return currentId;
}

export async function autoMergeAccounts({ userIds = [], clusterId = null, meta = {}, preferredPrimaryId = null }) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return null;
  }

  const uniqueIds = Array.from(new Set(userIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)));
  if (uniqueIds.length === 0) return null;

  return tx(async (exec) => {
    const placeholders = uniqueIds.map(() => '?').join(', ');
    const { rows } = await exec(
      `SELECT id, provider, cluster_id, primary_user_id, created_at FROM users WHERE id IN (${placeholders}) ORDER BY id ASC`,
      uniqueIds
    );
    if (!rows.length) return null;

    let resolvedCluster = clusterId || rows.find((r) => r.cluster_id)?.cluster_id || crypto.randomUUID();

    let resolvedPrimary = preferredPrimaryId ? Number(preferredPrimaryId) : null;
    if (!resolvedPrimary) {
      const explicit = rows.find((r) => r.primary_user_id && uniqueIds.includes(Number(r.primary_user_id)));
      if (explicit) resolvedPrimary = Number(explicit.primary_user_id);
    }
    if (!resolvedPrimary) {
      const vk = rows.find((r) => r.provider === 'vk');
      if (vk) resolvedPrimary = vk.id;
    }
    if (!resolvedPrimary) {
      let earliest = rows[0];
      try {
        earliest = rows
          .slice()
          .sort((a, b) => {
            const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
            const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
            if (ta && tb && ta !== tb) return ta - tb;
            return a.id - b.id;
          })[0];
      } catch {
        earliest = rows[0];
      }
      resolvedPrimary = earliest.id;
    }

    const updates = [];
    for (const row of rows) {
      const needCluster = row.cluster_id !== resolvedCluster;
      const needPrimary = Number(row.primary_user_id || 0) !== resolvedPrimary;
      if (needCluster || needPrimary) {
        updates.push(exec(
          `UPDATE users SET cluster_id = ?, primary_user_id = ? WHERE id = ?`,
          [resolvedCluster, resolvedPrimary, row.id]
        ));
      }
    }
    await Promise.all(updates);

    const mergedUserIds = rows.map((r) => r.id).filter((id) => id !== resolvedPrimary);
    if (mergedUserIds.length) {
      const payload = {
        ...meta,
        cluster_id: resolvedCluster,
        primary_user_id: resolvedPrimary,
        merged_user_ids: mergedUserIds,
      };
      await exec(
        `INSERT INTO events (user_id, type, meta) VALUES (?, ?, ?)`,
        [resolvedPrimary, 'merge_auto', JSON.stringify(payload)]
      );
    }

    return {
      cluster_id: resolvedCluster,
      primary_user_id: resolvedPrimary,
      merged_user_ids: mergedUserIds,
    };
  });
}
