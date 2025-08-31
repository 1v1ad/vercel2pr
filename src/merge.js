// src/merge.js — clean ESM, no template strings; safe auto-merge helpers
import { db } from './db.js';

export async function ensureUsersMetaColumn() {
  try {
    await db.query("alter table users add column if not exists meta jsonb default '{}'::jsonb");
  } catch {}
}

export async function adminMergeUsersTx(client, primaryId, secondaryId) {
  // переносим связи
  await client.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, secondaryId]);
  try { await client.query('update transactions set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
  try { await client.query('update events set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
  // суммируем баланс
  await client.query('update users u set balance = coalesce(u.balance,0) + (select coalesce(balance,0) from users where id=$2) where id=$1', [primaryId, secondaryId]);
  // дополняем пустые поля профиля
  await client.query(
    "update users p set first_name = coalesce(nullif(p.first_name,''), s.first_name), last_name = coalesce(nullif(p.last_name,''), s.last_name), username = coalesce(nullif(p.username,''), s.username), avatar = coalesce(nullif(p.avatar,''), s.avatar), country_code = coalesce(nullif(p.country_code,''), s.country_code) from users s where p.id=$1 and s.id=$2",
    [primaryId, secondaryId]
  );
  // помечаем вторичку
  await client.query("update users set balance=0, meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{merged_into}', to_jsonb($1)::jsonb), updated_at=now() where id=$2", [primaryId, secondaryId]);
}

export async function findPrimaryByDeviceId(deviceId) {
  if (!deviceId) return null;
  const r = await db.query(
    "select user_id from auth_accounts where (meta->>'device_id') = $1 and user_id is not null order by updated_at desc limit 1",
    [deviceId]
  );
  return (r.rows && r.rows[0] && r.rows[0].user_id) ? r.rows[0].user_id : null;
}

export async function findSecondaryTgUserByDeviceOrAccount(opts = {}) {
  const deviceId = opts.deviceId || null;
  const tgId = opts.tgId || null;
  const sql = [
    'select u.id',
    '  from users u',
    '  join auth_accounts aa on aa.user_id = u.id',
    " where coalesce(u.meta->>'merged_into','') = ''",
    '   and (',
    '     (aa.provider = $1 and aa.provider_user_id = $2)',
    '     || exists(',
    "       select 1 from auth_accounts x where x.user_id = u.id and (x.meta->>'device_id') = $3",
    '     )',
    '   )',
    ' group by u.id',
    ' order by u.id desc limit 1'
  ].join('\n');
  const params = ['tg', String(tgId || ''), deviceId];
  const q = await db.query(sql, params);
  return (q.rows && q.rows[0] && q.rows[0].id) ? q.rows[0].id : null;
}

export async function isSafeToAutoMerge(secondaryId) {
  if (!secondaryId) return false;
  let bal0 = true;
  try {
    const r1 = await db.query('select coalesce(balance,0) as bal from users where id=$1', [secondaryId]);
    bal0 = !r1.rows.length || Number(r1.rows[0].bal) == 0;
  } catch { bal0 = true; }

  let okTx = true;
  try {
    const r2 = await db.query("select count(*)::int as c from transactions where user_id=$1 and type not in ('auth','auth_login')", [secondaryId]);
    okTx = (r2.rows[0]?.c ?? 0) === 0;
  } catch { okTx = true; }

  let okEv = true;
  try {
    const r3 = await db.query("select count(*)::int as c from events where user_id=$1 and type not in ('login','auth','auth_start','auth_callback')", [secondaryId]);
    okEv = (r3.rows[0]?.c ?? 0) === 0;
  } catch {
    try {
      const r4 = await db.query("select count(*)::int as c from events where user_id=$1 and event_type not in ('login','auth','auth_start','auth_callback')", [secondaryId]);
      okEv = (r4.rows[0]?.c ?? 0) === 0;
    } catch { okEv = true; }
  }

  return bal0 && okTx && okEv;
}

export async function autoMergeByDevice({ deviceId, tgId }) {
  if (!deviceId) return { ok:false, reason:'no_device' };
  await ensureUsersMetaColumn();
  const primaryId = await findPrimaryByDeviceId(deviceId);
  if (!primaryId) return { ok:false, reason:'no_primary' };
  const secondaryId = await findSecondaryTgUserByDeviceOrAccount({ deviceId, tgId });
  if (!secondaryId || secondaryId === primaryId) return { ok:false, reason:'no_secondary' };
  const safe = await isSafeToAutoMerge(secondaryId);
  if (!safe) return { ok:false, reason:'not_safe' };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await adminMergeUsersTx(client, primaryId, secondaryId);
    await client.query('COMMIT');
    return { ok:true, primaryId, secondaryId };
  } catch (e) {
    await client.query('ROLLBACK');
    return { ok:false, error: e.message };
  } finally {
    client.release();
  }
}

export async function mergeSuggestions(limit = 200) {
  await ensureUsersMetaColumn();
  const sql = [
    'with tg as (',
    "  select user_id, max(meta->>'device_id') as did",
    '    from auth_accounts',
    "   where provider = 'tg'",
    '   group by user_id',
    '),',
    'cand as (',
    '  select u.id as secondary_id,',
    '         (select user_id from auth_accounts a',
    "           where a.user_id is not null and (a.meta->>'device_id') = t.did",
    '           order by updated_at desc limit 1) as primary_id',
    '    from users u',
    '    join tg t on t.user_id = u.id',
    "   where coalesce(u.meta->>'merged_into','') = ''",
    ')',
    'select * from cand where primary_id is not null limit $1'
  ].join('\n');
  const r = await db.query(sql, [limit]);
  return r.rows;
}
