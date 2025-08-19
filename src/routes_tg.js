import { Router } from 'express';
import { verifyTelegramLogin } from './tg.js'; // утилита лежит в src/tg.js

const router = Router();

/**
 * Telegram Login Widget, как правило, делает GET на /callback
 * с query-параметрами (иногда POST с form-urlencoded).
 * Принимаем оба варианта.
 */
router.all('/callback', (req, res) => {
  const data = req.method === 'POST' ? req.body : req.query;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return res.status(500).send('Missing TELEGRAM_BOT_TOKEN');
  }

  // Проверка подписи (hash) по документации Telegram
  const ok = verifyTelegramLogin(data, botToken);

  // Доп. защита от "просроченной" авторизации — 24 часа
  const fresh =
    data?.auth_date && Number.isFinite(+data.auth_date)
      ? Math.abs(Date.now() / 1000 - Number(data.auth_date)) < 86400
      : true;

  if (!ok || !fresh) {
    return res.status(401).send('Invalid Telegram auth');
  }

  /**
   * TODO (когда захотим полноценную сессию):
   *   - найти/создать пользователя в БД
   *   - выдать JWT/куку sid
   *
   * Для MVP просто редиректим на фронт — index.html у тебя ловит ?logged=1
   * и отправляет в лобби.
   */
  const front = process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app';
  const url = new URL(front);
  url.searchParams.set('logged', '1');

  return res.redirect(302, url.toString());
});

export default router;
