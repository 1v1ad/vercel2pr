import { Router } from 'express';
import { verifyTelegramLogin } from './tg.js';
import { upsertAndLink, logEvent } from './db.js';
import { signSession } from './jwt.js';

const router = Router();

function getenv() {
  const env = process.env;
  return {
    frontendUrl: env.FRONTEND_URL || env.CLIENT_URL,
    deviceHeader: env.DEVICE_ID_HEADER || 'x-device-id',
  };
}

function getFirstIp(req) {
  return (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
}

// Telegram Login Widget — GET/POST
router.all('/callback', async (req, res) => {
  const data = req.method === 'POST' ? req.body : req.query;

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return res.status(500).send('Missing TELEGRAM_BOT_TOKEN');

  const isValid = verifyTelegramLogin(data, botToken);
  if (!isValid) return res.status(400).send('invalid tg login payload');

  const { frontendUrl, deviceHeader } = getenv();
  const device_id = (req.query?.did || req.headers[deviceHeader] || '').toString().slice(0, 200) || null;

  try {
    const user = await upsertAndLink({
      provider: 'tg',
      provider_user_id: data.id,
      username: data.username || null,
      first_name: data.first_name || null,
      last_name: data.last_name || null,
      avatar_url: data.photo_url || null,
      phone_hash: null,
      device_id,
    });

    await logEvent({ user_id:user?.id, event_type:'auth_ok', payload:{ provider:'tg' }, ip:getFirstIp(req), ua:(req.headers['user-agent']||'').slice(0,256) });

    const session = signSession({ uid: user.id, prov: 'tg' });
    res.cookie('sid', session, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    url.searchParams.set('provider', 'tg');
    return res.redirect(302, url.toString());
  } catch (e) {
    console.error('tg/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('tg callback failed');
  }
});

export default router;