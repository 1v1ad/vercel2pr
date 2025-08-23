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
  const clientSecret = env.VK_CLIENT_SECRET; // допустим к передаче с PKCE
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

const samesiteNone = {
  httpOnly: true,
  sameSite: 'none',
  secure: true,
  path: '/',
  maxAge: 10 * 60 * 1000,
};

// === VK ID: start ===
router.get('/vk/start', async (req, res) => {
  try {
    const { clientId, redirectUri } = getenv();

    const state         = crypto.randomBytes(16).toString('hex');
    const codeVerifier  = createCodeVerifier();
    const codeChallenge = createCodeChallenge(codeVerifier);

    // сохраняем в куках (SameSite=None чтобы точно вернулись на callback)
    res.cookie('vk_state', state, samesiteNone);
    res.cookie('vk_code_verifier', codeVerifier, samesiteNone);

    await logEvent({
      user_id: null,
      event_type: 'auth_start',
      payload: null,
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
    // базовый набор для VK ID (email — по желанию)
    u.searchParams.set('scope', 'openid vkid.personal_info email');

    console.log('[VK START] redirect to:', u.toString());
    return res.redirect(u.toString());
  } catch (e) {
    console.error('vk/start error:', e?.response?.data || e?.message);
    return res.status(500).send('auth start failed');
  }
});

// === VK ID: callback ===
router.get('/vk/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const savedState   = req.cookies['vk_state'];
    const codeVerifier = req.cookies['vk_code_verifier'];

    if (!code || !state || !savedState || savedState !== state || !codeVerifier) {
      console.warn('[VK CALLBACK] invalid state check', {
        hasCode: !!code, state, savedState: !!savedState, codeVerifier: !!codeVerifier,
      });
      return res.status(400).send('Invalid state');
    }

    // почистим одноразовые куки
    res.clearCookie('vk_state', { path: '/' });
    res.clearCookie('vk_code_verifier', { path: '/' });

    const { clientId, clientSecret, redirectUri, frontendUrl } = getenv();

    // 1) обмен кода на токены на VK ID
    let tokenData;
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: String(code),
        client_id: clientId,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      // передаём secret, если есть (для конфиденциальных клиентов это ок)
      if (clientSecret) body.set('client_secret', clientSecret);

      const resp = await axios.post(
        'https://id.vk.com/oauth2/token',
        body.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
      );
      tokenData = resp.data;
    } catch (err) {
      console.error('[VK CALLBACK] token exchange failed:', err?.response?.data || err?.message);
      return res.status(500).send('auth callback failed');
    }

    const accessToken = tokenData?.access_token;
    const idToken     = tokenData?.id_token;
    if (!accessToken && !idToken) {
      console.error('[VK CALLBACK] no tokens in response:', tokenData);
      return res.status(500).send('auth callback failed');
    }

    // 2) userinfo (надёжно и просто)
    let ui;
    try {
      const r = await axios.get('https://id.vk.com/oauth2/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });
      ui = r.data || {};
    } catch (e) {
      console.error('[VK CALLBACK] userinfo failed:', e?.response?.data || e?.message);
      return res.status(500).send('auth callback failed');
    }

    const vk_id = String(ui?.sub || '');
    const first_name = ui?.given_name || '';
    const last_name  = ui?.family_name || '';
    const avatar     = ui?.picture || '';

    if (!vk_id) {
      console.error('[VK CALLBACK] missing sub in userinfo:', ui);
      return res.status(500).send('auth callback failed');
    }

    const user = await upsertUser({ vk_id, first_name, last_name, avatar });

    await logEvent({
      user_id: user.id,
      event_type: 'auth_success',
      payload: { vk_id },
      ip: firstIp(req),
      ua: (req.headers['user-agent'] || '').slice(0, 256),
    });

    const sessionJwt = signSession({ uid: user.id, vk_id: user.vk_id });
    res.cookie('sid', sessionJwt, {
      httpOnly: true,
      sameSite: 'none',
      secure: true,
      path: '/',
      maxAge: 30 * 24 * 3600 * 1000,
    });

    const url = new URL((process.env.FRONTEND_URL || '').trim() || 'https://sweet-twilight-63a9b6.netlify.app');
    url.searchParams.set('logged', '1');
    return res.redirect(url.toString());
  } catch (e) {
    console.error('vk/callback error:', e?.response?.data || e?.message);
    return res.status(500).send('auth callback failed');
  }
});

export default router;
