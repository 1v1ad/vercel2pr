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
  const clientSecret = env.VK_CLIENT_SECRET; // для id.vk.com можно и без него, но оставим — не мешает
  const redirectUri  = env.VK_REDIRECT_URI || env.REDIRECT_URI;
  const frontendUrl  = env.FRONTEND_URL  || env.CLIENT_URL;

  for (const [k, v] of Object.entries({
    VK_CLIENT_ID: clientId,
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

// Старт VK OAuth (PKCE)
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // ВАЖНО: SameSite=None + Secure, чтобы cookie дошли после редиректа с id.vk.com
    const cookieOpts = {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 10 * 60 * 1000, // 10 минут
    };
    res.cookie('vk_state', state, cookieOpts);
    res.cookie('vk_code_verifier', codeVerifier, cookieOpts);

    // device id просто логируем (можно при желании класть в state/куку отдельно)
    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: { did: req.query.did || null },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    const u = new URL('https://id.vk.com/authorize');
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', clientId);
    u.searchParams.set('redirect_uri', redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    // scope у VK ID можно не указывать или просить персональные данные; оставим email — как у тебя.
    u.searchParams.set('scope', 'email');

    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.response?.data || e.message);
    return res.status(500).send('auth start failed');
  }
});

// Callback от VK ID
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];

    const invalidState =
      !code ||
      !state ||
      !savedState ||
      savedState !== state ||
      !codeVerifier;

    if (invalidState) {
      console.error('[VK CALLBACK] invalid state check {', {
        hasCode: !!code,
        hasState: !!state,
        savedState: !!savedState,
        codeVerifier: !!codeVerifier,
      }, '}');
      return res.status(400).send('Invalid state');
    }

    // Чистим временные куки
    try {
      res.clearCookie('vk_state', { path: '/' });
      res.clearCookie('vk_code_verifier', { path: '/' });
    } catch {}

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // Обмен кода на токен — СТРОГО через id.vk.com (PKCE)
    let tokenData = null;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: String(clientId),
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      // client_secret можно добавить; VK ID примет и без него, но лишним не будет.
      if (clientSecret) body.set('client_secret', clientSecret);

      const resp = await axios.post(
        'https://id.vk.com/oauth2/token',
        body.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          timeout: 10000,
        }
      );
      tokenData = resp.data;
    } catch (err) {
      console.error('[VK CALLBACK] id.vk.com token fail:', err?.response?.status, err?.response?.data || err.message);
      return res.status(500).send('auth callback failed');
    }

    const accessToken = tokenData?.access_token;
    if (!accessToken) {
      console.error('[VK CALLBACK] no access_token in tokenData:', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // Получаем профиль. Для большинства приложений этим токеном можно дернуть classic API.
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
      console.warn('[VK CALLBACK] users.get warn:', e?.response?.status, e?.response?.data || e.message);
    }

    const vk_id = String(
      tokenData?.user_id ||
      tokenData?.user?.id ||
      tokenData?.vk_user_id || // мало ли
      ''
    );

    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    // Ставим сессию (кука кросс-сайт → SameSite=None)
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
    console.error('vk/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
