// src/routes_tg.js
import { Router } from 'express';
import { db } from './db.js';
import { autoMergeByDevice } from './merge.js';

const router = Router();

/**
 * Твой колбек мини-аппа TG.
 * Сервер смонтирован как: app.use('/api/auth/tg', routes_tg)
 * => значит здесь путь должен быть ровно '/callback' (НЕ '/tg/callback').
 */
router.get('/callback', async (req, res) => {
  try {
    // забираем то, что ты уже прокидываешь из фронта
    const deviceId   = (req.query.device_id || '').toString().trim();
    const tgId       = (req.query.tg_id || req.query.id || '').toString().trim();
    const firstName  = (req.query.first_name || '').toString().trim();
    const username   = (req.query.username || '').toString().trim();
    const avatarUrl  = (req.query.photo_url || '').toString().trim();

    if (!tgId) return res.status(400).send('tg_id required');

    // находим/создаём пользователя (упрощённо: по tgId в auth_accounts)
    const r = await db.query(
      `select u.id from auth_accounts aa
       join users u on u.id = aa.user_id
       where aa.provider = 'tg' and aa.provider_user_id = $1
       limit 1`, [tgId]
    );

    let userId;
    if (r.rowCount) {
      userId = r.rows[0].id;
      // чуть освежим профиль
      await db.query(
        `update users
           set first_name = coalesce(nullif(first_name,''), $1),
               username   = coalesce(nullif(username,''),   $2),
               avatar     = coalesce(nullif(avatar,''),     $3),
               updated_at = now()
         where id = $4`,
        [firstName, username, avatarUrl, userId]
      );
    } else {
      // создаём юзера
      const u = await db.query(
        `insert into users(first_name, username, avatar)
         values ($1, $2, $3) returning id`,
        [firstName, username, avatarUrl]
      );
      userId = u.rows[0].id;

      // и привязываем аккаунт TG
      await db.query(
        `insert into auth_accounts(user_id, provider, provider_user_id, device_id)
         values ($1,'tg',$2,$3)`,
        [userId, tgId, deviceId || null]
      );
    }

    // авто-склейка, если у устройства есть ещё аккаунты
    if (deviceId) {
      await autoMergeByDevice(userId, deviceId);
    }

    // ответ будь какой тебе удобен (JSON/скрипт/редирект)
    res.send('OK'); // минимально. Раньше у тебя работало — оставь свой формат.

  } catch (e) {
    console.error('tg/callback error', e);
    res.status(500).send('tg callback error');
  }
});

export default router;
