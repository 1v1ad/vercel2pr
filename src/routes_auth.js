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

/**
 * Старт VK ID OAuth (PKCE).
 * Можно передать ?did=... (device_id) с фронта — прокинем его до обмена токена.
 */
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);
    const deviceId      = (req.query.did || '').toString().slice(0, 128);

    // Куки на 10 минут
    res.cookie('vk_state', state, {
      httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000,
    });
    res.cookie('vk_code_verifier', codeVerifier, {
      httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000,
    });
    if (deviceId) {
      res.cookie('vk_device_id', deviceId, {
        httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: 10 * 60 * 1000,
      });
    }

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: deviceId ? { device_id: deviceId } : null,
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // Авторизация VK ID
    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // Скоуп: персональные данные. Если у тебя в приложении включены email/phone — можно добавить через запятую
    u.searchParams.set('scope', 'vkid.personal_info');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.response?.data || e.message);
    return res.status(500).send('auth start failed');
  }
});

router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;

  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];
    const deviceId     = req.cookies['vk_device_id'] || '';

    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      return res.status(400).send('Invalid state');
    }

    // Чистим временные куки
    res.clearCookie('vk_state',        { path: '/' });
    res.clearCookie('vk_code_verifier',{ path: '/' });
    res.clearCookie('vk_device_id',    { path: '/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // === Обмен кода на токен VK ID ===
    // ВАЖНО: корректный endpoint — /oauth2/token (а не /oauth2/auth)
    let tokenData = null;
    try {
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      if (deviceId) form.set('device_id', deviceId);

      const resp = await axios.post(
        'https://id.vk.com/oauth2/token',
        form.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch (err) {
      // Логируем тело ответа, чтобы видеть реальную причину
      console.error('[VK CALLBACK] id.vk.com token fail:', err?.response?.data || err.message);
      // Пробовать обменивать на oauth.vk.com бессмысленно — код от id.vk.com другой природы.
      return res.status(500).send('auth callback failed');
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      console.error('no access_token from id.vk.com:', tokenData);
      return res.status(400).send('Token exchange failed');
    }

    // Получаем профиль
    let first_name = '', last_name = '', avatar = '';
    let vk_uid = '';
    try {
      const prof = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000
      });
      const r = prof.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name  || '';
        avatar     = r.photo_200  || '';
        vk_uid     = String(r.id || '');
      }
    } catch (e) {
      console.error('users.get fail:', e?.response?.data || e.message);
    }

    const user = await upsertUser({ vk_id: vk_uid || String(tokenData?.user_id || ''), first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id: user.vk_id, provider: 'vk' },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256)
    });

    // Сессия
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000
    });

    const url = new URL(frontendUrl);
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
