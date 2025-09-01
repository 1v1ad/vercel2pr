// src/routes_tg.js
import { Router } from 'express';
import { db } from './db.js';
import { autoMergeByDevice } from './merge.js';

const router = Router();

/**
 * TG callback:
 * ожидаем ?id=...&first_name=...&last_name=...&username=...&photo_url=...&device_id=...
 * В бою добавь валидацию подписи Telegram Login (hash), тут опущено для простоты теста.
 */
router.get('/callback', async (req, res) => {
  try {
    const q = req.query || {};
    const provider = 'tg';

    const providerUserId = (q.id || q.user_id || '').toString().trim();
    if (!providerUserId) return res.status(400).send('tg callback error: id required');

    const deviceId  = (q.device_id || '').toString().trim();

    const firstName = (q.first_name || '').toString().slice(0, 100) || null;
    const lastName  = (q.last_name  || '').toString().slice(0, 100) || null;
    const username  = (q.username   || '').toString().slice(0, 100) || null;
    const avatar    = (q.photo_url  || q.avatar || '').toString().slice(0, 512) || null;

    // 1) Пытаемся найти пользователя по связке в auth_accounts
    let userId = null;
    const map = await db.query(
      `select user_id from auth_accounts
        where provider = $1 and provider_user_id = $2
        limit 1`,
      [provider, providerUserId]
    );

    if (map.rowCount) {
      userId = map.rows[0].user_id;

      // мягко освежим профиль, если пришли новые данные
      await db.query(
        `update users
            set first_name = coalesce($1, first_name),
                last_name  = coalesce($2, last_name),
                username   = coalesce(nullif($3,''), username),
                avatar     = coalesce(nullif($4,''), avatar),
                updated_at = now()
          where id = $5`,
        [firstName, lastName, username, avatar, userId]
      );
    } else {
      // 2) Нет связи — создаём пользователя
      const ins = await db.query(
        `insert into users (first_name, last_name, username, avatar, created_at, updated_at)
         values ($1,$2,$3,$4, now(), now())
         returning id`,
        [firstName, lastName, username, avatar]
      );
      userId = ins.rows[0].id;

      // и привязываем telegram-аккаунт
      await db.query(
        `insert into auth_accounts (user_id, provider, provider_user_id, device_id)
         values ($1,$2,$3, nullif($4,''))`,
        [userId, provider, providerUserId, deviceId]
      );
    }

    // 3) Сохраним/обновим device_id для связки (если пришёл)
    if (deviceId) {
      await db.query(
        `update auth_accounts
            set device_id = $3
          where user_id = $1 and provider = $2
            and (device_id is distinct from $3)`,
        [userId, provider, deviceId]
      );

      // 4) Автосклейка по девайсу (безопасно: внутри есть свои проверки)
      try { await autoMergeByDevice(userId, deviceId); } catch (_e) {}
    }

    // 5) (необязательно) Запишем событие — в try, чтобы не упасть если таблицы/колонок нет
    try {
      await db.query(
        `insert into events (user_id, event_type, created_at)
         values ($1, 'auth_success', now())`,
        [userId]
      );
    } catch (_e) {
      // ок, пропускаем если схема events отличается
    }

    // Можно редирект на фронт/лоби, но для тестов достаточно «ok»
    res.send('ok');
  } catch (e) {
    console.error('tg callback error:', e);
    res.status(500).send('tg callback error');
  }
});

export default router;
