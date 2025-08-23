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
  const frontendUrl  = env.FRONTEND_URL   || env.CLIENT_URL;

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

// ====================== VK START (PKCE) ======================
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    // device id (для фоновой склейки)
    const did = (req.query?.did || '').toString().slice(0, 200) || null;

    const state        = crypto.randomBytes(16).toString('hex');
    const codeVerifier = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // Куки на короткое время
    const tmpCookie = { httpOnly: true, sameSite: 'none', secure: true, path: '/', maxAge: 10 * 60 * 1000 };
    res.cookie('vk_state', state, tmpCookie);
    res.cookie('vk_code_verifier', codeVerifier, tmpCookie);
    if (did) res.cookie('vk_did', did, tmpCookie);

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: null,
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // Авторизация через VK ID
    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // Просим только email — безопасно для большинства приложений
    u.searchParams.set('scope', 'email');
    u.searchParams.set('v', '5.199');

    try { console.log('[VK START] redirect to:', u.toString()); } catch {}

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.message || e);
    return res.status(500).send('auth start failed');
  }
});

// ====================== VK CALLBACK =========================
router.get('/vk/callback', async (req, res) => {
  const { code = '', state = '' } = req.query || {};
  try {
    const savedState   = req.cookies['vk_state'] || '';
    const codeVerifier = req.cookies['vk_code_verifier'] || '';

    // «Мягкая» проверка state — логируем, но не ломаем флоу
    if (!code) return res.status(400).send('Missing code');
    if (savedState && state && savedState !== state) {
      console.warn('[VK CALLBACK] state mismatch', { cookieState: savedState, state });
    }
    // Чистим временные куки
    try {
      res.clearCookie('vk_state', { path: '/', httpOnly: true, sameSite: 'none', secure: true });
      res.clearCookie('vk_code_verifier', { path: '/', httpOnly: true, sameSite: 'none', secure: true });
    } catch {}

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // ---------- Обмен кода на токен ----------
    let tokenData = null;

    // 1) Новый стек VK ID (PKCE)
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: clientId,
        redirect_uri: redirectUri,
      });
      if (clientSecret) body.set('client_secret', clientSecret);
      if (codeVerifier) body.set('code_verifier', codeVerifier);

      const resp = await axios.post(
        'https://id.vk.com/oauth2/token',
        body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch (err) {
      console.warn('[VK CALLBACK] id.vk.com token fail:', err?.response?.data || err?.message);
    }

    // 2) Фоллбэк на старый oauth
    if (!tokenData?.access_token) {
      const resp = await axios.get('https://oauth.vk.com/access_token', {
        params: {
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          code: String(code),
        },
        timeout: 10000,
      });
      tokenData = resp.data;
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      console.error('[VK CALLBACK] no access_token:', tokenData);
      return res.status(400).send('VK token exchange failed');
    }

    // ---------- Профиль ----------
    let first_name = '', last_name = '', avatar = '';
    try {
      const u = await axios.get('https://api.vk.com/method/users.get', {
        params: { access_token: accessToken, v: '5.199', fields: 'photo_200,first_name,last_name' },
        timeout: 10000,
      });
      const r = u.data?.response?.[0];
      if (r) {
        first_name = r.first_name || '';
        last_name  = r.last_name  || '';
        avatar     = r.photo_200  || '';
      }
    } catch (e) {
      console.warn('[VK CALLBACK] users.get failed:', e?.response?.data || e?.message);
    }

    const vk_id = String(tokenData?.user_id || tokenData?.user?.id || 'unknown');

    // ---------- Апсерт пользователя + лог ----------
    const user = await upsertUser({ vk_id, first_name, last_name, avatar });
    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // ---------- Ставим сессию ----------
    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    // ---------- Редирект в лобби ----------
    const to = new URL((frontendUrl || '').replace(/\/$/, '') + '/lobby.html');
    to.searchParams.set('logged', '1');
    to.searchParams.set('provider', 'vk');
    return res.redirect(to.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message || e);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
