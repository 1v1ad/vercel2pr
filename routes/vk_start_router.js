import { Router } from 'express';
import crypto from 'crypto';

function base64url(buf) {
  return buf.toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export default function makeVkStartRouter() {
  const r = Router();

  r.get('/start', async (req, res) => {
    const CLIENT_ID = process.env.VK_CLIENT_ID;
    const REDIRECT_URI = process.env.VK_REDIRECT_URI; // ДОЛЖЕН совпадать побайтно с тем, что в VK
    if (!CLIENT_ID || !REDIRECT_URI) {
      return res.status(500).send('VK client not configured');
    }

    // Хост авторизации: по умолчанию id.vk.com
    const VK_AUTH_HOST = (process.env.VK_AUTH_HOST || 'id.vk.com').trim(); // можно поставить oauth.vk.com при желании

    // Куки для did/state/pkce
    const cookieOpts = { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 10 * 60 * 1000 };

    // device_id с фронта (для последующей склейки)
    const did = (req.query?.did || '').toString().slice(0, 200) || null;
    if (did) res.cookie('vk_did', did, cookieOpts);

    // CSRF state
    const state = crypto.randomBytes(16).toString('hex');
    res.cookie('vk_state', state, cookieOpts);

    // PKCE
    const verifier = base64url(crypto.randomBytes(32));
    const code_challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
    res.cookie('vk_pkce_v', verifier, cookieOpts);

    // Сборка authorize-URL
    // Для id.vk.com нужны code_challenge(_method=S256)
    // Для oauth.vk.com PKCE тоже поддерживается, но если хочешь — можно отключить (но не нужно).
    const u = new URL(`https://${VK_AUTH_HOST}/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', CLIENT_ID);
    u.searchParams.set('redirect_uri', REDIRECT_URI);
    u.searchParams.set('scope', 'email');          // ВАЖНО: только email
    u.searchParams.set('state', state);
    u.searchParams.set('v', '5.199');
    u.searchParams.set('code_challenge', code_challenge);
    u.searchParams.set('code_challenge_method', 'S256');

    // Лог в Render — можно открыть Logs и видеть точный URL
    try { console.log('[VK START] redirect to:', u.toString()); } catch {}

    return res.redirect(302, u.toString());
  });

  return r;
}
