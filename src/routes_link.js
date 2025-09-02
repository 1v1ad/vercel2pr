// src/routes_link.js — persist device_id on provider account + call auto-merge
import { Router } from 'express';
import { autoMergeByDevice, ensureMetaColumns } from './merge.js';
import { db, getUserById, logEvent } from './db.js';
import { signSession } from './jwt.js';

const router = Router();

router.post('/link/background', async (req, res) => {
  try {
    const body = (req && req.body) || {};
    const provider = (body.provider || '').toString().trim();           // 'vk' | 'tg'
    const provider_user_id = (body.provider_user_id || '').toString().trim();
    const device_id = (body.device_id || '').toString().trim();
    const username = (body.username || '').toString().trim();

    await ensureMetaColumns();

    // 1) Пробуем обновить meta.device_id у текущего аккаунта (он должен существовать после авторизации)
    let updated = 0;
    try {
      const upd = await db.query(
        "update auth_accounts set meta = jsonb_set(coalesce(meta,'{}'::jsonb), '{device_id}', to_jsonb($3::text), true), updated_at=now() where provider=$1 and provider_user_id=$2",
        [provider, provider_user_id, device_id || null]
      );
      updated = upd.rowCount || 0;
    } catch {}

    // 2) На всякий случай, если записи нет — создадим «мягко» (без user_id, чтобы не сломать внешние ключи)
    if (!updated && provider && provider_user_id) {
      try {
        await db.query(
          "insert into auth_accounts (provider, provider_user_id, username, meta) values ($1,$2,$3, jsonb_build_object('device_id',$4)) on conflict do nothing",
          [provider, provider_user_id, username || null, device_id || null]
        );
      } catch {}
    }

    // 3) Пытаемся автосклеить, отдаём «мягкий» ответ
    const merged = await autoMergeByDevice({ deviceId: device_id || null, tgId: provider === 'tg' ? provider_user_id : null });

    // Try to resolve primary by device_id (mapped earlier via VK) and set session cookie
    let sessionSet = false;
    try {
      if (device_id) {
        const found = await db.query(
          `select user_id
             from auth_accounts
            where provider='vk' and user_id is not null
              and (meta->>'device_id') = $1
            order by updated_at desc
            limit 1`,
          [device_id]
        );
        if (found.rows.length) {
          const primary = await getUserById(found.rows[0].user_id);
          if (primary) {
            res.cookie('sid', signSession({ uid: primary.id }), {
              httpOnly: true, sameSite: 'none', secure: true, path: '/',
              maxAge: 30 * 24 * 3600 * 1000
            });
            sessionSet = true;
            try {
              await logEvent({
                user_id: primary.id,
                event_type: 'auth_success',
                payload: { provider, via: 'background_link' },
                ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null),
                ua: req.get('user-agent') || null,
                country_code: null
              });
            } catch {}
          }
        }
      }
    } catch (e) {
      console.warn('link/background: set session failed', e?.message || e);
    }

    res.json({ ok:true, merged, sessionSet });
  } catch (e) {
    res.json({ ok:false, error: String(e && e.message || e) });
  }
});

export default router;
