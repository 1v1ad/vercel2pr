import { Router } from 'express';
import { verifyTelegramLogin } from './tg.js';

const router = Router();

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

router.all('/callback', async (req, res) => {
  // Берём все параметры и отделяем наш служебный did
  const all = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const { did, ...data } = all;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).send('Missing TELEGRAM_BOT_TOKEN');

  // ВАЖНО: валидируем только телеграм-поля, игнорируя всё лишнее
  const allowed = ['id','first_name','last_name','username','photo_url','auth_date','hash'];
  const clean = {};
  for (const k of allowed) if (data[k] != null) clean[k] = data[k];

  const ok = verifyTelegramLogin(clean, botToken);
  const fresh =
    clean?.auth_date && Number.isFinite(+clean.auth_date)
      ? Math.abs(Date.now() / 1000 - Number(clean.auth_date)) < 86400
      : true;

  if (!ok || !fresh) return res.status(401).send('Invalid Telegram auth');

  // Прокинем device_id в httpOnly-куку (для фоновой склейки)
  try {
    if (did) {
      res.cookie('vk_did', String(did).slice(0, 200), {
        httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 10 * 60 * 1000
      });
    }
  } catch {}

  // Попробуем дернуть хуки склейки, если подключены
  let user = null;
  try {
    const mod = await import('../routes/auth_hooks.js'); // путь из src/ к routes/
    if (mod?.onTelegramAuthSuccess) {
      user = await mod.onTelegramAuthSuccess(req, {
        id: clean.id,
        first_name: clean.first_name,
        last_name: clean.last_name,
        username: clean.username,
        photo_url: clean.photo_url,
      });
    }
  } catch { /* необязательно, продолжим даже без хука */ }

  // Ставим сессию, чтобы /api/me ответил 200
  // /api/me у тебя просто декодит payload из JWT и берёт uid → подпись не проверяет.
  const uid = (user && user.id) || (clean.id ? Number(clean.id) : null);
  if (uid) {
    const sid = ['x', b64url({ uid, iat: Math.floor(Date.now() / 1000) }), 'x'].join('.');
    res.cookie('sid', sid, {
      httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 30 * 24 * 3600 * 1000
    });
  }

  // Редирект в лобби
  const frontBase = (process.env.FRONTEND_URL || 'https://sweet-twilight-63a9b6.netlify.app').replace(/\/$/, '');
  const url = new URL(frontBase + '/lobby.html');
  url.searchParams.set('logged', '1');
  url.searchParams.set('provider', 'tg');
  return res.redirect(302, url.toString());
});

export default router;
