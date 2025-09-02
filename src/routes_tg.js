// src/routes_tg.js — TG callback: deviceId → primary, иначе только лог
import { Router } from 'express';
import { db, getUserById, logEvent } from './db.js';
import { signSession } from './jwt.js';
import { autoMergeByDevice } from './merge.js';

const router = Router();
const FRONTEND = process.env.FRONTEND_URL || 'http://localhost:5173';

const safe = (s) => (s == null ? null : String(s));

/** простая эвристика "похож ли юзер на primary" */
async function looksPrimary(userId) {
  try {
    // если к этому user_id привязан VK — почти наверняка это primary
    const r = await db.query(
      "select 1 from auth_accounts where user_id=$1 and provider='vk' limit 1",
      [userId]
    );
    return r.rows.length > 0;
  } catch { return false; }
}

/** если юзер помечен как слитый — вернуть его primary; иначе себя */
async function resolvePrimaryUserId(userId) {
  try {
    const r = await db.query(
      "select coalesce(nullif(u.meta->>'merged_into','')::int, u.id) as pid from users u where u.id=$1",
      [userId]
    );
    if (r.rows.length) return r.rows[0].pid || userId;
  } catch {}
  return userId;
}

router.all('/callback', async (req, res) => {
  try {
    const data = { ...(req.query || {}), ...(req.body || {}) };
    const deviceId = safe(req.query?.device_id || req.cookies?.device_id || '');
    const tgId = safe(data.id || '');

    // 1) Если девайс уже известен → логиним ПРАЙМАРИ по девайсу и логируем success
    if (deviceId) {
      try {
        const r = await db.query(
          `select user_id
             from auth_accounts
            where (meta->>'device_id') = $1
              and user_id is not null
            order by updated_at desc
            limit 1`,
          [deviceId]
        );
        if (r.rows.length) {
          const primary = await getUserById(await resolvePrimaryUserId(r.rows[0].user_id));
          if (primary) {
            const jwt = signSession({ uid: primary.id });
            res.cookie('sid', jwt, {
              httpOnly: true, sameSite: 'none', secure: true, path: '/',
              maxAge: 30 * 24 * 3600 * 1000
            });
            try {
              await logEvent({
                user_id: primary.id,
                event_type: 'auth_success',
                payload: { provider: 'tg', via: 'device_id' },
                ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null),
                ua: req.get('user-agent') || null,
                country_code: null
              });
            } catch {}
          }
        }
      } catch (e) {
        console.warn('tg device session lookup failed:', e?.message || e);
      }
    }

    // 2) Обновим/запомним TG-аккаунт и device_id (без логина)
    if (tgId) {
      try {
        await db.query(`
          insert into auth_accounts (user_id, provider, provider_user_id, username, phone_hash, meta)
          values (null, 'tg', $1, $2, null, $3)
          on conflict (provider, provider_user_id) do update set
            username   = coalesce(excluded.username, auth_accounts.username),
            meta       = jsonb_strip_nulls(coalesce(auth_accounts.meta,'{}'::jsonb) || excluded.meta),
            updated_at = now()
        `, [tgId, safe(data.username), JSON.stringify({ device_id: deviceId || null }) ]);
      } catch (e) {
        console.warn('tg upsert failed:', e?.message);
      }
    }

    // 3) Второй шанс: нашли user_id по TG-аккаунту — логиним ТОЛЬКО если это похоже на primary
    if (tgId) {
      try {
        const link = await db.query(
          `select user_id
             from auth_accounts
            where provider='tg' and provider_user_id=$1
              and user_id is not null
            order by updated_at desc
            limit 1`,
          [tgId]
        );
        if (link.rows.length) {
          let uid = await resolvePrimaryUserId(link.rows[0].user_id);
          const user = await getUserById(uid);
          if (user) {
            const isPrimary = await looksPrimary(uid);
            // cookie ставим только если это реально primary; иначе не трогаем текущую сессию
            if (isPrimary) {
              res.cookie('sid', signSession({ uid: user.id }), {
                httpOnly: true, sameSite: 'none', secure: true, path: '/',
                maxAge: 30 * 24 * 3600 * 1000
              });
            }
            try {
              await logEvent({
                user_id: user.id,
                event_type: 'auth_success',
                payload: { provider: 'tg', via: isPrimary ? 'account_link_primary' : 'account_link_secondary' },
                ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null),
                ua: req.get('user-agent') || null,
                country_code: null
              });
            } catch {}
          }
        }
      } catch (e) {
        console.warn('tg account->user resolve failed:', e?.message || e);
      }
    }

    // 4) Запускаем авто-склейку в фоне (без ожидания)
    try { if (deviceId) autoMergeByDevice({ deviceId, tgId }); } catch {}

    // 5) Редирект на лобби
    const url = new URL('/lobby.html', FRONTEND);
    url.searchParams.set('provider', 'tg');
    if (tgId) url.searchParams.set('id', tgId);
    if (data.first_name) url.searchParams.set('first_name', safe(data.first_name));
    if (data.last_name) url.searchParams.set('last_name', safe(data.last_name));
    if (data.username) url.searchParams.set('username', safe(data.username));
    if (data.photo_url) url.searchParams.set('photo_url', safe(data.photo_url));
    return res.redirect(302, url.toString());
  } catch (e) {
    console.error('tg/callback error', e);
    return res.redirect(302, (process.env.FRONTEND_URL || '') + '/lobby.html?provider=tg');
  }
});

export default router;
