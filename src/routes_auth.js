// src/routes_auth.js
import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';

import { signSession } from './jwt.js';
import { upsertUser, logEvent, ensureAuthAccount, getUserById } from './db.js';
import { mergeUsers } from './linking.js';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';

function getenv() {
  const env = process.env;
  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET;
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;
  if (!clientId || !clientSecret || !redirectUri || !frontendUrl) {
    throw new Error('VK env not configured');
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

function mask(t) {
  if (!t || typeof t !== 'string') return '';
  return t.slice(0, 6) + '…' + t.slice(-4);
}

/* ─────────────── VK OAuth START (classic) ─────────────── */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: { provider: 'vk', mode: 'classic' },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    const u = new URL('https://oauth.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    // оффлайн не обязателен, но пусть будет
    u.searchParams.set('scope', 'offline');
    u.searchParams.set('display', 'page');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

/* ─────────────── VK OAuth CALLBACK (classic) ─────────────── */
router.get('/vk/callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    if (!code) return res.status(400).send('code required');

    // 1) Обмен кода на токен (classic)
    let tokenData = null;
    try {
      const resp = await axios.get('https://oauth.vk.com/access_token', {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
        },
        timeout: 15000,
      });
      tokenData = resp.data || null;
      console.log('vk/callback (classic) token resp:', {
        has_access_token: !!tokenData?.access_token,
        user_id: tokenData?.user_id || null,
        access_token_masked: mask(tokenData?.access_token),
      });
      if (!tokenData?.access_token || !tokenData?.user_id) {
        return res.status(400).send('Token exchange failed');
      }
    } catch (err) {
      console.error('vk/callback (classic) token exchange failed:', err?.response?.data || err?.message);
      return res.status(400).send('Token exchange failed');
    }

    const accessToken = tokenData.access_token;
    let   vk_id       = String(tokenData.user_id);

    // 2) Дотянем имя/аватар (не критично)
    let first_name = '', last_name = '', avatar = '';
    try {
      const prof = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000,
      });
      const r = prof.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name  || '';
        avatar     = r.photo_200  || '';
      }
    } catch { /* необязательно */ }

    // 3) upsert user + связка VK
    let user = await upsertUser({ vk_id, first_name, last_name, avatar });
    await ensureAuthAccount({
      user_id: user.id,
      provider: 'vk',
      provider_user_id: vk_id,
      username: null,
      meta: { first_name, last_name, avatar },
    });

    // 4) Автосклейка по старому sid (тот же браузер)
    const priorSid = req.cookies?.sid;
    if (priorSid) {
      try {
        const payload = jwt.verify(priorSid, JWT_SECRET);
        const priorUid = Number(payload?.uid);
        if (priorUid && priorUid !== user.id) {
          const [a, b] = await Promise.all([getUserById(priorUid), getUserById(user.id)]);
          const [primaryId, mergedId] =
            (new Date(a.created_at) <= new Date(b.created_at)) ? [a.id, b.id] : [b.id, a.id];

          await mergeUsers(primaryId, mergedId, {
            method: 'auto-merge',
            source: '/api/auth/vk/callback(classic)',
            ip: firstIp(req),
            ua: (req.headers['user-agent'] || '').slice(0, 256),
          });

          user = await getUserById(primaryId);
        }
      } catch { /* невалидный sid — ок */ }
    }

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { provider: 'vk', mode: 'classic' },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // 5) Выдаём сессию
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
