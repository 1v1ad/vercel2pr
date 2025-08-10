// backend/src/routes_auth.js  (ESM)
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser } from './db.js';

const router = express.Router();

/** Читаем ENV с подстраховкой названий */
function getenv() {
  const env = process.env;
  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET;
  // Принимаем оба варианта, приоритет — VK_REDIRECT_URI
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;

  for (const [k, v] of Object.entries({
    VK_CLIENT_ID: clientId,
    VK_CLIENT_SECRET: clientSecret,
    VK_REDIRECT_URI: redirectUri,
    FRONTEND_URL: frontendUrl,
  })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

/** Утилита для state */
function randomHex(len = 16) {
  return crypto.randomBytes(len).toString('hex');
}

/** 1) Старт авторизации: ставим state + PKCE в HttpOnly-куки и редиректим на VK ID */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const state        = randomHex(16);
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier); // S256

    // временные куки живут только на домене API (Render)
    res.cookie('vk_state', state, {
      httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000,
    });
    res.cookie('vk_code_verifier', codeVerifier, {
      httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000,
    });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // минимальный скоуп для получения персональных данных
    u.searchParams.set('scope', 'vkid.personal_info');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e.message);
    return res.status(500).send('auth start failed');
  }
});

/** 2) Callback: меняем code -> token, берём профиль, создаём сессию */
router.get('/vk/callback', async (req, res) => {
  const { code, state, device_id } = req.query;
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      return res.status(400).send('Invalid state');
    }

    // подчистим временные куки
    res.clearCookie('vk_state', { path: '/' });
    res.clearCookie('vk_code_verifier', { path: '/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // 2.1 Пытаемся обменять код на токен через id.vk.com (VK ID)
    let tokenData = null;
    try {
      const resp = await axios.post(
        'https://id.vk.com/oauth2/auth',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
          // device_id VK отдаёт в query; прокинем если есть
          device_id: device_id || ''
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch (err) {
      console.warn('id.vk.com exchange failed, fallback to oauth.vk.com', err?.response?.data || err?.message);
      // 2.2 Фолбэк на легаси эндпоинт (часто прокатывает)
      const resp = await axios.get('https://oauth.vk.com/access_token', {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code,
          code_verifier: codeVerifier,
          device_id: device_id || ''
        },
        timeout: 10000
      });
      tokenData = resp.data;
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      console.error('no access_token in tokenData:', tokenData);
      return res.status(400).send('Token exchange failed');
    }

    // 2.3 Подтянем базовый профиль (имя/аватар)
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000
      });
      const r = u.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name  || '';
        avatar     = r.photo_200  || '';
      }
    } catch (e) {
      console.warn('users.get failed', e?.response?.data || e?.message);
    }

    const vk_id = String(tokenData?.user_id || tokenData?.user?.id || 'unknown');
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    // 2.4 Выдаём сессию: кука для кросс-домена (Netlify -> Render)
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',   // ВАЖНО: чтобы кука шла в XHR с другого домена
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    // 2.5 Возвращаем на фронт (index потом сам кидает в /lobby.html)
    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
