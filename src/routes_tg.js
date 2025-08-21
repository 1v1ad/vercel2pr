// src/routes_tg.js
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { verifyTelegramLogin } from './tg.js';
import { upsertUser, ensureAuthAccount, logEvent, getUserById } from './db.js';
import { signSession } from './jwt.js';
import { mergeUsers } from './linking.js';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

router.all('/callback', async (req, res) => {
  try {
    const data = (req.method === 'GET') ? req.query : req.body;
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const frontendUrl = process.env.FRONTEND_URL;

    if (!verifyTelegramLogin(data, botToken)) {
      return res.status(400).send('invalid tg login');
    }

    const tg_id = String(data.id);
    const first_name = String(data.first_name || '');
    const last_name = String(data.last_name || '');
    const username = String(data.username || '');
    const avatar = String(data.photo_url || '');

    // Для единообразия пользуемся vk_id='tg:<id>' как уникальным идентификатором
    const tg_vk_id = `tg:${tg_id}`;
    let user = await upsertUser({ vk_id: tg_vk_id, first_name, last_name, avatar });
    await ensureAuthAccount({ user_id: user.id, provider: 'tg', provider_user_id: tg_id, username, meta: { first_name, last_name, avatar } });

    // Если уже был sid от VK (или другого провайдера) — склеиваем автоматически
    const priorSid = req.cookies?.sid;
    if (priorSid) {
      try {
        const payload = jwt.verify(priorSid, JWT_SECRET);
        const priorUid = Number(payload?.uid);
        if (priorUid && priorUid !== user.id) {
          const older = await Promise.all([getUserById(priorUid), getUserById(user.id)]);
          const [a,b] = older;
          const [primaryId, mergedId] =
            (new Date(a.created_at) <= new Date(b.created_at)) ? [a.id, b.id] : [b.id, a.id];

          await mergeUsers(primaryId, mergedId, {
            method: 'auto-merge',
            source: '/api/auth/tg/callback',
            ip: firstIp(req),
            ua: (req.headers['user-agent']||'').slice(0,256)
          });

          user = await getUserById(primaryId);
        }
      } catch { /* старый sid невалиден — игнор */ }
    }

    await logEvent({ user_id: user.id, event_type: 'tg_auth', payload: { tg_id, username }, ip: firstIp(req), ua: (req.headers['user-agent']||'').slice(0,256) });

    // Выдаём sid старшего
    const sessionJwt = signSession({ uid: user.id, tg_id });
    res.cookie('sid', sessionJwt, { httpOnly:true, sameSite:'none', secure:true, path:'/', maxAge: 30*24*3600*1000 });

    // Можно отправить в бота «кнопку контакта» (если подключишь webhook)
    // (смотри ниже routes_telegram_webhook.js)

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    url.searchParams.set('provider', 'tg');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('tg/callback error', e?.message || e);
    return res.status(500).send('tg callback failed');
  }
});

export default router;
