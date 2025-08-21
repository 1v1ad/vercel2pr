import { Router } from 'express';
import { verifyTelegramLogin } from './tg.js';
import { upsertUser, ensureAuthAccount, logEvent } from './db.js';
import { signSession } from './jwt.js';

const router = Router();

router.all('/callback', async (req, res) => {
  try {
    const data = req.method === 'GET' ? req.query : req.body;
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

    // Для единообразия используем vk_id='tg:<id>' (уникально и not null)
    const vk_id = `tg:${tg_id}`;
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await ensureAuthAccount({
      user_id: user.id,
      provider: 'tg',
      provider_user_id: tg_id,
      username,
      meta: { first_name, last_name, avatar }
    });

    await logEvent({
      user_id: user.id,
      event_type: 'tg_auth',
      payload: { tg_id, username },
      ip: req.ip,
      ua: (req.headers['user-agent'] || '').slice(0, 256)
    });

    const sessionJwt = signSession({ uid: user.id, tg_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

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
