// src/routes_tg.js — TG-логин + автосклейка по device_id
import { Router } from 'express';
import { db } from './db.js';

const router = Router();

// --- утилиты ---

async function ensureMetaColumns() {
  try { await db.query("alter table users add column if not exists meta jsonb default '{}'::jsonb"); } catch {}
  try { await db.query("alter table auth_accounts add column if not exists meta jsonb default '{}'::jsonb"); } catch {}
}

async function upsertArrayMeta(client, userId, key, value) {
  // добавляем value в jsonb-массив users.meta[key], без дублей
  await client.query(
    `
    update users
       set meta = jsonb_set(
                  coalesce(meta,'{}'::jsonb),
                  $2::text[],
                  (
                    select to_jsonb(
                      (
                        select array_agg(distinct x)
                        from unnest(
                          coalesce( (select array_agg(v::text)
                                       from jsonb_array_elements_text(coalesce(meta->($3)::jsonb, '[]'::jsonb)) v),
                                    ARRAY[]::text[])
                          || ARRAY[$4::text]
                        ) x
                      )
                    )
                  ),
                  true
                ),
           updated_at = now()
     where id = $1
    `,
    [userId, '{' + key + '}', key, value]
  );
}

async function choosePrimary(candidates) {
  // candidates: [{id, has_vk}]
  const withVk = candidates.find(c => c.has_vk);
  if (withVk) return withVk.id;
  // иначе — самый маленький id
  return candidates.reduce((min, c) => (c.id < min ? c.id : min), candidates[0].id);
}

async function mergeOneSecondaryTx(client, primaryId, secondaryId) {
  // переносим все связи и баланс secondary -> primary
  await client.query('update auth_accounts set user_id=$1 where user_id=$2', [primaryId, secondaryId]);
  try { await client.query('update transactions set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}
  try { await client.query('update events set user_id=$1 where user_id=$2', [primaryId, secondaryId]); } catch {}

  // баланс
  await client.query(
    'update users u set balance = coalesce(u.balance,0) + (select coalesce(balance,0) from users where id=$2) where id=$1',
    [primaryId, secondaryId]
  );

  // поле avatar/имя/страна заполняем из secondary, если в primary пусто
  await client.query(
    `
    update users p
       set first_name   = coalesce(nullif(p.first_name,''), s.first_name),
           last_name    = coalesce(nullif(p.last_name,''),  s.last_name),
           username     = coalesce(nullif(p.username,''),   s.username),
           avatar       = coalesce(nullif(p.avatar,''),     s.avatar),
           country_code = coalesce(nullif(p.country_code,''), s.country_code),
           updated_at   = now()
      from users s
     where p.id=$1 and s.id=$2
    `,
    [primaryId, secondaryId]
  );

  // помечаем secondary замёрдженным
  await client.query(
    "update users set balance=0, meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{merged_into}', to_jsonb($1)::jsonb, true), updated_at=now() where id=$2",
    [primaryId, secondaryId]
  );
}

async function autoMergeByDevice(userId, deviceId) {
  if (!deviceId) return userId;
  await ensureMetaColumns();

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // 1) запомнить device_id у текущего пользователя
    await upsertArrayMeta(client, userId, 'device_ids', deviceId);

    // 2) собрать кандидатов: все, у кого этот device_id
    const candSql = `
      with c as (
        select u.id,
               exists(select 1 from auth_accounts a where a.user_id=u.id and a.provider='vk') as has_vk
          from users u
         where coalesce(u.meta->>'merged_into','') = ''
           and (
                  exists(select 1 from jsonb_array_elements_text(coalesce(u.meta->'device_ids','[]'::jsonb)) v where v = $1)
                or exists(select 1 from auth_accounts a where a.user_id=u.id and a.meta->>'device_id' = $1)
               )
      )
      select * from c order by id asc
    `;
    const { rows } = await client.query(candSql, [deviceId]);
    if (!rows || rows.length <= 1) {
      await client.query('COMMIT');
      return userId; // никто не нашёлся — или он один
    }

    // 3) выбрать primary и замёрджить остальных
    const primaryId = await choosePrimary(rows);
    for (const r of rows) {
      if (r.id === primaryId) continue;
      await mergeOneSecondaryTx(client, primaryId, r.id);
    }

    await client.query('COMMIT');
    return primaryId;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[tg auto-merge]', e);
    return userId; // не мешаем логину
  } finally {
    client.release();
  }
}

// --- ваш TG коллбэк ---
// Пример: фронтенд отправляет сюда { device_id, tg_user: { id, first_name, last_name, username, photo_url } }
router.post('/tg/callback', async (req, res) => {
  try {
    const body = req.body || {};
    const deviceId = (body.device_id || req.query.device_id || '').toString().trim();

    // здесь — ваша валидация initData/подписи от Telegram (оставляю как есть)
    const tg = body.tg_user || {};
    const tgId = parseInt(tg.id, 10);
    if (!tgId) return res.status(400).json({ ok:false, error:'bad_tg' });

    // upsert пользователя (чуть упрощённый пример)
    // заведём запись в users при отсутствии и в auth_accounts (provider='tg')
    const u = await db.query(
      `
      insert into users (first_name, last_name, username, avatar, created_at, updated_at)
      values ($1,$2,$3,$4, now(), now())
      on conflict do nothing
      returning id
      `,
      [tg.first_name||'', tg.last_name||'', tg.username||'', tg.photo_url||'']
    );

    // найдём/создадим auth_accounts
    let rowUser = null;
    if (u.rows.length) {
      rowUser = { id: u.rows[0].id };
    } else {
      // уже есть юзер — найдём по TG привязке
      const r = await db.query(
        `select user_id as id from auth_accounts where provider='tg' and provider_user_id=$1 limit 1`,
        [tgId]
      );
      if (r.rows[0]) rowUser = { id: r.rows[0].id };
      else {
        // fallback: возьмём кого-то «пустого»/последнего — под ваш текущий код тут можно доработать
        const r2 = await db.query(`insert into users (created_at,updated_at) values (now(),now()) returning id`);
        rowUser = { id: r2.rows[0].id };
      }
    }

    // связка в auth_accounts
    await ensureMetaColumns();
    await db.query(
      `
      insert into auth_accounts (provider, provider_user_id, user_id, meta, created_at, updated_at)
      values ('tg', $1, $2, jsonb_build_object('device_id',$3), now(), now())
      on conflict (provider, provider_user_id)
      do update set user_id=excluded.user_id, meta=coalesce(auth_accounts.meta,'{}'::jsonb) || jsonb_build_object('device_id', $3), updated_at=now()
      `,
      [tgId, rowUser.id, deviceId || null]
    );

    // автосклейка по device_id (если есть)
    const primaryId = await autoMergeByDevice(rowUser.id, deviceId);

    // логируем событие
    try {
      await db.query(
        `insert into events (user_id, event_type, created_at) values ($1, 'auth', now())`,
        [primaryId]
      );
    } catch {}

    res.json({
      ok: true,
      user_id: primaryId,
      provider: 'tg'
    });
  } catch (e) {
    console.error('[tg/callback]', e);
    res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
});

export default router;
