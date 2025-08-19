import { Router } from 'express';
import { verifyTelegramLogin } from '../tg.js';

const router = Router();

/**
 * Телеграм-виджет обычно делает GET на /callback с query-параметрами.
 * Мы принимаем и GET, и POST (на будущее).
 */
router.all('/callback', (req, res) => {
  const data = req.method === 'POST' ? req.body : req.query;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).send('Missing TELEGRAM_BOT_TOKEN');
  }

  const ok = verifyTelegramLogin(data, botToken);

  // Защита от «просроченной» авторизации: 24 часа с момента выдачи
  const fresh =
    data?.auth_date && Number.isFinite(+data.auth_date)
      ? Math.abs(Date.now() / 1000 - Number(data.auth_date)) < 86400
      : true;

  if (!ok || !fresh) {
    return res.status(401).send('Invalid Telegram auth');
  }

  // Здесь можно найти/создать пользователя, выдать JWT/сессию и т.п.
  // Для MVP возвращаемся на фронт: index ловит ?logged=1 и редиректит в лобби
  const front = process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app';
  const url = new URL(front);
  url.searchParams.set('logged', '1');

  return res.redirect(302, url.toString());
});

export default router;
