import express from 'express';
import crypto from 'crypto';
import { upsertUser, logEvent } from './db.js';
import { signSession } from './jwt.js';

const router = express.Router();

function checkTelegramAuth(data, botToken) {
  const authData = { ...data };
  const hash = authData.hash;
  delete authData.hash;
  const checkString = Object.keys(authData).sort().map(k => `${k}=${authData[k]}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hex = crypto.createHmac('sha256', secret).update(checkString).digest('hex');
  return hex === hash;
}

router.post('/telegram', express.json(), async (req, res) => {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.status(500).json({ ok:false, error:'no bot token' });

    const ok = checkTelegramAuth(req.body || {}, botToken);
    if (!ok) return res.status(401).json({ ok:false, error:'invalid hash' });

    const u = req.body;
    const user = await upsertUser({
      telegram_id: String(u.id),
      first_name: u.first_name || '',
      last_name: u.last_name || '',
      avatar: u.photo_url || ''
    });

    await logEvent({ user_id:user.id, event_type:'tg_auth', payload:{ telegram_id:user.telegram_id }, ip:(req.headers['x-forwarded-for']||'').toString(), ua:(req.headers['user-agent']||'').slice(0,256) });

    const sessionJwt = signSession({ uid: user.id, telegram_id: user.telegram_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    return res.json({ ok:true, user:{ id:user.id, first_name:user.first_name, last_name:user.last_name, photo_url:user.avatar } });
  } catch (e) {
    console.error('telegram auth error', e);
    return res.status(500).json({ ok:false });
  }
});

export default router;
