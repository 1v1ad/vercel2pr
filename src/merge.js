// src/merge.js
// Utilities for suggesting and performing user merges (VK/TG) + helpers
// All functions are idempotent and safe to call multiple times.

import { db } from './db.js';

/**
 * Ensure meta jsonb columns exist where we rely on them.
 * - users.meta
 * - auth_accounts.meta
 * Safe to call multiple times.
 */
export async function ensureMetaColumns() {
  try {
    await db.query(`
      alter table users
        add column if not exists meta jsonb default '{}'::jsonb
    `);
  } catch {}
  try {
    await db.query(`
      alter table auth_accounts
        add column if not exists meta jsonb default '{}'::jsonb
    `);
  } catch {}
}

/**
 * Backward-compat alias (old name used in some places).
 * Keeps older imports working if они остались.
 */
export async function ensureMetaColumn() {
  return ensureMetaColumns();
}

/** Follow meta.merged_into chain to find the real (primary) user id */
export async function resolvePrimaryUserId(userId) {
  if (!userId) return null;
  await ensureMetaColumns();
  let current = userId;
  // Follow at most 5 hops to avoid accidental cycles
  for (let i = 0; i < 5; i++) {
    const r = await db.query(
      `select coalesce(meta->>'merged_into','') as to_id
         from users where id = $1`,
      [current]
    );
    if (!r.rowCount) break;
    const to = (r.rows[0].to_id || '').trim();
    if (!to) break;
    const next = parseInt(to, 10) || null;
    if (!next || next === current) break;
    current = next;
  }
  return current;
}

/** Merge two users into one (primary keeps id). Wrapped in a transaction. */
export async function mergeUsers(primaryId, secondaryId) {
  if (!primaryId || !secondaryId || primaryId === secondaryId) {
    throw new Error('mergeUsers: bad args');
  }
  await ensureMetaColumns();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Move accounts, events, transactions
    await client.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, secondaryId]);
    try { await client.query('update transactions set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
    try { await client.query('update events set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}

    // Sum balances
    await client.query(
      'update users u set balance = coalesce(u.balance,0) + (select coalesce(balance,0) from users where id=$2) where id=$1',
      [primaryId, secondaryId]
    );

    // Prefer non-empty profile fields from secondary if primary empty
    await client.query(
      `update users p set
          first_name   = coalesce(nullif(p.first_name,''), s.first_name),
          last_name    = coalesce(nullif(p.last_name,''),  s.last_name),
          username     = coalesce(nullif(p.username,''),  s.username),
          avatar       = coalesce(nullif(p.avatar,''),    s.avatar),
          country_code = coalesce(nullif(p.country_code,''), s.country_code),
          country_name = coalesce(nullif(p.country_name,''), s.country_name)
        from users s
       where p.id=$1 and s.id=$2`,
      [primaryId, secondaryId]
    );

    // Mark secondary as merged
    await client.query(
      `update users
          set balance = 0,
              meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{merged_into}', to_jsonb($1)::jsonb),
              updated_at = now()
        where id = $2`,
      [primaryId, secondaryId]
    );

    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Suggest merges by device_id across providers */
export async function mergeSuggestions(limit = 100) {
  await ensureMetaColumns();
  const r = await db.query(
    `select device_id,
            array_agg(distinct user_id) as users,
            array_agg(distinct provider) as providers
       from auth_accounts
      where coalesce(device_id,'') <> ''
      group by device_id
     having count(distinct user_id) > 1
      limit $1`,
    [limit]
  );
  return r.rows.map(x => ({
    device_id: x.device_id,
    user_ids:  (x.users || []).map(Number),
    providers: x.providers || []
  }));
}

/** Heuristic: choose primary for a given device among 2+ users. */
async function pickPrimaryForDevice(userIds) {
  // Prefer user with VK id (historically main), otherwise by richer balance, then oldest account
  const r = await db.query(
    `select id, vk_id, created_at, balance from users where id = any($1::int[])`,
    [userIds]
  );
  if (!r.rowCount) return userIds[0];
  const rows = r.rows;
  rows.sort((a,b) => {
    const avk = a.vk_id ? 1 : 0;
    const bvk = b.vk_id ? 1 : 0;
    if (avk !== bvk) return bvk - avk;                   // VK first
    const ab = Number(a.balance || 0), bb = Number(b.balance || 0);
    if (ab !== bb) return bb - ab;                       // richer first
    return (new Date(a.created_at) - new Date(b.created_at)); // oldest first
  });
  return rows[0].id;
}

/** Auto-merge by device: after new login/link, merge accounts on same device */
export async function autoMergeByDevice(userId, deviceId) {
  if (!userId || !deviceId) return;
  await ensureMetaColumns();

  // Find all users tied to the same device
  const r = await db.query(
    `select distinct user_id from auth_accounts where device_id = $1`,
    [deviceId]
  );
  const set = new Set((r.rows || []).map(x => Number(x.user_id)));
  set.add(userId);
  const users = Array.from(set);
  if (users.length < 2) return;

  const primary = await pickPrimaryForDevice(users);
  const others = users.filter(id => id !== primary);

  for (const sid of others) {
    const resolved = await resolvePrimaryUserId(sid);
    if (resolved !== primary) {
      await mergeUsers(primary, resolved);
    }
  }
}
