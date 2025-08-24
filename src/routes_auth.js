import express from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createCodeVerifier, createCodeChallenge } from './pkce.js';
import { signSession } from './jwt.js';
import { upsertUser, logEvent } from './db.js';

const router = express.Router();

/** ENV helper */
function getenv() {
  const env = process.env;
  const clientId     = env.VK_CLIENT_ID;
  const clientSecret = env.VK_CLIENT_SECRET; // может быть не нужен для PKCE, но не мешает
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;

  for (const [k, v] of Object.entries({
    VK_CLIENT_ID: clientId,
    VK_REDIRECT_URI: redirectUri,
    FRONTEND_URL: frontendUrl
  })) {
    if (!v) throw new Error(`Missing env ${k}`);
  }
  return { clientId, clientSecret, redirectUri, frontendUrl };
}

/** первый внешний IP клиента */
function firstIp(req) {
  const ipHeader = (req.headers['x-forwarded-for'] || req.ip || '').toString();
  return ipHeader.split(',')[0].trim();
}

/**
 * Старт VK ID OAuth + PKCE
 */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    // PKCE
    const codeVerifier  = createCodeVerifier();          // ~43 симв. base64url
    const codeChallenge = createCodeChallenge(codeVerifier);

    // Защита от CSRF
    const state = crypto.randomBytes(16).toString('hex');

    // Сохраняем в куки для коллбэка
    const cookieOpts = {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',   // top-level навигация с id.vk.com принесёт куки
      path: '/',
      maxAge: 10 * 60 * 1000
    };
    res.cookie('vk_state', state, cookieOpts);
    res.cookie('vk_code_verifier', codeVerifier, cookieOpts);

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: null,
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256)
    });

    // URL авторизации VK ID
    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // набор прав можно сузить/расширить при необходимости
    u.searchParams.set('scope', 'vkid.personal_info');

    console.log('[VK START] redirect to:', u.toString());
    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.response?.data || e?.message);
    return res.status(500).send('auth start failed');
  }
});

/**
 * Коллбэк VK ID: обмен кода на токен, апсерт юзера, сессия, редирект на фронт
 */
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query || {};
  try {
    const savedState   = req.cookies?.vk_state;
    const codeVerifier = req.cookies?.vk_code_verifier;

    // Подробный лог диагностики
    console.log('[VK CALLBACK] state check', {
      hasCode: !!code,
      hasState: !!state,
      savedState: !!savedState && (savedState === state),
      codeVerifier: !!codeVerifier
    });

    if (!code || !state || !savedState || savedState !== state) {
      return res.status(400).send('Invalid state');
    }

    // чистим одноразовые куки
    res.clearCookie('vk_state', { path: '/' });
    res.clearCookie('vk_code_verifier', { path: '/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // Обмен кода на токен — ИМЕННО /oauth2/token у id.vk.com
    let tokenData;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: String(codeVerifier || '')
      });

      // Секрет некоторым конфигурациям не нужен, но если есть — добавим
      if (clientSecret) body.set('client_secret', clientSecret);

      const resp = await axios.post(
        'https://id.vk.com/oauth2/token',
        body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch (err) {
      // Покажем, что ответил VK ID
      console.error('[VK CALLBACK] token exchange fail:', err?.response?.status, err?.response?.data || err?.message);
      return res.status(500).send('auth callback failed');
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      console.error('[VK CALLBACK] no access_token in', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // Профиль для first_name/last_name/avatar (опционально)
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000
      });
      const r = u.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name || '';
        avatar     = r.photo_200 || '';
      }
    } catch (e) {
      console.warn('[VK PROFILE] users.get failed:', e?.response?.data || e?.message);
    }

    const vk_id = String(tokenData?.user_id || tokenData?.user?.id || '');
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256)
    });

    // Сессионная кука
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none', // понадобится для запросов с фронта с другого домена
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    // Редирект на фронт: фронт может дернуть /api/me и показать профиль
    const url = new URL((frontendUrl || '').replace(/\/$/, ''));
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
