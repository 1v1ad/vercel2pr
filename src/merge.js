// src/merge.js — shared auto-merge logic
import { db } from './db.js';

export async function autoMergeByDevice({ deviceId, tgId }) {
  if (!deviceId) return { ok:false, reason:'no_device' };
  try { await db.query("alter table users add column if not exists meta jsonb default '{}'::jsonb"); } catch {}

  // find primary by device_id (attached account)
  const p = await db.query(
    "select user_id from auth_accounts where (meta->>'device_id') = $1 and user_id is not null order by updated_at desc limit 1",
    [deviceId]
  );
  const primaryId = p.rows[0]?.user_id || null;
  if (!primaryId) return { ok:false, reason:'no_primary' };

  // find tg-only user bound to same device or exact tgId
  const s = await db.query(\`
    select u.id
      from users u
      join auth_accounts aa on aa.user_id = u.id
     where coalesce(u.meta->>'merged_into','') = ''
       and (
         (aa.provider = 'tg' and aa.provider_user_id = $1)
         or exists(select 1 from auth_accounts x where x.user_id = u.id and (x.meta->>'device_id') = $2)
       )
     group by u.id
     order by u.id desc limit 1
  \`, [String(tgId || ''), deviceId]);
  const secondaryId = s.rows[0]?.id || null;
  if (!secondaryId || secondaryId === primaryId) return { ok:false, reason:'no_secondary' };

  // safety: secondary must be empty
  const bal = await db.query("select coalesce(balance,0) as bal from users where id=$1", [secondaryId]);
  const bal0 = (bal.rows[0]?.bal ?? 0) == 0;

  let okTx = true; try {
    const r = await db.query("select count(*)::int as c from transactions where user_id=$1 and type not in ('auth','auth_login')",[secondaryId]);
    okTx = (r.rows[0]?.c ?? 0) == 0;
  } catch {}

  let okEv = true; try {
    const r = await db.query("select count(*)::int as c from events where user_id=$1 and event_type not in ('login','auth','auth_start','auth_callback')",[secondaryId]);
    okEv = (r.rows[0]?.c ?? 0) == 0;
  } catch {}

  if (!(bal0 && okTx && okEv)) return { ok:false, reason:'not_safe' };

  // perform merge
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("update auth_accounts set user_id=$1 where user_id=$2", [primaryId, secondaryId]);
    try { await client.query("update transactions set user_id=$1 where user_id=$2", [primaryId, secondaryId]); } catch {}
    try { await client.query("update events set user_id=$1 where user_id=$2", [primaryId, secondaryId]); } catch {}
    await client.query("update users u set balance = coalesce(u.balance,0) + (select coalesce(balance,0) from users where id=$2) where id=$1", [primaryId, secondaryId]);
    await client.query("update users p set first_name = coalesce(nullif(p.first_name,''), s.first_name), last_name = coalesce(nullif(p.last_name,''), s.last_name), username = coalesce(nullif(p.username,''), s.username), avatar = coalesce(nullif(p.avatar,''), s.avatar), country_code = coalesce(nullif(p.country_code,''), s.country_code) from users s where p.id=$1 and s.id=$2", [primaryId, secondaryId]);
    await client.query("update users set balance=0, meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{merged_into}', to_jsonb($1)::jsonb), updated_at=now() where id=$2", [primaryId, secondaryId]);
    await client.query('COMMIT');
    return { ok:true, primaryId, secondaryId };
  } catch (e) {
    await client.query('ROLLBACK');
    return { ok:false, error: e.message };
  } finally {
    client.release();
  }
}
