// src/routes_auth.js
import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent } from './db.js';

const router = express.Router();

function getenv() {
  const env = process.env;
  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET;
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

function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

// Унифицированные опции кук, чтобы точно вернулись после редиректа с id.vk.com
const cookieOpts = {
  httpOnly: true,
  sameSite: 'none', // важно: кросс-сайтовый редирект
  secure: true,
  path: '/',
  maxAge: 10 * 60 * 1000, // 10 минут на весь PKCE-обмен
};

router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    // PKCE
    const state        = crypto.randomBytes(16).toString('hex');
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // сохраняем в куках (host-only, без домена)
    res.cookie('vkid_state', state, cookieOpts);
    res.cookie('vkid_code_verifier', codeVerifier, cookieOpts);

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: null,
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // строим ссылку на VK ID
    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // если фронт передаст device id (did), пробросим его
    if (typeof req.query.did === 'string' && req.query.did.trim()) {
      u.searchParams.set('device_id', req.query.did.trim());
    }
    // можно добавить скоупы по необходимости
    // u.searchParams.set('scope', 'email'); // пример

    console.log('[VK START] redirect to:', u.toString());

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;

  // снимаем куки в самом начале, чтобы не протекали дальше
  const savedState    = req.cookies['vkid_state'];
  const codeVerifier  = req.cookies['vkid_code_verifier'];
  res.clearCookie('vkid_state', { path: '/' });
  res.clearCookie('vkid_code_verifier', { path: '/' });

  const stateCheck = {
    hasCode: !!code,
    hasState: !!state,
    savedState: !!savedState,
    codeVerifier: !!codeVerifier,
  };
  console.log('[VK CALLBACK] state check {', stateCheck, '}');

  if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
    return res.status(400).send('Invalid state');
  }

  try {
    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // ===== обмен кода на токен у VK ID (правильный токен-эндпоинт) =====
    let tokenData;
    try {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });

      const resp = await axios.post(
        'https://id.vk.com/oauth2/token',
        form.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 },
      );
      tokenData = resp.data;
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      console.error('[VK CALLBACK] token exchange fail:', status, data || err?.message);
      return res.status(500).send('auth callback failed');
    }

    const accessToken =
      tokenData?.access_token || tokenData?.token || tokenData?.access_token_value;

    if (!accessToken) {
      console.error('no access_token in tokenData:', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // ===== профиль =====
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: {
          access_token: accessToken,
          v: '5.199',
          fields: 'photo_200,first_name,last_name',
        },
        timeout: 10000,
      });
      const r = u.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name  || '';
        avatar     = r.photo_200  || '';
      }
    } catch (e) {
      console.warn('users.get failed:', e?.response?.data || e?.message);
    }

    // некоторые ответы VK ID возвращают user.id внутри tokenData.user
    const vk_id = String(tokenData?.user_id || tokenData?.user?.id || 'unknown');

    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // sid
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    // редирект на фронт
    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
