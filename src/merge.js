// src/merge.js
import crypto from 'crypto';
import { query, tx, isPg } from './db.js';

let metaEnsured = false;

function nowExpression() {
  return isPg() ? 'now()' : "datetime('now')";
}

function sanitizeIds(ids) {
  return Array.from(
    new Set(
      (ids || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
}

function buildInClause(ids, offset = 0) {
  return ids.map((_, idx) => `$${idx + 1 + offset}`).join(', ');
}

export async function ensureMetaColumns() {
  if (metaEnsured) return;
  try {
    if (isPg()) {
      await query('ALTER TABLE IF EXISTS auth_accounts ADD COLUMN IF NOT EXISTS meta JSONB');
      await query('ALTER TABLE IF EXISTS auth_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()');
    } else {
      try { await query('ALTER TABLE auth_accounts ADD COLUMN meta TEXT'); } catch {}
      try {
        await query("ALTER TABLE auth_accounts ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))");
      } catch {}
    }
  } finally {
    metaEnsured = true;
  }
}

export async function ensureClusterId() {
  await query('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)');
  const existing = await query("SELECT value FROM settings WHERE key = 'cluster_id' LIMIT 1");
  if (existing.rows.length && existing.rows[0].value) {
    const value = existing.rows[0].value;
    console.log('[BOOT] cluster_id =', value);
    return value;
  }

  let legacy = null;
  try {
    const res = await query('SELECT cluster_id AS value FROM meta LIMIT 1');
    if (res.rows.length && res.rows[0].value) legacy = res.rows[0].value;
  } catch {}
  if (!legacy) {
    try {
      const res = await query("SELECT value FROM kv WHERE key = 'cluster_id' LIMIT 1");
      if (res.rows.length && res.rows[0].value) legacy = res.rows[0].value;
    } catch {}
  }

  const clusterId = legacy || `c_${crypto.randomUUID()}`;
  await query(
    "INSERT INTO settings (key, value) VALUES ('cluster_id', $1) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    [clusterId]
  );
  console.log('[BOOT] cluster_id set to', clusterId, legacy ? '(migrated)' : '(new)');
  return clusterId;
}

export async function autoMergeAccounts({ userIds, reason = 'auto', meta = {}, preferredPrimaryId, requestedUserId } = {}) {
  const ids = sanitizeIds(userIds);
  if (ids.length < 2) {
    return { merged: false, primary_user_id: ids[0] || null, cluster_id: null };
  }

  return tx(async (client) => {
    const clause = buildInClause(ids);
    let selectSql = `SELECT id, provider, provider_user_id, cluster_id, primary_user_id FROM users WHERE id IN (${clause})`;
    if (isPg()) selectSql += ' FOR UPDATE';
    const { rows } = await client.query(selectSql, ids);
    if (rows.length < ids.length) {
      return { merged: false, primary_user_id: null, cluster_id: null };
    }

    let primaryId = null;
    const preferred = Number(preferredPrimaryId || 0);
    if (preferred && ids.includes(preferred)) {
      primaryId = preferred;
    } else {
      const existingPrimary = rows.map((r) => Number(r.primary_user_id || 0)).filter((v) => ids.includes(v));
      if (existingPrimary.length) {
        primaryId = existingPrimary[0];
      } else {
        const vkRow = rows.find((r) => r.provider === 'vk');
        primaryId = vkRow ? Number(vkRow.id) : Number(rows[0].id);
      }
    }

    const clusterId = rows.find((r) => r.cluster_id)?.cluster_id || `c_${crypto.randomUUID()}`;

    const nowExpr = nowExpression();
    const clusterSql = `UPDATE users SET cluster_id = $1, updated_at = ${nowExpr} WHERE id IN (${buildInClause(ids, 1)})`;
    const primarySql = `UPDATE users SET primary_user_id = $1, updated_at = ${nowExpr} WHERE id IN (${buildInClause(ids, 1)})`;

    let changed = false;
    if (rows.some((r) => r.cluster_id !== clusterId)) {
      await client.query(clusterSql, [clusterId, ...ids]);
      changed = true;
    }
    if (rows.some((r) => Number(r.primary_user_id || 0) !== primaryId)) {
      await client.query(primarySql, [primaryId, ...ids]);
      changed = true;
    }

    const secondary = ids.filter((id) => id !== primaryId);
    if (secondary.length) {
      const updateAuthSql = `UPDATE auth_accounts SET user_id = $1, updated_at = ${nowExpr} WHERE user_id IN (${buildInClause(secondary, 1)})`;
      await client.query(updateAuthSql, [primaryId, ...secondary]);
      changed = true;
    }

    if (changed) {
      await client.query(
        'INSERT INTO events (user_id, type, meta) VALUES ($1, $2, $3)',
        [
          primaryId,
          'merge_auto',
          {
            reason,
            requested_user_id: requestedUserId || null,
            user_ids: ids,
            primary_user_id: primaryId,
            cluster_id,
            ...(meta || {}),
          },
        ]
      );
    }

    return { merged: changed, primary_user_id: primaryId, cluster_id };
  });
}

export async function autoMergeByDevice({ deviceId, tgId } = {}) {
  const did = (deviceId || '').toString().trim();
  if (!did) return { merged: false, primary_user_id: null };

  const ids = new Set();
  if (isPg()) {
    const { rows } = await query(
      `SELECT DISTINCT user_id FROM auth_accounts WHERE user_id IS NOT NULL AND COALESCE(meta->>'device_id','') = $1`,
      [did]
    );
    for (const row of rows) {
      if (row.user_id != null) ids.add(Number(row.user_id));
    }
  } else {
    const { rows } = await query('SELECT user_id, meta FROM auth_accounts WHERE user_id IS NOT NULL AND meta IS NOT NULL');
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.meta || '{}');
        if ((meta?.device_id || '').toString() === did) {
          ids.add(Number(row.user_id));
        }
      } catch {}
    }
  }

  if (tgId) {
    const { rows } = await query('SELECT id FROM users WHERE provider = $1 AND provider_user_id = $2 LIMIT 1', [
      'tg',
      String(tgId),
    ]);
    if (rows.length) ids.add(Number(rows[0].id));
  }

  const list = sanitizeIds(Array.from(ids));
  if (list.length < 2) {
    return { merged: false, primary_user_id: list[0] || null };
  }

  return autoMergeAccounts({
    userIds: list,
    reason: 'device_id',
    meta: { device_id: did, tg_id: tgId || null },
  });
}

export async function mergeSuggestions(limit = 50) {
  const max = Math.max(1, Math.min(500, Number(limit) || 50));
  if (isPg()) {
    const { rows } = await query(
      `
        SELECT meta->>'device_id' AS device_id,
               array_agg(DISTINCT user_id) AS user_ids
          FROM auth_accounts
         WHERE user_id IS NOT NULL AND COALESCE(meta->>'device_id','') <> ''
         GROUP BY 1
        HAVING COUNT(DISTINCT user_id) > 1
         ORDER BY COUNT(*) DESC
         LIMIT $1
      `,
      [max]
    );
    return rows.map((row) => ({
      device_id: row.device_id,
      user_ids: (row.user_ids || []).map((id) => Number(id)).filter(Boolean),
      count: (row.user_ids || []).length,
      reason: 'device_id',
    }));
  }

  const { rows } = await query('SELECT user_id, meta FROM auth_accounts WHERE user_id IS NOT NULL AND meta IS NOT NULL');
  const map = new Map();
  for (const row of rows) {
    try {
      const meta = JSON.parse(row.meta || '{}');
      const did = (meta?.device_id || '').toString();
      if (!did) continue;
      if (!map.has(did)) map.set(did, new Set());
      map.get(did).add(Number(row.user_id));
    } catch {}
  }
  const suggestions = [];
  for (const [device_id, set] of map.entries()) {
    const list = Array.from(set).filter(Boolean);
    if (list.length > 1) {
      suggestions.push({ device_id, user_ids: list, count: list.length, reason: 'device_id' });
    }
  }
  suggestions.sort((a, b) => b.count - a.count);
  return suggestions.slice(0, max);
}
