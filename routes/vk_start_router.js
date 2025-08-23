import { Router } from 'express';
import crypto from 'crypto';

export default function makeVkStartRouter() {
  const r = Router();

  r.get('/start', async (req, res) => {
    const CLIENT_ID = process.env.VK_CLIENT_ID;
    const REDIRECT_URI = process.env.VK_REDIRECT_URI;
    if (!CLIENT_ID || !REDIRECT_URI) return res.status(500).send('VK client not configured');

    // Примем did с фронта и положим во временную httpOnly-куку
    const did = (req.query?.did || '').toString().slice(0, 200) || null;
    const cookieOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 10 * 60 * 1000 };
    if (did) res.cookie('vk_did', did, cookieOpts);

    // state для защиты от CSRF
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('vk_state', state, cookieOpts);

    // ВАЖНО: scope только email (без phone)
    const u = new URL('https://oauth.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', CLIENT_ID);
    u.searchParams.set('redirect_uri', REDIRECT_URI);
    u.searchParams.set('scope', 'email');
    u.searchParams.set('v', '5.199');
    u.searchParams.set('state', state);

    return res.redirect(302, u.toString());
  });

  return r;
}
