import { Router } from 'express';
import { verifyTelegramLogin } from '../tg.js'; // используем утилиту из корня

const router = Router();

/**
 * Telegram Login Widget обычно делает GET на /callback с query-параметрами.
 * На всякий случай принимаем и POST.
 */
router.all('/callback', (req, res) => {
  const data = req.method === 'POST' ? req.body : req.query;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).send('Missing TELEGRAM_BOT_TOKEN');

  const ok = verifyTelegramLogin(data, botToken);

  // доп.проверка «свежести» (24 часа)
  const fresh =
    data?.auth_date && Number.isFinite(+data.auth_date)
      ? Math.abs(Date.now() / 1000 - Number(data.auth_date)) < 86400
      : true;

  if (!ok || !fresh) return res.status(401).send('Invalid Telegram auth');

  // тут можно создать/найти пользователя и выдать JWT/куку
  // для MVP — просто редиректим на фронт, а index.html ловит ?logged=1
  const front = process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app';
  const url = new URL(front);
  url.searchParams.set('logged', '1');
  return res.redirect(302, url.toString());
});

export default router;
