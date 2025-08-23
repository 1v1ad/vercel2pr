import { Router } from 'express';
import { verifyTelegramLogin } from './tg.js';

const router = Router();

/**
 * Telegram Login Widget присылает данные user (обычно GET с query).
 * Отвечаем быстро: валидируем hash и сразу редиректим на фронт
 * с параметрами, чтобы лобби могло отрисовать профиль TG.
 */
router.all('/callback', (req, res) => {
  const data = req.method === 'POST' ? req.body : req.query;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).send('Missing TELEGRAM_BOT_TOKEN');

  const ok = verifyTelegramLogin(data, botToken);
  const fresh =
    data?.auth_date && Number.isFinite(+data.auth_date)
      ? Math.abs(Date.now() / 1000 - Number(data.auth_date)) < 86400
      : true;

  if (!ok || !fresh) return res.status(401).send('Invalid Telegram auth');

  // Чистим возможную старую VK-куку, чтобы не перетёрла отображение
  try {
    res.clearCookie('sid', { path: '/', httpOnly: true, secure: true, sameSite: 'none' });
  } catch {}

  // Быстрый редирект на фронт с данными TG (без БД и без задержек)
  const frontBase = (process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app').replace(/\/$/, '');
  const url = new URL(frontBase + '/');

  url.searchParams.set('logged', '1');
  url.searchParams.set('provider', 'tg');

  if (data.id) url.searchParams.set('id', String(data.id));
  if (data.first_name) url.searchParams.set('first_name', String(data.first_name));
  if (data.last_name) url.searchParams.set('last_name', String(data.last_name));
  if (data.username) url.searchParams.set('username', String(data.username));
  if (data.photo_url) url.searchParams.set('photo_url', String(data.photo_url));

  return res.redirect(302, url.toString());
});

export default router;
